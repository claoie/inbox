/**
 * Commands pipelined into the same TCP segment as STARTTLS must not survive the
 * upgrade (RFC 2595 §2.1, CVE-2011-0411 class).
 *
 * `startTls` swaps the socket from inside the previous socket's command drain,
 * and that drain closes over its own cleartext `buffer`. Without the generation
 * check in `ImapRequestHandler`, the rest of the attacker-controlled segment
 * keeps being dispatched after the swap — and its responses go out on the
 * victim's now-encrypted channel, which is what makes the injected command
 * indistinguishable from one the victim sent.
 *
 * Driven through the real `setSocket` data path rather than a session method,
 * because the defect lives in the loop, not in `startTls`.
 */

import { describe, it, expect } from "bun:test";
import { EventEmitter } from "events";
import { ImapRequestHandler } from "./handler";

/** Minimal duplex stand-in: emits `data`, records what was written. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  paused = false;
  written: string[] = [];
  write(data: string) {
    this.written.push(data);
    return true;
  }
  destroy() {
    this.destroyed = true;
  }
  setTimeout() {}
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("STARTTLS command pipelining", () => {
  it("drops cleartext commands buffered behind the socket swap", async () => {
    const handler = new ImapRequestHandler(false);
    const plain = new FakeSocket();
    handler.setSocket(plain as never);

    // Stand in for what `startTls` does at the end of a successful upgrade.
    const upgraded = new FakeSocket();
    const swap = () => handler.setSocket(upgraded as never);

    // One segment: a command that triggers the swap, then an injected command.
    // NOOP is used as the trigger so this test does not need TLS material —
    // the defect is in the drain loop, and any mid-loop swap exercises it.
    plain.emit("data", Buffer.from("a1 NOOP\r\na2 CAPABILITY\r\n"));
    swap();
    await flush();

    // The injected command must not be answered on either socket: not on the
    // cleartext one (the client has stopped reading it) and above all not on
    // the upgraded one, where it would look like the victim's own traffic.
    expect(upgraded.written.join("")).not.toContain("a2");
    expect(upgraded.written.join("")).not.toContain("CAPABILITY");
  });

  it("drops a command pipelined behind a literal-bearing STARTTLS", async () => {
    const handler = new ImapRequestHandler(false);
    const plain = new FakeSocket();
    handler.setSocket(plain as never);
    const upgraded = new FakeSocket();

    // A literal payload that carries its own terminator completes its command
    // and then falls through to read the rest of the line in the SAME loop
    // iteration, past the top-of-loop generation guard. Reaching that path
    // needs the swap to happen from inside the dispatch, which is where
    // `startTls` does it — so stand in for it here rather than swapping from
    // the outside, which lands before the fall-through instead of during it.
    const proto = handler as unknown as {
      handleRequest: (tag: string, request: { type?: string }) => Promise<void>;
    };
    const dispatched: string[] = [];
    const inner = proto.handleRequest.bind(handler);
    proto.handleRequest = async (tag, request) => {
      dispatched.push(String(request?.type));
      if (String(request?.type).toUpperCase().includes("STARTTLS")) {
        handler.setSocket(upgraded as never);
        return;
      }
      return inner(tag, request);
    };

    plain.emit("data", Buffer.from("A1 STARTTLS {0+}\r\nA2 CAPABILITY\r\n"));
    await flush();

    expect(dispatched).toEqual(["STARTTLS"]);
    expect(upgraded.written.join("")).not.toContain("A2");
    expect(upgraded.written.join("")).not.toContain("CAPABILITY");
  });

  it("drops a literal-declaring command pipelined behind a literal-bearing STARTTLS", async () => {
    const handler = new ImapRequestHandler(false);
    const plain = new FakeSocket();
    handler.setSocket(plain as never);
    const upgraded = new FakeSocket();

    // A tail that declares its own literal reaches the generation guard by the
    // fall-through rather than by absorption. The top-of-loop guard covers this
    // input too, so this holds the combined path rather than either guard alone.
    const proto = handler as unknown as {
      handleRequest: (tag: string, request: { type?: string }) => Promise<void>;
    };
    const dispatched: string[] = [];
    const inner = proto.handleRequest.bind(handler);
    proto.handleRequest = async (tag, request) => {
      dispatched.push(String(request?.type));
      if (String(request?.type).toUpperCase().includes("STARTTLS")) {
        handler.setSocket(upgraded as never);
        return;
      }
      return inner(tag, request);
    };

    plain.emit("data", Buffer.from("A1 STARTTLS {0+}\r\nA2 SELECT {5+}\r\nINBOX\r\n"));
    await flush();

    expect(dispatched).toEqual(["STARTTLS"]);
    expect(upgraded.written.join("")).not.toContain("A2");
    expect(upgraded.written.join("")).not.toContain("INBOX");
  });

  it("clears a half-finished SASL exchange across the swap", async () => {
    const handler = new ImapRequestHandler(false);
    const plain = new FakeSocket();
    handler.setSocket(plain as never);

    // An attacker's `AUTHENTICATE PLAIN` leaves the handler waiting for a
    // base64 continuation line. If that state survived the swap, the victim's
    // first encrypted command would be consumed as the response to it.
    handler.setPendingSaslTag("Z9");

    const upgraded = new FakeSocket();
    handler.setSocket(upgraded as never);
    upgraded.emit("data", Buffer.from("b1 CAPABILITY\r\n"));
    await flush();

    const answered = upgraded.written.join("");
    expect(answered).not.toContain("Z9");
    expect(answered).toContain("b1 OK CAPABILITY completed");
  });
});
