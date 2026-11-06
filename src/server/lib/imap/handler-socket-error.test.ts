import { describe, it, expect, spyOn } from "bun:test";
import { EventEmitter } from "events";
// See handler-idle.test.ts: import push first so the idle-manager ↔ push ↔
// server-barrel import cycle initializes in production order.
import "../push";
import { logger } from "../logger";
import { ImapRequestHandler } from "./handler";

const socketFrom = (remoteAddress: string, remotePort: number) =>
  Object.assign(new EventEmitter(), {
    remoteAddress,
    remotePort,
    destroyed: false,
    writable: true,
    write: () => true,
    setTimeout: () => {},
    destroy: () => {},
    end: () => {}
  });

describe("IMAP socket errors", () => {
  const loggedContext = (failure: Error) => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const socket = socketFrom("203.0.113.7", 50123);
      new ImapRequestHandler().setSocket(socket as never);
      socket.emit("error", failure);
      return error.mock.calls.find(([message]) => message === "IMAP socket error")?.[1];
    } finally {
      error.mockRestore();
    }
  };

  it("names the peer that rejected the certificate", () => {
    const failure = new Error("error:10000412:SSL routines:OPENSSL_internal:SSLV3_ALERT_BAD_CERTIFICATE");
    expect(loggedContext(failure)).toEqual({ component: "imap", remote: "203.0.113.7:50123" });
  });

  it("keeps the peer out of every other socket error", () => {
    const failure = new Error("error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER");
    expect(loggedContext(failure)).toEqual({ component: "imap" });
  });
});
