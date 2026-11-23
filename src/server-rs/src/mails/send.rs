//! Sending a mail and recording it in Sent (mails/send.ts).

use serde_json::{json, Map, Value};

use super::mailgun::{send_mailgun_mail, MailgunApiError, MailgunResponse};
use super::receive::{save_buffer, save_mail, Attachment, AttachmentContent, Mail, MailAddress, MailAddressValue, MailUid};
use super::threading::{bare_message_id, stored_id_forms};
use super::util::get_text;
use super::validation::{validate_mail_data, MailValidationError};
use crate::alarm::spawn_alarm;
use crate::domains::{default_domain, is_in_served_zone, owned_domain_names};
use crate::http::upload::UploadedFile;
use crate::mime::header::MAX_REFERENCE_IDS;
use crate::models::SignedUser;
use crate::postgres::repositories::mails::thread::get_reference_ids_by_message_id;
use crate::postgres::repositories::mails::{get_account_uid_next, get_domain_uid_next};
use crate::users::AuthenticationMail;
use crate::util::get_domain;
use crate::{js, logger};

/// What the client asked to send. Each field keeps the JSON value it
/// arrived as, since what the Bun server does with a value of the wrong type
/// is part of the behaviour; the shared model's defaults are applied.
#[derive(Debug, Clone, PartialEq)]
pub struct MailDataToSend {
    /// The local part of the From address; `""` when falsy.
    pub sender: Value,
    /// The domain of that address: one the sender owns. Absent, the sender's
    /// default domain. `send_mail` settles it to a string.
    pub sender_domain: Option<Value>,
    /// The From display name; `""` when falsy.
    pub sender_full_name: Value,
    /// `""` when falsy.
    pub to: Value,
    /// `None` when absent.
    pub cc: Option<Value>,
    pub bcc: Option<Value>,
    /// `"No Subject"` when falsy.
    pub subject: Value,
    /// `""` when falsy.
    pub html: Value,
    pub in_reply_to: Option<Value>,
    /// Message-IDs of the conversation, oldest first, for `References`.
    pub references: Option<Vec<String>>,
}

fn or_default(value: Option<&Value>, default: &str) -> Value {
    match value {
        Some(value) if js::is_truthy(value) => value.clone(),
        _ => Value::String(default.to_string()),
    }
}

impl MailDataToSend {
    /// The fields of a request body. `references` is never read: the server
    /// works them out from the stored conversation.
    pub fn from_json(fields: &Map<String, Value>) -> MailDataToSend {
        MailDataToSend {
            sender: or_default(fields.get("sender"), ""),
            sender_domain: fields.get("senderDomain").cloned(),
            sender_full_name: or_default(fields.get("senderFullName"), ""),
            to: or_default(fields.get("to"), ""),
            cc: fields.get("cc").cloned(),
            bcc: fields.get("bcc").cloned(),
            subject: or_default(fields.get("subject"), "No Subject"),
            html: or_default(fields.get("html"), ""),
            in_reply_to: fields.get("inReplyTo").cloned(),
            references: None,
        }
    }

    pub fn to_list(&self) -> Option<&str> {
        self.to.as_str()
    }

    pub fn cc_list(&self) -> Option<&str> {
        self.cc.as_ref().and_then(Value::as_str)
    }

    pub fn bcc_list(&self) -> Option<&str> {
        self.bcc.as_ref().and_then(Value::as_str)
    }

    /// The In-Reply-To to send and store: a non-empty string, else nothing.
    pub fn in_reply_to_text(&self) -> Option<String> {
        match &self.in_reply_to {
            Some(Value::String(id)) if !id.is_empty() => Some(id.clone()),
            _ => None,
        }
    }
}

impl From<AuthenticationMail> for MailDataToSend {
    fn from(mail: AuthenticationMail) -> MailDataToSend {
        let mut fields = Map::new();
        fields.insert("senderFullName".into(), json!(mail.sender_full_name));
        fields.insert("sender".into(), json!(mail.sender));
        fields.insert("to".into(), json!(mail.to));
        fields.insert("subject".into(), json!(mail.subject));
        fields.insert("html".into(), json!(mail.html));
        MailDataToSend::from_json(&fields)
    }
}

/// `String(value)` as JavaScript writes it.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(_) => js::json_number_to_string(value).unwrap_or_default(),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// The text a value of the `html` field is stored and sent as, the way the
/// PostgreSQL driver of the Bun server writes it: a list as an array literal,
/// an object as JSON.
pub fn pg_text(value: &Value) -> String {
    fn element(value: &Value) -> String {
        match value {
            Value::Null => "NULL".to_string(),
            Value::Array(items) => format!("{{{}}}", items.iter().map(element).collect::<Vec<_>>().join(",")),
            other => {
                let text = match other {
                    Value::Object(_) => js::json_stringify(other),
                    _ => js_string(other),
                };
                format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
            }
        }
    }
    match value {
        Value::Array(_) => element(value),
        Value::Object(_) => js::json_stringify(value),
        other => js_string(other),
    }
}

/// The plain text of an `html` field. A non-empty list breaks the HTML
/// reader, as it does in the Bun server; any other non-string reads as empty.
pub fn text_of_html(html: &Value) -> anyhow::Result<String> {
    match html {
        Value::String(html) => Ok(get_text(html)),
        Value::Array(items) if !items.is_empty() => Err(anyhow::anyhow!(
            "html.substring is not a function. (In 'html.substring(sectionStart, i)', 'html.substring' is undefined)"
        )),
        _ => Ok(get_text("")),
    }
}

/// A send that failed after validation; the message is shown to the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MailSendingError(pub String);

impl std::fmt::Display for MailSendingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MailSendingError {}

/// Why [`send_mail`] did not send.
#[derive(Debug)]
pub enum SendMailError {
    /// Refused before anything went out (answered as a `failed` body).
    Validation(MailValidationError),
    /// Mailgun refused or could not be reached (answered as a `failed` body).
    Sending(MailSendingError),
    /// Anything else: a 500.
    Internal(anyhow::Error),
}

impl std::fmt::Display for SendMailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendMailError::Validation(error) => error.fmt(f),
            SendMailError::Sending(error) => error.fmt(f),
            SendMailError::Internal(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for SendMailError {}

/// Options of [`send_mail`].
#[derive(Debug, Clone, Copy)]
pub struct SendMailOptions {
    /// Whether the mail is also written to the sender's Sent mailbox. Off for
    /// transactional mail whose body carries a live credential.
    pub persist_to_sent_mailbox: bool,
}

impl Default for SendMailOptions {
    fn default() -> SendMailOptions {
        SendMailOptions { persist_to_sent_mailbox: true }
    }
}

/// Logs and alarms a failed send, and words it for the person who sent it.
///
/// Mailgun answers 404 for a sending domain it doesn't have. Any user can
/// verify a domain outside the served zone and send from it before the
/// operator has added it to Mailgun, so that refusal is the sender's to act
/// on: it is logged at warn and never alarms. A 404 for the zone or a name
/// under it (every account's own domain, and every system mail) means the
/// operator's own Mailgun setup is broken, so it alarms like any other fault.
fn sending_failure(error: &anyhow::Error, domain: &str) -> MailSendingError {
    let status = error.downcast_ref::<MailgunApiError>().map(|api| api.status);
    if status == Some(404) && !is_in_served_zone(domain) {
        logger::warn_with("Mailgun has no sending domain for this send", json!({ "domain": domain }), error);
        return MailSendingError(format!(
            "This server can't send from {domain} yet. Ask its operator to add the domain to Mailgun."
        ));
    }
    logger::error_with("Email sending request failed", json!({}), error);
    spawn_alarm("Mail Send Failed", format!("**Error:** {error}"));
    MailSendingError(sending_message(error))
}

/// Sends mail from this server itself rather than from a user: the sign-up
/// and password-reset links. It goes out from `<sender>@<EMAIL_DOMAIN>` and is
/// stored nowhere, so the link it carries is readable only by its recipient.
/// Any failure is an error (the route's 500).
pub async fn send_system_mail(mail: AuthenticationMail) -> anyhow::Result<()> {
    let mut mail = MailDataToSend::from(mail);
    validate_mail_data(&mail).map_err(anyhow::Error::new)?;
    let domain = get_domain();
    mail.sender_domain = Some(Value::String(domain.clone()));
    match send_mailgun_mail(&domain, &mail, &[]).await {
        Ok(_) => Ok(()),
        Err(error) => Err(anyhow::Error::new(sending_failure(&error, &domain))),
    }
}

/// The message the user sees for a failed delivery.
fn sending_message(error: &anyhow::Error) -> String {
    let generic = "Failed to send email. Please try again.".to_string();
    let Some(api) = error.downcast_ref::<MailgunApiError>() else {
        return generic;
    };
    match api.status {
        401 | 403 => "Email service not configured correctly".to_string(),
        400 if api.message.is_empty() => "Invalid email request".to_string(),
        400 => api.message.clone(),
        429 => "Too many requests. Please try again later.".to_string(),
        _ if api.details == "socket hang up" && !api.message.is_empty() => api.message.clone(),
        _ => generic,
    }
}

/// The domain a send names: `senderDomain` trimmed and lower-cased, `None`
/// when it is absent or empty. A value of another type fails as the Bun
/// server's `.trim()` does.
fn named_sender_domain(mail: &MailDataToSend) -> Result<Option<String>, SendMailError> {
    match &mail.sender_domain {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(domain)) => Ok(Some(js::trim(domain).to_lowercase()).filter(|domain| !domain.is_empty())),
        Some(_) => Err(SendMailError::Internal(anyhow::anyhow!("mailToSend.senderDomain?.trim is not a function"))),
    }
}

/// Sends `mail` from `user` through Mailgun and, unless told otherwise,
/// stores the sender's copy in Sent. A failure to store the copy is logged
/// and alarmed, never reported: the recipients already have the mail.
pub async fn send_mail(
    user: &SignedUser,
    mut mail: MailDataToSend,
    files: &[UploadedFile],
    options: SendMailOptions,
) -> Result<Option<MailgunResponse>, SendMailError> {
    validate_mail_data(&mail).map_err(SendMailError::Validation)?;

    // A user sends only from a domain they own: a viewer reads a domain and
    // never sends as it, and nobody sends as a domain they hold no role on.
    let owned = owned_domain_names(&user.id).await.map_err(|error| SendMailError::Internal(error.into()))?;
    let domain = match named_sender_domain(&mail)? {
        Some(domain) => Some(domain),
        None => default_domain(&owned, &user.username),
    };
    let domain = match domain {
        Some(domain) if owned.contains(&domain) => domain,
        Some(domain) => {
            return Err(SendMailError::Validation(MailValidationError(format!("You can't send from {domain}."))))
        }
        None => {
            return Err(SendMailError::Validation(MailValidationError("You have no domain to send from.".into())))
        }
    };
    mail.sender_domain = Some(Value::String(domain.clone()));

    if let Some(in_reply_to) = mail.in_reply_to.clone().filter(js::is_truthy) {
        // Mail appended over IMAP stores its Message-ID without brackets, and
        // a bare id isn't a valid msg-id in a header.
        let Value::String(in_reply_to) = in_reply_to else {
            return Err(SendMailError::Internal(anyhow::anyhow!("inReplyTo.trim is not a function")));
        };
        let bracketed = bracketed_message_id(&in_reply_to);
        mail.references = match mail.references.take().filter(|ids| !ids.is_empty()) {
            Some(ids) => Some(ids.iter().map(|id| bracketed_message_id(id)).collect()),
            None => Some(thread_references(&user.id, &bracketed).await),
        };
        mail.in_reply_to = Some(Value::String(bracketed));
    }

    let response = match send_mailgun_mail(&domain, &mail, files).await {
        Ok(response) => response,
        Err(error) => return Err(SendMailError::Sending(sending_failure(&error, &domain))),
    };
    if !options.persist_to_sent_mailbox {
        return Ok(response);
    }

    let mailgun_id = response.as_ref().and_then(|response| response.id.clone()).filter(js::is_truthy);
    let provider_id = mailgun_id.as_ref().map(js_string);
    let mailgun_id_json = mailgun_id.clone().unwrap_or(Value::Null);
    let sent_mail = match get_sent_mail(user, &mail, provider_id.as_deref(), files).await {
        Ok(sent_mail) => sent_mail,
        Err(error) => {
            logger::error_with(
                "Mailgun accepted the send but building the local Sent record failed",
                json!({ "mailgunMessageId": mailgun_id_json }),
                &error,
            );
            let shown = mailgun_id.as_ref().map(js_string).unwrap_or_else(|| "unknown".to_string());
            spawn_alarm("Mail Send Save Failed", format!("**Error:** {error}\n**Mailgun message-id:** {shown}"));
            return Ok(response);
        }
    };
    if let Err(error) = save_mail(&sent_mail, Some(&user.id), None).await {
        // save_mail already alarmed and dumped the mail.
        logger::error_with(
            "Mailgun accepted the send but local Sent-record save failed — recipient got the mail, per-mailbox mapping missing",
            json!({ "mailgunMessageId": mailgun_id_json }),
            &error,
        );
    }
    Ok(response)
}

/// A comma-separated address list as stored: trimmed, empty items dropped,
/// each address lower-cased.
pub fn parse_address_list(list: &str) -> Vec<MailAddressValue> {
    list.split(',')
        .map(js::trim)
        .filter(|address| !address.is_empty())
        .map(|address| MailAddressValue::new(address.to_lowercase(), None))
        .collect()
}

/// A stored recipient header, or `None` for an empty list so the column
/// stays NULL.
pub fn address_field(list: Option<&str>) -> Option<MailAddress> {
    let list = list.filter(|list| !list.is_empty())?;
    Some(MailAddress { value: parse_address_list(list), text: list.to_string() })
}

/// Every address the submission was delivered to, across To, Cc and Bcc.
pub fn envelope_recipients(lists: &[Option<&str>]) -> Vec<MailAddressValue> {
    let joined: Vec<&str> = lists.iter().flatten().copied().filter(|list| !list.is_empty()).collect();
    parse_address_list(&joined.join(","))
}

/// A Message-ID in the `<id>` form headers require.
pub fn bracketed_message_id(id: &str) -> String {
    format!("<{}>", bare_message_id(id))
}

/// The Message-ID stored on the Sent copy. Mailgun's id already names a domain
/// and is the one recipients see, so it is kept as given; a bare token, or no
/// id at all, gets one minted on the user's domain.
pub fn sent_message_id(provider_id: Option<&str>, user_domain: &str) -> String {
    let bare = provider_id.map(bare_message_id).unwrap_or_default();
    if bare.contains('@') {
        return format!("<{bare}>");
    }
    if bare.is_empty() {
        return format!("<{}@{user_domain}>", uuid::Uuid::new_v4());
    }
    format!("<{bare}@{user_domain}>")
}

/// The `References` of a reply from the given earlier References: those ids
/// bracketed, without the answered id, then the answered id, the last 50.
pub fn build_references(earlier: &[String], answered: &str) -> Vec<String> {
    let answered = bracketed_message_id(answered);
    let mut ids: Vec<String> =
        earlier.iter().map(|id| bracketed_message_id(id)).filter(|id| *id != answered).collect();
    ids.push(answered);
    let skip = ids.len().saturating_sub(MAX_REFERENCE_IDS);
    ids.split_off(skip)
}

/// The `References` for a reply: the answered message's own References plus
/// its Message-ID, so the reply stays in the conversation. A failed lookup
/// still threads the reply under the message it answers.
pub async fn thread_references(user_id: &str, in_reply_to: &str) -> Vec<String> {
    let answered = bracketed_message_id(in_reply_to);
    let earlier = match get_reference_ids_by_message_id(user_id, &stored_id_forms([answered.as_str()])).await {
        Ok(ids) => ids.unwrap_or_default(),
        Err(error) => {
            logger::warn_with("Couldn't read the answered mail's References", json!({}), &error);
            Vec::new()
        }
    };
    build_references(&earlier, &answered)
}

async fn attachments_to_save(files: &[UploadedFile]) -> anyhow::Result<Vec<Attachment>> {
    let mut attachments = Vec::with_capacity(files.len());
    for file in files {
        let bytes = tokio::fs::read(&file.temp_file_path).await?;
        attachments.push(Attachment {
            content: AttachmentContent { data: save_buffer(&bytes).await? },
            filename: file.name.clone(),
            content_type: file.mimetype.clone(),
            size: file.size,
        });
    }
    Ok(attachments)
}

/// The sender's copy of a sent mail, under the Message-ID Mailgun gave it.
async fn get_sent_mail(
    user: &SignedUser,
    mail: &MailDataToSend,
    provider_id: Option<&str>,
    files: &[UploadedFile],
) -> anyhow::Result<Mail> {
    let text = text_of_html(&mail.html)?;
    // `send_mail` has already settled the domain to one the user owns.
    let user_domain = mail.sender_domain.as_ref().and_then(Value::as_str).unwrap_or_default().to_string();
    let from_email = format!("{}@{user_domain}", js_string(&mail.sender)).to_lowercase();
    let attachments = attachments_to_save(files).await?;
    let (domain_uid, account_uid) =
        tokio::join!(get_domain_uid_next(&user.id, true), get_account_uid_next(&user.id, &from_email, true));
    let uid = MailUid { domain: domain_uid?, account: account_uid? };

    let name = Some(mail.sender_full_name.clone()).filter(js::is_truthy);
    let sender = MailAddressValue::new(from_email.clone(), name.clone());
    let from_text = match &name {
        Some(name) => format!("{} <{from_email}>", js_string(name)),
        None => from_email.clone(),
    };
    Ok(Mail {
        subject: pg_text(&mail.subject),
        text,
        html: pg_text(&mail.html),
        date: js::now_iso(),
        attachments,
        message_id: sent_message_id(provider_id, &user_domain),
        from: Some(MailAddress { value: vec![sender.clone()], text: from_text }),
        to: address_field(mail.to_list()),
        cc: address_field(mail.cc_list()),
        bcc: address_field(mail.bcc_list()),
        envelope_from: Some(vec![sender.clone()]),
        envelope_to: envelope_recipients(&[mail.to_list(), mail.cc_list(), mail.bcc_list()]),
        reply_to: Some(MailAddress { value: vec![sender], text: from_email }),
        read: true,
        sent: true,
        saved: false,
        in_reply_to: mail.in_reply_to_text(),
        references: mail.references.clone(),
        uid,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_defaults_fill_falsy_fields() {
        let mail = MailDataToSend::from_json(json!({ "sender": 0, "to": null, "subject": "", "html": false }).as_object().unwrap());
        assert_eq!(mail.sender, json!(""));
        assert_eq!(mail.to, json!(""));
        assert_eq!(mail.subject, json!("No Subject"));
        assert_eq!(mail.html, json!(""));
        assert_eq!(mail.cc, None);
        let mail = MailDataToSend::from_json(json!({ "cc": null, "references": ["<x>"] }).as_object().unwrap());
        assert_eq!(mail.cc, Some(Value::Null));
        assert_eq!(mail.references, None);
    }

    #[test]
    fn values_coerce_to_strings_as_javascript_does() {
        assert_eq!(js_string(&json!(5)), "5");
        assert_eq!(js_string(&json!(1.5)), "1.5");
        assert_eq!(js_string(&json!(true)), "true");
        assert_eq!(js_string(&json!(["A", null, ["b", 1]])), "A,,b,1");
        assert_eq!(js_string(&json!({ "a": 1 })), "[object Object]");
        assert_eq!(pg_text(&json!(["a", "b\"c"])), r#"{"a","b\"c"}"#);
        assert_eq!(pg_text(&json!({ "a": 1 })), r#"{"a":1}"#);
        assert_eq!(pg_text(&json!(5)), "5");
    }

    #[test]
    fn only_a_non_empty_list_breaks_the_text_of_the_html() {
        assert!(text_of_html(&json!(["<p>x</p>"])).is_err());
        assert_eq!(text_of_html(&json!([])).unwrap(), get_text(""));
        assert_eq!(text_of_html(&json!(5)).unwrap(), get_text(""));
        assert_eq!(text_of_html(&json!("<p>Hello</p>")).unwrap(), get_text("<p>Hello</p>"));
    }

    #[test]
    fn stored_addresses_are_lower_cased_and_the_text_kept_as_typed() {
        let field = address_field(Some(" A@X.Example , ,b@y.example")).unwrap();
        assert_eq!(field.text, " A@X.Example , ,b@y.example");
        let values: Vec<Value> = field.value.iter().map(MailAddressValue::to_json).collect();
        assert_eq!(values, vec![json!({ "address": "a@x.example" }), json!({ "address": "b@y.example" })]);
        assert_eq!(address_field(Some("")), None);
        assert_eq!(address_field(None), None);
        // A list of only separators is kept as an empty list.
        assert_eq!(address_field(Some(" , ")).unwrap().value, vec![]);
        let envelope = envelope_recipients(&[Some("a@x"), None, Some(""), Some("B@y, c@z")]);
        let addresses: Vec<&str> = envelope.iter().map(|v| v.address.as_str()).collect();
        assert_eq!(addresses, vec!["a@x", "b@y", "c@z"]);
    }

    #[test]
    fn references_end_with_the_answered_id_once_and_keep_the_last_fifty() {
        assert_eq!(bracketed_message_id(" a@x "), "<a@x>");
        assert_eq!(bracketed_message_id("<a@x>"), "<a@x>");
        let earlier = vec!["root@x".to_string(), "<a@x>".to_string(), "<mid@x>".to_string()];
        assert_eq!(build_references(&earlier, "a@x"), vec!["<root@x>", "<mid@x>", "<a@x>"]);
        assert_eq!(build_references(&[], "<a@x>"), vec!["<a@x>"]);
        let long: Vec<String> = (0..60).map(|i| format!("id{i}@x")).collect();
        let built = build_references(&long, "last@x");
        assert_eq!(built.len(), 50);
        assert_eq!(built[0], "<id11@x>");
        assert_eq!(built[49], "<last@x>");
    }

    #[test]
    fn the_sent_copy_keeps_mailguns_id_and_mints_one_only_without_a_domain() {
        assert_eq!(sent_message_id(Some("<abc@mail.test>"), "u.mail.test"), "<abc@mail.test>");
        assert_eq!(sent_message_id(Some(" abc@mail.test "), "u.mail.test"), "<abc@mail.test>");
        assert_eq!(sent_message_id(Some("bare-id"), "u.mail.test"), "<bare-id@u.mail.test>");
        for missing in [None, Some(""), Some("  ")] {
            let minted = sent_message_id(missing, "u.mail.test");
            let token = minted.strip_prefix('<').and_then(|m| m.strip_suffix("@u.mail.test>")).unwrap();
            assert!(uuid::Uuid::parse_str(token).is_ok(), "{minted}");
        }
    }

    #[test]
    fn delivery_failures_are_worded_for_the_user() {
        let wording = |status: u16, message: &str| {
            sending_message(&anyhow::Error::new(MailgunApiError { status, message: message.into(), details: String::new() }))
        };
        assert_eq!(wording(401, "Unauthorized"), "Email service not configured correctly");
        assert_eq!(wording(403, "Forbidden"), "Email service not configured correctly");
        assert_eq!(wording(400, "custom"), "custom");
        assert_eq!(wording(400, "ECONNREFUSED"), "ECONNREFUSED");
        assert_eq!(wording(429, "x"), "Too many requests. Please try again later.");
        assert_eq!(wording(500, "x"), "Failed to send email. Please try again.");
        assert_eq!(sending_message(&anyhow::anyhow!("other")), "Failed to send email. Please try again.");
    }

    #[test]
    fn the_authentication_mail_is_sent_as_its_fields() {
        let mail = MailDataToSend::from(AuthenticationMail {
            sender_full_name: "Administrator".into(),
            sender: "admin".into(),
            to: "x@y.example".into(),
            subject: "S".into(),
            html: "<p>h</p>".into(),
        });
        assert_eq!(mail.sender, json!("admin"));
        assert_eq!(mail.to_list(), Some("x@y.example"));
        assert_eq!(mail.cc, None);
        assert_eq!(mail.in_reply_to, None);
    }
}
