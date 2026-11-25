//! Discord alarms for server errors.
//!
//! One POST to `DISCORD_ALARM_WEBHOOK` per alarm key per minute, so a burst
//! from one source cannot flood the channel or starve another source.

use std::collections::HashMap;
use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::FutureExt;
use serde_json::json;

use crate::sync::LockUnpoisoned;
use crate::{env, js};

const COOLDOWN_MS: i64 = 60_000;

fn last_alarm_at() -> &'static Mutex<HashMap<String, i64>> {
    static STATE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}

/// The HTTP client every outbound request of this process shares.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("the HTTP client builds")
    })
}

/// Sends one alarm and waits for the webhook to answer. `key` is the cooldown
/// bucket; `None` uses the title. Never fails: a delivery problem is logged.
pub async fn send_alarm(title: &str, detail: &str, key: Option<&str>) {
    let units: Vec<u16> = detail.encode_utf16().collect();
    send_alarm_utf16(title, &units, key).await;
}

/// [`send_alarm`] for a detail given as UTF-16 code units: text that was cut
/// the way JavaScript's `slice` cuts it, which can leave half a character at
/// the end. The half travels as the `\udXXX` escape `JSON.stringify` writes.
pub async fn send_alarm_utf16(title: &str, detail: &[u16], key: Option<&str>) {
    let Some(webhook_url) = env::non_empty("DISCORD_ALARM_WEBHOOK") else {
        return;
    };

    let key = key.unwrap_or(title).to_string();
    let now = js::now_ms();
    {
        let mut last = last_alarm_at().lock_unpoisoned();
        if now - last.get(&key).copied().unwrap_or(0) < COOLDOWN_MS {
            return;
        }
        last.insert(key, now);
    }

    let body = alarm_body(title, detail, now);

    let request = http_client()
        .post(webhook_url)
        .header("Content-Type", "application/json")
        .body(body);
    if let Err(error) = request.send().await {
        eprintln!("Failed to send Discord alarm: {error}");
    }
}

/// The webhook's JSON body: one embed whose description is the first 4000
/// UTF-16 units of the detail.
fn alarm_body(title: &str, detail: &[u16], now_ms: i64) -> String {
    let title = json!(format!("🚨 Mail Server Error: {title}"));
    let description = js::json_quote_utf16(&detail[..detail.len().min(4000)]);
    let timestamp = json!(js::iso_from_ms(now_ms));
    format!(
        r#"{{"embeds":[{{"title":{title},"description":{description},"color":{color},"timestamp":{timestamp}}}]}}"#,
        color = 0xff0000
    )
}

/// Sends an alarm without waiting for it: the caller's work does not depend
/// on the delivery.
pub fn spawn_alarm(title: impl Into<String>, detail: impl Into<String>) {
    let (title, detail) = (title.into(), detail.into());
    tokio::spawn(async move { send_alarm(&title, &detail, None).await });
}

/// Like [`spawn_alarm`], with an explicit cooldown bucket.
pub fn spawn_alarm_keyed(title: impl Into<String>, detail: impl Into<String>, key: impl Into<String>) {
    let (title, detail, key) = (title.into(), detail.into(), key.into());
    tokio::spawn(async move { send_alarm(&title, &detail, Some(&key)).await });
}

/// Pages a panic the way the Bun server pages an uncaught exception: an
/// "Uncaught Exception" alarm with the message and where it happened, and an
/// error line in the log format operators query. A panic ends only the task it
/// happens in (usually one connection), so without this it reaches nothing but
/// a plain-text line on stderr. The default hook still prints afterwards.
pub fn install_panic_alarm() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|message| message.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        let location = info.location().map(ToString::to_string).unwrap_or_default();
        crate::logger::error_with("Uncaught exception", json!({ "location": location }), &message);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            let detail = format!("**Message:** {message}\n```\n{location}\n```");
            runtime.spawn(async move { send_alarm("Uncaught Exception", &detail, None).await });
        }
        default_hook(info);
    }));
}

/// How long a process that is about to exit waits for its alarm to go out.
const EXIT_ALARM_TIMEOUT: Duration = Duration::from_secs(5);

/// Spawns a task the server cannot do its job without: a listener's accept
/// loop. A panic there would leave the port open but unanswered, and the
/// process up, so the container's restart policy would never act. Instead the
/// panic pages and the process exits, and the restart brings up a fresh one:
/// what the Bun server does on an uncaught exception.
pub fn spawn_essential<F>(name: &'static str, task: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    tokio::spawn(async move {
        match AssertUnwindSafe(task).catch_unwind().await {
            Ok(output) => output,
            Err(_) => exit_after_essential_panic(name).await,
        }
    })
}

async fn exit_after_essential_panic(name: &str) -> ! {
    crate::logger::error_with("Essential task panicked, exiting", json!({ "task": name }), &"panic");
    let detail = format!("**Task:** {name}\nThe server exits so that it is restarted.");
    let _ = tokio::time::timeout(EXIT_ALARM_TIMEOUT, send_alarm("Server Restarting", &detail, None)).await;
    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXIT_CHILD: &str = "MAIL_TEST_ESSENTIAL_PANIC_CHILD";

    #[test]
    fn a_panic_in_an_essential_task_exits_the_process_with_status_1() {
        if std::env::var_os(EXIT_CHILD).is_some() {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            let _ = runtime.block_on(async { spawn_essential("test task", async { panic!("fault in an essential task") }).await });
            panic!("the process should have exited before the task was joined");
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "alarm::tests::a_panic_in_an_essential_task_exits_the_process_with_status_1"])
            .env(EXIT_CHILD, "1")
            .env_remove("DISCORD_ALARM_WEBHOOK")
            .output()
            .unwrap();
        assert_eq!(status.status.code(), Some(1), "{}", String::from_utf8_lossy(&status.stdout));
    }

    #[tokio::test]
    async fn an_essential_task_that_finishes_hands_back_its_output() {
        assert_eq!(spawn_essential("test task", async { 7 }).await.unwrap(), 7);
    }

    #[test]
    fn the_body_is_one_embed_in_the_order_the_bun_server_writes_it() {
        let detail: Vec<u16> = "**Message:** \"quoted\"\nline".encode_utf16().collect();
        assert_eq!(
            alarm_body("Client JS Error", &detail, 0),
            "{\"embeds\":[{\"title\":\"🚨 Mail Server Error: Client JS Error\",\"description\":\"**Message:** \\\"quoted\\\"\\nline\",\"color\":16711680,\"timestamp\":\"1970-01-01T00:00:00.000Z\"}]}"
        );
    }

    #[test]
    fn the_description_is_cut_at_4000_units_even_through_a_character() {
        let mut detail: Vec<u16> = "x".repeat(3999).encode_utf16().collect();
        detail.extend("😀 and more".encode_utf16());
        let body = alarm_body("t", &detail, 0);
        let description = format!("\"{}\\ud83d\"", "x".repeat(3999));
        assert!(body.contains(&description), "{}", &body[body.len() - 80..]);
    }
}
