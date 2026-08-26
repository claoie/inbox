/* eslint-disable no-case-declarations */
import { Socket } from "net";
import { TLSSocket, createSecureContext } from "tls";
import { readFileSync } from "fs";
import crypto from "crypto";
import { Throttler } from "common";
import { logger } from "server";
import { Store } from "./store";
import {
  FetchRequest,
  SearchRequest,
  StoreRequest,
  CopyRequest,
  MoveRequest,
  AppendRequest,
  StatusItem,
} from "./types";
import {
  idleManager,
  IDLE_SOCKET_TIMEOUT_MS,
  SOCKET_TIMEOUT_MS,
} from "./idle-manager";
import { getCapabilities } from "./capabilities";
import { getTlsCredentials } from "../tls";
import { ImapRequestHandler } from "./handler";
import { writeChunkedToSocket, writeStreamToSocket } from "./chunked-write";
import { imapTrace } from "./trace";

// Extracted module helpers
import { handleAuthenticate, handleLogin } from "./auth";
import {
  createMailbox,
  deleteMailbox,
  renameMailbox,
  subscribeMailbox,
  unsubscribeMailbox,
  statusMailbox,
  listMailboxes,
  listSubscribedMailboxes,
  selectMailbox as selectMailboxOp,
} from "./mailbox-ops";
import {
  fetchMessagesTyped as fetchMessagesOp,
  searchTyped as searchOp,
  storeFlagsTyped as storeFlagsOp,
  copyMessageTyped as copyMessageOp,
  moveMessageTyped as moveMessageOp,
  appendMessage as appendMessageOp,
  expunge as expungeOp,
} from "./message-ops";
import {
  reconcileSequenceMapping,
  setSequenceMapping,
  SequenceState,
} from "./sequence-resolver";

export class ImapSession {
  public selectedMailbox: string | null = null;
  private selectedMailboxMessageCount: number = 0;
  public mailboxReadOnly: boolean = false;
  private store: Store | null = null;
  // Mail clients pipeline aggressively during folder sync — iOS Mail sends
  // STATUS for every mailbox in one burst (hundreds of commands on accounts
  // with many virtual folders). 100 commands/sec stays far above any
  // legitimate interactive rate while still bounding a runaway client.
  private throttler: Throttler = new Throttler(100, 1000);
  private authenticated: boolean = false;
  // RFC 4551 CONDSTORE: once the client sends `ENABLE CONDSTORE`, MODSEQ is
  // emitted on every subsequent FETCH response for the life of the session.
  private condstoreEnabled: boolean = false;
  private isIdling: boolean = false;
  private idleTag: string | null = null;
  private sessionId: string;

  // Sequence number mapping: index 0 = seq 1, index 1 = seq 2, etc.
  private seqState: SequenceState = {
    seqToUid: [],
    uidToSeq: new Map(),
  };

  private serialTail: Promise<unknown> = Promise.resolve();

  /**
   * Run `task` once everything already queued on this session has settled.
   *
   * The handler's command drain and the IDLE notifier both write untagged
   * responses, and the notifier reaches the socket from a delivery callback
   * rather than from the drain. Without a shared chain a notification parked
   * on its DB read resumes in the middle of another command's response — RFC
   * 3501 §7.4.1 forbids an EXPUNGE while answering FETCH, STORE or SEARCH,
   * and renumbering mid-FETCH shifts the very sequence numbers that response
   * is reporting. Two overlapping notifications would likewise diff against
   * the same pre-rebuild snapshot and retire the same position twice.
   */
  runSerial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = this.serialTail.then(task, task);
    this.serialTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  constructor(
    private handler: ImapRequestHandler,
    public socket: Socket
  ) {
    this.sessionId = `session_${crypto.randomBytes(8).toString("hex")}`;
  }

  getCapabilities = () => {
    return getCapabilities(this.handler.isTls);
  };

  /**
   * Re-advertise the selected mailbox to an IDLE client, announcing whatever
   * left it first (see `reconcileSequenceMapping`). Returns the new message
   * count, or null when the session is no longer idling, there is no mailbox
   * to report on, or it could not be read — in which case nothing reaches the
   * wire and the client keeps the mapping it already has.
   */
  notifyMailboxUpdate = (): Promise<number | null> =>
    this.runSerial(async () => {
      if (!this.isIdling) return null;

      // RFC 3501 §7.4.1 forbids an EXPUNGE with no command in progress, so the
      // announcement is held back until the session is known to still be
      // idling at the moment it would reach the wire. IDLE can end either
      // while this task waits its turn on the chain (DONE) or while its
      // mailbox read is parked (the heartbeat's force-terminate, which runs
      // off the chain entirely).
      const advertised = [...this.seqState.seqToUid];
      const pending: string[] = [];
      const total = await reconcileSequenceMapping(
        this.store,
        this.selectedMailbox,
        this.seqState,
        (data: string) => pending.push(data)
      );
      if (total === null) return null;
      if (!this.isIdling) {
        setSequenceMapping(this.seqState, advertised);
        return null;
      }

      for (const response of pending) this.write(response);
      this.write(`* ${total} EXISTS\r\n`);
      this.write(`* 0 RECENT\r\n`);
      return total;
    });

  bytesWritten = 0;

  write = (data: string) => {
    if (this.socket.destroyed || !this.socket.writable) {
      logger.warn("Attempted to write to destroyed/unwritable socket", {
        component: "imap",
      });
      return false;
    }
    try {
      const ok = this.socket.write(data);
      // Only count after a successful call — a write that throws never
      // reached the wire.
      this.bytesWritten += Buffer.byteLength(data, "utf8");
      imapTrace("out", this.sessionId, data);
      return ok;
    } catch (error) {
      logger.error("Error writing to socket", { component: "imap" }, error);
      return false;
    }
  };

  /**
   * Write a large Buffer with socket-level backpressure. Chunks the payload
   * so the kernel/OS outbound queue doesn't have to buffer the entire
   * multi-MB body in one shot, and awaits `drain` between chunks whenever
   * `socket.write` reports its high-water mark reached. This is the write
   * path FETCH BODY responses take when the payload lands as a Buffer
   * (the residual materialized paths — partial non-FULL sections,
   * header-like sub-sections). Large-body streaming paths (FULL, TEXT,
   * MIME_PART bare/`.TEXT`) use `writeStream` instead. Resolves after
   * every chunk is queued and the socket is under its high-water mark
   * again.
   *
   * The `payload` parameter is a Buffer specifically so V8 can GC the
   * intermediate JS string that `buildFullMessage` produced, and so
   * `socket.write` doesn't run a per-write UTF-8 conversion.
   */
  writeChunked = async (payload: Buffer): Promise<void> => {
    if (this.socket.destroyed || !this.socket.writable) {
      logger.warn("Attempted to writeChunked to destroyed/unwritable socket", {
        component: "imap",
      });
      return;
    }
    const written = await writeChunkedToSocket(this.socket, payload, (error) =>
      logger.error(
        "Error in writeChunked socket.write",
        { component: "imap" },
        error
      )
    );
    this.bytesWritten += written;
  };

  /**
   * Stream an async iterable of `Buffer` chunks straight to the socket
   * with backpressure. Used by BODY[] / RFC822 fetches wired through
   * `streamFromSegments` — the full body is never materialized in
   * memory; each chunk (~64 KiB base64 slice of one attachment) is
   * emitted, written, and released before the next runs. Peak transient
   * allocation stays sub-MB regardless of body size.
   *
   * Distinct from `writeChunked` because the source is a stream (the
   * chunks are produced lazily by the generator) rather than a
   * pre-materialized Buffer. Both share the same backpressure
   * discipline via `chunked-write.ts`.
   */
  writeStream = async (chunks: AsyncIterable<Buffer>): Promise<void> => {
    if (this.socket.destroyed || !this.socket.writable) {
      logger.warn("Attempted to writeStream to destroyed/unwritable socket", {
        component: "imap",
      });
      return;
    }
    const written = await writeStreamToSocket(this.socket, chunks, (error) =>
      logger.error(
        "Error in writeStream socket.write",
        { component: "imap" },
        error
      )
    );
    this.bytesWritten += written;
  };

  /**
   * Backpressure for pipelined command bursts: resolves once the connection
   * is within its command-rate budget, recording the command against the
   * window. RFC 3501 §7 requires a tagged completion for every command, so
   * over-limit commands are delayed, never dropped. Bails out early when the
   * socket dies mid-wait — there is nobody left to answer, and pacing out
   * the rest of a dead connection's queue would just burn timers.
   */
  waitForCommandSlot = async (): Promise<void> => {
    let wait = this.throttler.msUntilFree();
    while (wait > 0) {
      if (this.socket.destroyed || !this.socket.writable) return;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = this.throttler.msUntilFree();
    }
    this.throttler.record();
  };

  // ---------------------------------------------------------------------------
  // Simple commands
  // ---------------------------------------------------------------------------

  capability = (tag: string) => {
    this.write(
      `* CAPABILITY ${this.getCapabilities()}\r\n${tag} OK CAPABILITY completed\r\n`
    );
  };

  noop = (tag: string) => {
    this.write(`${tag} OK NOOP completed\r\n`);
  };

  check = async (tag: string) => {
    this.write(`${tag} OK CHECK completed\r\n`);
  };

  /**
   * RFC 5161 ENABLE + RFC 4551 §3.7. Acknowledge the extensions we can turn on
   * and echo them back in a single `* ENABLED` line (empty when none match).
   * CONDSTORE is the only enable-able extension today; enabling it makes every
   * later FETCH response carry MODSEQ.
   */
  enable = (tag: string, capabilities: string[]) => {
    const enabled: string[] = [];
    for (const cap of capabilities) {
      if (cap.toUpperCase() === "CONDSTORE" && !this.condstoreEnabled) {
        this.condstoreEnabled = true;
        enabled.push("CONDSTORE");
      }
    }
    const suffix = enabled.length > 0 ? ` ${enabled.join(" ")}` : "";
    this.write(`* ENABLED${suffix}\r\n${tag} OK ENABLE completed\r\n`);
  };

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  authenticate = async (
    tag: string,
    mechanism: string,
    initialResponse?: string
  ) => {
    const result = await handleAuthenticate(
      tag,
      mechanism,
      initialResponse,
      this.socket,
      this.write,
      (t) => this.handler.setPendingSaslTag(t),
      this.getCapabilities
    );
    if (result) {
      this.store = result.store;
      this.authenticated = result.authenticated;
    }
  };

  login = async (tag: string, args: string[]) => {
    const result = await handleLogin(
      tag,
      args,
      this.socket,
      this.write,
      this.getCapabilities
    );
    if (result) {
      this.store = result.store;
      this.authenticated = result.authenticated;
    }
  };

  // ---------------------------------------------------------------------------
  // Mailbox operations
  // ---------------------------------------------------------------------------

  createMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return createMailbox(tag, mailbox, this.store, this.write);
  };

  deleteMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return deleteMailbox(tag, mailbox, this.store, this.write);
  };

  renameMailbox = async (tag: string, oldName: string, newName: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return renameMailbox(tag, oldName, newName, this.store, this.write);
  };

  subscribeMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return subscribeMailbox(tag, mailbox, this.store, this.write);
  };

  unsubscribeMailbox = async (tag: string, mailbox: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return unsubscribeMailbox(tag, mailbox, this.store, this.write);
  };

  statusMailbox = async (tag: string, mailbox: string, items: StatusItem[]) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return statusMailbox(tag, mailbox, items, this.store, this.write);
  };

  listMailboxes = async (tag: string, reference: string, pattern: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return listMailboxes(tag, reference, pattern, this.store, this.write);
  };

  listSubscribedMailboxes = async (
    tag: string,
    reference: string,
    pattern: string
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return listSubscribedMailboxes(
      tag,
      reference,
      pattern,
      this.store,
      this.write
    );
  };

  examineMailbox = async (tag: string, name: string) => {
    return this.selectMailbox(tag, name, true);
  };

  selectMailbox = async (
    tag: string,
    name: string,
    readOnly: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    this.mailboxReadOnly = readOnly;
    return selectMailboxOp(
      tag,
      name,
      readOnly,
      this.store,
      this.write,
      this.seqState,
      (mailbox, count) => {
        this.selectedMailbox = mailbox;
        this.selectedMailboxMessageCount = count;
      },
      () => {
        this.seqState.seqToUid = [];
        this.seqState.uidToSeq.clear();
      }
    );
  };

  // ---------------------------------------------------------------------------
  // Message operations
  // ---------------------------------------------------------------------------

  fetchMessagesTyped = async (
    tag: string,
    fetchRequest: FetchRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    // RFC 4551 §3.3.1: the CHANGEDSINCE modifier implicitly enables CONDSTORE
    // for the session — subsequent FETCH/STORE responses carry MODSEQ, and
    // this response emits it too.
    if (fetchRequest.changedSince !== undefined) {
      this.condstoreEnabled = true;
    }
    return fetchMessagesOp(
      tag,
      fetchRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.seqState,
      this.write,
      this.writeChunked,
      this.writeStream,
      this.condstoreEnabled
    );
  };

  searchTyped = async (
    tag: string,
    searchRequest: SearchRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    return searchOp(
      tag,
      searchRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.seqState,
      this.write
    );
  };

  storeFlagsTyped = async (
    tag: string,
    storeRequest: StoreRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    // RFC 7162 §3.1.3: like CHANGEDSINCE on FETCH, an UNCHANGEDSINCE modifier
    // implicitly enables CONDSTORE — "the server starts including the MODSEQ
    // FETCH response data items in all subsequent unsolicited FETCH responses"
    // — so a client that never sent ENABLE CONDSTORE still gets them.
    if (storeRequest.unchangedSince !== undefined) {
      this.condstoreEnabled = true;
    }
    return storeFlagsOp(
      tag,
      storeRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.mailboxReadOnly,
      this.seqState,
      this.write,
      this.condstoreEnabled
    );
  };

  copyMessageTyped = async (
    tag: string,
    copyRequest: CopyRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store || !this.selectedMailbox) {
      return this.write(`${tag} NO Not authenticated or no mailbox selected.\r\n`);
    }
    return copyMessageOp(
      tag,
      copyRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.seqState,
      this.write
    );
  };

  moveMessageTyped = async (
    tag: string,
    moveRequest: MoveRequest,
    isUidCommand: boolean = false
  ) => {
    if (!this.authenticated || !this.store || !this.selectedMailbox) {
      return this.write(`${tag} NO Not authenticated or no mailbox selected.\r\n`);
    }
    return moveMessageOp(
      tag,
      moveRequest,
      isUidCommand,
      this.store,
      this.selectedMailbox,
      this.mailboxReadOnly,
      this.seqState,
      this.write
    );
  };

  appendMessage = async (tag: string, appendRequest: AppendRequest) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    return appendMessageOp(
      tag,
      appendRequest,
      this.store,
      this.selectedMailbox,
      this.write,
      async () => {
        // The mail is already stored, so a failed rebuild is reported by the
        // store's own log rather than by turning a completed APPEND into a
        // tagged NO the client would answer by sending it again.
        await reconcileSequenceMapping(
          this.store,
          this.selectedMailbox,
          this.seqState,
          this.write
        );
      }
    );
  };

  expunge = async (tag: string) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    return expungeOp(
      tag,
      this.store,
      this.selectedMailbox,
      this.mailboxReadOnly,
      this.seqState,
      this.write
    );
  };

  // ---------------------------------------------------------------------------
  // Mailbox close / deselect
  // ---------------------------------------------------------------------------

  closeMailbox = (tag: string, unselect = false) => {
    if (!this.authenticated || !this.store) {
      return this.write(`${tag} NO Not authenticated.\r\n`);
    }
    if (!this.selectedMailbox) {
      return this.write(`${tag} BAD No mailbox selected\r\n`);
    }
    this.selectedMailbox = null;
    this.selectedMailboxMessageCount = 0;
    this.seqState.seqToUid = [];
    this.seqState.uidToSeq.clear();
    const verb = unselect ? "UNSELECT" : "CLOSE";
    this.write(`${tag} OK ${verb} completed\r\n`);
  };

  // ---------------------------------------------------------------------------
  // LOGOUT
  // ---------------------------------------------------------------------------

  logout = async (tag: string) => {
    if (this.isIdling) {
      this.endIdle();
    }
    this.store = null;
    this.selectedMailbox = null;
    this.selectedMailboxMessageCount = 0;
    this.seqState.seqToUid = [];
    this.seqState.uidToSeq.clear();
    this.authenticated = false;
    this.write("* BYE IMAP4rev1 Server logging out\r\n");
    this.write(`${tag} OK LOGOUT completed\r\n`);
    this.socket.end();
  };

  // ---------------------------------------------------------------------------
  // IDLE
  // ---------------------------------------------------------------------------

  startIdle = async (tag: string) => {
    if (!this.authenticated || !this.selectedMailbox || !this.store) {
      return this.write(
        `${tag} NO Not authenticated or no mailbox selected\r\n`
      );
    }
    if (this.isIdling) {
      return this.write(`${tag} BAD Already in IDLE mode\r\n`);
    }
    this.isIdling = true;
    this.idleTag = tag;

    // A client in IDLE may send no traffic for the whole window; raise the
    // raw-socket inactivity timeout past the idle-manager's force-terminate so
    // the socket doesn't tear the connection down mid-IDLE. Reset on endIdle.
    this.socket.setTimeout(IDLE_SOCKET_TIMEOUT_MS);

    const user = this.store.getUser();
    idleManager.addIdleSession(
      this.sessionId,
      this,
      tag,
      this.selectedMailbox,
      user.username
    );

    this.write("+ idling\r\n");
    // DONE is detected by the handler's main line buffer (handler.ts), which
    // reassembles split TCP chunks and \r\n-delimited lines. A raw socket
    // "data" listener here would miss split ("DO" + "NE\r\n") and pipelined
    // ("DONE\r\nA4 NOOP\r\n") DONEs, stranding the session in IDLE.
  };

  endIdle = (reason?: string) => {
    if (!this.isIdling || !this.idleTag) return;
    this.isIdling = false;
    const tag = this.idleTag;
    this.idleTag = null;
    idleManager.removeIdleSession(this.sessionId);
    // Back to normal command mode — restore the short inactivity timeout.
    this.socket.setTimeout(SOCKET_TIMEOUT_MS);
    const suffix = reason ? ` (${reason})` : "";
    this.write(`${tag} OK IDLE terminated${suffix}\r\n`);
  };

  isInIdleMode = (): boolean => {
    return this.isIdling;
  };

  isAuthenticated = (): boolean => {
    return this.authenticated;
  };

  getSessionId = (): string => {
    return this.sessionId;
  };

  cleanup = () => {
    if (this.isIdling) {
      idleManager.removeIdleSession(this.sessionId);
      this.isIdling = false;
      this.idleTag = null;
      logger.debug("IDLE session cleaned up on socket close", {
        component: "imap",
        sessionId: this.sessionId,
      });
    }
  };

  // ---------------------------------------------------------------------------
  // STARTTLS
  // ---------------------------------------------------------------------------

  startTls = (tag: string) => {
    // RFC 3501 §6.2.1 / RFC 2595 §3: STARTTLS is only valid on a cleartext
    // connection in the not-authenticated state. Both rejections matter in
    // practice, not just on paper: wrapping an already-encrypted socket waits
    // on a `secure` event no client inside TLS will ever trigger, and the
    // per-session serial command drain would stall behind it until the socket
    // times out.
    if (this.handler.isTls) {
      this.write(`${tag} BAD STARTTLS not permitted on a TLS connection\r\n`);
      return;
    }
    if (this.authenticated) {
      this.write(`${tag} BAD STARTTLS not permitted after authentication\r\n`);
      return;
    }

    const credentials = getTlsCredentials();
    // CAPABILITY no longer offers STARTTLS without a usable certificate, so
    // reaching here means the client asked for an extension it was not
    // offered. Answer it rather than letting readFileSync throw an ENOENT the
    // handler can only report as `BAD Internal server error`.
    if (credentials.state !== "available") {
      this.write(`${tag} NO STARTTLS is not available\r\n`);
      return;
    }

    // Build the context before answering: a present-but-unparseable key pair is
    // the last failure that can still be reported as a clean tagged NO, because
    // nothing on the connection has changed yet.
    let secureContext;
    try {
      secureContext = createSecureContext({
        key: readFileSync(credentials.key),
        cert: readFileSync(credentials.cert),
      });
    } catch (error) {
      logger.error("IMAP STARTTLS could not be prepared", { component: "imap", tag }, error);
      this.write(`${tag} NO STARTTLS is not available\r\n`);
      return;
    }

    // The rest of the sequence is load-bearing three times over:
    //
    // 1. The cleartext reader comes off the raw socket first. `TLSSocket` reads
    //    through that socket's handle, so a `data` listener still attached to
    //    it consumes the ClientHello and the handshake never starts.
    // 2. The tagged OK goes out in CLEARTEXT and BEFORE the wrap (RFC 3501
    //    §6.2.1 — negotiation begins immediately after its CRLF). A conformant
    //    client holds its ClientHello until it reads this line, so wrapping and
    //    awaiting `secure` first deadlocks both ends; and once wrapped, this
    //    line would go out encrypted to a client that is not yet in TLS.
    // 3. Only then is the socket wrapped and handed back to the handler, which
    //    re-attaches the reader — now on the plaintext side of TLS.
    const plainSocket = this.socket;
    plainSocket.removeAllListeners("data");
    plainSocket.removeAllListeners("close");
    plainSocket.removeAllListeners("error");
    plainSocket.removeAllListeners("timeout");

    this.write(`${tag} OK Begin TLS negotiation now\r\n`);

    const secureSocket = new TLSSocket(plainSocket, { isServer: true, secureContext });

    // RFC 2595 §3.1: the session restarts clean after the upgrade, and the new
    // one must no longer offer STARTTLS. `setSocket` also installs the socket
    // error handler on the TLS socket, so a handshake that fails from here on
    // closes the connection rather than answering an already-answered tag.
    // `this.socket` is deliberately NOT repointed at the TLS socket: this
    // session is finished, and `setSocket` detaches listeners from
    // `this.session.socket` — which would strip node's own `close`/`error`
    // handlers off the fresh TLSSocket (no `_destroySSL` on close) if the old
    // session were already pointing at it.
    this.handler.isTls = true;
    this.handler.setSocket(secureSocket);
  };
}
