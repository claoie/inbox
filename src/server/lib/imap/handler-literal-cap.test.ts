/**
 * Session-buffer ceilings.
 *
 * The drain loop held whatever a client declared. Two unauthenticated ways to
 * pin arbitrary heap on one TCP socket:
 *
 *  1) `a1 APPEND INBOX {999999999+}` — the drain waits for a gigabyte and
 *     holds every octet of it in the pending-literal state.
 *  2) Command text the drain never consumes — no literal needed. `lineEnd
 *     === -1` returns, leaving everything buffered, and `buffer` grows until
 *     the process dies. Terminating every line does not help the server: what
 *     costs memory is octets held unread, and the drain spends most of a
 *     flood parked on the session's serial chain.
 *
 *  3) A chain of declarations, each individually under its own cap, whose
 *     payloads accumulate on the pending-literal state until the process
 *     dies — bounded by a link count AND by the octets actually held, since
 *     four large payloads outweigh sixty small ones.
 *
 * All of them fill the buffer before `LOGIN` is ever parsed, so the cost to an
 * attacker is one socket and the cost to everyone else is the whole IMAP
 * server. These tests pin the ceilings and, just as importantly, pin that
 * refusing a literal does not resurrect the credential-echo defect — the
 * octets of a refused LITERAL+ payload must be discarded, never re-read as
 * commands.
 */

import { describe, it, expect, spyOn } from "bun:test";
import { EventEmitter } from "events";
import "../push";
import { ImapRequestHandler } from "./handler";
import { ImapRequest } from "./types";
import { logger } from "server";

function makeMockSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    writes: string[];
    writable: boolean;
    destroyed: boolean;
    write: (data: string) => boolean;
    setTimeout: () => void;
    destroy: () => void;
    end: () => void;
    paused: boolean;
    pause: () => void;
    resume: () => void;
  };
  socket.writes = [];
  socket.writable = true;
  socket.destroyed = false;
  socket.paused = false;
  socket.pause = () => {
    socket.paused = true;
  };
  socket.resume = () => {
    socket.paused = false;
  };
  socket.write = (data: string) => {
    socket.writes.push(data);
    return true;
  };
  socket.setTimeout = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.end = () => {};
  return socket;
}

function makeHarness(onRequest?: () => Promise<void>, authenticated = false) {
  const handler = new ImapRequestHandler();
  const socket = makeMockSocket();
  const dispatched: { tag: string; request: ImapRequest }[] = [];
  handler.handleRequest = async (tag, request) => {
    dispatched.push({ tag, request });
    if (onRequest) await onRequest();
  };
  handler.setSocket(socket as never);
  // The message-sized APPEND ceiling is offered to an authenticated session
  // only, and `setSocket` owns the session — so the state is set on it
  // directly rather than by driving a LOGIN this harness has no store for.
  if (authenticated) {
    (
      handler as unknown as { session: { authenticated: boolean } }
    ).session.authenticated = true;
  }
  return { socket, dispatched };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
};

// Mirrors the constants in handler.ts. Deliberately re-stated rather than
// imported: a test that reads the same symbol it is checking cannot catch a
// cap being widened, which is the change these tests exist to gate.
const SMALL_CAP = 8 * 1024;
const APPEND_CAP = 35 * 1024 * 1024;
const UNCONSUMED_CAP = 64 * 1024;
const CHAIN_CAP = 64;
const PENDING_CAP = APPEND_CAP + 64 * 1024;

describe("IMAP literal ceiling", () => {
  it("refuses an over-cap synchronizing literal without prompting for it", async () => {
    const { socket, dispatched } = makeHarness();

    // Withholding the continuation is what keeps the payload off the wire
    // entirely — the client is still waiting for permission it never gets.
    socket.emit("data", Buffer.from(`A1 SELECT {${SMALL_CAP + 1}}\r\n`));
    await settle();

    expect(socket.writes).toEqual([
      `A1 NO [TOOBIG] Literal exceeds ${SMALL_CAP} octets\r\n`
    ]);
    expect(dispatched).toEqual([]);
    expect(socket.destroyed).toBe(false);
  });

  it("keeps serving the session after refusing a synchronizing literal", async () => {
    const { socket, dispatched } = makeHarness();

    // A conforming client sends no payload, so nothing may be swallowed —
    // discarding here would eat the client's NEXT command instead.
    socket.emit("data", Buffer.from(`A1 SELECT {${SMALL_CAP + 1}}\r\nA2 NOOP\r\n`));
    await settle();

    expect(dispatched.map((d) => d.tag)).toEqual(["A2"]);
    expect(dispatched[0].request.type).toBe("NOOP");
  });

  it("discards an over-cap LITERAL+ payload instead of accumulating it", async () => {
    const { socket, dispatched } = makeHarness();

    const declared = SMALL_CAP + 1024;
    socket.emit("data", Buffer.from(`A1 SELECT {${declared}+}\r\n`));
    await settle();
    expect(socket.writes).toEqual([
      `A1 NO [TOOBIG] Literal exceeds ${SMALL_CAP} octets\r\n`
    ]);

    // The octets are already in flight — they can only be counted out.
    socket.emit("data", Buffer.alloc(declared, 0x41));
    socket.emit("data", Buffer.from("\r\nA2 NOOP\r\n"));
    await settle();

    // Exactly one further dispatch, and it is the command that came AFTER the
    // refused one — the discarded payload produced no commands of its own.
    expect(dispatched.map((d) => d.tag)).toEqual(["A2"]);
    expect(socket.writes).toEqual([
      `A1 NO [TOOBIG] Literal exceeds ${SMALL_CAP} octets\r\n`
    ]);
  });

  it("counts a refused LITERAL+ payload out across TCP segments", async () => {
    const { socket, dispatched } = makeHarness();

    const declared = SMALL_CAP + 3000;
    socket.emit("data", Buffer.from(`A1 SELECT {${declared}+}\r\n`));
    await settle();

    // Arrives in pieces, as a multi-MB payload always would.
    let sent = 0;
    while (sent < declared) {
      const chunk = Math.min(1000, declared - sent);
      socket.emit("data", Buffer.alloc(chunk, 0x42));
      sent += chunk;
      await new Promise((r) => setTimeout(r, 1));
    }
    socket.emit("data", Buffer.from("\r\nA2 NOOP\r\n"));
    await settle();

    expect(dispatched.map((d) => d.tag)).toEqual(["A2"]);
  });

  it("never lets a refused LITERAL+ tail reach the journal or the wire", async () => {
    const debugSpy = spyOn(logger, "debug");
    try {
      const { socket, dispatched } = makeHarness();
      debugSpy.mockClear();

      // The credential-echo hazard, re-entered through the refusal path: if
      // the discard stopped at the payload and resumed the line splitter
      // mid-command, the remaining arguments would be parsed as a command of
      // their own — and for LOGIN those arguments are the credentials.
      const declared = SMALL_CAP + 16;
      socket.emit("data", Buffer.from(`A1 LOGIN {${declared}+}\r\n`));
      await settle();
      socket.emit("data", Buffer.alloc(declared, 0x43));
      socket.emit("data", Buffer.from(' "hunter2"\r\nA2 NOOP\r\n'));
      await settle();

      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain("hunter2");
      expect(JSON.stringify(socket.writes)).not.toContain("hunter2");
      expect(dispatched.map((d) => d.tag)).toEqual(["A2"]);
    } finally {
      debugSpy.mockRestore();
    }
  });

  it("gives an authenticated APPEND a message-sized ceiling, not the small-argument one", async () => {
    const { socket, dispatched } = makeHarness(undefined, true);

    // A real mail is far larger than any mailbox name or credential, so APPEND
    // has to clear the small cap that every other literal takes.
    const message = "x".repeat(SMALL_CAP + 4096);
    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${message.length}+}\r\n`));
    await settle();
    socket.emit("data", Buffer.from(message));
    await new Promise((r) => setTimeout(r, 1));
    socket.emit("data", Buffer.from("\r\n"));
    await settle();

    expect(dispatched).toHaveLength(1);
    if (dispatched[0].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[0].request.data.message).toBe(message);
    expect(socket.writes).toEqual([]);
  });

  it("refuses an APPEND past the message ceiling", async () => {
    const { socket, dispatched } = makeHarness(undefined, true);

    // The issue's own repro shape: one socket, one declaration, a gigabyte of
    // heap. Refused on the declaration, before a single payload octet is held.
    socket.emit("data", Buffer.from("a1 APPEND INBOX {999999999+}\r\n"));
    await settle();

    expect(socket.writes).toEqual([
      `a1 NO [TOOBIG] Literal exceeds ${APPEND_CAP} octets\r\n`
    ]);
    expect(dispatched).toEqual([]);
  });

  it("holds an unauthenticated APPEND to the small-argument ceiling", async () => {
    const { socket, dispatched } = makeHarness();

    // `imap/index.ts` admits IMAP_MAX_CONNECTIONS sockets and none of them has
    // to authenticate to declare, so the message-sized ceiling before LOGIN is
    // a per-process multiple of itself. It costs a conforming client nothing:
    // APPEND is answered `NO Not authenticated` at this point either way.
    const message = "x".repeat(SMALL_CAP + 4096);
    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${message.length}+}\r\n`));
    await settle();

    expect(socket.writes).toEqual([
      `a1 NO [TOOBIG] Literal exceeds ${SMALL_CAP} octets\r\n`
    ]);
    expect(dispatched).toEqual([]);
  });

  it("caps the second literal of a chain on the command's own verb and tag", async () => {
    const { socket, dispatched } = makeHarness();

    // The refusal has to read the verb and the tag off the command assembled so
    // far, not off the tail line that carries the declaration.
    socket.emit("data", Buffer.from("A1 LOGIN {5+}\r\n"));
    await settle();
    socket.emit("data", Buffer.from("admin"));
    await new Promise((r) => setTimeout(r, 1));
    socket.emit("data", Buffer.from(` {${SMALL_CAP + 1}}\r\n`));
    await settle();

    expect(socket.writes).toEqual([
      `A1 NO [TOOBIG] Literal exceeds ${SMALL_CAP} octets\r\n`
    ]);
    expect(dispatched).toEqual([]);
  });
});

describe("IMAP unread-command-text ceiling", () => {
  it("stops reading from a peer whose line never terminates", async () => {
    const { socket, dispatched } = makeHarness();

    // No literal is involved, so no literal cap bounds this. Before the bound,
    // `buffer` grew for as long as the peer kept writing.
    socket.emit("data", Buffer.from("A1 SELECT "));
    await settle();
    let written = 0;
    const chunk = Buffer.alloc(4096, 0x41);
    for (let i = 0; i < 64 && !socket.paused; i++) {
      socket.emit("data", chunk);
      written += chunk.length;
    }
    await settle();

    expect(socket.paused).toBe(true);
    expect(written).toBeLessThanOrEqual(UNCONSUMED_CAP + chunk.length);
    // Backpressure, not a verdict: the peer is told nothing and the session is
    // left for SOCKET_TIMEOUT_MS to end.
    expect(socket.writes).toEqual([]);
    expect(socket.destroyed).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("stops reading a flood whose every line terminates", async () => {
    let release = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { socket, dispatched } = makeHarness(() => parked);

    // The shape a per-LINE bound cannot see. Every line here is well under any
    // line ceiling and ends in CRLF, so the run past the last CRLF stays at
    // zero however long the flood lasts — while the drain, parked on the
    // session's serial chain, consumes none of it and `buffer` grows by every
    // octet the peer writes.
    socket.emit("data", Buffer.from("A1 NOOP\r\n"));
    await settle();
    expect(dispatched.map((d) => d.tag)).toEqual(["A1"]);

    const line = Buffer.from("A2 SELECT " + "x".repeat(1012) + "\r\n");
    let written = 0;
    for (let i = 0; i < 512 && !socket.paused; i++) {
      socket.emit("data", line);
      written += line.length;
    }

    expect(socket.paused).toBe(true);
    expect(written).toBeLessThanOrEqual(UNCONSUMED_CAP + line.length);
    expect(socket.destroyed).toBe(false);

    release();
    await settle();
  });

  it("stops reading while a command is parked mid-drain", async () => {
    let release = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { socket, dispatched } = makeHarness(() => parked);

    // The drain runs one command at a time, and every `await` in that loop —
    // the authentication-failure delay on a bad LOGIN, the pipeline throttle,
    // any DB round-trip, and since the drain runs inside `session.runSerial`
    // any task another writer put on that chain — parks it while `data` events
    // keep appending. That window is exactly when an unauthenticated flood is
    // cheapest, and a bound that only runs inside the drain is not watching
    // during it.
    socket.emit("data", Buffer.from("A1 NOOP\r\n"));
    await settle();
    expect(dispatched.map((d) => d.tag)).toEqual(["A1"]);

    socket.emit("data", Buffer.from("A2 SELECT "));
    socket.emit("data", Buffer.alloc(UNCONSUMED_CAP + 1, 0x41));
    await settle();

    expect(socket.paused).toBe(true);
    expect(socket.destroyed).toBe(false);

    release();
    await settle();
  });

  it("reads again once the drain has consumed what was held", async () => {
    let release = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let park = true;
    const { socket, dispatched } = makeHarness(async () => {
      if (park) await parked;
    });

    socket.emit("data", Buffer.from("A1 NOOP\r\n"));
    await settle();
    socket.emit("data", Buffer.from("A2 SELECT "));
    socket.emit("data", Buffer.alloc(UNCONSUMED_CAP + 1, 0x41));
    await settle();
    expect(socket.paused).toBe(true);

    // A pause no drain can lift would be a wedge, not backpressure: the client
    // that merely outran the drain has to be read again once it catches up.
    park = false;
    release();
    socket.emit("data", Buffer.from("\r\n"));
    await settle();

    expect(socket.paused).toBe(false);
    expect(socket.destroyed).toBe(false);
    expect(dispatched.map((d) => d.tag)).toEqual(["A1", "A2"]);
  });

  it("keeps the bound after an over-cap declaration armed the discard", async () => {
    const { socket, dispatched } = makeHarness();

    // Everything the bound excludes is a credit the peer gets to spend against
    // it, so the excluded term has to be one the peer cannot choose. The
    // discard counter is the refused declaration itself: crediting it would let
    // one unauthenticated line buy four gigabytes of exemption for the rest of
    // the connection, and the octets it excuses are ones being thrown away.
    socket.emit("data", Buffer.from("A1 LOGIN {4000000000+}\r\n"));
    await settle();
    expect(socket.writes).toEqual([
      `A1 NO [TOOBIG] Literal exceeds ${SMALL_CAP} octets\r\n`
    ]);

    // One synchronous burst: `data` is synchronous and the drain is not, so
    // nothing is consumed between these events — the same window a flood rides
    // on a real socket, without needing a park to open it.
    const chunk = Buffer.alloc(32 * 1024, 0x5a);
    let written = 0;
    for (let i = 0; i < 64 && !socket.paused; i++) {
      socket.emit("data", chunk);
      written += chunk.length;
    }

    expect(socket.paused).toBe(true);
    expect(written).toBeLessThanOrEqual(UNCONSUMED_CAP + chunk.length);

    // The discard is throttled, not wedged: the drain consumes what is held
    // and the socket is read again.
    await settle();
    expect(socket.paused).toBe(false);
    expect(socket.destroyed).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it("leaves a long but legal command line alone", async () => {
    const { socket, dispatched } = makeHarness();

    // A UID set naming thousands of messages is a real command, not an attack.
    const uids = Array.from({ length: 4000 }, (_, i) => i + 1).join(",");
    expect(uids.length).toBeLessThan(UNCONSUMED_CAP);
    socket.emit("data", Buffer.from(`A1 UID FETCH ${uids} (FLAGS)\r\n`));
    await settle();

    expect(socket.paused).toBe(false);
    expect(socket.destroyed).toBe(false);
    expect(dispatched.map((d) => d.tag)).toEqual(["A1"]);
    expect(dispatched[0].request.type).toBe("UID");
  });

  it("does not count an announced APPEND payload as unread command text", async () => {
    const { socket, dispatched } = makeHarness(undefined, true);

    // An APPEND body is octets, not a command line, and it legitimately runs
    // past the bound. The literal branch has to consume it before the line
    // splitter ever sees it.
    const message = "y".repeat(UNCONSUMED_CAP + 4096);
    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${message.length}+}\r\n`));
    await settle();
    socket.emit("data", Buffer.from(message));
    await new Promise((r) => setTimeout(r, 1));
    socket.emit("data", Buffer.from("\r\n"));
    await settle();

    expect(socket.destroyed).toBe(false);
    expect(dispatched).toHaveLength(1);
    if (dispatched[0].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[0].request.data.message).toBe(message);
  });

  it("delivers a fragmented APPEND whose declaration is queued behind a parked drain", async () => {
    let release = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let park = true;
    const { socket, dispatched } = makeHarness(async () => {
      if (park) {
        park = false;
        await parked;
      }
    }, true);

    // Until the drain reads the declaration the payload is not announced yet,
    // so it is indistinguishable from unread command text — and it arrives in
    // TCP-sized pieces, none of which carries a CRLF. A bound that ended the
    // session here would kill a conforming client on nothing but segmentation:
    // `session-utils.ts` emits unfolded base64, so every message this server
    // hands out and a client hands back has runs this long.
    const message = "z".repeat(200_000);
    socket.emit("data", Buffer.from("a1 NOOP\r\n"));
    await settle();

    socket.emit("data", Buffer.from(`a2 APPEND INBOX {${message.length}+}\r\n`));
    const fragments: Buffer[] = [];
    for (let i = 0; i < message.length; i += 32 * 1024) {
      fragments.push(Buffer.from(message.slice(i, i + 32 * 1024)));
    }
    fragments.push(Buffer.from("\r\n"));

    // A paused socket delivers nothing, so the fixture has to honour the pause
    // the way the kernel would — feeding through it is what would make this
    // test pass against a server that never applies backpressure at all.
    let pumped = 0;
    const pump = (async () => {
      for (let guard = 0; fragments.length > 0 && guard < 500; guard++) {
        if (socket.paused || socket.destroyed) {
          await new Promise((r) => setTimeout(r, 5));
          continue;
        }
        socket.emit("data", fragments.shift() as Buffer);
        pumped++;
        await new Promise((r) => setTimeout(r, 1));
      }
    })();

    await settle();
    expect(socket.paused).toBe(true);
    expect(pumped).toBeGreaterThan(0);
    expect(fragments.length).toBeGreaterThan(0);

    release();
    await pump;
    await settle();

    expect(socket.destroyed).toBe(false);
    expect(socket.writes).toEqual([]);
    expect(dispatched.map((d) => d.tag)).toEqual(["a1", "a2"]);
    if (dispatched[1].request.type !== "APPEND") throw new Error("Expected APPEND");
    expect(dispatched[1].request.data.message).toBe(message);
  });
});

describe("IMAP literal-chain ceiling", () => {
  it("ends the session on a literal chain no real command would send", async () => {
    const { socket, dispatched } = makeHarness();

    // Each declaration is individually under the per-literal cap, so nothing
    // above bounds the chain: `pendingLiterals` and `pendingCommand` just keep
    // growing. Only the header line of a command reaches the pipeline throttle,
    // so a chain is not paced either.
    socket.emit("data", Buffer.from("A1 LOGIN {1+}\r\n"));
    await settle();
    for (let i = 0; i < 200; i++) {
      socket.emit("data", Buffer.from(`x {1+}\r\n`));
      await new Promise((r) => setTimeout(r, 1));
      if (socket.destroyed) break;
    }
    await settle();

    expect(socket.writes).toEqual(["* BYE Command too long\r\n"]);
    expect(socket.destroyed).toBe(true);
    expect(dispatched).toEqual([]);
  });

  it("ends the session on chained payloads that outgrow the byte ceiling", async () => {
    const { socket, dispatched } = makeHarness(undefined, true);

    // The chain cap counts links, so a chain of tiny literals returns the same
    // verdict whether or not the BYTE ceiling is armed. This drives the shape
    // only the byte ceiling can catch: payloads large enough that the session
    // has to die while the link count is still single digits.
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x79);
    const declaration = Buffer.from(` {${payload.length}+}\r\n`);

    socket.emit("data", Buffer.from(`a1 APPEND INBOX {${payload.length}+}\r\n`));
    await settle();

    // Sending only as many links as the byte ceiling can hold is what makes
    // this fixture discriminate: the count cap cannot fire inside that many
    // links, so a session still alive at the end is a session whose byte
    // ceiling is inert.
    const linksToCeiling = Math.ceil(PENDING_CAP / payload.length);
    expect(linksToCeiling).toBeLessThan(CHAIN_CAP);

    // Each declaration rides in its payload's last segment, so the buffer is
    // never empty when the payload is consumed and the command is never
    // dispatched as complete. The verb stays APPEND, so every link inherits
    // the large per-literal cap and none of them is refused on its own size.
    for (let i = 0; i < linksToCeiling && !socket.destroyed; i++) {
      socket.emit("data", Buffer.concat([payload, declaration]));
      await settle();
    }

    expect(socket.writes).toEqual(["* BYE Command too long\r\n"]);
    expect(socket.destroyed).toBe(true);
    expect(dispatched).toEqual([]);
  });

  it("leaves a command with a real number of literals alone", async () => {
    const { socket, dispatched } = makeHarness();

    // LOGIN chains two — one per credential. The cap must sit far above the
    // shapes conforming clients actually send.
    for (const chunk of ["A1 LOGIN {5+}\r\n", "admin", " {8+}\r\n", "password\r\n"]) {
      socket.emit("data", Buffer.from(chunk));
      await new Promise((r) => setTimeout(r, 1));
    }
    await settle();

    expect(socket.destroyed).toBe(false);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].request).toEqual({
      type: "LOGIN",
      data: { username: "admin", password: "password" }
    });
  });
});
