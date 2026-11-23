// Table names
export const USERS = "users";
export const MAILS = "mails";
export const SESSIONS = "sessions";
export const PUSH_SUBSCRIPTIONS = "push_subscriptions";
export const SPAM_ALLOWLIST = "spam_allowlist";
export const SPAM_TRAINING = "spam_training";
export const MAIL_UID_COUNTERS = "mail_uid_counters";
export const MAIL_MAILBOX_UID = "mail_mailbox_uid";

// Columns on mail_mailbox_uid. `mailbox` holds the full IMAP path (INBOX,
// Sent Messages, INBOX/accounts/<name>, and any future user-defined path).
export const MAILBOX = "mailbox";
export const UID = "uid";

// Common column names
export const UPDATED = "updated";
export const IS_DELETED = "is_deleted";

// Users columns
export const USER_ID = "user_id";
export const USERNAME = "username";
export const PASSWORD = "password";
export const EMAIL = "email";
export const TOKEN = "token";
export const EXPIRY = "expiry";
// Monotonic credential generation for the revocation fence.
// Bumped in the same UPDATE that writes a new password hash; every
// authentication surface compares the version a grant was stamped with
// against the row's current one.
export const PASSWORD_VERSION = "password_version";
export const IMAP_UID_VALIDITY = "imap_uid_validity";
// The single sign-on subject (`sub`) the account is linked to; null for an
// account that has never signed in through SSO.
export const AUTH_SUB = "auth_sub";

// Mails columns
export const MAIL_ID = "mail_id";
export const MESSAGE_ID = "message_id";
export const SUBJECT = "subject";
export const DATE = "date";
export const HTML = "html";
export const TEXT = "text";
export const FROM_ADDRESS = "from_address";
export const FROM_TEXT = "from_text";
export const TO_ADDRESS = "to_address";
export const TO_TEXT = "to_text";
export const CC_ADDRESS = "cc_address";
export const CC_TEXT = "cc_text";
export const BCC_ADDRESS = "bcc_address";
export const BCC_TEXT = "bcc_text";
export const REPLY_TO_ADDRESS = "reply_to_address";
export const REPLY_TO_TEXT = "reply_to_text";
export const ENVELOPE_FROM = "envelope_from";
export const ENVELOPE_TO = "envelope_to";
export const ATTACHMENTS = "attachments";
export const READ = "read";
export const SAVED = "saved";
export const SENT = "sent";
export const DELETED = "deleted";
export const DRAFT = "draft";
export const ANSWERED = "answered";
export const EXPUNGED = "expunged";
export const INSIGHT = "insight";
export const UID_DOMAIN = "uid_domain";
// Per-message mod-sequence for CONDSTORE (RFC 7162). Monotonically increasing
// within a mailbox. Bumped by the IMAP write paths — new-message insert
// (saveMail, incl. APPEND/COPY), STORE (setMailFlags), and EXPUNGE/MOVE.
// markMailSpam bumps it too: the flip moves the mail in or out of IMAP's INBOX
// (see `isInboxTree`), which is a membership change a CONDSTORE client must
// be able to detect. The web-REST and IMAP mutators bump it as well —
// markMailRead and markMailSaved reserve a fresh modseq exactly like
// markMailSpam — so a CONDSTORE client watching FETCH CHANGEDSINCE sees read
// and saved flips, even though they change no folder membership. markMailRead
// is reached from both the web `/mark` route and the IMAP implicit-\Seen
// writer (a non-peek BODY[] / RFC822 fetch).
export const MODSEQ = "modseq";
// mail_uid_counters columns
export const UID_KIND = "uid_kind";
export const UID_SCOPE = "uid_scope";
export const LAST_UID = "last_uid";
export const SPAM_SCORE = "spam_score";
export const SPAM_REASONS = "spam_reasons";
export const IS_SPAM = "is_spam";
export const RFC822_SIZE = "rfc822_size";
// Legacy decoded line counts. Nothing reads or writes them: RFC 3501 §7.4.2's
// `lines` describes the body in its transfer encoding, so BODYSTRUCTURE
// derives its own count. Kept only until the columns are dropped.
export const TEXT_LINE_COUNT = "text_line_count";
export const HTML_LINE_COUNT = "html_line_count";
export const IN_REPLY_TO = "in_reply_to";
export const REFERENCE_IDS = "reference_ids";
export const INGESTED = "ingested";

// Sessions columns
export const SESSION_ID = "session_id";
export const SESSION_USER_ID = "session_user_id";
export const SESSION_USERNAME = "session_username";
export const SESSION_EMAIL = "session_email";
export const SESSION_IS_READ_ONLY = "session_is_read_only";
export const SESSION_AUTHENTICATED_AS = "session_authenticated_as";
// The credential generation the session was minted from.
// Stamped at issuance; PostgresSessionStore.get rejects the row when it
// reads behind the user row's current PASSWORD_VERSION.
export const SESSION_PASSWORD_VERSION = "session_password_version";
// Set on a session started through single sign-on, null on a local one: the
// provider's session id, the refresh token that re-checks access, and when
// that re-check is next due.
export const SESSION_AUTH_SID = "auth_sid";
export const SESSION_AUTH_REFRESH_TOKEN = "auth_refresh_token";
export const SESSION_AUTH_RECHECK_AT = "auth_recheck_at";
export const COOKIE_ORIGINAL_MAX_AGE = "cookie_original_max_age";
export const COOKIE_MAX_AGE = "cookie_max_age";
export const COOKIE_SIGNED = "cookie_signed";
export const COOKIE_EXPIRES = "cookie_expires";
export const COOKIE_HTTP_ONLY = "cookie_http_only";
export const COOKIE_PATH = "cookie_path";
export const COOKIE_DOMAIN = "cookie_domain";
export const COOKIE_SECURE = "cookie_secure";
export const COOKIE_SAME_SITE = "cookie_same_site";

// Push subscriptions columns
export const PUSH_SUBSCRIPTION_ID = "push_subscription_id";
export const ENDPOINT = "endpoint";
export const KEYS_P256DH = "keys_p256dh";
export const KEYS_AUTH = "keys_auth";
export const LAST_NOTIFIED = "last_notified";

// SQL NULL
export const NULL = "NULL";
