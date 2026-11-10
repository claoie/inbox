import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import { connect as netConnect, Socket } from "net";
import os from "os";
import path from "path";
import type { Readable } from "stream";
import { connect as tlsConnect, TLSSocket } from "tls";
import { createSmtpServer, SmtpServer } from "./server";
import { evictSmtpConnections, registerSmtpServer, unregisterSmtpServer } from "../smtp-registry";
import type { SmtpServerOptions, SmtpSession } from "./types";

const servers: SmtpServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((r) => server.close(r))));
});

interface Delivery {
  session: SmtpSession;
  envelope: SmtpSession["envelope"];
  data: Buffer;
  ended: boolean;
}

const startServer = async (overrides: Partial<SmtpServerOptions> = {}) => {
  const deliveries: Delivery[] = [];
  const errors: (Error & { meta?: { stage?: string; remoteAddress?: string }; remoteAddress?: string })[] = [];
  const server = createSmtpServer({
    secure: false,
    name: "mx.test",
    size: 1024 * 1024,
    maxClients: 10,
    closeTimeout: 200,
    onAuth: (auth, _session, cb) =>
      cb(null, auth.username === "user" && auth.password === "pass" ? { user: "user" } : {}),
    onMailFrom: (_address, _session, cb) => cb(),
    onRcptTo: (_address, _session, cb) => cb(),
    onData: (stream: Readable, session, cb) => {
      const delivery: Delivery = {
        session,
        envelope: session.envelope,
        data: Buffer.alloc(0),
        ended: false
      };
      deliveries.push(delivery);
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        delivery.data = Buffer.concat(chunks);
        delivery.ended = true;
        cb();
      });
      stream.on("close", () => {
        if (!delivery.ended) delivery.data = Buffer.concat(chunks);
      });
    },
    ...overrides
  });
  server.on("error", (err) => errors.push(err));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };
  return { server, port, deliveries, errors };
};

/** A line-oriented SMTP client: `reply()` resolves with the next complete reply. */
const client = (socket: Socket) => {
  sockets.push(socket);
  let buffer = "";
  let closed = false;
  const waiters: Array<() => void> = [];
  const attach = (target: Socket) => {
    target.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      waiters.splice(0).forEach((wake) => wake());
    });
    target.on("close", () => {
      closed = true;
      waiters.splice(0).forEach((wake) => wake());
    });
    target.on("error", () => {});
  };
  attach(socket);

  const takeReply = (): string | undefined => {
    const lines = buffer.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join("\r\n");
        buffer = lines.slice(i + 1).join("\r\n");
        return reply;
      }
    }
    return undefined;
  };

  const self = {
    socket,
    write: (data: string | Buffer) => self.socket.write(data),
    reply: async (timeoutMs = 2000): Promise<string> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const reply = takeReply();
        if (reply !== undefined) return reply;
        if (closed) return "<closed>";
        if (Date.now() > deadline) return "<timeout>";
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    command: async (line: string) => {
      self.write(line + "\r\n");
      return self.reply();
    },
    isClosed: () => closed,
    upgrade: async () => {
      const secure = tlsConnect({ socket: self.socket, rejectUnauthorized: false });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", () => resolve());
        secure.once("error", reject);
      });
      sockets.push(secure);
      self.socket = secure;
      attach(secure);
    }
  };
  return self;
};

const connectTo = async (port: number) => {
  const c = client(netConnect(port, "127.0.0.1"));
  return c;
};

const greeted = async (port: number) => {
  const c = await connectTo(port);
  expect(await c.reply()).toBe("220 mx.test ESMTP");
  return c;
};

const MESSAGE = "Subject: hi\r\n\r\nbody\r\n";

describe("SMTP greeting and EHLO", () => {
  it("greets, then lists the extensions with the size ceiling", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    expect(await c.command("EHLO client.test")).toBe(
      [
        "250-mx.test Nice to meet you, [127.0.0.1]",
        "250-PIPELINING",
        "250-8BITMIME",
        "250-SMTPUTF8",
        "250-AUTH LOGIN PLAIN",
        `250 SIZE ${1024 * 1024}`
      ].join("\r\n")
    );
  });

  it("refuses a client that talks before the greeting", async () => {
    const { port } = await startServer();
    const c = await connectTo(port);
    c.write("EHLO early\r\n");
    expect(await c.reply()).toBe("421 mx.test You talk too soon");
  });

  it("refuses an HTTP request line", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    expect(await c.command("GET / HTTP/1.1")).toBe("421 HTTP requests not allowed");
  });

  it("requires HELO/EHLO before a transaction and checks its syntax", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("503 Error: send HELO/EHLO first");
    expect(await c.command("EHLO")).toBe("501 Error: syntax: EHLO hostname");
    expect(await c.command("HELO a b")).toBe("501 Error: Syntax: HELO hostname");
    expect(await c.command("HELO client")).toBe("250 mx.test Nice to meet you, [127.0.0.1]");
  });

  it("closes after ten unrecognized commands", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    for (let i = 0; i < 9; i++) {
      expect(await c.command(`XYZ${i}`)).toBe("500 Error: command not recognized");
    }
    expect(await c.command("XYZ9")).toBe("421 Error: too many unrecognized commands");
    expect(await c.reply()).toBe("<closed>");
  });

  it("refuses a command line past the length limit", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    c.write("NOOP " + "x".repeat(20 * 1024));
    expect(await c.reply()).toBe("421 Error: line too long");
  });
});

describe("SMTP transaction", () => {
  const transact = async (port: number) => {
    const c = await greeted(port);
    await c.command("EHLO client");
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("250 Accepted");
    expect(await c.command("RCPT TO:<b@y.org>")).toBe("250 Accepted");
    expect(await c.command("DATA")).toBe("354 End data with <CR><LF>.<CR><LF>");
    return c;
  };

  it("delivers the message dot-unstuffed, with the terminator removed", async () => {
    const { port, deliveries } = await startServer();
    const c = await transact(port);
    c.write("..leading dot\r\n.x\r\nlast\r\n.\r\n");
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(deliveries[0].data.toString()).toBe(".leading dot\r\n.x\r\nlast\r\n");
    expect(deliveries[0].envelope.mailFrom).toEqual({ address: "a@x.org", args: false });
    expect(deliveries[0].envelope.rcptTo).toEqual([{ address: "b@y.org", args: false }]);
  });

  it("finds the terminator split across writes", async () => {
    const { port, deliveries } = await startServer();
    const c = await transact(port);
    for (const piece of ["Subject: x\r\n\r\nbody\r", "\n", ".", "\r", "\n"]) {
      c.write(piece);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(deliveries[0].data.toString()).toBe("Subject: x\r\n\r\nbody\r\n");
  });

  it("answers pipelined commands in order, holding those after DATA until its reply", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { port } = await startServer({
      onData: (stream, _session, cb) => {
        stream.resume();
        stream.on("end", () => gate.then(() => cb()));
      }
    });
    const c = await greeted(port);
    c.write(`EHLO c\r\nMAIL FROM:<a@x.org>\r\nRCPT TO:<b@y.org>\r\nDATA\r\n`);
    expect(await c.reply()).toMatch(/^250-mx\.test/);
    expect(await c.reply()).toBe("250 Accepted");
    expect(await c.reply()).toBe("250 Accepted");
    expect(await c.reply()).toBe("354 End data with <CR><LF>.<CR><LF>");
    c.write(`${MESSAGE}.\r\nNOOP\r\n`);
    expect(await c.reply(300)).toBe("<timeout>");
    release();
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(await c.reply()).toBe("250 OK");
  });

  it("refuses a declared size over the ceiling at MAIL FROM", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    await c.command("EHLO c");
    expect(await c.command(`MAIL FROM:<a@x.org> SIZE=${1024 * 1024 + 1}`)).toBe(
      `552 Error: message exceeds fixed maximum message size ${1024 * 1024}`
    );
  });

  it("checks MAIL FROM syntax and parameters", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    await c.command("EHLO c");
    expect(await c.command("MAIL FROM:a@x.org")).toBe("501 Error: Bad sender address syntax");
    expect(await c.command("MAIL FROM:<a@x.org> BODY=BINARYMIME")).toBe(
      "501 Invalid BODY parameter value. Must be 7BIT or 8BITMIME"
    );
    expect(await c.command("MAIL FROM:<a@x.org> REQUIRETLS")).toBe(
      "530 REQUIRETLS not permitted on non-TLS connections"
    );
    expect(await c.command("MAIL FROM:<>")).toBe("250 Accepted");
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("503 Error: nested MAIL command");
  });

  it("checks RCPT TO ordering, syntax and the recipient limit", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    await c.command("EHLO c");
    expect(await c.command("RCPT TO:<b@y.org>")).toBe("503 Error: need MAIL command");
    await c.command("MAIL FROM:<a@x.org>");
    expect(await c.command("RCPT TO:<>")).toBe("501 Error: Bad recipient address syntax");
    for (let i = 0; i < 100; i++) await c.command(`RCPT TO:<r${i}@y.org>`);
    expect(await c.command("RCPT TO:<R0@Y.ORG>")).toBe("250 Accepted");
    expect(await c.command("RCPT TO:<r100@y.org>")).toBe("452 Error: too many recipients");
  });

  it("answers a hook's refusal with its response code", async () => {
    const refusal = Object.assign(new Error("5.1.1 no such mailbox"), { responseCode: 550 });
    const { port } = await startServer({ onRcptTo: (_address, _session, cb) => cb(refusal) });
    const c = await greeted(port);
    await c.command("EHLO c");
    await c.command("MAIL FROM:<a@x.org>");
    expect(await c.command("RCPT TO:<b@y.org>")).toBe("550 5.1.1 no such mailbox");
    expect(await c.command("DATA")).toBe("503 Error: need RCPT command");
  });

  it("answers a refused DATA transaction once the message has been read out", async () => {
    const refusal = Object.assign(new Error("too big"), { responseCode: 552 });
    const { port } = await startServer({
      onData: (stream, _session, cb) => {
        stream.resume();
        cb(refusal);
      }
    });
    const c = await transact(port);
    c.write(MESSAGE);
    expect(await c.reply(300)).toBe("<timeout>");
    c.write(".\r\n");
    expect(await c.reply()).toBe("552 too big");
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("250 Accepted");
  });

  it("forgets the envelope on RSET", async () => {
    const { port } = await startServer();
    const c = await transact(port);
    c.write(`${MESSAGE}.\r\n`);
    await c.reply();
    await c.command("MAIL FROM:<a@x.org>");
    await c.command("RCPT TO:<b@y.org>");
    expect(await c.command("RSET")).toBe("250 Flushed");
    expect(await c.command("DATA")).toBe("503 Error: need RCPT command");
  });

  it("closes the DATA stream without ending it when the client drops mid-message", async () => {
    const { port, deliveries } = await startServer();
    const c = await transact(port);
    c.write("Subject: partial\r\n\r\nsome of the bo");
    await new Promise((resolve) => setTimeout(resolve, 50));
    c.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deliveries[0].ended).toBe(false);
    expect(deliveries[0].data.toString()).toBe("Subject: partial\r\n\r\nsome of the bo");
  });

  it("ends DATA only at CRLF.CRLF, delivering bare LF and CR dot lines as content", async () => {
    const { port, deliveries } = await startServer();
    const c = await transact(port);
    const content =
      "Subject: x\r\n\r\nA\n.\r\nMAIL FROM:<smuggled@x.org>\r\n" +
      "B\r\n.\nRCPT TO:<smuggled@x.org>\r\nC\n.\nD\r.\rE\r\n";
    c.write(content + ".\r\nNOOP\r\n");
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(await c.reply()).toBe("250 OK");
    expect(await c.reply(300)).toBe("<timeout>");
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].data.toString()).toBe(content);
  });

  it("holds the sender back while the DATA consumer is not reading", async () => {
    let stream!: Readable;
    const { port } = await startServer({
      onData: (s, _session, cb) => {
        stream = s;
        s.on("end", () => cb());
      }
    });
    const c = await transact(port);
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const chunks = 64;
    for (let i = 0; i < chunks; i++) c.write(chunk);
    c.write("\r\n.\r\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    // What the server read ahead is a socket read or two, not the message.
    expect(stream.readableLength).toBeLessThan(1024 * 1024);
    let total = 0;
    stream.on("data", (piece: Buffer) => (total += piece.length));
    expect(await c.reply(5000)).toBe("250 OK: message queued");
    expect(total).toBe(chunks * chunk.length + 2);
  });
});

describe("SMTP AUTH", () => {
  const plain = (user: string, pass: string) =>
    Buffer.from(`\0${user}\0${pass}`).toString("base64");

  it("refuses AUTH in cleartext unless the listener allows it", async () => {
    const { port } = await startServer();
    const c = await greeted(port);
    await c.command("EHLO c");
    expect(await c.command(`AUTH PLAIN ${plain("user", "pass")}`)).toBe(
      "538 Error: Must issue a STARTTLS command first"
    );
  });

  it("authenticates PLAIN and LOGIN and refuses a second identity", async () => {
    const { port } = await startServer({ allowInsecureAuth: true });
    const c = await greeted(port);
    await c.command("EHLO c");
    expect(await c.command(`AUTH PLAIN ${plain("user", "wrong")}`)).toBe(
      "535 Error: Authentication credentials invalid"
    );
    expect(await c.command("AUTH LOGIN")).toBe("334 VXNlcm5hbWU6");
    expect(await c.command(Buffer.from("user").toString("base64"))).toBe("334 UGFzc3dvcmQ6");
    expect(await c.command(Buffer.from("pass").toString("base64"))).toBe(
      "235 Authentication successful"
    );
    expect(await c.command(`AUTH PLAIN ${plain("user", "pass")}`)).toBe(
      "503 Error: No identity changes permitted"
    );
    expect(await c.command("EHLO c")).not.toContain("AUTH");
  });

  it("handles the PLAIN continuation, abort and malformed tokens", async () => {
    const { port } = await startServer({ allowInsecureAuth: true });
    const c = await greeted(port);
    await c.command("EHLO c");
    expect(await c.command("AUTH PLAIN")).toBe("334 ");
    expect(await c.command("*")).toBe("501 Authentication aborted");
    expect(await c.command(`AUTH PLAIN ${Buffer.from("nonul").toString("base64")}`)).toBe(
      "500 Error: invalid userdata"
    );
    expect(await c.command("AUTH CRAM-MD5")).toBe("504 Error: Unrecognized authentication type");
  });

  it("answers an onAuth error with its code", async () => {
    const limited = Object.assign(new Error("Too many failed authentication attempts"), {});
    const { port } = await startServer({
      allowInsecureAuth: true,
      onAuth: (_auth, _session, cb) => cb(limited)
    });
    const c = await greeted(port);
    await c.command("EHLO c");
    expect(await c.command(`AUTH PLAIN ${plain("user", "pass")}`)).toBe(
      "535 Too many failed authentication attempts"
    );
  });
});

describe("SMTP credential eviction", () => {
  it("closes a live authenticated connection when its credential rotates", async () => {
    const { server, port } = await startServer({ allowInsecureAuth: true });
    registerSmtpServer(server);
    try {
      const authed = await greeted(port);
      const anonymous = await greeted(port);
      await authed.command("EHLO c");
      const token = Buffer.from("\0user\0pass").toString("base64");
      expect(await authed.command(`AUTH PLAIN ${token}`)).toBe("235 Authentication successful");

      expect(evictSmtpConnections("user")).toBe(1);
      expect(await authed.reply()).toBe("421 Credential changed, please re-authenticate");
      expect(await authed.reply()).toBe("<closed>");
      expect(await anonymous.command("NOOP")).toBe("250 OK");
    } finally {
      unregisterSmtpServer(server);
    }
  });
});

describe("SMTP reply backpressure", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("stops reading commands while the client is not reading its replies", async () => {
    const { server, port } = await startServer();
    const socket = netConnect(port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => {});
    let replies = 0;
    let tail = "";
    socket.on("data", (chunk: Buffer) => {
      const text = tail + chunk.toString("latin1");
      replies += text.split("\r\n").length - 1;
      tail = text.slice(text.lastIndexOf("\r\n") + 2);
    });
    await sleep(300);
    socket.pause();

    const commands = 1_000_000;
    socket.write("NOOP\r\n".repeat(commands));
    await sleep(1000);
    const [connection] = server.connections;
    // Without backpressure every reply to the flood would be queued here: ~8 MB.
    expect(connection["socket"].writableLength).toBeLessThan(256 * 1024);

    socket.resume();
    const deadline = Date.now() + 15000;
    while (replies < commands + 1 && Date.now() < deadline) await sleep(50);
    expect(replies).toBe(commands + 1);
  }, 20000);

  it("keeps a single close listener across repeated stalls", async () => {
    const { server, port } = await startServer();
    const socket = netConnect(port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => {});
    let received = 0;
    socket.on("data", (chunk: Buffer) => (received += chunk.length));
    await sleep(300);
    const [connection] = server.connections;
    let expected = received;
    for (let round = 0; round < 12; round++) {
      socket.pause();
      socket.write("NOOP\r\n".repeat(200_000));
      expected += 200_000 * "250 OK\r\n".length;
      await sleep(150);
      socket.resume();
      const deadline = Date.now() + 10000;
      while (received < expected && Date.now() < deadline) await sleep(10);
    }
    expect(received).toBe(expected);
    expect(connection["socket"].listenerCount("close")).toBeLessThanOrEqual(2);
  }, 60000);

  it("drops a connection that stops reading once the socket timeout passes", async () => {
    const { server, port } = await startServer({ socketTimeout: 500 });
    const socket = netConnect(port, "127.0.0.1");
    sockets.push(socket);
    socket.on("error", () => {});
    let closed = false;
    socket.on("close", () => (closed = true));
    await sleep(300);
    socket.pause();
    socket.write("NOOP\r\n".repeat(1_000_000));
    const deadline = Date.now() + 5000;
    while (server.connections.size && Date.now() < deadline) await sleep(50);
    expect(server.connections.size).toBe(0);
    socket.resume();
    socket.on("data", () => {});
    while (!closed && Date.now() < deadline) await sleep(50);
    expect(closed).toBe(true);
  }, 10000);
});

describe("SMTP limits and shutdown", () => {
  it("answers new commands 421 once closing, and closes idle ones at the deadline", async () => {
    const { server, port } = await startServer();
    const c = await greeted(port);
    const idle = await greeted(port);
    let closed = false;
    server.close(() => (closed = true));
    expect(await c.command("NOOP")).toBe("421 Server shutting down");
    expect(await idle.reply(1000)).toBe("421 Server shutting down");
    expect(closed).toBe(true);
    servers.splice(servers.indexOf(server), 1);
  });

  it("refuses connections past maxClients", async () => {
    const { port } = await startServer({ maxClients: 1 });
    await greeted(port);
    const extra = await connectTo(port);
    expect(await extra.reply()).toBe(
      "421 mx.test Too many connected clients, try again in a moment"
    );
  });

  it("closes a connection that stays idle past the socket timeout", async () => {
    const { port } = await startServer({ socketTimeout: 200 });
    const c = await greeted(port);
    expect(await c.reply(1000)).toBe("421 Timeout - closing connection");
  });
});

const tempCert = (() => {
  let cached: { key: Buffer; cert: Buffer } | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smtp-cert-"));
    const result = spawnSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem",
        "-days", "1", "-subj", "/CN=localhost"],
      { cwd: dir, stdio: "ignore" }
    );
    const read = (name: string) => fs.readFileSync(path.join(dir, name));
    cached = result.status === 0 ? { key: read("key.pem"), cert: read("cert.pem") } : null;
    fs.rmSync(dir, { recursive: true, force: true });
    return cached;
  };
})();

// A real key pair needs the openssl CLI; without it these are covered by E2E.
describe.skipIf(!tempCert())("SMTP over TLS", () => {
  const tlsOptions = () => ({ ...tempCert()!, minVersion: "TLSv1.2" as const });

  it("offers STARTTLS and discards plaintext pipelined after it", async () => {
    const { port, deliveries } = await startServer(tlsOptions());
    const c = await greeted(port);
    expect(await c.command("EHLO c")).toContain("250-STARTTLS");
    c.write("STARTTLS\r\nMAIL FROM:<injected@x.org>\r\nRCPT TO:<b@y.org>\r\n");
    expect(await c.reply()).toBe("220 Ready to start TLS");
    await c.upgrade();
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("503 Error: send HELO/EHLO first");
    const ehlo = await c.command("EHLO c");
    expect(ehlo).not.toContain("STARTTLS");
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("250 Accepted");
    expect(await c.command("RCPT TO:<b@y.org>")).toBe("250 Accepted");
    expect(await c.command("DATA")).toBe("354 End data with <CR><LF>.<CR><LF>");
    c.write(`${MESSAGE}.\r\n`);
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(deliveries[0].envelope.mailFrom).toEqual({ address: "a@x.org", args: false });
    expect(deliveries[0].session.secure).toBe(true);
    expect(await c.command("STARTTLS")).toBe("503 Error: TLS already active");
  });

  it("runs the handshake before the greeting on an implicit-TLS listener", async () => {
    const { port } = await startServer({ ...tlsOptions(), secure: true });
    const socket = tlsConnect({ port, host: "127.0.0.1", rejectUnauthorized: false }) as TLSSocket;
    const c = client(socket);
    expect(await c.reply()).toBe("220 mx.test ESMTP");
    expect(await c.command("EHLO c")).not.toContain("STARTTLS");
  });

  it("reports a failed implicit-TLS handshake tagged as pre-session", async () => {
    const { port, errors } = await startServer({ ...tlsOptions(), secure: true });
    const c = await connectTo(port);
    c.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    await c.reply(500);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].meta?.stage).toBe("connect");
    expect(errors[0].meta?.remoteAddress).toBe("127.0.0.1");
  });

  it("reports a failed STARTTLS handshake with the peer on the error", async () => {
    const { port, errors } = await startServer(tlsOptions());
    const c = await greeted(port);
    await c.command("EHLO client.example");
    await c.command("STARTTLS");
    c.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    await c.reply(500);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].remoteAddress).toBe("127.0.0.1");
  });
});

describe("SMTP behind a PROXY protocol proxy", () => {
  const HEADER = "PROXY TCP4 203.0.113.7 10.0.0.2 51000 25\r\n";

  it("takes the client from the header for the session and the EHLO reply", async () => {
    const { port, deliveries } = await startServer({ proxyProtocol: true });
    const c = await connectTo(port);
    c.write(HEADER);
    expect(await c.reply()).toBe("220 mx.test ESMTP");
    expect(await c.command("EHLO c")).toContain("[203.0.113.7]");
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("250 Accepted");
    expect(await c.command("RCPT TO:<b@y.org>")).toBe("250 Accepted");
    expect(await c.command("DATA")).toBe("354 End data with <CR><LF>.<CR><LF>");
    c.write(`${MESSAGE}.\r\n`);
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(deliveries[0].session.remoteAddress).toBe("203.0.113.7");
    expect(deliveries[0].session.remotePort).toBe(51000);
  });

  it("drops a connection that doesn't start with a header, without reporting it", async () => {
    const { port, errors } = await startServer({ proxyProtocol: true });
    const c = await connectTo(port);
    c.write("EHLO c\r\n");
    expect(await c.reply()).toBe("<closed>");
    expect(errors).toEqual([]);
  });

  it("still refuses a client that talks before the greeting", async () => {
    const { port } = await startServer({ proxyProtocol: true });
    const c = await connectTo(port);
    c.write(HEADER + "EHLO early\r\n");
    expect(await c.reply()).toBe("421 mx.test You talk too soon");
  });
});

describe.skipIf(!tempCert())("SMTP over TLS behind a PROXY protocol proxy", () => {
  const tlsOptions = () => ({ ...tempCert()!, minVersion: "TLSv1.2" as const });

  it("runs the implicit-TLS handshake after the header, even sent in one write with the ClientHello", async () => {
    const { port, deliveries } = await startServer({ ...tlsOptions(), secure: true, proxyProtocol: true });
    const raw = netConnect(port, "127.0.0.1");
    await new Promise((resolve) => raw.once("connect", resolve));
    raw.cork();
    raw.write("PROXY TCP6 2001:db8::7 fd00::2 51000 465\r\n");
    const socket = tlsConnect({ socket: raw, rejectUnauthorized: false }) as TLSSocket;
    process.nextTick(() => raw.uncork());
    const c = client(socket);
    expect(await c.reply()).toBe("220 mx.test ESMTP");
    expect(await c.command("EHLO c")).toContain("[2001:db8::7]");
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("250 Accepted");
    expect(await c.command("RCPT TO:<b@y.org>")).toBe("250 Accepted");
    expect(await c.command("DATA")).toBe("354 End data with <CR><LF>.<CR><LF>");
    c.write(`${MESSAGE}.\r\n`);
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(deliveries[0].session.remoteAddress).toBe("2001:db8::7");
    expect(deliveries[0].session.secure).toBe(true);
  });

  it("keeps the client from the header after STARTTLS", async () => {
    const { port, deliveries } = await startServer({ ...tlsOptions(), proxyProtocol: true });
    const c = await connectTo(port);
    c.write("PROXY TCP4 203.0.113.7 10.0.0.2 51000 587\r\n");
    expect(await c.reply()).toBe("220 mx.test ESMTP");
    await c.command("EHLO c");
    expect(await c.command("STARTTLS")).toBe("220 Ready to start TLS");
    await c.upgrade();
    await c.command("EHLO c");
    expect(await c.command("MAIL FROM:<a@x.org>")).toBe("250 Accepted");
    expect(await c.command("RCPT TO:<b@y.org>")).toBe("250 Accepted");
    expect(await c.command("DATA")).toBe("354 End data with <CR><LF>.<CR><LF>");
    c.write(`${MESSAGE}.\r\n`);
    expect(await c.reply()).toBe("250 OK: message queued");
    expect(deliveries[0].session.remoteAddress).toBe("203.0.113.7");
    expect(deliveries[0].session.secure).toBe(true);
  });
});
