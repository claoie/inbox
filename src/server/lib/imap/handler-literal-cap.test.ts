/**
 * Session-buffer ceilings.
 *
 * The drain loop held whatever a client declared. Two unauthenticated ways to
 * pin arbitrary heap on one TCP socket:
 *
 *  1) `a1 APPEND INBOX {999999999+}` — the drain waits for a gigabyte and
 *     holds every octet of it in the pending-literal state.
 *  2) A line that never terminates — no literal needed. `lineEnd === -1`
 *     returns, leaving everything buffered, and `buffer` grows until the
 *     process dies.
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
  };
  socket.writes = [];
  socket.writable = true;
  socket.destroyed = false;
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

function makeHarness(onRequest?: () => Promise<void>) {
  const handler = new ImapRequestHandler();
  const socket = makeMockSocket();
  const dispatched: { tag: string; request: ImapRequest }[] = [];
  handler.handleRequest = async (tag, request) => {
    dispatched.push({ tag, request });
    if (onRequest) await onRequest();
  };
  handler.setSocket(socket as never);
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
const LINE_CAP = 64 * 1024;
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

  it("gives APPEND a message-sized ceiling, not the small-argument one", async () => {
    const { socket, dispatched } = makeHarness();

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
    const { socket, dispatched } = makeHarness();

    // The issue's own repro shape: one socket, one declaration, a gigabyte of
    // heap. Refused on the declaration, before a single payload octet is held.
    socket.emit("data", Buffer.from("a1 APPEND INBOX {999999999+}\r\n"));
    await settle();

    expect(socket.writes).toEqual([
      `a1 NO [TOOBIG] Literal exceeds ${APPEND_CAP} octets\r\n`
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

describe("IMAP command-line ceiling", () => {
  it("ends the session on a line that never terminates", async () => {
    const { socket, dispatched } = makeHarness();

    // No literal is involved, so no literal cap bounds this. Before the cap,
    // `buffer` grew for as long as the peer kept writing.
    socket.emit("data", Buffer.from("A1 SELECT "));
    await settle();
    socket.emit("data", Buffer.alloc(LINE_CAP + 1, 0x41));
    await settle();

    expect(socket.writes).toEqual(["* BYE Command line too long\r\n"]);
    expect(socket.destroyed).toBe(true);
    expect(dispatched).toEqual([]);
  });

  it("leaves a long but legal command line alone", async () => {
    const { socket, dispatched } = makeHarness();

    // A UID set naming thousands of messages is a real command, not an attack.
    const uids = Array.from({ length: 4000 }, (_, i) => i + 1).join(",");
    expect(uids.length).toBeLessThan(LINE_CAP);
    socket.emit("data", Buffer.from(`A1 UID FETCH ${uids} (FLAGS)\r\n`));
    await settle();

    expect(socket.destroyed).toBe(false);
    expect(dispatched.map((d) => d.tag)).toEqual(["A1"]);
    expect(dispatched[0].request.type).toBe("UID");
  });

  it("ends the session while a command is parked mid-drain", async () => {
    let release = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { socket, dispatched } = makeHarness(() => parked);

    // The drain runs one command at a time, and every `await` in that loop —
    // the authentication-failure delay on a bad LOGIN, the pipeline throttle,
    // any DB round-trip — parks it while `data` events keep appending. That
    // window is exactly when an unauthenticated flood is cheapest, and a cap
    // that only runs inside the drain is not watching during it.
    socket.emit("data", Buffer.from("A1 NOOP\r\n"));
    await settle();
    expect(dispatched.map((d) => d.tag)).toEqual(["A1"]);

    socket.emit("data", Buffer.from("A2 SELECT "));
    socket.emit("data", Buffer.alloc(LINE_CAP + 1, 0x41));
    await settle();

    expect(socket.writes).toEqual(["* BYE Command line too long\r\n"]);
    expect(socket.destroyed).toBe(true);

    release();
    await settle();
  });

  it("does not fire the line cap while a large APPEND payload is arriving", async () => {
    const { socket, dispatched } = makeHarness();

    // An APPEND body is octets, not a command line, and it legitimately runs
    // past the line cap. The literal branch has to consume it before the line
    // splitter ever sees it.
    const message = "y".repeat(LINE_CAP + 4096);
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
    const { socket, dispatched } = makeHarness();

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
