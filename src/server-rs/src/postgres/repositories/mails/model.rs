//! Row types of the mail tables and their validation: `mails`
//! (models/mail.ts), `mail_uid_counters` (models/mail_uid_counter.ts) and
//! `mail_mailbox_uid` (models/mail_mailbox_uid.ts).
//!
//! A row is checked against its table's column types before it becomes a
//! model, as the Bun server checks it: a column of the wrong type is an
//! error, never a silently defaulted field.
//!
//! ```ignore
//! let mail = MailModel::from_record(&record)?;          // a whole `mails` row
//! let partial = PartialMailModel::new(&["mail_id", "read"], &record)?;
//! ```

use std::collections::HashSet;
use std::fmt;

use serde_json::{json, Map, Value};

use super::table::{Record, Table};
use crate::postgres::Row;

// Table names.
pub const MAILS: &str = "mails";
pub const MAIL_UID_COUNTERS: &str = "mail_uid_counters";
pub const MAIL_MAILBOX_UID: &str = "mail_mailbox_uid";

// Columns on `mails`.
pub const MAIL_ID: &str = "mail_id";
pub const USER_ID: &str = "user_id";
pub const MESSAGE_ID: &str = "message_id";
pub const ENVELOPE_TO: &str = "envelope_to";
pub const READ: &str = "read";
pub const SAVED: &str = "saved";
pub const SENT: &str = "sent";
pub const DELETED: &str = "deleted";
pub const DRAFT: &str = "draft";
pub const ANSWERED: &str = "answered";
pub const EXPUNGED: &str = "expunged";
pub const UID_DOMAIN: &str = "uid_domain";
/// Per-message mod-sequence for CONDSTORE (RFC 7162): every insert, flag
/// change and expunge stamps a freshly reserved value.
pub const MODSEQ: &str = "modseq";
pub const IS_SPAM: &str = "is_spam";
pub const RFC822_SIZE: &str = "rfc822_size";
pub const UPDATED: &str = "updated";

// Columns on `mail_uid_counters`.
pub const UID_KIND: &str = "uid_kind";
pub const UID_SCOPE: &str = "uid_scope";
pub const LAST_UID: &str = "last_uid";

// Columns on `mail_mailbox_uid`. `mailbox` holds the full IMAP path.
pub const MAILBOX: &str = "mailbox";
pub const UID: &str = "uid";

/// The `mails` table. Its unique `(user_id, message_id)` is what the save
/// path's merge branch keys on.
pub fn mails_table() -> Table {
    Table { name: MAILS, primary_key: MAIL_ID }
}

/// Per-(user, kind, scope, sent) durable UID counter, the IMAP UIDNEXT model.
pub fn mail_uid_counters_table() -> Table {
    Table { name: MAIL_UID_COUNTERS, primary_key: USER_ID }
}

/// Per-(user, mailbox, mail) UID assignment for IMAP folder views.
pub fn mail_mailbox_uid_table() -> Table {
    Table { name: MAIL_MAILBOX_UID, primary_key: USER_ID }
}

/// The columns of `mails` in declaration order.
pub fn mail_columns() -> Vec<&'static str> {
    mails_table().columns()
}

/// A row that does not have the shape its model requires.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelValidationError {
    pub model: String,
    /// One entry per failing field: `name: <value as JSON> (<JavaScript type>)`.
    pub errors: Vec<String>,
}

impl ModelValidationError {
    pub fn new(model: &str, errors: Vec<String>) -> ModelValidationError {
        ModelValidationError { model: model.to_string(), errors }
    }
}

impl fmt::Display for ModelValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} validation failed:\n{}", self.model, self.errors.join("\n"))
    }
}

impl std::error::Error for ModelValidationError {}

/// The type a field must hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldType {
    String,
    NullableString,
    Number,
    NullableNumber,
    Boolean,
    /// NULL, an object or an array: any JSONB document that is not a scalar.
    NullableObject,
    NullableArray,
    /// A nullable string that may also be missing from the row.
    OptionalNullableString,
    /// A nullable array that may also be missing from the row.
    OptionalNullableArray,
}

impl FieldType {
    /// `value` is `None` for a field the row does not carry.
    fn accepts(self, value: Option<&Value>) -> bool {
        match (self, value) {
            (FieldType::OptionalNullableString | FieldType::OptionalNullableArray, None) => true,
            (_, None) => false,
            (FieldType::String, Some(value)) => value.is_string(),
            (FieldType::NullableString | FieldType::OptionalNullableString, Some(value)) => {
                value.is_null() || value.is_string()
            }
            (FieldType::Number, Some(value)) => value.is_number(),
            (FieldType::NullableNumber, Some(value)) => value.is_null() || value.is_number(),
            (FieldType::Boolean, Some(value)) => value.is_boolean(),
            (FieldType::NullableObject, Some(value)) => value.is_null() || value.is_object() || value.is_array(),
            (FieldType::NullableArray | FieldType::OptionalNullableArray, Some(value)) => {
                value.is_null() || value.is_array()
            }
        }
    }
}

/// `typeof value`, with `None` as `undefined`.
fn js_type_of(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null | Value::Object(_) | Value::Array(_)) => "object",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
    }
}

fn js_json(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "undefined".to_string()),
    }
}

fn check_fields(object: &Map<String, Value>, checker: &[(&str, FieldType)], skip: &[&str]) -> Vec<String> {
    checker
        .iter()
        .filter(|(key, _)| !skip.contains(key))
        .filter_map(|(key, field_type)| {
            let value = object.get(*key);
            (!field_type.accepts(value)).then(|| format!("{key}: {} ({})", js_json(value), js_type_of(value)))
        })
        .collect()
}

/// The fields of `input` that fail `checker`, one message each; empty when
/// the object is valid. Fields named in `skip` are not checked.
pub fn validate_object(input: &Value, checker: &[(&str, FieldType)], skip: &[&str]) -> Vec<String> {
    match input {
        Value::Object(object) => check_fields(object, checker, skip),
        // An array is an object with none of the named fields.
        Value::Array(_) => check_fields(&Map::new(), checker, skip),
        Value::Null => vec!["Input is not a valid object: null".to_string()],
        Value::String(text) => vec![format!("Input is not a valid object: {text}")],
        other => vec![format!("Input is not a valid object: {other}")],
    }
}

/// Checks a row against its model's field types.
pub fn validate_record(model: &str, record: &Record, checker: &[(&str, FieldType)]) -> Result<(), ModelValidationError> {
    let errors = check_fields(record, checker, &[]);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(ModelValidationError::new(model, errors))
    }
}

/// The object in `data`, or the validation error a value that is not one
/// produces. An array is an object with none of the named fields.
fn checked_object(model: &str, data: &Value, checker: &[(&str, FieldType)]) -> Result<Record, ModelValidationError> {
    match data {
        Value::Object(object) => Ok(object.clone()),
        Value::Array(_) => Ok(Map::new()),
        other => Err(ModelValidationError::new(model, validate_object(other, checker, &[]))),
    }
}

fn text(record: &Record, column: &str) -> String {
    opt_text(record, column).unwrap_or_default()
}

fn opt_text(record: &Record, column: &str) -> Option<String> {
    record.get(column).and_then(Value::as_str).map(str::to_string)
}

fn boolean(record: &Record, column: &str) -> bool {
    record.get(column).and_then(Value::as_bool).unwrap_or(false)
}

fn opt_integer(record: &Record, column: &str) -> Option<i64> {
    let value = record.get(column)?;
    value.as_i64().or_else(|| value.as_f64().map(|number| number as i64))
}

fn integer(record: &Record, column: &str) -> i64 {
    opt_integer(record, column).unwrap_or(0)
}

/// A JSONB column, `None` when NULL or missing.
fn opt_json(record: &Record, column: &str) -> Option<Value> {
    record.get(column).filter(|value| !value.is_null()).cloned()
}

/// The type every field of a `mails` row must hold. `updated` and
/// `search_vector` are part of the row though not of its JSON form.
pub const MAIL_TYPE_CHECKER: [(&str, FieldType); 41] = [
    ("mail_id", FieldType::String),
    ("user_id", FieldType::String),
    ("message_id", FieldType::String),
    ("subject", FieldType::String),
    ("date", FieldType::String),
    ("html", FieldType::String),
    ("text", FieldType::String),
    ("from_address", FieldType::NullableObject),
    ("from_text", FieldType::NullableString),
    ("to_address", FieldType::NullableObject),
    ("to_text", FieldType::NullableString),
    ("cc_address", FieldType::NullableObject),
    ("cc_text", FieldType::NullableString),
    ("bcc_address", FieldType::NullableObject),
    ("bcc_text", FieldType::NullableString),
    ("reply_to_address", FieldType::NullableObject),
    ("reply_to_text", FieldType::NullableString),
    ("envelope_from", FieldType::NullableObject),
    ("envelope_to", FieldType::NullableObject),
    ("attachments", FieldType::NullableObject),
    ("read", FieldType::Boolean),
    ("saved", FieldType::Boolean),
    ("sent", FieldType::Boolean),
    ("deleted", FieldType::Boolean),
    ("draft", FieldType::Boolean),
    ("answered", FieldType::Boolean),
    ("expunged", FieldType::Boolean),
    ("insight", FieldType::NullableObject),
    ("uid_domain", FieldType::Number),
    ("modseq", FieldType::Number),
    ("spam_score", FieldType::Number),
    ("spam_reasons", FieldType::NullableArray),
    ("is_spam", FieldType::Boolean),
    ("rfc822_size", FieldType::NullableNumber),
    ("text_line_count", FieldType::NullableNumber),
    ("html_line_count", FieldType::NullableNumber),
    // Optional as well as nullable: rows read with an explicit column list
    // that predates these columns, and models built in code, don't carry
    // them, and threading treats a missing value as "no headers".
    ("in_reply_to", FieldType::OptionalNullableString),
    ("reference_ids", FieldType::OptionalNullableArray),
    ("ingested", FieldType::OptionalNullableString),
    ("updated", FieldType::NullableString),
    ("search_vector", FieldType::NullableString),
];

/// A row of `mails`. JSONB columns are kept as the documents they store;
/// timestamps are ISO strings in milliseconds, as the pool returns them.
#[derive(Debug, Clone, PartialEq)]
pub struct MailModel {
    pub mail_id: String,
    pub user_id: String,
    pub message_id: String,
    pub subject: String,
    pub date: String,
    pub html: String,
    pub text: String,
    pub from_address: Option<Value>,
    pub from_text: Option<String>,
    pub to_address: Option<Value>,
    pub to_text: Option<String>,
    pub cc_address: Option<Value>,
    pub cc_text: Option<String>,
    pub bcc_address: Option<Value>,
    pub bcc_text: Option<String>,
    pub reply_to_address: Option<Value>,
    pub reply_to_text: Option<String>,
    pub envelope_from: Option<Value>,
    pub envelope_to: Option<Value>,
    pub attachments: Option<Value>,
    pub read: bool,
    pub saved: bool,
    pub sent: bool,
    pub deleted: bool,
    pub draft: bool,
    pub answered: bool,
    pub expunged: bool,
    pub insight: Option<Value>,
    pub uid_domain: i64,
    pub modseq: i64,
    pub spam_score: i64,
    pub spam_reasons: Option<Value>,
    pub is_spam: bool,
    /// NULL on rows stored before the column existed, until a FETCH derives it.
    pub rfc822_size: Option<i64>,
    pub text_line_count: Option<i64>,
    pub html_line_count: Option<i64>,
    pub in_reply_to: Option<String>,
    pub reference_ids: Option<Value>,
    pub updated: Option<String>,
    pub search_vector: Option<String>,
}

impl MailModel {
    /// A whole `mails` row as the pool returned it.
    pub fn from_row(row: &Row) -> Result<MailModel, ModelValidationError> {
        MailModel::from_record(row.as_map())
    }

    /// Any JSON value: only an object with every column of the right type
    /// becomes a model.
    pub fn from_value(data: &Value) -> Result<MailModel, ModelValidationError> {
        MailModel::from_record(&checked_object("MailModel", data, &MAIL_TYPE_CHECKER)?)
    }

    pub fn from_record(record: &Record) -> Result<MailModel, ModelValidationError> {
        validate_record("MailModel", record, &MAIL_TYPE_CHECKER)?;
        Ok(MailModel {
            mail_id: text(record, "mail_id"),
            user_id: text(record, "user_id"),
            message_id: text(record, "message_id"),
            subject: text(record, "subject"),
            date: text(record, "date"),
            html: text(record, "html"),
            text: text(record, "text"),
            from_address: opt_json(record, "from_address"),
            from_text: opt_text(record, "from_text"),
            to_address: opt_json(record, "to_address"),
            to_text: opt_text(record, "to_text"),
            cc_address: opt_json(record, "cc_address"),
            cc_text: opt_text(record, "cc_text"),
            bcc_address: opt_json(record, "bcc_address"),
            bcc_text: opt_text(record, "bcc_text"),
            reply_to_address: opt_json(record, "reply_to_address"),
            reply_to_text: opt_text(record, "reply_to_text"),
            envelope_from: opt_json(record, "envelope_from"),
            envelope_to: opt_json(record, "envelope_to"),
            attachments: opt_json(record, "attachments"),
            read: boolean(record, "read"),
            saved: boolean(record, "saved"),
            sent: boolean(record, "sent"),
            deleted: boolean(record, "deleted"),
            draft: boolean(record, "draft"),
            answered: boolean(record, "answered"),
            expunged: boolean(record, "expunged"),
            insight: opt_json(record, "insight"),
            uid_domain: integer(record, "uid_domain"),
            modseq: integer(record, "modseq"),
            spam_score: integer(record, "spam_score"),
            spam_reasons: opt_json(record, "spam_reasons"),
            is_spam: boolean(record, "is_spam"),
            rfc822_size: opt_integer(record, "rfc822_size"),
            text_line_count: opt_integer(record, "text_line_count"),
            html_line_count: opt_integer(record, "html_line_count"),
            in_reply_to: opt_text(record, "in_reply_to"),
            reference_ids: opt_json(record, "reference_ids"),
            updated: opt_text(record, "updated"),
            search_vector: opt_text(record, "search_vector"),
        })
    }

    /// The row's JSON form: every column but `updated` and `search_vector`,
    /// in declaration order.
    pub fn to_json(&self) -> Value {
        json!({
            "mail_id": self.mail_id,
            "user_id": self.user_id,
            "message_id": self.message_id,
            "subject": self.subject,
            "date": self.date,
            "html": self.html,
            "text": self.text,
            "from_address": self.from_address,
            "from_text": self.from_text,
            "to_address": self.to_address,
            "to_text": self.to_text,
            "cc_address": self.cc_address,
            "cc_text": self.cc_text,
            "bcc_address": self.bcc_address,
            "bcc_text": self.bcc_text,
            "reply_to_address": self.reply_to_address,
            "reply_to_text": self.reply_to_text,
            "envelope_from": self.envelope_from,
            "envelope_to": self.envelope_to,
            "attachments": self.attachments,
            "read": self.read,
            "saved": self.saved,
            "sent": self.sent,
            "deleted": self.deleted,
            "draft": self.draft,
            "answered": self.answered,
            "expunged": self.expunged,
            "insight": self.insight,
            "uid_domain": self.uid_domain,
            "modseq": self.modseq,
            "spam_score": self.spam_score,
            "spam_reasons": self.spam_reasons,
            "is_spam": self.is_spam,
            "rfc822_size": self.rfc822_size,
            "text_line_count": self.text_line_count,
            "html_line_count": self.html_line_count,
            "in_reply_to": self.in_reply_to,
            "reference_ids": self.reference_ids,
        })
    }
}

/// Fields a partial row may carry that are not columns of `mails`: a JOIN
/// alias or a function projection the repository adds.
///
/// - `uid_mailbox`: the per-mailbox UID from `mail_mailbox_uid.uid`, set when
///   a range read names a mapped mailbox.
/// - `text_octets` / `html_octets`: `octet_length()` of the body columns, so
///   a caller can size a `BODY[]` literal without loading the body.
pub const PARTIAL_SYNTHETIC_FIELDS: [(&str, FieldType); 3] = [
    ("uid_mailbox", FieldType::Number),
    ("text_octets", FieldType::Number),
    ("html_octets", FieldType::Number),
];

fn partial_field_type(field: &str) -> Option<FieldType> {
    MAIL_TYPE_CHECKER
        .iter()
        .chain(PARTIAL_SYNTHETIC_FIELDS.iter())
        .find(|(name, _)| *name == field)
        .map(|(_, field_type)| *field_type)
}

/// A subset of a mail row's fields, each validated like the whole row's.
/// Use it for a query that selects some columns, such as an IMAP FETCH.
///
/// An accessor answers `None` both for a field that was not selected and for
/// one that is NULL; [`PartialMailModel::get`] tells the two apart.
#[derive(Debug, Clone, PartialEq)]
pub struct PartialMailModel {
    selected_fields: HashSet<String>,
    values: Map<String, Value>,
}

macro_rules! partial_accessors {
    (text: $($text:ident),*; flag: $($flag:ident),*; number: $($number:ident),*; json: $($json:ident),*;) => {
        $(pub fn $text(&self) -> Option<&str> { self.values.get(stringify!($text)).and_then(Value::as_str) })*
        $(pub fn $flag(&self) -> Option<bool> { self.values.get(stringify!($flag)).and_then(Value::as_bool) })*
        $(pub fn $number(&self) -> Option<i64> {
            let value = self.values.get(stringify!($number))?;
            value.as_i64().or_else(|| value.as_f64().map(|number| number as i64))
        })*
        $(pub fn $json(&self) -> Option<&Value> {
            self.values.get(stringify!($json)).filter(|value| !value.is_null())
        })*
    };
}

impl PartialMailModel {
    /// Every field a partial row may select, in the order `*` expands to:
    /// the row's columns, then the synthetic fields.
    pub fn valid_fields() -> Vec<&'static str> {
        MAIL_TYPE_CHECKER.iter().chain(PARTIAL_SYNTHETIC_FIELDS.iter()).map(|(name, _)| *name).collect()
    }

    pub fn is_valid_field(field: &str) -> bool {
        partial_field_type(field).is_some()
    }

    fn refuse_unknown_fields<S: AsRef<str>>(fields: &[S]) -> Result<(), ModelValidationError> {
        let unknown: Vec<String> = fields
            .iter()
            .map(AsRef::as_ref)
            .filter(|field| !PartialMailModel::is_valid_field(field))
            .map(|field| format!("Unknown field: {field}"))
            .collect();
        if unknown.is_empty() {
            Ok(())
        } else {
            Err(ModelValidationError::new("PartialMailModel", unknown))
        }
    }

    /// Validates that every name in `fields` is a known field and that the
    /// row holds a value of the right type for each, then keeps those fields.
    pub fn new<S: AsRef<str>>(fields: &[S], data: &Record) -> Result<PartialMailModel, ModelValidationError> {
        PartialMailModel::refuse_unknown_fields(fields)?;

        // Each field is checked once, at the position it was first named.
        let mut checker: Vec<(&str, FieldType)> = Vec::new();
        for field in fields.iter().map(AsRef::as_ref) {
            if let (false, Some(field_type)) =
                (checker.iter().any(|(name, _)| *name == field), partial_field_type(field))
            {
                checker.push((field, field_type));
            }
        }
        validate_record("PartialMailModel", data, &checker)?;

        let mut values = Map::new();
        for (field, _) in &checker {
            if let Some(value) = data.get(*field) {
                values.insert((*field).to_string(), value.clone());
            }
        }
        Ok(PartialMailModel {
            selected_fields: checker.iter().map(|(field, _)| (*field).to_string()).collect(),
            values,
        })
    }

    /// The selected fields of a row as the pool returned it.
    pub fn from_row<S: AsRef<str>>(fields: &[S], row: &Row) -> Result<PartialMailModel, ModelValidationError> {
        PartialMailModel::new(fields, row.as_map())
    }

    /// Like [`PartialMailModel::new`], for any JSON value: only an object can
    /// be a row.
    pub fn from_value<S: AsRef<str>>(fields: &[S], data: &Value) -> Result<PartialMailModel, ModelValidationError> {
        match data {
            Value::Object(object) => PartialMailModel::new(fields, object),
            Value::Array(_) => PartialMailModel::new(fields, &Map::new()),
            other => {
                // Unknown names are reported before the row's shape is.
                PartialMailModel::refuse_unknown_fields(fields)?;
                Err(ModelValidationError::new("PartialMailModel", validate_object(other, &[], &[])))
            }
        }
    }

    pub fn selected_fields(&self) -> &HashSet<String> {
        &self.selected_fields
    }

    /// The field's value: `None` when it was not selected, `Value::Null`
    /// when it is NULL.
    pub fn get(&self, field: &str) -> Option<&Value> {
        self.values.get(field)
    }

    partial_accessors! {
        text: mail_id, user_id, message_id, subject, date, html, text, from_text, to_text, cc_text,
            bcc_text, reply_to_text, in_reply_to, updated, search_vector;
        flag: read, saved, sent, deleted, draft, answered, expunged, is_spam;
        number: uid_domain, uid_mailbox, text_octets, html_octets, modseq, spam_score, rfc822_size,
            text_line_count, html_line_count;
        json: from_address, to_address, cc_address, bcc_address, reply_to_address, envelope_from,
            envelope_to, attachments, insight, spam_reasons, reference_ids;
    }
}

const MAIL_UID_COUNTER_TYPE_CHECKER: [(&str, FieldType); 5] = [
    ("user_id", FieldType::String),
    ("uid_kind", FieldType::String),
    ("uid_scope", FieldType::String),
    ("sent", FieldType::Boolean),
    ("last_uid", FieldType::Number),
];

/// A row of `mail_uid_counters`. `uid_kind` separates the domain-wide
/// sequence (`domain`) from the per-account (`account`), per-mailbox
/// (`mailbox`) and mod-sequence (`modseq`) ones; `last_uid` is the most
/// recently assigned value.
#[derive(Debug, Clone, PartialEq)]
pub struct MailUidCounterModel {
    pub user_id: String,
    pub uid_kind: String,
    pub uid_scope: String,
    pub sent: bool,
    pub last_uid: i64,
}

impl MailUidCounterModel {
    pub fn from_row(row: &Row) -> Result<MailUidCounterModel, ModelValidationError> {
        MailUidCounterModel::from_record(row.as_map())
    }

    pub fn from_record(record: &Record) -> Result<MailUidCounterModel, ModelValidationError> {
        validate_record("MailUidCounterModel", record, &MAIL_UID_COUNTER_TYPE_CHECKER)?;
        Ok(MailUidCounterModel {
            user_id: text(record, "user_id"),
            uid_kind: text(record, "uid_kind"),
            uid_scope: text(record, "uid_scope"),
            sent: boolean(record, "sent"),
            last_uid: integer(record, "last_uid"),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "user_id": self.user_id,
            "uid_kind": self.uid_kind,
            "uid_scope": self.uid_scope,
            "sent": self.sent,
            "last_uid": self.last_uid,
        })
    }
}

const MAIL_MAILBOX_UID_TYPE_CHECKER: [(&str, FieldType); 4] = [
    ("user_id", FieldType::String),
    ("mailbox", FieldType::String),
    ("mail_id", FieldType::String),
    ("uid", FieldType::Number),
];

/// A row of `mail_mailbox_uid`: the UID one mail carries in one mailbox.
#[derive(Debug, Clone, PartialEq)]
pub struct MailMailboxUidModel {
    pub user_id: String,
    pub mailbox: String,
    pub mail_id: String,
    pub uid: i64,
}

impl MailMailboxUidModel {
    pub fn from_row(row: &Row) -> Result<MailMailboxUidModel, ModelValidationError> {
        MailMailboxUidModel::from_record(row.as_map())
    }

    pub fn from_record(record: &Record) -> Result<MailMailboxUidModel, ModelValidationError> {
        validate_record("MailMailboxUidModel", record, &MAIL_MAILBOX_UID_TYPE_CHECKER)?;
        Ok(MailMailboxUidModel {
            user_id: text(record, "user_id"),
            mailbox: text(record, "mailbox"),
            mail_id: text(record, "mail_id"),
            uid: integer(record, "uid"),
        })
    }

    pub fn to_json(&self) -> Value {
        json!({
            "user_id": self.user_id,
            "mailbox": self.mailbox,
            "mail_id": self.mail_id,
            "uid": self.uid,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail_data(overrides: Value) -> Value {
        let mut data = json!({
            "mail_id": "aaaaaaaa-0000-0000-0000-000000000001",
            "user_id": "bbbbbbbb-0000-0000-0000-000000000002",
            "message_id": "<test@example.com>",
            "subject": "Hello",
            "date": "2024-01-01T00:00:00+00:00",
            "html": "<p>hi</p>",
            "text": "hi",
            "from_address": { "address": "sender@example.com", "name": "Sender" },
            "from_text": "Sender <sender@example.com>",
            "to_address": null,
            "to_text": null,
            "cc_address": null,
            "cc_text": null,
            "bcc_address": null,
            "bcc_text": null,
            "reply_to_address": null,
            "reply_to_text": null,
            "envelope_from": null,
            "envelope_to": null,
            "attachments": null,
            "read": false,
            "saved": false,
            "sent": false,
            "deleted": false,
            "draft": false,
            "answered": false,
            "expunged": false,
            "insight": null,
            "uid_domain": 0,
            "modseq": 1,
            "spam_score": 0,
            "spam_reasons": null,
            "is_spam": false,
            "rfc822_size": null,
            "text_line_count": null,
            "html_line_count": null,
            "updated": "2024-01-01T00:00:00+00:00",
            "search_vector": null,
        });
        for (key, value) in overrides.as_object().expect("overrides is an object") {
            data[key] = value.clone();
        }
        data
    }

    fn mail(overrides: Value) -> Result<MailModel, ModelValidationError> {
        MailModel::from_value(&mail_data(overrides))
    }

    const CHECKER: [(&str, FieldType); 2] = [("name", FieldType::String), ("age", FieldType::Number)];

    // models.test.ts — "validateObject"

    #[test]
    fn validate_object_returns_nothing_for_a_valid_object() {
        assert!(validate_object(&json!({ "name": "Alice", "age": 30 }), &CHECKER, &[]).is_empty());
    }

    #[test]
    fn validate_object_reports_null_input() {
        let errors = validate_object(&Value::Null, &CHECKER, &[]);
        assert!(!errors.is_empty());
        assert!(errors[0].contains("not a valid object"));
    }

    #[test]
    fn validate_object_reports_string_input() {
        assert!(!validate_object(&json!("oops"), &CHECKER, &[]).is_empty());
    }

    #[test]
    fn validate_object_reports_each_failing_field() {
        let errors = validate_object(&json!({ "name": 42, "age": "old" }), &CHECKER, &[]);
        assert_eq!(errors.len(), 2);
        assert!(errors.iter().any(|error| error.starts_with("name:")));
        assert!(errors.iter().any(|error| error.starts_with("age:")));
    }

    #[test]
    fn validate_object_skips_fields_listed_in_skip() {
        let errors = validate_object(&json!({ "name": 42, "age": "wrong" }), &CHECKER, &["age"]);
        assert_eq!(errors.len(), 1);
        assert!(errors[0].starts_with("name:"));
    }

    #[test]
    fn validate_object_accepts_anything_with_an_empty_checker() {
        assert!(validate_object(&json!({ "anything": true }), &[], &[]).is_empty());
    }

    // models.test.ts — "ModelValidationError"

    #[test]
    fn validation_error_names_the_model_and_its_errors() {
        let error = ModelValidationError::new("FooModel", vec!["x: 1 (number)".to_string()]);
        assert!(error.to_string().contains("FooModel"));
        assert!(error.to_string().contains("x: 1 (number)"));
    }

    #[test]
    fn validation_error_exposes_its_errors() {
        let errors = vec!["a: null (object)".to_string(), "b: undefined (undefined)".to_string()];
        assert_eq!(ModelValidationError::new("M", errors.clone()).errors, errors);
    }

    #[test]
    fn validation_error_is_an_error() {
        let error: Box<dyn std::error::Error> = Box::new(ModelValidationError::new("M", vec![]));
        assert_eq!(error.to_string(), "M validation failed:\n");
    }

    // models.test.ts — "MailModel construction"

    #[test]
    fn mail_carries_the_threading_headers_and_accepts_rows_without_them() {
        let with_headers = mail(json!({ "in_reply_to": "<a@x>", "reference_ids": ["<a@x>"] })).unwrap();
        assert_eq!(with_headers.in_reply_to.as_deref(), Some("<a@x>"));
        assert_eq!(with_headers.to_json()["reference_ids"], json!(["<a@x>"]));

        let without = mail(json!({})).unwrap();
        assert_eq!(without.to_json()["in_reply_to"], Value::Null);
        assert_eq!(without.to_json()["reference_ids"], Value::Null);

        assert!(mail(json!({ "reference_ids": "<a@x>" })).is_err());
    }

    #[test]
    fn mail_constructs_from_valid_data_and_assigns_all_fields() {
        let data = mail_data(json!({}));
        let model = MailModel::from_value(&data).unwrap();
        assert_eq!(model.mail_id, data["mail_id"]);
        assert_eq!(model.user_id, data["user_id"]);
        assert_eq!(model.message_id, data["message_id"]);
        assert_eq!(model.subject, data["subject"]);
        assert!(!model.read);
        assert_eq!(model.spam_score, 0);
        assert!(!model.is_spam);
        assert_eq!(model.from_address, Some(json!({ "address": "sender@example.com", "name": "Sender" })));
        assert_eq!(model.from_text.as_deref(), Some("Sender <sender@example.com>"));
        assert_eq!(model.to_address, None);
    }

    #[test]
    fn mail_refuses_a_missing_required_string_field() {
        assert!(mail(json!({ "mail_id": 999 })).is_err());
    }

    #[test]
    fn mail_refuses_input_that_is_not_an_object() {
        assert!(MailModel::from_value(&Value::Null).is_err());
        assert!(MailModel::from_value(&json!("bad")).is_err());
    }

    #[test]
    fn mail_refuses_a_boolean_field_of_the_wrong_type() {
        assert!(mail(json!({ "read": "true" })).is_err());
    }

    #[test]
    fn mail_refuses_a_number_field_of_the_wrong_type() {
        assert!(mail(json!({ "uid_domain": "0" })).is_err());
    }

    #[test]
    fn mail_accepts_null_for_nullable_fields() {
        let model = mail(json!({ "insight": null, "from_address": null, "spam_reasons": null })).unwrap();
        assert_eq!(model.insight, None);
        assert_eq!(model.from_address, None);
        assert_eq!(model.spam_reasons, None);
    }

    #[test]
    fn mail_accepts_arrays_for_spam_reasons() {
        let model = mail(json!({ "spam_reasons": ["SPAM_WORD", "BLACKLIST"] })).unwrap();
        assert_eq!(model.spam_reasons, Some(json!(["SPAM_WORD", "BLACKLIST"])));
    }

    #[test]
    fn mail_accepts_numeric_line_counts() {
        let model = mail(json!({ "text_line_count": 12, "html_line_count": 34 })).unwrap();
        assert_eq!(model.text_line_count, Some(12));
        assert_eq!(model.html_line_count, Some(34));
        assert_eq!(model.to_json()["text_line_count"], json!(12));
        assert_eq!(model.to_json()["html_line_count"], json!(34));
    }

    #[test]
    fn mail_accepts_null_line_counts() {
        let model = mail(json!({ "text_line_count": null, "html_line_count": null })).unwrap();
        assert_eq!(model.text_line_count, None);
        assert_eq!(model.html_line_count, None);
    }

    #[test]
    fn mail_refuses_a_line_count_that_is_neither_number_nor_null() {
        assert!(mail(json!({ "text_line_count": "12" })).is_err());
    }

    // models.test.ts — "MailModel.toJSON"

    #[test]
    fn mail_json_returns_all_expected_fields() {
        let model = mail(json!({})).unwrap();
        let json = model.to_json();
        assert_eq!(json["mail_id"], json!(model.mail_id));
        assert_eq!(json["user_id"], json!(model.user_id));
        assert_eq!(json["subject"], json!(model.subject));
        assert_eq!(json["read"], json!(false));
        assert_eq!(json["is_spam"], json!(false));
    }

    #[test]
    fn mail_json_leaves_out_updated() {
        assert!(mail(json!({})).unwrap().to_json().get("updated").is_none());
    }

    #[test]
    fn mail_json_leaves_out_search_vector() {
        assert!(mail(json!({})).unwrap().to_json().get("search_vector").is_none());
    }

    // models.test.ts — "PartialMailModel"

    fn partial(fields: &[&str], data: Value) -> Result<PartialMailModel, ModelValidationError> {
        PartialMailModel::from_value(fields, &data)
    }

    #[test]
    fn partial_constructs_with_a_subset_of_valid_fields() {
        let data = json!({ "mail_id": "aaaaaaaa-0000-0000-0000-000000000001", "subject": "Hey", "read": true });
        let model = partial(&["mail_id", "subject", "read"], data).unwrap();
        assert_eq!(model.mail_id(), Some("aaaaaaaa-0000-0000-0000-000000000001"));
        assert_eq!(model.subject(), Some("Hey"));
        assert_eq!(model.read(), Some(true));
    }

    #[test]
    fn partial_leaves_unselected_fields_unset() {
        let model = partial(&["mail_id"], json!({ "mail_id": "aaaaaaaa-0000-0000-0000-000000000001" })).unwrap();
        assert!(model.mail_id().is_some());
        assert_eq!(model.subject(), None);
        assert_eq!(model.read(), None);
    }

    #[test]
    fn partial_refuses_unknown_field_names() {
        assert!(partial(&["nonexistent_field"], json!({ "nonexistent_field": "x" })).is_err());
    }

    #[test]
    fn partial_refuses_a_type_mismatch_on_a_selected_field() {
        assert!(partial(&["read"], json!({ "read": "yes" })).is_err());
    }

    #[test]
    fn partial_exposes_the_selected_fields() {
        let data = json!({ "mail_id": "aaaaaaaa-0000-0000-0000-000000000001", "read": false });
        let model = partial(&["mail_id", "read"], data).unwrap();
        assert!(model.selected_fields().contains("mail_id"));
        assert!(model.selected_fields().contains("read"));
        assert!(!model.selected_fields().contains("subject"));
    }

    #[test]
    fn partial_accepts_an_empty_field_list_with_empty_data() {
        assert!(partial(&[], json!({})).unwrap().selected_fields().is_empty());
    }

    #[test]
    fn partial_valid_fields_include_every_mail_checker_key() {
        let valid = PartialMailModel::valid_fields();
        for (key, _) in MAIL_TYPE_CHECKER {
            assert!(valid.contains(&key), "{key}");
        }
    }

    #[test]
    fn partial_accepts_a_nullable_object_field_as_null() {
        let model = partial(&["from_address"], json!({ "from_address": null })).unwrap();
        assert_eq!(model.from_address(), None);
        assert_eq!(model.get("from_address"), Some(&Value::Null));
    }

    #[test]
    fn partial_error_message_lists_the_unknown_field_name() {
        let error = partial(&["totally_fake_col"], json!({})).unwrap_err();
        assert!(error.to_string().contains("totally_fake_col"));
    }

    #[test]
    fn partial_accepts_the_octet_length_synthetic_fields_as_numbers() {
        let data = json!({
            "mail_id": "aaaaaaaa-0000-0000-0000-000000000001",
            "text_octets": 12345,
            "html_octets": 67890,
        });
        let model = partial(&["mail_id", "text_octets", "html_octets"], data).unwrap();
        assert_eq!(model.text_octets(), Some(12345));
        assert_eq!(model.html_octets(), Some(67890));
    }

    #[test]
    fn partial_refuses_octet_lengths_that_are_not_numbers() {
        assert!(partial(&["text_octets"], json!({ "text_octets": "12345" })).is_err());
        assert!(partial(&["html_octets"], json!({ "html_octets": null })).is_err());
    }

    // models.test.ts — "Model base class"

    #[test]
    fn a_bad_row_is_a_validation_error() {
        let error = MailModel::from_value(&json!({ "mail_id": 1 })).unwrap_err();
        assert_eq!(error.model, "MailModel");
        assert!(error.errors.contains(&"mail_id: 1 (number)".to_string()));
    }

    #[test]
    fn a_bad_field_produces_no_model() {
        assert!(matches!(mail(json!({ "mail_id": 99 })), Err(ModelValidationError { .. })));
    }

    #[test]
    fn a_record_and_its_json_value_build_the_same_model() {
        let data = mail_data(json!({}));
        let record = data.as_object().unwrap();
        assert_eq!(MailModel::from_record(record).unwrap(), MailModel::from_value(&data).unwrap());
    }
}
