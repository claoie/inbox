//! Multipart uploads, streamed to temp files so no upload is held in memory.

use std::sync::OnceLock;

use bytes::{Buf, Bytes, BytesMut};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use regex::Regex;
use serde_json::{json, Map, Value};
use tokio::io::AsyncWriteExt;

use super::request::{discard_rest, HttpError, HttpRequest, RawBody};
use super::respond::{json, Response};
use crate::{js, logger};

const MAX_FILE_SIZE: u64 = 25 * 1024 * 1024;

pub const MAX_ATTACHMENTS_PER_MAIL: usize = 20;

// Parsing one more than the mail cap is what lets the route answer "too many
// attachments" instead of dropping the surplus without telling the sender.
const MAX_PARSED_FILES: usize = MAX_ATTACHMENTS_PER_MAIL + 1;

/// Matches the send validator's ceiling on the mail body, the largest field a form carries.
const MAX_FIELD_BYTES: usize = 10 * 1024 * 1024;

/// The largest request body the server reads.
pub const MAX_REQUEST_BODY_SIZE: u64 = MAX_PARSED_FILES as u64 * MAX_FILE_SIZE + 64 * 1024 * 1024;
const MAX_HEADER_LINE_BYTES: usize = 16 * 1024;
const MAX_PART_HEADERS: usize = 64;

const TEMP_DIR: &str = "/tmp/";

/// One uploaded file, written to a temp file as it arrived.
#[derive(Debug, Clone, PartialEq)]
pub struct UploadedFile {
    /// The client's file name, without any directory part.
    pub name: String,
    pub mimetype: String,
    pub size: u64,
    pub temp_file_path: String,
}

/// File parts by field name, in arrival order.
#[derive(Debug, Clone, Default)]
pub struct UploadedFiles(Vec<(String, Vec<UploadedFile>)>);

impl UploadedFiles {
    /// Every file sent under `field`; empty when there was none.
    pub fn get(&self, field: &str) -> &[UploadedFile] {
        self.0
            .iter()
            .find(|(name, _)| name == field)
            .map(|(_, files)| files.as_slice())
            .unwrap_or(&[])
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    fn add(&mut self, field: &str, file: UploadedFile) {
        if is_unsafe_key(field) {
            return;
        }
        match self.0.iter_mut().find(|(name, _)| name == field) {
            Some((_, files)) => files.push(file),
            None => self.0.push((field.to_string(), vec![file])),
        }
    }
}

fn is_unsafe_key(name: &str) -> bool {
    matches!(name, "__proto__" | "constructor" | "prototype")
}

/// A repeated name collects its values into an array.
fn add_field(target: &mut Map<String, Value>, name: &str, value: Value) {
    if is_unsafe_key(name) {
        return;
    }
    match target.get_mut(name) {
        None => {
            target.insert(name.to_string(), value);
        }
        Some(Value::Array(existing)) => existing.push(value),
        Some(existing) => {
            let first = existing.take();
            *existing = Value::Array(vec![first, value]);
        }
    }
}

fn is_bodyless(method: &str) -> bool {
    matches!(method, "GET" | "HEAD" | "DELETE" | "OPTIONS" | "CONNECT" | "TRACE")
}

fn boundary_of(content_type: Option<&str>) -> Option<String> {
    static MULTIPART: OnceLock<Regex> = OnceLock::new();
    static BOUNDARY: OnceLock<Regex> = OnceLock::new();
    let content_type = content_type?;
    // The class is `[\w'"()+-_?/:=,.]` with its `+-_` range spelled out.
    let multipart = MULTIPART.get_or_init(|| {
        Regex::new(r#"(?i-u)^multipart/[A-Za-z0-9_'"()\x2B-\x5F?/:=,.]+(?:; ?[A-Za-z0-9_'"()\x2B-\x5F?/:=,.]*)+$"#)
            .expect("a valid pattern")
    });
    if !content_type.contains("boundary=") || !multipart.is_match(content_type) {
        return None;
    }
    let boundary = BOUNDARY.get_or_init(|| {
        Regex::new(r#"(?i);[\t\n\x0B\x0C\r \u{a0}\u{feff}]*boundary=(?:"([^"]+)"|([^;\t\n\x0B\x0C\r \u{a0}\u{feff}]+))"#)
            .expect("a valid pattern")
    });
    let captures = boundary.captures(content_type)?;
    captures.get(1).or_else(|| captures.get(2)).map(|m| m.as_str().to_string())
}

fn unquote(value: &str) -> String {
    if value.len() > 1 && value.starts_with('"') && value.ends_with('"') {
        let inner = &value[1..value.len() - 1];
        let mut out = String::with_capacity(inner.len());
        let mut chars = inner.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                // `\x` → `x`; a trailing backslash, or one before a line break, stays.
                match chars.next() {
                    Some(next) if next != '\n' && next != '\r' && next != '\u{2028}' && next != '\u{2029}' => out.push(next),
                    Some(next) => {
                        out.push('\\');
                        out.push(next);
                    }
                    None => out.push('\\'),
                }
            } else {
                out.push(c);
            }
        }
        out
    } else {
        value.to_string()
    }
}

/// `form-data; name="a"; filename="b"` → `[("name", "a"), ("filename", "b")]`.
fn disposition_params(header: &str) -> Vec<(String, String)> {
    static PARAM: OnceLock<Regex> = OnceLock::new();
    let pattern = PARAM.get_or_init(|| {
        Regex::new(r#";\s*([^\s=;]+)\s*=\s*("(?:\\.|[^"\\])*"|[^;]*)"#).expect("a valid pattern")
    });
    let mut params: Vec<(String, String)> = Vec::new();
    let set = |params: &mut Vec<(String, String)>, key: String, value: String| {
        match params.iter_mut().find(|(existing, _)| *existing == key) {
            Some(slot) => slot.1 = value,
            None => params.push((key, value)),
        }
    };
    for captures in pattern.captures_iter(header) {
        let key = captures[1].to_lowercase();
        let value = unquote(js::trim(&captures[2]));
        set(&mut params, key, value);
    }
    let extended = params.iter().find(|(key, _)| key == "filename*").map(|(_, value)| value.clone());
    if let Some(extended) = extended.filter(|value| !value.is_empty()) {
        // charset'language'value
        if let Some(first) = extended.find('\'') {
            if let Some(second) = extended[first + 1..].find('\'') {
                let encoded = &extended[first + 1 + second + 1..];
                if let Some(decoded) = js::decode_uri_component(encoded) {
                    set(&mut params, "filename".to_string(), decoded);
                }
            }
        }
    }
    params
}

/// Strips any directory part a client sent with the file name.
fn base_name(name: &str) -> &str {
    let cut = name.rfind(['/', '\\']);
    let base = match cut {
        Some(at) => &name[at + 1..],
        None => name,
    };
    if base == "." || base == ".." {
        ""
    } else {
        base
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

/// Pulls bytes from a body stream on demand, holding only what a search needs.
struct StreamCursor {
    body: Incoming,
    buffer: BytesMut,
    ended: bool,
    /// Body octets taken in so far, held to [`MAX_REQUEST_BODY_SIZE`] as the
    /// Bun server's `maxRequestBodySize` holds every body.
    received: u64,
}

fn unexpected_end() -> HttpError {
    HttpError::new(400, "Unexpected end of form")
}

impl StreamCursor {
    async fn fill(&mut self) -> Result<(), HttpError> {
        if self.ended {
            return Err(unexpected_end());
        }
        loop {
            match self.body.frame().await {
                None => {
                    self.ended = true;
                    return Err(unexpected_end());
                }
                Some(Err(_)) => {
                    self.ended = true;
                    return Err(unexpected_end());
                }
                Some(Ok(frame)) => {
                    if let Ok(data) = frame.into_data() {
                        self.received += data.len() as u64;
                        if self.received > MAX_REQUEST_BODY_SIZE {
                            self.ended = true;
                            discard_rest(&mut self.body).await;
                            return Err(HttpError::new(413, "request entity too large"));
                        }
                        self.buffer.extend_from_slice(&data);
                        return Ok(());
                    }
                }
            }
        }
    }

    async fn peek(&mut self, length: usize) -> Result<&[u8], HttpError> {
        while self.buffer.len() < length {
            self.fill().await?;
        }
        Ok(&self.buffer[..length])
    }

    /// The next run of bytes before `delimiter`, or `None` once the delimiter
    /// itself has been consumed. Only a delimiter's length is ever held back.
    async fn next_until(&mut self, delimiter: &[u8]) -> Result<Option<Bytes>, HttpError> {
        loop {
            if let Some(at) = find(&self.buffer, delimiter) {
                if at > 0 {
                    return Ok(Some(self.buffer.split_to(at).freeze()));
                }
                self.buffer.advance(delimiter.len());
                return Ok(None);
            }
            let held_back = delimiter.len() - 1;
            if self.buffer.len() > held_back {
                let flushable = self.buffer.len() - held_back;
                return Ok(Some(self.buffer.split_to(flushable).freeze()));
            }
            self.fill().await?;
        }
    }

    async fn skip_until(&mut self, delimiter: &[u8]) -> Result<(), HttpError> {
        while self.next_until(delimiter).await?.is_some() {}
        Ok(())
    }

    /// Reads one CRLF-terminated line of at most `limit` bytes.
    async fn read_line(&mut self, limit: usize) -> Result<String, HttpError> {
        let mut line = Vec::new();
        while let Some(chunk) = self.next_until(b"\r\n").await? {
            line.extend_from_slice(&chunk);
            if line.len() > limit {
                return Err(HttpError::new(400, "Malformed part header"));
            }
        }
        Ok(String::from_utf8_lossy(&line).into_owned())
    }
}

enum FormError {
    Http(HttpError),
    /// A part broke a size limit; the message is what the sender is told.
    PartTooLarge(String),
    Io(std::io::Error),
}

impl From<HttpError> for FormError {
    fn from(error: HttpError) -> FormError {
        FormError::Http(error)
    }
}

impl From<std::io::Error> for FormError {
    fn from(error: std::io::Error) -> FormError {
        FormError::Io(error)
    }
}

#[derive(Default)]
struct ParsedForm {
    fields: Map<String, Value>,
    files: UploadedFiles,
    temp_files: Vec<String>,
}

async fn write_file_part(
    cursor: &mut StreamCursor,
    delimiter: &[u8],
    temp_files: &mut Vec<String>,
) -> Result<(String, u64), FormError> {
    let temp_file_path = format!("{TEMP_DIR}upload-{}", uuid::Uuid::new_v4());
    temp_files.push(temp_file_path.clone());
    let mut file = tokio::fs::File::create(&temp_file_path).await?;
    let mut size = 0u64;
    while let Some(chunk) = cursor.next_until(delimiter).await? {
        size += chunk.len() as u64;
        if size >= MAX_FILE_SIZE {
            return Err(FormError::PartTooLarge(format!("Each attachment must be smaller than {}MB", MAX_FILE_SIZE / 1024 / 1024)));
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok((temp_file_path, size))
}

async fn parse_parts(cursor: &mut StreamCursor, boundary: &str, form: &mut ParsedForm) -> Result<(), FormError> {
    static FORM_DATA: OnceLock<Regex> = OnceLock::new();
    let form_data = FORM_DATA.get_or_init(|| Regex::new(r"(?i)^form-data\s*(;|$)").expect("a valid pattern"));
    let delimiter = format!("\r\n--{boundary}").into_bytes();
    let mut file_count = 0;

    cursor.skip_until(format!("--{boundary}").as_bytes()).await?;
    loop {
        if cursor.peek(2).await? == b"--" {
            return Ok(());
        }
        cursor.read_line(MAX_HEADER_LINE_BYTES).await?;

        let mut headers: Vec<(String, String)> = Vec::new();
        loop {
            let line = cursor.read_line(MAX_HEADER_LINE_BYTES).await?;
            if line.is_empty() {
                break;
            }
            if headers.len() >= MAX_PART_HEADERS {
                return Err(HttpError::new(400, "Malformed part header").into());
            }
            if let Some(colon) = line.find(':').filter(|at| *at > 0) {
                let name = js::trim(&line[..colon]).to_lowercase();
                let value = js::trim(&line[colon + 1..]).to_string();
                match headers.iter_mut().find(|(existing, _)| *existing == name) {
                    Some(slot) => slot.1 = value,
                    None => headers.push((name, value)),
                }
            }
        }
        let header = |name: &str| headers.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());

        let disposition = header("content-disposition").unwrap_or("");
        let params = disposition_params(disposition);
        let param = |name: &str| params.iter().find(|(n, _)| n == name).map(|(_, v)| v.as_str());
        let name = param("name");
        let filename = param("filename");

        match (name, filename) {
            (Some(name), None) if form_data.is_match(disposition) => {
                let mut value = Vec::new();
                while let Some(chunk) = cursor.next_until(&delimiter).await? {
                    if value.len() + chunk.len() > MAX_FIELD_BYTES {
                        return Err(FormError::PartTooLarge(format!(
                            "Each form field must be at most {}MB",
                            MAX_FIELD_BYTES / 1024 / 1024
                        )));
                    }
                    value.extend_from_slice(&chunk);
                }
                add_field(&mut form.fields, name, Value::String(String::from_utf8_lossy(&value).into_owned()));
            }
            (Some(name), Some(filename)) if form_data.is_match(disposition) => {
                if file_count >= MAX_PARSED_FILES {
                    cursor.skip_until(&delimiter).await?;
                    continue;
                }
                file_count += 1;
                let file_name = js::utf16_truncate(base_name(filename), 255);
                let name = name.to_string();
                let content_type = header("content-type").map(str::to_string);
                let (temp_file_path, size) = write_file_part(cursor, &delimiter, &mut form.temp_files).await?;
                // An empty name with no bytes is a file input the user left blank.
                if file_name.is_empty() && size == 0 {
                    continue;
                }
                let fallback_name = temp_file_path.rsplit('/').next().unwrap_or("").to_string();
                form.files.add(
                    &name,
                    UploadedFile {
                        name: if file_name.is_empty() { fallback_name } else { file_name },
                        mimetype: match content_type.as_deref().filter(|value| !value.is_empty()) {
                            Some(value) => js::trim(value.split(';').next().unwrap_or("")).to_lowercase(),
                            None => "text/plain".to_string(),
                        },
                        size,
                        temp_file_path,
                    },
                );
            }
            _ => cursor.skip_until(&delimiter).await?,
        }
    }
}

/// Deletes upload temp files; a file that is already gone is not an error.
pub fn remove_temp_files(temp_file_paths: Vec<String>) {
    for path in temp_file_paths {
        tokio::spawn(async move {
            if let Err(error) = tokio::fs::remove_file(&path).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    logger::warn_with("Failed to reclaim an upload temp file", json!({ "tempFilePath": path }), &error);
                }
            }
        });
    }
}

/// What [`parse_uploads`] leaves to the caller.
#[derive(Default)]
pub struct UploadOutcome {
    /// Answer this instead of running the route: the upload broke a limit.
    pub rejection: Option<Response>,
    /// Temp files to delete once the route has finished with them.
    pub temp_files: Vec<String>,
}

/// Parses a multipart body onto `req.body` (fields) and `req.files` (file
/// parts). A request that is not multipart, or has no body, is left
/// untouched. Call it only behind authentication, so unauthenticated bytes
/// never reach disk. A file or field over its size limit is answered 413; a malformed
/// body is an [`HttpError`] with 400.
pub async fn parse_uploads(req: &mut HttpRequest) -> anyhow::Result<UploadOutcome> {
    let Some(boundary) = boundary_of(req.header("content-type")) else {
        return Ok(UploadOutcome::default());
    };
    if is_bodyless(&req.method) || !req.has_body {
        return Ok(UploadOutcome::default());
    }
    let RawBody::Unread(body) = std::mem::replace(&mut req.raw, RawBody::Taken) else {
        return Ok(UploadOutcome::default());
    };

    let mut cursor = StreamCursor { body, buffer: BytesMut::new(), ended: false, received: 0 };
    let mut form = ParsedForm::default();
    match parse_parts(&mut cursor, &boundary, &mut form).await {
        Ok(()) => {}
        Err(error) => {
            remove_temp_files(std::mem::take(&mut form.temp_files));
            return match error {
                FormError::PartTooLarge(message) => Ok(UploadOutcome {
                    temp_files: Vec::new(),
                    rejection: Some(json(&json!({ "status": "failed", "message": message }), 413)),
                }),
                FormError::Http(error) => Err(error.into()),
                FormError::Io(error) => Err(error.into()),
            };
        }
    }

    let mut body = match std::mem::take(&mut req.body) {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for (name, value) in form.fields {
        match value {
            Value::Array(values) => {
                for each in values {
                    add_field(&mut body, &name, each);
                }
            }
            value => add_field(&mut body, &name, value),
        }
    }
    req.body = Value::Object(body);
    if !form.files.is_empty() {
        req.files = Some(form.files);
    }
    Ok(UploadOutcome { rejection: None, temp_files: form.temp_files })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundaries() {
        assert_eq!(boundary_of(Some("multipart/form-data; boundary=abc")).as_deref(), Some("abc"));
        assert_eq!(boundary_of(Some("multipart/form-data; boundary=\"a b\"")), None);
        assert_eq!(boundary_of(Some("Multipart/Form-Data;boundary=----x")).as_deref(), Some("----x"));
        assert_eq!(boundary_of(Some("application/json")), None);
        assert_eq!(boundary_of(Some("multipart/form-data")), None);
        assert_eq!(boundary_of(None), None);
    }

    #[test]
    fn dispositions() {
        let params = disposition_params(r#"form-data; name="a"; filename="b \"q\".txt""#);
        assert_eq!(params, vec![("name".into(), "a".into()), ("filename".into(), "b \"q\".txt".into())]);
        let params = disposition_params("form-data; name=field; filename*=UTF-8''na%C3%AFve.txt");
        assert!(params.contains(&("filename".into(), "naïve.txt".into())));
        assert_eq!(base_name("C:\\dir\\file.txt"), "file.txt");
        assert_eq!(base_name("../../etc/passwd"), "passwd");
        assert_eq!(base_name(".."), "");
    }

    #[test]
    fn repeated_fields_collect() {
        let mut map = Map::new();
        add_field(&mut map, "a", json!("1"));
        add_field(&mut map, "a", json!("2"));
        add_field(&mut map, "a", json!("3"));
        add_field(&mut map, "__proto__", json!("x"));
        assert_eq!(Value::Object(map), json!({ "a": ["1", "2", "3"] }));
    }
}
