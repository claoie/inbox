// Environment access (standalone, no dependencies)
export * from "./env";

// Logging (standalone, no dependencies)
export { logger } from "./logger";

// Shared utilities (domain helpers etc.) - no internal dependencies, safe to import anywhere.
// Pattern: export * from "./util" here so consumers can `import { getDomain } from "server"`
// without circular imports. Sub-modules that need these should also re-export via
// `export * from "../util"` in their own util.ts barrel.
export * from "./util";

// PostgreSQL database layer
export * from "./postgres";

// Push notifications (uses postgres internally)
export { push } from "./push";

// Mails module (uses postgres internally)
export {
  getMailHeaders,
  getMailHeadersDelta,
  getMailBody,
  searchMail,
  markRead,
  markSaved,
  deleteMail,
  saveMailHandler,
  saveMail,
  convertMail,
  validateIncomingMail,
  addressToUsername,
  saveBuffer,
  getAccounts,
  searchAccounts,
  getText,
  ATTACHMENT_FOLDER,
  getAttachmentId,
  getAttachmentFilePath,
  getAttachment,
  sendMail,
  validateMailData,
  MailValidationError,
  MailSendingError,
  markSpam,
} from "./mails";
export type { AccountsGetResponse, GetMailsOptions, MailHeadersDelta, ValidationResult, SaveMailHandlerOptions } from "./mails";

// Spam filter
export * from "./spam";

// Version
export { version } from "./postgres/initialize";

// Users module
export * from "./users";

// Read-only role attribution
export * from "./read-only";

// Session store
export { PostgresSessionStore } from "./session";

// HTTP server
export * from "./http";

// IMAP server
export * from "./imap";

// SMTP server
export * from "./smtp";
