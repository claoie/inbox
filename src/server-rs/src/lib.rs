//! The Mail backend: an HTTP API, an IMAP server and an SMTP server over one
//! PostgreSQL database.
//!
//! It is a drop-in for the Bun server in `src/server`: the same environment
//! variables, ports, database schema, session cookies and attachment layout,
//! verified by running one black-box suite (`e2e/`) against both.

pub mod alarm;
pub mod auth_client;
pub mod auth_rate_limit;
pub mod concurrency_env;
pub mod domains;
pub mod env;
pub mod fifo_semaphore;
pub mod http;
pub mod imap;
pub mod js;
pub mod logger;
pub mod mails;
pub mod mime;
pub mod models;
pub mod net;
pub mod postgres;
pub mod proxy_protocol;
pub mod push;
pub mod push_validation;
pub mod smtp;
pub mod spam;
pub mod sso;
pub mod sync;
pub mod tls;
pub mod users;
pub mod util;
pub mod verify_password;
