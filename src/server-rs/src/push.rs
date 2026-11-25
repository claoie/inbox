//! Web push notifications.

use std::sync::RwLock;
use std::time::Duration;

use anyhow::{bail, Result};
use base64::Engine;
use serde_json::json;

use crate::postgres::repositories::push_subscriptions as repo;
use crate::push_validation::{validate_push_subscription, PushSubscription};
use crate::sync::RwLockUnpoisoned;
use crate::{env, logger};

#[derive(Clone, Default)]
struct Vapid {
    public_key: Option<String>,
    private_key: Option<String>,
    subject: String,
    configured: bool,
}

static VAPID: RwLock<Vapid> = RwLock::new(Vapid {
    public_key: None,
    private_key: None,
    subject: String::new(),
    configured: false,
});

/// `Buffer.from(value, "base64url")`: padding is optional, and bits left over
/// in the last character are dropped rather than refused.
fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    LENIENT.decode(value.trim_end_matches('=')).ok()
}

/// The checks the push library applies to its VAPID details.
fn validate_vapid_details(subject: &str, public_key: &str, private_key: &str) -> Result<()> {
    if subject.is_empty() {
        bail!("No subject set in vapidDetails.subject.");
    }
    if url::Url::parse(subject).is_err() {
        bail!("Vapid subject is not a valid URL. {subject}");
    }
    // `/^[A-Za-z0-9\-_]+$/`: no padding, and not empty.
    let is_url_safe =
        |value: &str| !value.is_empty() && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !is_url_safe(public_key) {
        bail!("Vapid public key must be a URL safe Base 64 (without \"=\")");
    }
    if decode_base64url(public_key).map(|bytes| bytes.len()) != Some(65) {
        bail!("Vapid public key should be 65 bytes long when decoded.");
    }
    if !is_url_safe(private_key) {
        bail!("Vapid private key must be a URL safe Base 64 (without \"=\")");
    }
    if decode_base64url(private_key).map(|bytes| bytes.len()) != Some(32) {
        bail!("Vapid private key should be 32 bytes long when decoded.");
    }
    Ok(())
}

/// Reads the VAPID keys. Push is on only when both are set; a malformed pair
/// is a startup error.
pub fn init_push() -> Result<()> {
    // Kept as set, even empty: the public-key route answers with it verbatim.
    let public_key = env::var("PUSH_VAPID_PUBLIC_KEY");
    let private_key = env::var("PUSH_VAPID_PRIVATE_KEY");
    let domain = env::non_empty("EMAIL_DOMAIN").unwrap_or_else(|| "mydomain".to_string());
    let subject = format!("mailto:admin@{domain}");
    let filled = |key: &Option<String>| key.as_deref().is_some_and(|key| !key.is_empty());
    let configured = filled(&public_key) && filled(&private_key);

    if let (true, Some(public_key), Some(private_key)) = (configured, &public_key, &private_key) {
        validate_vapid_details(&subject, public_key, private_key)?;
    } else {
        logger::warn(
            "VAPID keys not configured - push notifications disabled",
            json!({
                "component": "push",
                "hint": "Set PUSH_VAPID_PUBLIC_KEY and PUSH_VAPID_PRIVATE_KEY to enable",
            }),
        );
    }
    *VAPID.write_unpoisoned() = Vapid { public_key, private_key, subject, configured };
    Ok(())
}

/// The VAPID public key a browser subscribes with, when one is set.
pub fn get_push_public_key() -> Option<String> {
    VAPID.read_unpoisoned().public_key.clone()
}

pub fn is_push_enabled() -> bool {
    VAPID.read_unpoisoned().configured
}

/// Stores a subscription for `user_id` and returns its id.
pub async fn store_subscription(user_id: &str, subscription: &PushSubscription) -> Option<String> {
    repo::store_subscription(user_id, subscription).await
}

/// Re-validates and stores a subscription given as untrusted JSON.
pub async fn store_untrusted_subscription(user_id: &str, input: Option<&serde_json::Value>) -> Option<String> {
    match validate_push_subscription(input) {
        Ok(subscription) => store_subscription(user_id, &subscription).await,
        Err(reason) => {
            logger::warn(
                "Refused to store an unusable push subscription",
                json!({ "component": "push", "reason": reason }),
            );
            None
        }
    }
}

pub async fn delete_subscription_for_user(push_subscription_id: &str, user_id: &str) -> bool {
    repo::delete_subscription_for_user(push_subscription_id, user_id).await
}

pub async fn refresh_subscription(push_subscription_id: &str, user_id: &str) -> bool {
    repo::refresh_subscription(push_subscription_id, user_id).await
}

const ONE_DAY: Duration = Duration::from_secs(60 * 60 * 24);

/// Starts the daily sweep of subscriptions no browser has refreshed.
pub fn clean_subscriptions() {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(ONE_DAY).await;
            logger::info("Cleaning old push subscriptions", json!({ "component": "push" }));
            let deleted = repo::clean_subscriptions().await;
            logger::info("Deleted old subscriptions", json!({ "component": "push", "count": deleted }));
        }
    });
}

mod web_push {
    //! Encrypts and delivers one push message: RFC 8291 message encryption
    //! with the `aes128gcm` content coding, authenticated with VAPID (RFC 8292).

    use aes_gcm::aead::Aead;
    use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
    use base64::Engine;
    use hkdf::Hkdf;
    use p256::ecdsa::signature::Signer;
    use p256::ecdsa::{Signature, SigningKey};
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    use p256::{ecdh::EphemeralSecret, PublicKey};
    use sha2::Sha256;

    use super::decode_base64url;

    const TTL_SECONDS: u32 = 2_419_200;
    const VAPID_EXPIRATION_SECONDS: i64 = 12 * 60 * 60;
    const RECORD_SIZE: u32 = 4096;

    /// The client pushes go out on. A redirect from the push service is its
    /// answer, not followed, as the Bun server's push library answers it: the
    /// endpoint is a URL a user chose, checked only as it was given.
    fn push_client() -> &'static reqwest::Client {
        static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        CLIENT.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("the push HTTP client builds")
        })
    }

    /// Why a send did not happen.
    #[derive(Debug)]
    pub enum PushError {
        /// The push service answered outside 2xx.
        Status(u16),
        /// The subscription or the keys were unusable, or the request failed.
        Other(String),
    }

    impl std::fmt::Display for PushError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                PushError::Status(status) => write!(f, "Received unexpected response code {status}"),
                PushError::Other(message) => f.write_str(message),
            }
        }
    }

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
    }

    fn other(message: impl Into<String>) -> PushError {
        PushError::Other(message.into())
    }

    /// The `aes128gcm` body for `payload`, encrypted to the subscription's keys.
    pub fn encrypt(p256dh: &str, auth: &str, payload: &[u8]) -> Result<Vec<u8>, PushError> {
        let ua_public_bytes = decode_base64url(p256dh)
            .filter(|bytes| bytes.len() == 65)
            .ok_or_else(|| other("The subscription p256dh value should be 65 bytes long."))?;
        let auth_secret = decode_base64url(auth)
            .filter(|bytes| bytes.len() >= 16)
            .ok_or_else(|| other("The subscription auth key should be at least 16 bytes long"))?;
        let ua_public = PublicKey::from_sec1_bytes(&ua_public_bytes)
            .map_err(|_| other("The subscription p256dh value is not a valid P-256 point."))?;

        let local_secret = EphemeralSecret::random(&mut rand::rngs::OsRng);
        let local_public = local_secret.public_key().to_encoded_point(false);
        let shared = local_secret.diffie_hellman(&ua_public);
        let salt: [u8; 16] = rand::random();

        // IKM for the content keys, bound to both public keys.
        let mut key_info = b"WebPush: info\0".to_vec();
        key_info.extend_from_slice(&ua_public_bytes);
        key_info.extend_from_slice(local_public.as_bytes());
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&auth_secret), shared.raw_secret_bytes())
            .expand(&key_info, &mut ikm)
            .map_err(|_| other("key derivation failed"))?;

        let prk = Hkdf::<Sha256>::new(Some(&salt), &ikm);
        let mut content_key = [0u8; 16];
        let mut nonce = [0u8; 12];
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut content_key)
            .and_then(|_| prk.expand(b"Content-Encoding: nonce\0", &mut nonce))
            .map_err(|_| other("key derivation failed"))?;

        // One record: the payload, then the delimiter of a final record.
        let mut record = payload.to_vec();
        record.push(2);
        let cipher = Aes128Gcm::new_from_slice(&content_key).map_err(|_| other("cipher setup failed"))?;
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), record.as_ref())
            .map_err(|_| other("encryption failed"))?;

        let mut body = Vec::with_capacity(86 + ciphertext.len());
        body.extend_from_slice(&salt);
        body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
        body.push(local_public.as_bytes().len() as u8);
        body.extend_from_slice(local_public.as_bytes());
        body.extend_from_slice(&ciphertext);
        Ok(body)
    }

    /// The `Authorization` value for a push to `endpoint`.
    pub fn vapid_authorization(
        endpoint: &url::Url,
        subject: &str,
        public_key: &str,
        private_key: &str,
    ) -> Result<String, PushError> {
        let scalar = decode_base64url(private_key).ok_or_else(|| other("the VAPID private key is not base64url"))?;
        let signing_key = SigningKey::from_slice(&scalar).map_err(|_| other("the VAPID private key is not a P-256 scalar"))?;
        let audience = endpoint.origin().ascii_serialization();
        let header = b64(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = serde_json::json!({
            "aud": audience,
            "exp": crate::js::now_ms() / 1000 + VAPID_EXPIRATION_SECONDS,
            "sub": subject,
        });
        let unsigned = format!("{header}.{}", b64(claims.to_string().as_bytes()));
        let signature: Signature = signing_key.sign(unsigned.as_bytes());
        Ok(format!("vapid t={unsigned}.{}, k={public_key}", b64(&signature.to_bytes())))
    }

    /// Posts the encrypted `payload` to the subscription's endpoint.
    pub async fn send(
        endpoint: &str,
        p256dh: &str,
        auth: &str,
        payload: &str,
        vapid: (&str, &str, &str),
    ) -> Result<(), PushError> {
        let url = url::Url::parse(endpoint).map_err(|_| other("You must pass in a subscription with at least an endpoint."))?;
        let body = encrypt(p256dh, auth, payload.as_bytes())?;
        let (subject, public_key, private_key) = vapid;
        let authorization = vapid_authorization(&url, subject, public_key, private_key)?;
        let response = push_client()
            .post(url)
            .header("TTL", TTL_SECONDS)
            .header("Content-Type", "application/octet-stream")
            .header("Content-Encoding", "aes128gcm")
            .header("Authorization", authorization)
            .header("Urgency", "normal")
            .body(body)
            .send()
            .await
            .map_err(|error| other(error.to_string()))?;
        let status = response.status().as_u16();
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(PushError::Status(status))
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use aes_gcm::aead::Aead;
        use p256::SecretKey;

        // What a browser does with the message: RFC 8291 section 3.4, receiving side.
        fn decrypt(body: &[u8], ua_secret: &SecretKey, auth_secret: &[u8]) -> Vec<u8> {
            let (salt, rest) = body.split_at(16);
            let (record_size, rest) = rest.split_at(4);
            assert_eq!(record_size, RECORD_SIZE.to_be_bytes());
            let (id_length, rest) = rest.split_at(1);
            let (sender_public, ciphertext) = rest.split_at(id_length[0] as usize);
            let sender = PublicKey::from_sec1_bytes(sender_public).unwrap();
            let shared = p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), sender.as_affine());
            let ua_public = ua_secret.public_key().to_encoded_point(false);
            let mut key_info = b"WebPush: info\0".to_vec();
            key_info.extend_from_slice(ua_public.as_bytes());
            key_info.extend_from_slice(sender_public);
            let mut ikm = [0u8; 32];
            Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes()).expand(&key_info, &mut ikm).unwrap();
            let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
            let (mut key, mut nonce) = ([0u8; 16], [0u8; 12]);
            prk.expand(b"Content-Encoding: aes128gcm\0", &mut key).unwrap();
            prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
            let mut plain = Aes128Gcm::new_from_slice(&key)
                .unwrap()
                .decrypt(Nonce::from_slice(&nonce), ciphertext)
                .unwrap();
            assert_eq!(plain.pop(), Some(2));
            plain
        }

        #[test]
        fn a_subscriber_can_decrypt_the_message() {
            let ua_secret = SecretKey::random(&mut rand::rngs::OsRng);
            let p256dh = b64(ua_secret.public_key().to_encoded_point(false).as_bytes());
            let auth_secret: [u8; 16] = rand::random();
            let body = encrypt(&p256dh, &b64(&auth_secret), br#"{"title":"You have a new mail"}"#).unwrap();
            assert_eq!(decrypt(&body, &ua_secret, &auth_secret), br#"{"title":"You have a new mail"}"#);
        }

        // The worked example of RFC 8291, Appendix A.
        #[test]
        fn decrypts_the_rfc_8291_example() {
            let ua_secret =
                SecretKey::from_slice(&decode_base64url("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94").unwrap()).unwrap();
            let auth_secret = decode_base64url("BTBZMqHH6r4Tts7J_aSIgg").unwrap();
            let body = decode_base64url(
                "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
            )
            .unwrap();
            assert_eq!(decrypt(&body, &ua_secret, &auth_secret), b"When I grow up, I want to be a watermelon");
        }

        #[test]
        fn unusable_keys_are_refused() {
            assert!(encrypt("AAAA", &b64(&[0u8; 16]), b"x").is_err());
            let ua_secret = SecretKey::random(&mut rand::rngs::OsRng);
            let p256dh = b64(ua_secret.public_key().to_encoded_point(false).as_bytes());
            assert!(encrypt(&p256dh, "AAAA", b"x").is_err());
        }

        #[test]
        fn vapid_token_verifies_with_the_public_key() {
            use p256::ecdsa::signature::Verifier;
            let secret = SecretKey::random(&mut rand::rngs::OsRng);
            let private_key = b64(&secret.to_bytes());
            let public_key = b64(secret.public_key().to_encoded_point(false).as_bytes());
            let endpoint = url::Url::parse("https://push.example.com/send/abc").unwrap();
            let value = vapid_authorization(&endpoint, "mailto:admin@mail.test", &public_key, &private_key).unwrap();
            let token = value.strip_prefix("vapid t=").unwrap().split(", k=").next().unwrap();
            let (unsigned, signature) = token.rsplit_once('.').unwrap();
            let signature = Signature::from_slice(&decode_base64url(signature).unwrap()).unwrap();
            p256::ecdsa::VerifyingKey::from(secret.public_key()).verify(unsigned.as_bytes(), &signature).unwrap();
            let claims: serde_json::Value =
                serde_json::from_slice(&decode_base64url(unsigned.split('.').nth(1).unwrap()).unwrap()).unwrap();
            assert_eq!(claims["aud"], "https://push.example.com");
            assert_eq!(claims["sub"], "mailto:admin@mail.test");
        }
    }
}

use crate::imap::idle_manager;
use crate::mails::notifications::get_notifications;
use crate::models::SignedUser;
use crate::users::get_active_users;

/// Sends one notification. A subscription the push service reports as gone
/// (410) is deleted. Returns whether the send succeeded.
async fn send_notification_safely(
    subscription: &repo::ComputedPushSubscription,
    payload: serde_json::Value,
) -> bool {
    let vapid = VAPID.read_unpoisoned().clone();
    let (Some(public_key), Some(private_key)) = (vapid.public_key, vapid.private_key) else {
        return false;
    };
    let sent = web_push::send(
        &subscription.endpoint,
        &subscription.p256dh,
        &subscription.auth,
        &payload.to_string(),
        (&vapid.subject, &public_key, &private_key),
    )
    .await;
    match sent {
        Ok(()) => true,
        Err(web_push::PushError::Status(410)) => {
            logger::info(
                "Subscription has expired, removing from database",
                json!({ "component": "push", "push_subscription_id": subscription.push_subscription_id }),
            );
            repo::delete_subscription(&subscription.push_subscription_id).await;
            false
        }
        Err(error) => {
            logger::error_with("Error sending push notification", json!({ "component": "push" }), &error);
            false
        }
    }
}

/// Tells IDLE IMAP sessions and subscribed browsers that these users have
/// new mail. A browser already notified about the newest mail is skipped.
pub async fn notify_new_mails(usernames: &[String], mailboxes: Option<&[String]>) {
    idle_manager::notify_new_mail(usernames, mailboxes).await;
    if !is_push_enabled() {
        return;
    }
    let users = match get_active_users(usernames).await {
        Ok(users) => users,
        Err(error) => {
            logger::error_with("Error sending push notification", json!({ "component": "push" }), &error);
            return;
        }
    };
    let (notifications, subscriptions) = tokio::join!(get_notifications(&users), repo::get_subscriptions(&users));
    let sends = subscriptions.iter().map(|subscription| {
        let notification = notifications.get(&subscription.username).cloned();
        async move {
            let Some(notification) = notification else { return };
            let last_notified = subscription.last_notified.unwrap_or_default();
            if notification.latest.is_some_and(|latest| latest <= last_notified) {
                return;
            }
            let title = if notification.count > 1 {
                format!("You have {} new mails", notification.count)
            } else {
                "You have a new mail".to_string()
            };
            let payload = json!({
                "title": title,
                "icon": "/icons/logo192.png",
                "badge_count": notification.count,
                "push_subscription_id": subscription.push_subscription_id,
            });
            if send_notification_safely(subscription, payload).await {
                repo::update_last_notified(&subscription.push_subscription_id).await;
            }
        }
    });
    futures_util::future::join_all(sends).await;
}

/// Best-effort push of flag changes to IDLE IMAP sessions, after a change
/// made outside IMAP.
pub async fn notify_flag_change(usernames: &[String], mail_ids: &[String]) {
    idle_manager::notify_flag_change(usernames, mail_ids).await;
}

/// Lowers the badge on the users' subscribed browsers by one, after a mail
/// was read.
pub async fn decrement_badge_count(users: &[SignedUser]) {
    if !is_push_enabled() {
        return;
    }
    let (notifications, subscriptions) = tokio::join!(get_notifications(users), repo::get_subscriptions(users));
    let sends = subscriptions.iter().map(|subscription| {
        let count = notifications.get(&subscription.username).map(|notification| notification.count);
        async move {
            let Some(count) = count else { return };
            let payload = json!({
                "badge_count": (count - 1).max(0),
                "push_subscription_id": subscription.push_subscription_id,
            });
            send_notification_safely(subscription, payload).await;
        }
    });
    futures_util::future::join_all(sends).await;
}
