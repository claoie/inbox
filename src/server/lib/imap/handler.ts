/**
 * IMAP request handler - translates parsed commands to session method calls
 */

import { Socket } from "net";
import { ImapSession } from "./session";
import { ImapRequest } from "./types";
import { parseCommand } from "./parsers";
import { imapTrace, redactCredentials } from "./trace";
import { getBodyBudgetWaitMs, runInBodyBudgetContext } from "./body-budget";
import { SOCKET_TIMEOUT_MS } from "./idle-manager";
import { logger } from "server";

// Per-command diagnostic log thresholds. A command is "interesting"
// (logged at INFO) if ANY of these thresholds is exceeded. Otherwise
// the payload drops to DEBUG — same shape, same fields, but suppressed
// by prod's INFO-level filter so the noise floor doesn't drown the tail
// during a client retry storm. Chosen so that:
// - A `UID FETCH X (BODY)` on a multi-MB message ALWAYS logs (huge
//   response, non-trivial duration, RSS delta).
// - A `UID FETCH X (FLAGS)` under an idle-loop poll drops to DEBUG
//   (0-byte-ish response, sub-ms, no RSS delta).
// - Anything abnormally slow (`durationMs >= 100`) surfaces regardless
//   of size — a slow FLAGS query is diagnosable evidence for a DB /
//   pool issue.
const INTERESTING_RSS_DELTA_MB = 1;
const INTERESTING_DURATION_MS = 100;
const INTERESTING_RESPONSE_BYTES = 4096;

// A trailing `{N}` / `{N+}` is a literal declaration (RFC 3501 §4.3, RFC 7888).
// It has to stand as its own argument, so it is preceded by SP or begins the
// line — without that anchor a password ending in `{5}` reads as a declaration
// and the server answers a continuation to a command that already completed.
const LITERAL_DECLARATION = /(?:^|\s)\{(\d+)(\+?)\}\s*$/;

// A command whose grammar admits more arguments than it has already consumed.
// SEARCH is `1*(SP search-key)` (RFC 3501 §6.4.4), so parsing is not evidence
// that the client is finished: `A1 SEARCH SUBJECT {3+}` is a whole command on
// its own and still legally chains ` FROM {3+}`. Every other literal-bearing
// command has fixed arity, so for those a parse success does mean the last
// argument arrived. UID wraps its subcommand rather than replacing it, so
// `UID SEARCH` inherits the same unbounded list.
const chainsUnboundedArguments = (request: ImapRequest): boolean =>
  request.type === "SEARCH" ||
  (request.type === "UID" && chainsUnboundedArguments(request.data.request));

// Tag of a command line. RFC 3501 §7 requires a tagged completion for every
// command, including one that failed to parse, so an unparseable line still
// needs its first token. Reads the first token of the FIRST line — a
// literal-bearing command spans several.
const commandTag = (input: string): string =>
  /^\s*(\S+)/.exec(input)?.[1] || "BAD";

// Verb of a command line, uppercased. Second token of the FIRST line, so it
// still reads correctly once `pendingCommand` spans several lines.
const commandVerb = (input: string): string =>
  /^\s*\S+\s+(\S+)/.exec(input)?.[1]?.toUpperCase() ?? "";

// Literal ceilings. Without them a single unauthenticated socket pins arbitrary
// heap: `a1 APPEND INBOX {999999999+}` makes the drain hold a gigabyte, and the
// buffer fills before LOGIN is ever parsed. Against the container's memory
// ceiling one connection takes IMAP down for every user.
//
// APPEND carries a whole RFC 5322 message, so its ceiling is the largest
// message a client may file into Sent or Drafts. Nothing else in the process
// bounds a message: the composer's `fileSize: 25 * 1024 * 1024` is per FILE
// and no limit caps the file count, and the relay declares no SIZE ceiling of
// its own — so this number is a judgment about how much one socket may hold,
// not a value derived from a limit that already exists. 35 MiB clears the
// message sizes mainstream providers accept, with the memory cost of the
// worst case being one payload per connected socket.
const MAX_APPEND_LITERAL_BYTES = 35 * 1024 * 1024;

// Every other literal is a mailbox name, a credential, or a SEARCH string.
// RFC 2683 §3.2.1.5 asks servers to accept at least 8000 octets of command
// text; 8 KiB covers that with nothing left over for an attacker.
const MAX_LITERAL_BYTES = 8 * 1024;

// A line with no CRLF in it is not a command yet. Past this length the peer is
// not speaking IMAP — it is streaming to fill the heap — so the session ends.
// Sized to hold the longest plausible real command (a UID set naming thousands
// of messages) with room to spare.
const MAX_COMMAND_LINE_BYTES = 64 * 1024;

// The per-literal cap alone does not bound a COMMAND: literal declarations
// chain, so N declarations each under the cap still accumulate N payloads on
// `pendingLiterals` and N line fragments on `pendingCommand`. Only the header
// line of a command reaches `waitForCommandSlot()`, so a chain is not paced
// either. Both are new surface — before literals were generalized, only APPEND
// could hold literal state and it could not chain at all.
//
// No real command comes close to either bound. The most literals any command
// this server implements takes is a handful (LOGIN's two credentials, RENAME's
// two mailbox names, a SEARCH with several strings), and the only command that
// carries megabytes is APPEND, whose single message literal is already capped.
const MAX_LITERALS_PER_COMMAND = 64;
const MAX_PENDING_COMMAND_BYTES = MAX_APPEND_LITERAL_BYTES + 64 * 1024;

// Cap for the literal `commandText` is about to declare.
const literalCapFor = (commandText: string): number =>
  commandVerb(commandText) === "APPEND"
    ? MAX_APPEND_LITERAL_BYTES
    : MAX_LITERAL_BYTES;

// Short human-readable summary of a request for the per-command diagnostic
// log. Never emits mail contents. Cap at ~200 chars so a runaway pipeline of
// FETCH commands doesn't blow the log volume; the sequence range + item
// names are enough to identify OOM-triggering shapes (full-mailbox FETCH,
// BODY[] on a large range, etc.).
export function describeImapCommand(request: ImapRequest): string {
  const summary = (s: string) => (s.length > 180 ? s.slice(0, 177) + "..." : s);
  const rangesOf = (rs: { start: number; end?: number }[]) =>
    rs
      .map((r) => (r.end === undefined ? String(r.start) : `${r.start}:${r.end}`))
      .join(",");

  switch (request.type) {
    case "UID":
      return `UID ${describeImapCommand(request.data.request)}`;
    case "FETCH": {
      const seq = rangesOf(request.data.sequenceSet.ranges);
      const items = request.data.dataItems?.map((i) => i.type).join(" ") ?? "";
      return summary(`FETCH ${seq} (${items})`);
    }
    case "STORE": {
      const seq = rangesOf(request.data.sequenceSet.ranges);
      return summary(`STORE ${seq} ${request.data.operation} ${request.data.flags.join(" ")}`);
    }
    case "SEARCH":
      // SEARCH criteria can be arbitrarily nested; summarize root types only.
      return summary(`SEARCH ${JSON.stringify(request.data.criteria ?? "").slice(0, 120)}`);
    case "COPY":
      return summary(`COPY ${rangesOf(request.data.sequenceSet.ranges)} ${request.data.mailbox}`);
    case "MOVE":
      return summary(`MOVE ${rangesOf(request.data.sequenceSet.ranges)} ${request.data.mailbox}`);
    case "SELECT":
    case "EXAMINE":
      return summary(`${request.type} ${request.data.mailbox}`);
    case "LIST":
    case "LSUB":
      return summary(`${request.type} "${request.data.reference}" "${request.data.pattern}"`);
    case "STATUS":
      return summary(`STATUS ${request.data.mailbox} (${request.data.items.join(" ")})`);
    case "APPEND":
      return summary(`APPEND ${request.data.mailbox} ${request.data.message?.length ?? 0}B`);
    case "CREATE":
    case "DELETE":
    case "RENAME":
    case "SUBSCRIBE":
    case "UNSUBSCRIBE":
    case "GETQUOTAROOT":
      return summary(`${request.type} ${JSON.stringify(request.data).slice(0, 160)}`);
    case "LOGIN":
      // NEVER emit the password.
      return summary(`LOGIN ${request.data.username}`);
    case "AUTHENTICATE":
      return summary(`AUTHENTICATE ${request.data.mechanism}`);
    case "ENABLE":
      return summary(`ENABLE ${request.data.capabilities.join(" ")}`);
    default:
      return request.type;
  }
}

export class ImapRequestHandler {
  private session: ImapSession | null = null;
  private _pendingSaslTag: string | null = null;
  /**
   * Bumped on every `setSocket`. A STARTTLS upgrade swaps the socket while the
   * previous socket's `drainCommands` loop is still on the stack, and that loop
   * closes over its own cleartext `buffer` — so it has to be able to tell that
   * it is no longer the current connection and stop. See the RFC 2595 §2.1 note
   * in `drainCommands`.
   */
  private generation = 0;

  constructor(public isTls = false) {}

  setPendingSaslTag = (tag: string) => {
    this._pendingSaslTag = tag;
  };

  setSocket = (socket: Socket) => {
    if (this.session) {
      this.session.socket.removeAllListeners("data");
      this.session.socket.removeAllListeners("close");
      this.session.socket.removeAllListeners("error");
      this.session.socket.removeAllListeners("timeout");
    }

    // Nothing learned before the swap carries across it — a half-finished SASL
    // exchange from the cleartext phase would otherwise consume the first
    // command of the encrypted one as its base64 response.
    this._pendingSaslTag = null;
    const generation = ++this.generation;

    const session = new ImapSession(this, socket);
    this.session = session;

    // A Buffer, not a string: `{N}` counts OCTETS, and a UTF-8 decode makes
    // `length` a count of UTF-16 code units instead — so slicing a literal off
    // a decoded string takes the wrong number of characters for any payload
    // holding a multi-byte character.
    let buffer = Buffer.alloc(0);

    // Literal continuation state. `pendingCommand` is the command text
    // assembled so far, holding the `{N}` markers but NOT the payloads;
    // `pendingLiterals` carries the decoded payloads in wire order, and the two
    // travel together into `parseCommand`. `awaitingLiteral` means octets are
    // still outstanding; cleared alongside a non-null `pendingCommand` it means
    // the payload landed and the remainder of that line is still to come.
    let pendingCommand: string | null = null;
    let pendingLiterals: string[] = [];
    let awaitingLiteral = false;
    let literalBytesNeeded = 0;

    // Over-cap LITERAL+ recovery state. A non-synchronizing `{N+}` payload is
    // already inbound by the time the declaration is read, so it cannot be
    // refused — only counted and thrown away. `discardToEndOfCommand` then
    // swallows the rest of that command line, because resuming the line
    // splitter mid-command would hand the remaining arguments to the parser as
    // a fresh command, putting a LOGIN password in the journal and on the
    // wire.
    let discardBytesRemaining = 0;
    let discardToEndOfCommand = false;

    // pendingSaslTag is stored on this (class property) so session can set it

    // Parse and dispatch one complete command. `input` is the assembled
    // command text — `{N}` markers, never payloads, which travel out of band
    // on `literals`. `redactCredentials` is anchored, so it scrubs a credential
    // only while that credential sits inside a `LOGIN` / `AUTHENTICATE`-prefixed
    // string: the plain-argument form (`A1 LOGIN admin hunter2`) is covered, a
    // payload that non-conformant framing strands on a line of its own arrives
    // as a bare astring and is not.
    const executeCommand = async (
      input: string,
      literals?: string[]
    ): Promise<void> => {
      try {
        const parseResult = parseCommand(input, literals);
        if (parseResult.success && parseResult.value) {
          const { tag, request } = parseResult.value;
          await this.handleRequest(tag, request);
        } else {
          logger.debug("Parse failed", {
            component: "imap.parser",
            input: redactCredentials(input),
            error: parseResult.error
          });
          const errorMsg = parseResult.error || "Invalid command syntax";
          session.write(`${commandTag(input)} BAD ${errorMsg}\r\n`);
        }
      } catch (error) {
        logger.error("Error processing command", { component: "imap" }, error);
        session.write(`${commandTag(input)} BAD Internal server error\r\n`);
      }
    };

    // Enforce the literal ceiling on a declaration. Returns true when the
    // declaration was refused, in which case the caller must NOT enter
    // accumulation — the whole point is that the octets never get held.
    const refuseOversizedLiteral = (
      commandText: string,
      declaredBytes: number,
      isSynchronizing: boolean
    ): boolean => {
      const cap = literalCapFor(commandText);
      if (declaredBytes <= cap) return false;

      logger.info("IMAP literal over cap; refusing", {
        component: "imap",
        cmd: commandVerb(commandText),
        declaredBytes,
        cap,
        synchronizing: isSynchronizing,
        remote: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`
      });
      // `[TOOBIG]` is the established response code for a literal the server
      // will not accept, so a client can tell this apart from a generic
      // failure and stop retrying the same oversized message.
      session.write(
        `${commandTag(commandText)} NO [TOOBIG] Literal exceeds ${cap} octets\r\n`
      );

      pendingCommand = null;
      pendingLiterals = [];
      awaitingLiteral = false;
      literalBytesNeeded = 0;

      if (!isSynchronizing) {
        // LITERAL+: the client did not wait for permission, so the payload is
        // already in flight. It can only be counted out of the stream and
        // dropped — along with the rest of the command line, so its remaining
        // arguments are not read as a command of their own.
        discardBytesRemaining = declaredBytes;
        discardToEndOfCommand = true;
      }
      // Synchronizing `{N}`: the continuation was withheld, so a conforming
      // client never sends the payload. Discarding here would swallow its NEXT
      // command instead.
      return true;
    };

    // Per-session serial drain guard. Node emits `data` events without
    // awaiting the async handler, so before this guard existed each TCP
    // segment spawned its own async loop reading and mutating the shared
    // `buffer` — and, worse, calling `handleRequest`/`session.write` in
    // parallel. Pipelined FETCHes on one session (iOS Mail issues N
    // `UID FETCH (BODY.PEEK[]<off.393216>)` slices in a burst for a
    // multi-MB body) would interleave: `writeFetchResponse` writes a
    // literal-length header `{N}\r\n`, `await writeStream(...)`, then `)`.
    // Under WAN backpressure the `await` yields, and the concurrent
    // handler's synchronous `write()` for the next FETCH injects its own
    // `* n FETCH (…` header into the middle of the still-streaming
    // literal — iOS's parser desyncs and drops the session ("Cannot Get
    // Mail" modal). RFC 3501 explicitly permits serial command execution
    // on a single connection, so we serialize.
    let draining = false;
    const drainCommands = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      try {
        // The IDLE notifier writes untagged responses from a delivery
        // callback, outside this loop; sharing the session's serial chain is
        // what keeps its EXPUNGE out of the middle of a FETCH response.
        await session.runSerial(async () => {
          while (true) {
            // RFC 2595 §2.1: a server MUST discard any knowledge obtained from
            // the client before TLS that was not obtained from the TLS
            // negotiation itself. `startTls` swaps the socket from inside this
            // very loop, so without this check the rest of the cleartext segment
            // — commands an attacker can pipeline into the same TCP write as
            // `STARTTLS` — would keep being dispatched, and answered inside the
            // victim's encrypted channel (CVE-2011-0411 class). Drop the buffer
            // and hand the connection to the new generation's own loop.
            if (generation !== this.generation) {
              buffer = Buffer.alloc(0);
              pendingCommand = null;
              pendingLiterals = [];
              awaitingLiteral = false;
              literalBytesNeeded = 0;
              discardBytesRemaining = 0;
              discardToEndOfCommand = false;
              return;
            }

            // Recovery from an over-cap LITERAL+ declaration: swallow the
            // announced octets, then the remainder of that command line, without
            // holding any of it. Runs ahead of literal accumulation so the
            // discarded payload can never reach `pendingLiterals`.
            if (discardBytesRemaining > 0) {
              const take = Math.min(discardBytesRemaining, buffer.length);
              buffer = Buffer.concat([buffer.subarray(take) as Uint8Array]);
              discardBytesRemaining -= take;
              if (discardBytesRemaining > 0) return;
              continue;
            }
            if (discardToEndOfCommand) {
              const end = buffer.indexOf("\r\n");
              // The tail can arrive in pieces. Drop what is here and wait for the
              // terminator rather than retaining it, so no length cap is needed
              // in this state — nothing accumulates. A peer that never sends the
              // terminator is holding an idle socket, which SOCKET_TIMEOUT_MS
              // already ends.
              if (end === -1) {
                buffer = Buffer.alloc(0);
                return;
              }
              buffer = Buffer.concat([buffer.subarray(end + 2) as Uint8Array]);
              discardToEndOfCommand = false;
              continue;
            }

            // Literal octets are payload, never commands. Consume them before the
            // line splitter can reach them: `LOGIN {5+}\r\nadmin {8+}\r\npassword`
            // otherwise splits into three "commands", so the username and the
            // plaintext password each land in the parse-failure log AND get
            // echoed back on the wire as `<credential> BAD Invalid command`.
            // `awaitingLiteral` rather than `literalBytesNeeded > 0`: a `{0}`
            // literal is legal (an empty APPEND body, an empty mailbox name) and
            // its payload is the empty string, which a count-based guard would
            // skip — leaving the queue short by one and the parse failing.
            if (pendingCommand !== null && awaitingLiteral) {
              if (buffer.length < literalBytesNeeded) return;
              const payload = buffer
                .subarray(0, literalBytesNeeded)
                .toString("utf8");
              pendingLiterals.push(payload);
              // COPY the residual rather than viewing it. `subarray` returns a
              // view that keeps the whole parent allocation alive, so after a
              // multi-MB APPEND the session would sit on the full message for as
              // long as it stays idle — per connection, against a 256 MiB
              // container ceiling. The residual here is a command tail (bytes,
              // not megabytes), so the copy is free; the line splitter below
              // then views that small copy instead of the big one. `concat`
              // rather than `subarray` because concat always allocates its own
              // exactly-sized backing store, empty residual included.
              buffer = Buffer.concat([
                buffer.subarray(literalBytesNeeded) as Uint8Array
              ]);
              literalBytesNeeded = 0;
              awaitingLiteral = false;
              // A payload that consumed its own line terminator (the client
              // counted the CRLF into `{N}`, or declared the last argument and
              // sent nothing after it) leaves no tail to read. Dispatch now
              // rather than blocking on a CRLF that is never coming: waiting
              // turns a non-conforming client into a wedged session.
              //
              // `buffer.length === 0` alone is NOT that condition: it means "no
              // further octets have arrived from the OS yet", which is also true
              // whenever the client flushed the payload in its own `write()` or
              // the payload happened to end on an MSS boundary. Dispatching
              // there answers the tag while the rest of the command is still in
              // flight, and the remainder is then read as a fresh command line
              // — putting the credential back in the journal and back on the
              // wire, which is the leak this framing exists to close.
              //
              // Whether the command is complete is a question about STRUCTURE,
              // so ask the parser rather than inspecting the payload's bytes. A
              // literal exists precisely to carry octets an astring cannot —
              // CRLF included — so "the payload ends in CRLF" does not mean "the
              // client counted the command's terminator into {N}". The parser
              // knows whether the declared literal was the last argument:
              // `A1 LOGIN {7+}` + ["admin\r\n"] fails (keep waiting), while
              // `a1 APPEND INBOX {13+}` + ["Hello World\r\n"] succeeds.
              //
              // Parsing is necessary but not sufficient, for the same reason
              // the chained-tail gate below carries a second discriminator: a
              // command with an unbounded argument list parses while more of it
              // is still in flight. Dispatching one on an empty buffer drops
              // every argument the client had not flushed yet and answers OK on
              // a result computed from the rest, then reads the remainder as a
              // fresh command line and puts a `BAD` on a tag the client never
              // issued.
              const pending = parseCommand(pendingCommand, pendingLiterals);
              if (
                buffer.length === 0 &&
                pending.success &&
                !chainsUnboundedArguments(pending.value!.request)
              ) {
                const input = pendingCommand;
                const literals = pendingLiterals;
                pendingCommand = null;
                pendingLiterals = [];
                await executeCommand(input, literals);
              }
              continue;
            }

            const lineEnd = buffer.indexOf("\r\n");
            if (lineEnd === -1) return;

            const line = buffer.subarray(0, lineEnd).toString("utf8");
            buffer = buffer.subarray(lineEnd + 2);

            // Text following a consumed payload on the same line: either it
            // declares the next literal (LOGIN chains two — one per credential)
            // or the command is complete. Handled ahead of the SASL/IDLE/blank
            // checks below because a completing tail is usually the empty string.
            if (pendingCommand !== null) {
              const literals = pendingLiterals;
              const complete = parseCommand(pendingCommand, literals).success;
              // Ending in `{N}` is not enough to call `line` a continuation: a
              // pipelined NEXT command declares a literal the same way. What
              // separates them is the SP between two astrings (RFC 3501 §4.3) —
              // an argument tail carries one, while a payload that consumed its
              // own terminator leaves the next command flush against the buffer
              // start. Completeness alone cannot decide it either: `SEARCH
              // SUBJECT {3+}` parses on its own yet legally chains ` FROM {3+}`.
              // The residual: a pipelined command that opens with SP *and*
              // ends in `{N}` is absorbed as an argument tail. A synchronizing
              // `{N}` takes the pending command with it — the continuation
              // drawn is for a literal no client asked for, and until that
              // payload arrives neither command gets a tagged completion; a
              // non-synchronizing `{N+}` carrying its payload inline still
              // completes the pending command. RFC 3501 §9 gives a command line
              // no leading SP, so only a hand-crafted client reaches it, and the
              // absorbed text still never reaches the wire.
              const chained =
                complete && !/^\s/.test(line)
                  ? null
                  : LITERAL_DECLARATION.exec(line);
              if (chained) {
                const declaredBytes = parseInt(chained[1], 10);
                // The payloads live on `pendingLiterals`; `pendingCommand` keeps
                // only the `{N}` markers, some thirty octets per link. Measuring
                // the command text therefore measures none of what is held, so
                // the byte ceiling has to sum the payloads themselves — plus the
                // declaration about to be accepted, whose octets are already in
                // flight under LITERAL+.
                const heldBytes =
                  pendingLiterals.reduce((n, s) => n + Buffer.byteLength(s), 0) +
                  Buffer.byteLength(pendingCommand) +
                  declaredBytes;
                // A chain that has outgrown any real command is an accumulator
                // attack, not a client the session can keep negotiating with, so
                // it ends the session rather than answering `NO` and inviting the
                // next one.
                if (
                  pendingLiterals.length >= MAX_LITERALS_PER_COMMAND ||
                  heldBytes > MAX_PENDING_COMMAND_BYTES
                ) {
                  logger.info("IMAP literal chain over cap; closing session", {
                    component: "imap",
                    literals: pendingLiterals.length,
                    pendingBytes: heldBytes,
                    remote: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`
                  });
                  session.write("* BYE Command too long\r\n");
                  if (!socket.destroyed) socket.destroy();
                  return;
                }
                // Cap-check before mutating any state: the verb and the tag both
                // come off the command assembled so far, not off this tail line.
                if (
                  refuseOversizedLiteral(pendingCommand, declaredBytes, !chained[2])
                ) {
                  continue;
                }
                pendingCommand += line.trimEnd();
                literalBytesNeeded = declaredBytes;
                awaitingLiteral = true;
                if (!chained[2]) session.write("+ go ahead\r\n");
                continue;
              }
              // If the command already parses without this line, the payload
              // carried its own terminator and `line` is not its tail — it is the
              // NEXT command, pipelined behind it. Appending it to the command
              // text instead lets `parseAppend` succeed and drop it silently,
              // leaving it with no tagged completion at all, which RFC 3501 §7
              // does not allow. Dispatch what is complete, then fall through and
              // read `line` as the fresh command it is.
              const input = complete ? pendingCommand : pendingCommand + line;
              pendingCommand = null;
              pendingLiterals = [];
              await executeCommand(input, literals);
              if (!complete) continue;
              // `line` is the pipelined NEXT command, and it is about to be read
              // by the rest of this iteration rather than by a fresh one — so
              // the top-of-loop generation guard is already behind us. A
              // literal-declaring `STARTTLS` swaps the socket inside the
              // `executeCommand` above, and without this check the attacker's
              // pipelined remainder would be answered inside the victim's
              // encrypted channel (RFC 2595 §2.1, CVE-2011-0411 class).
              if (generation !== this.generation) return;
            }

            // Handle SASL challenge response (client sends base64 after "+ " challenge)
            if (this._pendingSaslTag !== null) {
              const tag = this._pendingSaslTag;
              this._pendingSaslTag = null;
              // Client may send "*" to cancel authentication
              if (line.trim() === "*") {
                session.write(`${tag} BAD Authentication cancelled\r\n`);
              } else {
                await session.authenticate(tag, "PLAIN", line.trim());
              }
              continue;
            }

            if (!line.trim()) continue;

            // The only valid client input during IDLE is "DONE". This line
            // buffer already reassembles split TCP chunks and pipelined input,
            // so handle DONE here: terminate IDLE and fall through so any
            // command pipelined after DONE (e.g. "DONE\r\nA4 NOOP\r\n") is
            // processed on the next loop iteration. Non-DONE input during IDLE
            // is ignored per RFC 2177.
            if (session.isInIdleMode()) {
              if (line.trim().toUpperCase() === "DONE") {
                session.endIdle();
              }
              continue;
            }

            logger.debug("IMAP command received", {
              component: "imap",
              command: redactCredentials(line.trim()),
              mailbox: session.selectedMailbox
            });
            imapTrace("in", session.getSessionId(), line.trim());

            // Pace pipelined bursts. RFC 3501 §7 requires a tagged
            // completion for every command, so over-limit commands are
            // delayed, never skipped — clients pipeline heavily during
            // folder sync (iOS Mail sends STATUS for every mailbox in one
            // burst after LIST).
            await session.waitForCommandSlot();

            // A command line ending in `{N}` / `{N+}` declares a literal: the
            // next N octets are payload, not a command. APPEND is the familiar
            // case, but RFC 3501 permits a literal wherever an astring is legal —
            // LOGIN, SELECT, CREATE — and RFC 7888 LITERAL+ (which this server
            // advertises) lets a conforming client send it without waiting for
            // the continuation. Accumulate for any command, not just APPEND.
            const literalMatch = LITERAL_DECLARATION.exec(line);
            if (literalMatch) {
              if (
                refuseOversizedLiteral(
                  line,
                  parseInt(literalMatch[1], 10),
                  !literalMatch[2]
                )
              ) {
                continue;
              }
              pendingCommand = line.trimEnd();
              pendingLiterals = [];
              literalBytesNeeded = parseInt(literalMatch[1], 10);
              awaitingLiteral = true;
              // Synchronizing literals {N} (without +) require a continuation
              // response before the client will send the literal data.
              // Non-synchronizing literals {N+} (LITERAL+) do not.
              if (!literalMatch[2]) {
                session.write("+ go ahead\r\n");
              }
              continue;
            }

            await executeCommand(line);
          }
        });
      } catch (error) {
        logger.error("Error processing data", { component: "imap" }, error);
        if (!socket.destroyed) {
          socket.destroy();
        }
      } finally {
        draining = false;
      }
    };

    // Octets buffered that cannot become a command however long the session
    // waits. Everything the drain has agreed to receive is excluded — an
    // announced literal payload, or the tail of an over-cap declaration being
    // counted out — and of what remains, only the run past the last CRLF is
    // still an unfinished line.
    const unterminatedTailBytes = (): number => {
      const awaited =
        discardBytesRemaining > 0
          ? discardBytesRemaining
          : awaitingLiteral
            ? literalBytesNeeded
            : 0;
      if (buffer.length <= awaited) return 0;
      const tail = buffer.subarray(awaited);
      const lastLineEnd = tail.lastIndexOf("\r\n");
      return lastLineEnd === -1 ? tail.length : tail.length - (lastLineEnd + 2);
    };

    socket.on("data", (data) => {
      // Sync-only: append to the shared buffer, then wake the drain.
      // The `data` event fires synchronously per TCP segment; any await
      // here would let a second segment race the buffer append. Keep this
      // handler synchronous — all async work belongs inside `drainCommands`
      // which owns the `draining` guard.
      try {
        buffer =
          buffer.length === 0
            ? data
            : Buffer.concat([buffer as Uint8Array, data as Uint8Array]);
      } catch (error) {
        logger.error("Error appending data to buffer", { component: "imap" }, error);
        if (!socket.destroyed) socket.destroy();
        return;
      }

      // A line that has outgrown the longest legal command is not a command in
      // progress, it is a peer streaming bytes to fill the heap. The check has
      // to sit here rather than in the drain: `drainCommands` returns early
      // while a drain is already in flight, and every `await` in that loop — a
      // deliberate authentication-failure delay, the pipeline throttle, a DB
      // round-trip — parks it while this handler keeps concatenating. Growth
      // happens here, so the bound belongs here, and it needs no
      // authentication to start.
      if (unterminatedTailBytes() > MAX_COMMAND_LINE_BYTES) {
        logger.info("IMAP command line over cap; closing session", {
          component: "imap",
          bufferedBytes: buffer.length,
          remote: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}`
        });
        session.write("* BYE Command line too long\r\n");
        if (!socket.destroyed) socket.destroy();
        return;
      }
      // Fire-and-forget: `drainCommands` self-serializes via `draining`.
      // Errors inside are already logged; catch here just to prevent an
      // unhandled-rejection.
      void drainCommands().catch((error) => {
        logger.error("Unhandled drain error", { component: "imap" }, error);
      });
    });

    socket.on("close", () => {
      logger.debug("IMAP connection closed", { component: "imap" });
      session.cleanup();
    });

    socket.on("error", (error) => {
      if (!(error as Error).message?.includes("ECONNRESET")) {
        logger.error("IMAP socket error", { component: "imap" }, error);
      }
      if (!socket.destroyed) {
        socket.destroy();
      }
    });

    // Set socket timeout to prevent hanging connections
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on("timeout", () => {
      logger.info("IMAP socket timeout", { component: "imap" });
      session.write("* BYE Timeout\r\n");
      if (!socket.destroyed) {
        socket.destroy();
      }
    });
  };

  /**
   * Handle a parsed IMAP request by delegating to appropriate session methods
   */
  async handleRequest(tag: string, request: ImapRequest): Promise<void> {
    if (!this.session) {
      logger.error("Invalid session: Use setSocket to start a session", { component: "imap" });
      return;
    }

    // Per-command diagnostic: RSS delta + bytes emitted to the client + wall
    // duration, so a memory spike can be attributed to a specific command
    // rather than only to a coarse metrics-poll window. Sampled from
    // `session.bytesWritten` (session-scoped counter) rather than wrapping
    // `session.write` — the wrap approach was racy under the pre-serialized
    // data-event handler and could restore an orphan `originalWrite` from a
    // nested handler and permanently break the wrap for the rest of the
    // socket's lifetime. Commands are now serialized per session (see the
    // `drainCommands` note above), so cross-command interleaving on the
    // same session is gone; the counter approach stays because it also
    // avoids the wrap-restore hazard.
    //
    // RSS is process-wide, not session-scoped: under multi-socket load two
    // concurrent commands (on DIFFERENT sessions) both see the same
    // rssDelta. `remote` in the log lets triage disambiguate.
    const session = this.session;
    const startedAt = performance.now();
    const memBefore = process.memoryUsage();
    const rssBefore = memBefore.rss;
    const bytesBefore = session.bytesWritten;

    // Bind a body-budget wait ledger to this command's async scope so
    // every `withBodyBudget` acquire made deeper in the FETCH path
    // (across await boundaries + nested calls) attributes its wait to
    // THIS command's totals, not a racing sibling command on another
    // socket. Reads via `getBodyBudgetWaitMs()` in the finally below.
    // See `body-budget.ts`.
    return runInBodyBudgetContext(async () => {
    try {
      switch (request.type) {
        case "CAPABILITY":
          session.capability(tag);
          break;

        case "NOOP":
          session.noop(tag);
          break;

        case "LOGIN":
          await session.login(tag, [
            request.data.username,
            request.data.password
          ]);
          break;

        case "AUTHENTICATE":
          await session.authenticate(
            tag,
            request.data.mechanism,
            request.data.initialResponse
          );
          break;

        case "LIST":
          await session.listMailboxes(
            tag,
            request.data.reference,
            request.data.pattern
          );
          break;
        case "LSUB":
          await session.listSubscribedMailboxes(
            tag,
            request.data.reference,
            request.data.pattern
          );
          break;

        case "SELECT":
          await session.selectMailbox(tag, request.data.mailbox);
          break;

        case "EXAMINE":
          await session.examineMailbox(tag, request.data.mailbox);
          break;

        case "CREATE":
          await session.createMailbox(tag, request.data.mailbox);
          break;

        case "DELETE":
          await session.deleteMailbox(tag, request.data.mailbox);
          break;

        case "RENAME":
          await session.renameMailbox(
            tag,
            request.data.oldName,
            request.data.newName
          );
          break;

        case "SUBSCRIBE":
          await session.subscribeMailbox(tag, request.data.mailbox);
          break;

        case "UNSUBSCRIBE":
          await session.unsubscribeMailbox(tag, request.data.mailbox);
          break;

        case "STATUS":
          await session.statusMailbox(
            tag,
            request.data.mailbox,
            request.data.items
          );
          break;

        case "APPEND":
          await session.appendMessage(tag, request.data);
          break;

        case "IDLE":
          await session.startIdle(tag);
          break;

        case "CHECK":
          await session.check(tag);
          break;

        case "FETCH":
          await session.fetchMessagesTyped(tag, request.data, false);
          break;

        case "SEARCH":
          await session.searchTyped(tag, request.data, false);
          break;

        case "STORE":
          await session.storeFlagsTyped(tag, request.data, false);
          break;

        case "COPY":
          await session.copyMessageTyped(tag, request.data, false);
          break;

        case "MOVE":
          await session.moveMessageTyped(tag, request.data, false);
          break;

        case "UID":
          await this.handleUidCommand(tag, request.data);
          break;

        case "CLOSE":
          session.closeMailbox(tag);
          break;

        case "EXPUNGE":
          await session.expunge(tag);
          break;

        case "LOGOUT":
          await session.logout(tag);
          break;

        case "ID":
          session.write(`* ID NIL\r\n${tag} OK ID completed\r\n`);
          break;

        case "STARTTLS":
          session.startTls(tag);
          break;

        case "NAMESPACE":
          // RFC 2342: single personal namespace, no other/shared namespaces
          session.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
          break;

        case "ENABLE":
          // RFC 5161 / RFC 4551 §3.7: enable CONDSTORE (the one extension we
          // support enabling) and echo back what was activated.
          session.enable(tag, request.data.capabilities);
          break;

        case "UNSELECT":
          // RFC 3691: like CLOSE but without expunging; deselect the current mailbox
          session.closeMailbox(tag, true);
          break;

        case "GETQUOTAROOT":
          // RFC 2087: quota not supported, return empty quota
          session.write(`${tag} NO Quota not supported\r\n`);
          break;

        default:
          session.write(`${tag} BAD Unknown command\r\n`);
          break;
      }
    } catch (error) {
      logger.error("Error handling IMAP request", { component: "imap", tag, type: request.type }, error);
      session.write(`${tag} BAD Internal server error\r\n`);
    } finally {
      const memAfter = process.memoryUsage();
      const rssAfter = memAfter.rss;
      const socket = session.socket;
      const rssDeltaMB = Math.round((rssAfter - rssBefore) / 1_048_576);
      const responseBytes = session.bytesWritten - bytesBefore;
      const durationMs = Math.round(performance.now() - startedAt);
      const isInteresting =
        Math.abs(rssDeltaMB) >= INTERESTING_RSS_DELTA_MB ||
        durationMs >= INTERESTING_DURATION_MS ||
        responseBytes >= INTERESTING_RESPONSE_BYTES;
      const waitedForBodyBudgetMs = Math.round(getBodyBudgetWaitMs());
      // Attribution of the per-command RSS delta by memory class. `rss` is
      // OS-reported (Node process resident) — the other four are V8/Node
      // internal counters that partition where the growth actually lives:
      //   heapUsed / heapTotal — V8 JS heap (objects, strings, closures)
      //   external            — Buffers + typed arrays bound to a V8 wrapper
      //   arrayBuffers        — subset of `external` for ArrayBuffer backing
      //                         stores (raw Buffer allocations sit here)
      // Under a same-socket pipelined burst, seeing external/arrayBuffers
      // climb points at Buffer accumulation (pgTextChunks / socket outbound
      // / attachment reads); seeing heapUsed climb points at retained JS
      // references (mail-row copies, segment lists); seeing rss climb
      // without any of the above pointing at Node-internal buffers.
      const heapUsedDeltaKB = Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024);
      const heapTotalDeltaKB = Math.round((memAfter.heapTotal - memBefore.heapTotal) / 1024);
      const externalDeltaKB = Math.round((memAfter.external - memBefore.external) / 1024);
      const arrayBuffersDeltaKB = Math.round(
        (memAfter.arrayBuffers - memBefore.arrayBuffers) / 1024
      );
      // Attribution of which BODY[] variant a FETCH command uses.
      // `bodyFullPartial` = the client sent `BODY[]<start.length>`, which
      // routes to `streamPartialFromSegments`; `bodyFullStream` = a full
      // `BODY[]` or `RFC822`, which routes to `streamFromSegments`. Both
      // walk the segment list rather than materializing text+html into the
      // V8 heap, so under an iOS retry storm this pair attributes RSS by
      // request shape, not by materialized-vs-streamed. Non-FETCH commands
      // set both to 0.
      let bodyFullPartial = 0;
      let bodyFullStream = 0;
      const collectBodyShapes = (r: ImapRequest): void => {
        if (r.type === "UID") { collectBodyShapes(r.data.request); return; }
        if (r.type !== "FETCH") return;
        for (const item of r.data.dataItems ?? []) {
          if (item.type === "BODY" && item.section.type === "FULL") {
            if (item.partial) bodyFullPartial += 1;
            else bodyFullStream += 1;
          } else if (item.type === "RFC822") {
            // RFC822 aliases BODY[] and has no partial-range form (RFC 3501
            // §6.4.5), so it always counts as a full fetch.
            bodyFullStream += 1;
          }
        }
      };
      collectBodyShapes(request);
      const payload = {
        component: "imap",
        tag,
        cmd: describeImapCommand(request),
        mailbox: session.selectedMailbox,
        remote: socket ? `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? 0}` : "?",
        rssBeforeMB: Math.round(rssBefore / 1_048_576),
        rssAfterMB: Math.round(rssAfter / 1_048_576),
        rssDeltaMB,
        heapUsedAfterMB: Math.round(memAfter.heapUsed / 1_048_576),
        heapTotalAfterMB: Math.round(memAfter.heapTotal / 1_048_576),
        externalAfterMB: Math.round(memAfter.external / 1_048_576),
        arrayBuffersAfterMB: Math.round(memAfter.arrayBuffers / 1_048_576),
        heapUsedDeltaKB,
        heapTotalDeltaKB,
        externalDeltaKB,
        arrayBuffersDeltaKB,
        bodyFullPartial,
        bodyFullStream,
        responseBytes,
        durationMs,
        waitedForBodyBudgetMs,
      };
      if (isInteresting) {
        logger.info("IMAP command completed", payload);
      } else {
        logger.debug("IMAP command completed", payload);
      }
    }
    });
  }

  /**
   * Handle UID commands by delegating to the appropriate sub-command with UID context
   */
  private async handleUidCommand(
    tag: string,
    data: { command: string; request: ImapRequest }
  ): Promise<void> {
    if (!this.session) {
      logger.error("Invalid session: Use setSocket to start a session", { component: "imap" });
      return;
    }

    // Handle the inner request but pass UID context to session methods
    const { command, request } = data;

    try {
      switch (request.type) {
        case "FETCH":
          await this.session.fetchMessagesTyped(tag, request.data, true);
          break;

        case "SEARCH":
          await this.session.searchTyped(tag, request.data, true);
          break;

        case "STORE":
          await this.session.storeFlagsTyped(tag, request.data, true);
          break;

        case "COPY":
          await this.session.copyMessageTyped(tag, request.data, true);
          break;

        case "MOVE":
          await this.session.moveMessageTyped(tag, request.data, true);
          break;

        default:
          this.session.write(`${tag} BAD UID ${command} not supported\r\n`);
          break;
      }
    } catch (error) {
      logger.error("Error handling UID command", { component: "imap", tag, command }, error);
      this.session.write(`${tag} BAD Internal server error\r\n`);
    }
  }
}
