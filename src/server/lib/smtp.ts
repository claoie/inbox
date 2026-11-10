import fs, { readFileSync } from "fs";
import path from "path";
import { PassThrough, Readable } from "stream";
import { createSmtpServer, SmtpServer } from "./smtp/server";
import type { SmtpAddress, SmtpServerOptions, SmtpSession } from "./smtp/types";
import { parseMessage } from "./mime/parser";
import type { ParsedAddress, ParsedAddressValue } from "./mime/address";
import {
  saveMailHandler,
  sendMail,
  getUser,
  ADMIN_RO_USERNAME
} from "server";
import { IncomingMail, MailDataToSend } from "common";
import {
  isAuthRateLimited,
  isRecipientProbeRateLimited,
  normalizeAuthAccount,
  recordAuthFailure,
  recordRecipientProbe,
  resetAuthFailures
} from "./auth-rate-limit";
import { verifyPassword } from "./verify-password";
import { addressToUsername, getUserDomain, isLocalAddress } from "./util";
import { sendAlarm } from "./alarm";
import { isPeerCertRejection } from "./peer-cert-rejection";
import { logger } from "./logger";
import { getTlsCredentials } from "./tls";
import { isProxyProtocolEnabled } from "./proxy-protocol";
import { registerSmtpServer, unregisterSmtpServer } from "./smtp-registry";
import { MAX_MESSAGE_BYTES } from "./message-size";
import { ATTACHMENT_FOLDER } from "./mails/util";
import { incomingMailFromParsed } from "./mails/receive";
import {
  DataBudgetUnavailableError,
  withSmtpDataBudget
} from "./smtp-data-budget";

// On an implicit-TLS server, handshake errors are tagged with meta.stage
// "connect" before the connection exists, so the tag means "before any SMTP
// command". A STARTTLS handshake carries the same tag but happens inside a
// session, so only the implicit-TLS listener treats it as scanner noise. The
// message under the tag is the runtime's own ("socket hang up" on Bun).
const isImplicitTlsHandshakeFailure = (server: SmtpServer, err: Error): boolean =>
  server.options.secure === true &&
  (err as Error & { meta?: { stage?: string } }).meta?.stage === "connect";

// Errors from the TLS layer carry library "SSL routines" and an ERR_SSL_* code
// on both Node (OpenSSL) and Bun (BoringSSL). BoringSSL messages name no OpenSSL
// function ("SSL routines:OPENSSL_internal:NO_SHARED_CIPHER"), so the function
// names below never match there.
const isTlsLayerError = (err: Error): boolean => {
  const { library, code } = err as Error & { library?: string; code?: string };
  return library === "SSL routines" || (typeof code === "string" && code.startsWith("ERR_SSL_"));
};

// A remote client dropping or stalling its connection. Matched by syscall and
// errno code because the message differs by runtime ("read ETIMEDOUT" on Node,
// "ETIMEDOUT: connection timed out, read" on Bun).
const PEER_DROP_SYSCALL_ERRORS = new Set([
  "read ECONNRESET",
  "read ETIMEDOUT",
  "write ECONNRESET",
  "write EPIPE",
  "write EPROTO"
]);
const isPeerDropError = (err: Error): boolean => {
  const { syscall, code } = err as Error & { syscall?: string; code?: string };
  return PEER_DROP_SYSCALL_ERRORS.has(`${syscall} ${code}`);
};

// Handshake failures carry the peer in meta; session errors set it on the error.
const peerAddress = (err: Error): string | undefined => {
  const { meta, remoteAddress } = err as Error & {
    meta?: { remoteAddress?: string };
    remoteAddress?: string;
  };
  return meta?.remoteAddress ?? remoteAddress;
};

const registerListeners = (
  server: SmtpServer,
  port: number,
  callback: () => void
) => {
  registerSmtpServer(server);

  server.on("error", (err) => {
    // Suppress noise from external port scanners and misconfigured clients.
    // These errors originate from the remote side failing TLS negotiation —
    // they do not indicate a server-side problem.
    //
    // Strategy: suppress by OpenSSL function name in the error string.
    // - tls_early_post_process_client_hello: all errors at the TLS ClientHello stage
    //   (unsupported protocol, version too low, no suitable signature algorithm, etc.)
    //   These all mean the client's TLS capabilities are incompatible with the server.
    // - extract_keyshares: TLS 1.3 key exchange failures (bad key share, etc.)
    // - Plus a few connection-level strings for connection-drop cases.
    const msg = err.message ?? "";
    if (
      !isPeerCertRejection(err) &&
      (isImplicitTlsHandshakeFailure(server, err) ||
      isTlsLayerError(err) ||
      isPeerDropError(err) ||
      // All errors from TLS handshake/negotiation OpenSSL functions — these are
      // client-side incompatibilities, not server bugs. Matching by function name
      // covers all variants (unsupported protocol, version too low, no shared cipher,
      // no suitable signature algorithm, etc.) without enumerating each string.
      msg.includes("tls_early_post_process_client_hello") || // ClientHello stage rejections
      msg.includes("tls_post_process_client_hello") ||       // post-ClientHello cipher/extension failures
      msg.includes("tls_parse_ctos_") ||                     // malformed ClientHello extension (max_fragment_length, SNI, ALPN, ...)
      msg.includes("tls_collect_extensions") ||              // duplicate or malformed ClientHello extension block
      msg.includes("tls_validate_record_header") ||          // malformed/wrong-protocol record header
      msg.includes("extract_keyshares") ||                   // TLS 1.3 key exchange failure (bad key share)
      msg.includes("final_key_share") ||                     // TLS 1.3 key exchange failure (no suitable key share)
      msg.includes("tls_choose_sigalg") ||                   // signature algorithm negotiation failure
      msg.includes("tls_get_more_records") ||                // oversized/malformed TLS record
      // connection-level strings for connection-drop cases
      msg.includes("Socket closed") ||                       // client disconnected before TLS handshake
      msg.includes("Failed to establish TLS session") ||     // generic TLS failure wrapper
      msg.includes("read ECONNRESET") ||                      // client dropped connection mid-handshake
      msg.includes("read ETIMEDOUT") ||                       // client connected but stopped responding (scanner idle timeout)
      msg.includes("write EPROTO") ||                         // protocol error writing to socket — client aborted during TLS
      // The connection itself swallows a write ECONNRESET/EPIPE silently once a transaction
      // is complete (no open envelope) — see `SmtpConnection.onError`.
      // So by the time either string reaches here, the client abandoned an in-flight
      // transaction (e.g. sent MAIL FROM but never completed DATA/RSET) and reset the
      // socket before a pending write (often the QUIT reply) landed. No mail content
      // was ever accepted on that connection. Which errno surfaces is platform/timing
      // dependent, not semantically different — both need suppressing.
      msg.includes("write ECONNRESET") ||
      msg.includes("write EPIPE") ||
      msg.includes("TLS handshake timeout"))                  // implicit-TLS handshake timeout (port 465) — client connected but never completed the handshake
    ) {
      // Still logged (at warn, not error) so a real failure hiding in this
      // bucket leaves a trace — only the page to Discord is suppressed.
      logger.warn(`SMTP Server(${port}) Error`, {}, err);
      return;
    }
    const remoteAddress = peerAddress(err);
    const remoteLine = remoteAddress ? `**Remote:** ${remoteAddress}\n` : "";
    logger.error(`SMTP Server(${port}) Error`, { remoteAddress }, err);
    sendAlarm(
      "SMTP Server Error",
      `**Port:** ${port}\n${remoteLine}**Error:** ${String(err)}`
    ).catch(() => undefined);
  });

  server.on("close", () => {
    unregisterSmtpServer(server);
    logger.info(`SMTP Server(${port}) closed`);
  });

  server.listen(port, callback);
};

/**
 * The SMTP server discards the promise an async handler returns and hands the
 * command-loop continuation to `cb`, so a rejection that escapes leaves the
 * whole session unanswered rather than the one command. Every path here ends
 * in `cb`, including the failure ones.
 */
export const onAuth: SmtpServerOptions["onAuth"] = async (auth, session, cb) => {
  if (session.user) return cb(null, { user: session.user });

  const ip = session.remoteAddress ?? "unknown";

  const { username, password } = auth;
  // The attempted identity: failures accumulate per (ip, account) and the
  // success below forgives only this account's own bucket. The per-IP
  // aggregate is never reset here, so alternating accounts from one IP
  // cannot wipe the counter.
  const account = normalizeAuthAccount(username);

  if (isAuthRateLimited(ip, account)) {
    return cb(new Error("Too many failed authentication attempts"));
  }

  let user;
  let pwMatches = false;
  try {
    user = await getUser({ username });
    pwMatches = await verifyPassword(password, user?.password);
  } catch (err) {
    logger.error("SMTP: authentication lookup failed", { remoteAddress: ip }, err);
    return cb(new LookupFailedError());
  }

  const signedUser = user?.getSigned();
  if (!user || !signedUser || !pwMatches) {
    await recordAuthFailure(ip, account);
    return cb(null, { user: undefined });
  }

  // Scoped reset: forgive only the authenticating account's own bucket. The
  // per-IP aggregate keeps its count, so a success here cannot wipe another
  // account's failures from the same IP.
  resetAuthFailures(ip, account);
  // Credential-revocation fence: stamp the credential row's
  // current generation onto the connection. The server only copies
  // `response.user` onto the session, so the stamp goes on the session
  // object directly; the per-command gates below re-check it.
  (session as VersionStampedSmtpSession).passwordVersion =
    user.passwordVersion ?? 1;
  // Audit line names the original credential. Read-only sessions pass this
  // gate and are refused later at the single mutating gate this surface
  // has, `onMailFrom` (below) — matching HTTP and IMAP where the read-only
  // credential logs in but is refused at every write.
  if (username === ADMIN_RO_USERNAME) {
    logger.info("SMTP AUTH success (read-only)", { authenticatedAs: username, ip });
  }
  cb(null, { user: username });
};

/**
 * Refuses MAIL FROM for a session authenticated with the read-only credential
 * — SMTP submission is a mutating action (writes a sent-mail row and hands the
 * message to Mailgun for non-local recipients). 550 keeps this in the "policy
 * denied" family rather than the "server error" family that would train
 * clients to retry.
 */
export const onMailFrom: SmtpServerOptions["onMailFrom"] = async (
  _address: SmtpAddress,
  session: SmtpSession,
  cb: (err?: Error | null) => void
) => {
  if (session.user === ADMIN_RO_USERNAME) {
    const err = new Error("READ-ONLY user cannot send") as Error & {
      responseCode?: number;
    };
    err.responseCode = 550;
    return cb(err);
  }
  // Credential-revocation fence: an authenticated connection
  // whose credential rotated after AUTH loses its grant at this command.
  // The server discards the returned promise, so every path ends in `cb`.
  try {
    await checkSmtpCredentialVersion(session);
  } catch (err) {
    return cb(err instanceof Error ? err : new Error(String(err)));
  }
  return cb();
};

/**
 * RFC 5321 §3.6.1 gives 550 to a message this host will not relay — neither
 * the sender nor any recipient is local. 550 keeps it in the "policy denied"
 * family rather than the "server error" family that would train a client to
 * retry, matching `onMailFrom`'s refusal above.
 */
class RelayDeniedError extends Error {
  responseCode = 550;

  constructor() {
    super("Error: relay access denied");
  }
}

/**
 * RFC 5321 §3.5.3 gives 550 to a recipient this host is responsible for but
 * holds no mailbox for. Answered at RCPT TO rather than at DATA so the octets
 * are never transferred, and permanent so the sender bounces at once instead
 * of queueing for a mailbox that will not appear.
 */
class NoSuchMailboxError extends Error {
  responseCode = 550;

  constructor() {
    super("5.1.1 Error: no such mailbox here");
  }
}

/**
 * The mailbox `onRcptTo` accepted held nothing by the end of DATA, so it went
 * away mid-transaction. Transient, because the authoritative answer for a
 * recipient that does not exist is given one command earlier — a retry reaches
 * that 550 rather than this, and this host cannot claim authority over a state
 * change it did not observe.
 */
class MailNotStoredError extends Error {
  responseCode = 451;

  constructor() {
    super("4.2.1 Error: mailbox unavailable, try again later");
  }
}

/**
 * A lookup this host needed to answer a command did not return, so it has
 * observed nothing about the account either way. RFC 5321 §4.2.3 gives 451 to
 * a local error in processing — transient, because a permanent refusal would
 * make a sender bounce mail over an outage the sender cannot see.
 */
class LookupFailedError extends Error {
  responseCode = 451;

  constructor() {
    super("4.3.0 Error: temporary lookup failure");
  }
}

/**
 * The connection authenticated before the credential was rotated. 421
 * tells the client the service wants the channel back — the same wording
 * the eviction sweep uses — so it reconnects and re-authenticates
 * rather than retrying the stale grant.
 */
class CredentialChangedError extends Error {
  responseCode = 421;

  constructor() {
    super("4.4.2 Credential changed, please re-authenticate");
  }
}

/**
 * The session object as this module sees it: the server's own session plus
 * the credential-generation stamp `onAuth` writes.
 */
interface VersionStampedSmtpSession extends SmtpSession {
  passwordVersion?: number;
}

/**
 * Credential-revocation fence for SMTP: the generation stamped
 * at AUTH time is compared against the credential row's current version on
 * every authenticated command, so a connection a sweep could not reach —
 * another process's registry, or an AUTH that straddled the rotation — loses
 * its grant at its next command instead of at the life of its socket.
 * Unauthenticated sessions carry no grant and are not checked. A lookup
 * fault is answered transient (LookupFailedError): a grant that cannot be
 * proven current is not exercised.
 */
const checkSmtpCredentialVersion = async (
  session: SmtpSession
): Promise<void> => {
  const username = session.user;
  if (!username) return;
  const stamped =
    (session as VersionStampedSmtpSession).passwordVersion ?? 1;
  let user;
  try {
    user = await getUser({ username });
  } catch (err) {
    logger.error(
      "SMTP: credential version lookup failed",
      { remoteAddress: session.remoteAddress },
      err
    );
    throw new LookupFailedError();
  }
  if ((user?.passwordVersion ?? 1) > stamped) {
    logger.info("SMTP: refused a command on a rotated credential", {
      authenticatedAs: username,
    });
    throw new CredentialChangedError();
  }
};

/**
 * The peer has spent its recipient-probe budget. Transient and free — no
 * lookup runs behind it, and it is answered for every local recipient alike
 * so that a throttled peer learns nothing from the difference.
 */
class TooManyProbesError extends Error {
  responseCode = 451;

  constructor() {
    super("4.7.0 Error: too many unknown recipients, try again later");
  }
}

/** RFC 5321 §4.2.3 gives 552 to a message that exceeds the fixed maximum size. */
class MessageTooLargeError extends Error {
  responseCode = 552;

  constructor() {
    super(
      `Error: message exceeds fixed maximum message size ${MAX_MESSAGE_BYTES}`
    );
  }
}

/**
 * The connection dropped mid-DATA — an abrupt RST, the idle-socket timeout, or
 * a sender that went silent. The DATA stream then closes without ever ending.
 * RFC 5321 §3.8's 421 never reaches the peer in practice (the connection is
 * already gone); it exists so this answers through the same machinery every
 * other refusal does.
 */
class AbandonedTransactionError extends Error {
  responseCode = 421;

  constructor() {
    super("4.4.2 Error: connection lost mid-transaction");
  }
}

/**
 * Refuses a recipient inside the served zone that maps onto no account.
 *
 * `isLocalAddress` answers by label, so every `<anything>.$EMAIL_DOMAIN` is
 * this host's to answer for, while only the labels {@link addressToUsername}
 * maps onto a real account have a mailbox behind them. Deciding that here is
 * what keeps the set of recipients answered `250` equal to the set stored for:
 * at DATA the message would already have been transferred, and the save path
 * skips an unresolvable username silently.
 *
 * A foreign recipient is not this host's to judge and passes — the relay
 * decision belongs to {@link onData}, which needs the envelope complete.
 *
 * Naming a nonexistent mailbox is answerable here or in a bounce, and a bounce
 * tells the same sender the same thing at the cost of carrying the message
 * first, so refusing early trades nothing away.
 *
 * The refusal is also a yes/no on username existence, and this listener takes
 * `RCPT TO` unauthenticated, so each one is charged to a per-IP budget that
 * prices it exactly as a failed credential is priced. Past the budget the
 * answer is a uniform transient refusal and no lookup runs, which is what
 * bounds the connection-pool draw an unauthenticated peer can cause.
 */
export const onRcptTo: SmtpServerOptions["onRcptTo"] = async (
  address: SmtpAddress,
  session: SmtpSession,
  cb: (err?: Error | null) => void
) => {
  const ip = session.remoteAddress ?? "unknown";
  try {
    // Credential-revocation fence: an authenticated connection
    // whose credential rotated after AUTH loses its grant at this command.
    // Unauthenticated probing sessions carry no grant and skip the check.
    await checkSmtpCredentialVersion(session);

    const { EMAIL_DOMAIN } = process.env;
    if (!EMAIL_DOMAIN) return cb();
    if (!isLocalAddress(address.address, EMAIL_DOMAIN)) return cb();

    if (isRecipientProbeRateLimited(ip)) return cb(new TooManyProbesError());

    const username = addressToUsername(address.address);
    const user = username ? await getUser({ username }) : undefined;
    if (user) return cb();

    logger.warn("SMTP: refused a recipient with no mailbox", {
      remoteAddress: ip,
      username
    });
    await recordRecipientProbe(ip);
    return cb(new NoSuchMailboxError());
  } catch (err) {
    logger.error("SMTP: recipient lookup failed", { remoteAddress: ip }, err);
    return cb(new LookupFailedError());
  }
};

/**
 * A DATA transaction, carried to the parser only as far as the ceiling.
 *
 * `refused` is read after every `await` the handlers do: the reply has already
 * gone out by then, so the side effect that `await` was leading up to must not
 * run, and nothing may answer the transaction a second time.
 */
interface BoundedMessage {
  stream: Readable;
  refused: boolean;
  /**
   * Disarms the ceiling watcher and reads the rest of DATA out without
   * holding it. Every path that answers the transaction calls this first: the
   * watcher answers through the same `cb`, and a transaction is answered only
   * once, so a refusal must be the first answer to reach it.
   */
  drain: () => void;
}

/**
 * Bounds what one DATA transaction can make the process hold.
 *
 * The listener's `size` option makes `EHLO` advertise `SIZE` and refuses a
 * `MAIL FROM` that declares more, but a sender that declares nothing still
 * streams whatever it likes. So the count is kept here, where the octets
 * arrive, and the parser is cut off at the ceiling rather than told about it
 * afterwards.
 *
 * Two shapes this deliberately avoids. The source keeps flowing past the cut,
 * because the reply is only sent once DATA ends and a source nobody reads
 * never ends. And no cut is silent: the parser is handed an `error`, so it
 * settles and closes the attachment file it was writing instead of waiting on
 * a stream that will never end. Refusals are still answered through `cb`,
 * which is in hand the whole time, and never through that error.
 *
 * A third shape it has to answer on its own: the connection dying mid-DATA
 * (see {@link AbandonedTransactionError}). Left unanswered, `cb` never runs,
 * so the concurrency-budget slot this transaction holds (`withSmtpDataBudget`
 * in {@link onData}) never releases — at the default capacity of 2, two
 * abandoned connections permanently refuse every later inbound message. A
 * source that closes without ending is answered at once; the idle ceiling,
 * armed up front and on every chunk, catches one that goes silent without
 * closing, while a slow-but-live sender is never cut off.
 */
export const DATA_IDLE_TIMEOUT_MS = 65 * 1000;

const boundMessageSize = (
  source: Readable,
  session: SmtpSession,
  cb: (err?: Error | null) => void
): BoundedMessage => {
  const bounded = new PassThrough();
  // The outgoing handler reaches the parser only after a user lookup, so a
  // refusal can destroy this before anything is listening.
  bounded.on("error", () => {});
  const message: BoundedMessage = {
    stream: bounded,
    refused: false,
    drain: () => {
      message.refused = true;
      clearTimeout(idleTimer);
      bounded.destroy(new Error("message refused"));
      source.resume();
    }
  };
  let bytes = 0;

  const refuse = (err: Error) => {
    message.drain();
    cb(err);
  };

  const abandon = () => {
    logger.warn("SMTP: DATA transaction abandoned mid-transfer, releasing its budget slot", {
      remoteAddress: session.remoteAddress
    });
    refuse(new AbandonedTransactionError());
  };

  let idleTimer: ReturnType<typeof setTimeout>;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(abandon, DATA_IDLE_TIMEOUT_MS);
  };
  armIdleTimer();

  source.on("data", (chunk: Buffer) => {
    if (message.refused) return;
    armIdleTimer();

    bytes += chunk.length;
    if (bytes > MAX_MESSAGE_BYTES) {
      logger.warn("SMTP: refused a message over the maximum size", {
        remoteAddress: session.remoteAddress,
        maxBytes: MAX_MESSAGE_BYTES
      });
      refuse(new MessageTooLargeError());
      return;
    }

    if (!bounded.write(chunk)) {
      source.pause();
      bounded.once("drain", () => source.resume());
    }
  });

  let ended = false;
  source.once("end", () => {
    ended = true;
    clearTimeout(idleTimer);
    if (!message.refused) bounded.end();
  });

  source.once("close", () => {
    if (ended || message.refused) return;
    clearTimeout(idleTimer);
    abandon();
  });

  source.once("error", (err) => {
    clearTimeout(idleTimer);
    if (message.refused) return;
    logger.error("SMTP: DATA stream failed", {}, err);
    refuse(err);
  });

  // A connection that dropped while queued for its slot destroyed the source
  // before these listeners existed, and a destroyed stream fires none of them.
  if (source.destroyed && !source.readableEnded) abandon();

  return message;
};

/**
 * Discards the rest of a DATA stream that was refused before anything read it.
 *
 * The server holds the reply until the stream emits `end`, and a stream nobody
 * reads never will — so refusing without this leaves the peer waiting on its
 * own socket timeout instead of reading the code. Flowing mode drops each
 * chunk as it arrives, which keeps the drain off the heap.
 */
const drainDataStream = (stream: Readable) => {
  stream.resume();
};

/** Per-transaction attachment working directories, beside the attachments they become. */
export const INCOMING_ATTACHMENT_FOLDER = path.join(ATTACHMENT_FOLDER, ".incoming");

export const newTransactionDir = () => path.join(INCOMING_ATTACHMENT_FOLDER, crypto.randomUUID());

export const removeTransactionDir = (dir: string) =>
  fs.promises.rm(dir, { recursive: true, force: true }).catch((err) => {
    logger.warn("Could not remove a transaction's working files", { dir }, err);
  });

/**
 * Removes the transaction directories a previous process left behind, crashed
 * mid-DATA or mid-APPEND. Runs before the SMTP and IMAP listeners open, so none
 * can belong to a live transaction of this one.
 */
const sweepLeftoverTransactionDirs = () => removeTransactionDir(INCOMING_ATTACHMENT_FOLDER);

export const onData = (
  stream: Readable,
  session: SmtpSession,
  cb: (err?: Error | null) => void
) => {
  const { EMAIL_DOMAIN } = process.env;
  if (!EMAIL_DOMAIN) {
    logger.warn("SMTP: EMAIL_DOMAIN not set, rejecting all emails.");
    stream.resume();
    return cb(new Error("Email service not configured"));
  }

  const isIncomingEmail = session.envelope.rcptTo.some((addr) => {
    return isLocalAddress(addr.address, EMAIL_DOMAIN);
  });

  // `mailFrom` is a value any sender chooses freely, so a local one selects
  // submission only on a session that authenticated. Without that, inbound mail
  // whose envelope sender sits under the served zone — a forwarder, a bounce, a
  // spoof — is routed to submission and refused, and the genuine relay probe
  // (local sender, foreign recipient, no auth) draws the transient reply that
  // invites the retry rather than the permanent one this host owes it.
  const from = session.envelope.mailFrom;
  const isOutgoingEmail =
    !!session.user &&
    typeof from !== "boolean" &&
    isLocalAddress(from.address, EMAIL_DOMAIN);

  if (!isIncomingEmail && !isOutgoingEmail) {
    logger.warn("SMTP: refused to relay a message with no local party", {
      remoteAddress: session.remoteAddress
    });
    stream.resume();
    return cb(new RelayDeniedError());
  }

  // The budget wraps the dispatch rather than sitting inside each lane, so the
  // slot is taken before either lane touches the stream — the one ordering
  // that keeps an unadmitted transaction at its stream buffer instead of a
  // whole decoded message. `boundMessageSize` attaches its listeners only
  // once the slot is granted, for the same reason.
  withSmtpDataBudget(
    () =>
      new Promise<void>((resolve, reject) => {
        const settle = (err?: Error | null) => (err ? reject(err) : resolve());
        const message = boundMessageSize(stream, session, settle);
        if (isOutgoingEmail) onDataOutgoing(message, session, settle);
        else onDataIncoming(message, session, settle);
      })
  ).then(
    () => cb(),
    (err) => {
      if (err instanceof DataBudgetUnavailableError) drainDataStream(stream);
      // Every other rejection already logged at its own call site (the
      // byte-ceiling refusal, the vanished-mailbox refusal, the auth
      // refusal) at the severity its RFC code implies — re-logging here at
      // error level would turn routine client-fault refusals into
      // server-error noise.
      else if (!(err instanceof Error) || !("responseCode" in err))
        logger.error("Error handling DATA transaction", {}, err);
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  );
};

const onDataIncoming = (
  message: BoundedMessage,
  session: SmtpSession,
  cb: (err?: Error | null) => void
) => {
  const attachmentDir = newTransactionDir();
  parseMessage(message.stream, { attachmentDir })
    .then(async (parsed) => {
      if (message.refused) return;

      const mail: IncomingMail = {
        ...incomingMailFromParsed(parsed),
        envelopeFrom: session.envelope.mailFrom || undefined,
        envelopeTo: session.envelope.rcptTo.map((addr) => ({
          address: addr.address
        }))
      };

      // Extract remote address for spam DNSBL checks
      const remoteAddress = session.remoteAddress;
      const stored = await saveMailHandler(null, mail, { remoteAddress });
      if (message.refused) return;

      // `onRcptTo` refuses the recipients this cannot store for, so a zero here
      // is a mailbox that went away mid-transaction. Answering an error keeps
      // the 250 from outrunning the write in every case, including one the
      // recipient check has no way to see.
      if (stored === 0) {
        logger.warn("SMTP: accepted DATA that stored into no mailbox", {
          remoteAddress
        });
        message.drain();
        return cb(new MailNotStoredError());
      }

      cb();
    })
    .catch((err) => {
      if (message.refused) return;
      logger.error("Error parsing email", {}, err);
      message.drain();
      cb(err);
    })
    .finally(() => removeTransactionDir(attachmentDir));
};

const splitAddress = (address: string) => {
  const at = address.lastIndexOf("@");
  if (at === -1) return undefined;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain || local.includes("@")) return undefined;
  return { local, domain };
};

const addressList = (
  header: ParsedAddress | ParsedAddress[] | undefined
): string[] => {
  const flatten = (entries: ParsedAddressValue[]): string[] =>
    entries.flatMap((entry) =>
      entry.group ? flatten(entry.group) : [entry.address ?? ""]
    );
  if (!header) return [];
  const objects = Array.isArray(header) ? header : [header];
  return objects.flatMap((object) => flatten(object.value)).filter(Boolean);
};

interface OutgoingSender {
  sender: string;
  recipients: string[];
}

/**
 * Resolves which of the user's accounts an SMTP submission is sent as, given
 * the parsed `To:` addresses in `addressedTo`.
 *
 * Clients strip `Bcc:` before DATA and carry those addresses only in the
 * envelope, so a Cc and a Bcc cannot be told apart here and both select. `To:`
 * is the one recipient field that always survives into the message, which is
 * what makes excluding it possible.
 */
export const resolveOutgoingSender = (
  username: string,
  userDomain: string,
  from: { header?: string; envelope?: string },
  recipients: string[],
  addressedTo: string[]
): OutgoingSender => {
  const normalize = (address: string | undefined) =>
    address?.trim().toLowerCase();
  const accountOf = (address: string | undefined) => {
    const parts = splitAddress(normalize(address) ?? "");
    if (!parts || parts.domain !== userDomain.toLowerCase()) return undefined;
    return parts.local;
  };

  const fromAccount = accountOf(from.header) || accountOf(from.envelope);
  if (fromAccount && fromAccount !== username) {
    return { sender: fromAccount, recipients };
  }

  const addressed = new Set(addressedTo.map(normalize));
  const selected = recipients.findIndex((address) => {
    const account = accountOf(address);
    return (
      !!account && account !== username && !addressed.has(normalize(address))
    );
  });

  if (selected === -1 || recipients.length === 1) {
    const envelopeAccount = splitAddress(normalize(from.envelope) ?? "")?.local;
    return {
      sender: fromAccount || envelopeAccount || username,
      recipients
    };
  }

  return {
    sender: accountOf(recipients[selected])!,
    recipients: recipients.filter((_, index) => index !== selected)
  };
};

/**
 * Splits the SMTP envelope recipients into To / Cc / Bcc.
 *
 * A client puts Bcc addresses only in `RCPT TO` and strips the `Bcc:` header
 * out of DATA, so an envelope recipient that neither header names is a Bcc.
 * The envelope decides who is delivered to; the headers only decide which of
 * the three lists each recipient belongs in.
 *
 * @example
 * splitEnvelopeRecipients(["a@x.com", "b@x.com"], ["a@x.com"], [])
 * // => { to: ["a@x.com"], cc: [], bcc: ["b@x.com"] }
 */
export const splitEnvelopeRecipients = (
  recipients: string[],
  addressedTo: string[],
  addressedCc: string[]
) => {
  const normalize = (address: string) => address.trim().toLowerCase();
  const toHeader = new Set(addressedTo.map(normalize));
  const ccHeader = new Set(addressedCc.map(normalize));

  const to: string[] = [];
  const cc: string[] = [];
  const bcc: string[] = [];

  recipients.forEach((address) => {
    const key = normalize(address);
    if (toHeader.has(key)) to.push(address);
    else if (ccHeader.has(key)) cc.push(address);
    else bcc.push(address);
  });

  return { to, cc, bcc };
};

const onDataOutgoing = async (
  message: BoundedMessage,
  session: SmtpSession,
  cb: (err?: Error | null) => void
) => {
  const attachmentDir = newTransactionDir();
  try {
    const username = session.user;
    const user = username && (await getUser({ username }));
    if (message.refused) return;

    const signedUser = user && user.getSigned();
    if (!username || !user || !signedUser) {
      logger.warn("SMTP: Unauthenticated user attempted to send email.");
      message.drain();
      return cb(new Error("User not authenticated"));
    }

    // Credential-revocation fence: the stamp is compared
    // against the credential row's current version before the message is
    // sent, so a rotation that landed after MAIL FROM / RCPT TO still loses
    // the grant here. The user row was just read above, so no second lookup
    // is needed. `onData` itself stays synchronous — the DATA stream's
    // handlers must attach before the first bytes arrive — which is why the
    // check lives at the send gate rather than at DATA dispatch.
    const stamped =
      (session as VersionStampedSmtpSession).passwordVersion ?? 1;
    if ((user.passwordVersion ?? 1) > stamped) {
      logger.info("SMTP: refused an outgoing message on a rotated credential", {
        authenticatedAs: username,
      });
      message.drain();
      return cb(new CredentialChangedError());
    }

    const parsed = await parseMessage(message.stream, { attachmentDir });
    if (message.refused) return;

    const mailFrom = session.envelope.mailFrom;
    const envelopeFrom =
      mailFrom && typeof mailFrom !== "boolean" ? mailFrom.address : undefined;
    const { sender, recipients } = resolveOutgoingSender(
      username,
      getUserDomain(username),
      { header: parsed.from?.value?.[0]?.address, envelope: envelopeFrom },
      session.envelope.rcptTo.map((addr) => addr.address),
      addressList(parsed.to)
    );

    const { to, cc, bcc } = splitEnvelopeRecipients(
      recipients,
      addressList(parsed.to),
      addressList(parsed.cc)
    );

    const mailData = new MailDataToSend({
      to: to.join(","),
      cc: cc.join(",") || undefined,
      bcc: bcc.join(",") || undefined,
      subject: parsed.subject || "",
      html: parsed.html || parsed.text || "",
      sender,
      senderFullName: parsed.from?.value?.[0]?.name || sender
    });

    await sendMail(signedUser, mailData);
    if (message.refused) return;
    cb();
  } catch (err) {
    if (message.refused) return;
    message.drain();
    cb(err instanceof Error ? err : new Error(String(err)));
  } finally {
    await removeTransactionDir(attachmentDir);
  }
};

const SMTP_MAX_CLIENTS = 100;

/**
 * How long `SmtpServer.close` waits on open connections before it answers the
 * rest `421 Server shutting down` and returns. It has to fit inside compose's
 * 10s stop grace, which an idle client would otherwise hold for all of it —
 * long enough for the SIGKILL to land before the pool drains.
 *
 * The window is for a transaction already in DATA: once `close` runs, any new
 * command is answered 421 on arrival, so only a message still streaming in
 * needs it. One cut off here gets a transient reply and is retried by the
 * sender, so the bound costs a redelivery, never a message.
 */
export const SMTP_CLOSE_TIMEOUT_MS = 5 * 1000;

export const initializeSmtp = async () => {
  const servers: SmtpServer[] = [];
  await sweepLeftoverTransactionDirs();

  const options: Omit<SmtpServerOptions, "secure"> = {
    onAuth,
    onMailFrom,
    onRcptTo,
    onData,
    maxClients: SMTP_MAX_CLIENTS,
    size: MAX_MESSAGE_BYTES,
    proxyProtocol: isProxyProtocolEnabled(),
    closeTimeout: SMTP_CLOSE_TIMEOUT_MS
  };

  const credentials = getTlsCredentials();
  const isSslAvailable = credentials.state === "available";

  if (credentials.state === "unreadable") {
    // Same reasoning as the IMAP listener: TLS was configured and cannot be
    // served, so this is an operator error that has to page rather than sit in
    // a warn line while the server accepts plaintext auth.
    logger.error("SMTP: SSL certificate files not readable — starting without TLS", {
      cert: credentials.cert,
      key: credentials.key,
    });
    sendAlarm(
      "TLS certificate not readable",
      `SMTP is configured for TLS but cannot read its certificate, and is serving cleartext only.\n**cert:** ${credentials.cert}\n**key:** ${credentials.key}`,
      "tls-cert-unreadable-smtp"
    ).catch(() => undefined);
  }

  if (credentials.state === "available") {
    options.key = readFileSync(credentials.key);
    options.cert = readFileSync(credentials.cert);
    // Broaden TLS compatibility for external MTAs (e.g. Postfix, Exchange) that
    // may offer cipher suites excluded from OpenSSL 3's stricter defaults.
    // TLSv1.2 minimum is maintained; known-weak ciphers remain disabled.
    options.minVersion = "TLSv1.2";
    options.ciphers = "HIGH:!aNULL:!eNULL:!EXPORT:!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA";
  } else if (credentials.state === "unconfigured") {
    logger.warn("SMTP: SSL certificate not configured.");
  }

  const smtpServer = await new Promise<SmtpServer>((res) => {
    const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 25;
    const server = createSmtpServer({ ...options, secure: false });
    registerListeners(server, port, () => {
      logger.info(`SMTP server listening on port ${port}`);
      res(server);
    });
  });
  servers.push(smtpServer);

  if (isSslAvailable) {
    const smtpsServer = await new Promise<SmtpServer>((res) => {
      const port = process.env.SMTPS_PORT ? parseInt(process.env.SMTPS_PORT, 10) : 465;
      const server = createSmtpServer({ ...options, secure: true });
      registerListeners(server, port, () => {
        logger.info(`SMTP server listening on port ${port}`);
        res(server);
      });
    });
    servers.push(smtpsServer);

    const submissionServer = await new Promise<SmtpServer>((res) => {
      const port = process.env.SMTP_SUBMISSION_PORT ? parseInt(process.env.SMTP_SUBMISSION_PORT, 10) : 587;
      const server = createSmtpServer({
        ...options,
        secure: false,
        allowInsecureAuth: true
      });
      registerListeners(server, port, () => {
        logger.info(`SMTP server listening on port ${port}`);
        res(server);
      });
    });
    servers.push(submissionServer);
  }

  return servers;
};
