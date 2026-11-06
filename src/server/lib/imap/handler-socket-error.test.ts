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
  it("names the peer whose handshake failed", () => {
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const socket = socketFrom("203.0.113.7", 50123);
      new ImapRequestHandler().setSocket(socket as never);
      socket.emit("error", new Error("SSLV3_ALERT_BAD_CERTIFICATE"));

      const call = error.mock.calls.find(([message]) => message === "IMAP socket error");
      expect(call?.[1]).toEqual({ component: "imap", remote: "203.0.113.7:50123" });
    } finally {
      error.mockRestore();
    }
  });
});
