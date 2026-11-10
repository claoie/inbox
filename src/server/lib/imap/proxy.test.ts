import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import fs from "fs";
import { connect, createServer, Server, Socket } from "net";
import os from "os";
import path from "path";
import { connect as tlsConnect, createSecureContext, Server as TlsServer, TLSSocket } from "tls";
import { createTlsEnvFixture } from "test-helpers";
import { setPeer } from "../proxy-protocol";
import { acceptProxied, createImapServer } from "./index";
import { ImapSession } from "./session";

const HEADER = "PROXY TCP4 203.0.113.7 10.0.0.2 51000 143\r\n";

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.destroy());
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

const listen = async (onConnection: (socket: Socket) => void) => {
  const server = createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
};

const open = async (port: number) => {
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  return socket;
};

const readLine = (socket: Socket) =>
  new Promise<string>((resolve) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (!text.endsWith("\r\n")) return;
      socket.off("data", onData);
      resolve(text);
    };
    socket.on("data", onData);
  });

/** The listener IMAP hands each connection to, reduced to what it sees. */
const recordingListener = () => {
  const seen: { address?: string; port?: number; secure: boolean; line: Promise<string> }[] = [];
  const listener = (socket: Socket) => {
    seen.push({
      address: socket.remoteAddress,
      port: socket.remotePort,
      secure: socket instanceof TLSSocket,
      line: readLine(socket)
    });
    socket.write("* OK ready\r\n");
  };
  return { seen, listener };
};

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("createImapServer", () => {
  const original = process.env.PROXY_PROTOCOL;
  afterEach(() => {
    if (original === undefined) delete process.env.PROXY_PROTOCOL;
    else process.env.PROXY_PROTOCOL = original;
  });

  const serve = async (server: Server) => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
  };

  it("hands a connection straight to IMAP when PROXY_PROTOCOL is unset", async () => {
    delete process.env.PROXY_PROTOCOL;
    const { seen, listener } = recordingListener();
    const port = await serve(createImapServer(listener));
    const client = await open(port);
    expect(await readLine(client)).toBe("* OK ready\r\n");
    expect(seen[0].address).toBe("127.0.0.1");
  });

  it("waits for the PROXY header when PROXY_PROTOCOL is true", async () => {
    process.env.PROXY_PROTOCOL = "true";
    const { seen, listener } = recordingListener();
    const port = await serve(createImapServer(listener));
    const client = await open(port);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen).toEqual([]);
    const greeting = readLine(client);
    client.write(HEADER);
    expect(await greeting).toBe("* OK ready\r\n");
    expect(seen[0].address).toBe("203.0.113.7");
  });
});

describe("IMAP behind a PROXY protocol proxy", () => {
  it("hands over the socket reporting the header's client, with what followed the header", async () => {
    const { seen, listener } = recordingListener();
    const port = await listen(acceptProxied(listener));
    const client = await open(port);
    const greeting = readLine(client);
    client.write(HEADER + "A1 NOOP\r\n");
    expect(await greeting).toBe("* OK ready\r\n");
    expect(seen).toHaveLength(1);
    expect(seen[0].address).toBe("203.0.113.7");
    expect(seen[0].port).toBe(51000);
    expect(seen[0].secure).toBe(false);
    expect(await seen[0].line).toBe("A1 NOOP\r\n");
  });

  it("closes a connection that doesn't start with a header, never reaching IMAP", async () => {
    const { seen, listener } = recordingListener();
    const port = await listen(acceptProxied(listener));
    const client = await open(port);
    const closed = new Promise((resolve) => client.once("close", resolve));
    client.write("A1 CAPABILITY\r\n");
    await closed;
    expect(seen).toEqual([]);
  });
});

const tempCert = (() => {
  let cached: { dir: string; key: Buffer; cert: Buffer } | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imap-proxy-cert-"));
    const result = spawnSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem",
        "-days", "1", "-subj", "/CN=localhost"],
      { cwd: dir, stdio: "ignore" }
    );
    const read = (name: string) => fs.readFileSync(path.join(dir, name));
    cached = result.status === 0 ? { dir, key: read("key.pem"), cert: read("cert.pem") } : null;
    return cached;
  };
})();

// A real key pair needs the openssl CLI; without it these are covered by E2E.
describe.skipIf(!tempCert())("IMAP over TLS behind a PROXY protocol proxy", () => {
  let ssl: ReturnType<typeof createTlsEnvFixture>;

  beforeAll(() => {
    ssl = createTlsEnvFixture();
  });

  afterEach(() => ssl.restore());

  afterAll(() => {
    ssl.cleanup();
    fs.rmSync(tempCert()!.dir, { recursive: true, force: true });
  });

  it("runs the implicit-TLS handshake after the header, even sent in one write with the ClientHello", async () => {
    const { seen, listener } = recordingListener();
    const { key, cert } = tempCert()!;
    const port = await listen(acceptProxied(listener, createSecureContext({ key, cert })));
    const raw = await open(port);
    raw.cork();
    raw.write("PROXY TCP6 2001:db8::7 fd00::2 51000 993\r\n");
    const client = tlsConnect({ socket: raw, rejectUnauthorized: false });
    sockets.push(client);
    process.nextTick(() => raw.uncork());
    expect(await readLine(client)).toBe("* OK ready\r\n");
    expect(seen[0].address).toBe("2001:db8::7");
    expect(seen[0].secure).toBe(true);
    client.write("A1 NOOP\r\n");
    expect(await seen[0].line).toBe("A1 NOOP\r\n");
  });

  it("runs the TLS handshake after the header on the implicit-TLS listener when PROXY_PROTOCOL is true", async () => {
    const original = process.env.PROXY_PROTOCOL;
    process.env.PROXY_PROTOCOL = "true";
    try {
      const { seen, listener } = recordingListener();
      const { key, cert } = tempCert()!;
      const server = createImapServer(listener, { key, cert });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as { port: number }).port;
      const raw = await open(port);
      raw.write("PROXY TCP4 203.0.113.7 10.0.0.2 51000 993\r\n");
      const client = tlsConnect({ socket: raw, rejectUnauthorized: false });
      sockets.push(client);
      expect(await readLine(client)).toBe("* OK ready\r\n");
      expect(seen[0].secure).toBe(true);
      expect(seen[0].address).toBe("203.0.113.7");
    } finally {
      if (original === undefined) delete process.env.PROXY_PROTOCOL;
      else process.env.PROXY_PROTOCOL = original;
    }
  });

  it("serves TLS from the first byte unless PROXY_PROTOCOL is true", () => {
    const original = process.env.PROXY_PROTOCOL;
    const { key, cert } = tempCert()!;
    try {
      delete process.env.PROXY_PROTOCOL;
      expect(createImapServer(() => {}, { key, cert })).toBeInstanceOf(TlsServer);
      process.env.PROXY_PROTOCOL = "true";
      expect(createImapServer(() => {}, { key, cert })).not.toBeInstanceOf(TlsServer);
    } finally {
      if (original === undefined) delete process.env.PROXY_PROTOCOL;
      else process.env.PROXY_PROTOCOL = original;
    }
  });

  it("keeps the client the socket reported across STARTTLS", async () => {
    const { dir } = tempCert()!;
    ssl.use(path.join(dir, "cert.pem"), path.join(dir, "key.pem"));
    const upgraded: TLSSocket[] = [];
    const port = await listen((socket) => {
      setPeer(socket, { address: "203.0.113.7", port: 51000 });
      const handler = { isTls: false, setSocket: (s: TLSSocket) => upgraded.push(s) };
      new ImapSession(handler as never, socket).startTls("A1");
    });
    const raw = await open(port);
    expect(await readLine(raw)).toBe("A1 OK Begin TLS negotiation now\r\n");
    await until(() => upgraded.length > 0);
    expect(upgraded[0].remoteAddress).toBe("203.0.113.7");
    const client = tlsConnect({ socket: raw, rejectUnauthorized: false });
    sockets.push(client);
    client.on("error", () => {});
    await new Promise((resolve) => upgraded[0].once("secure", resolve));
    expect(upgraded[0].remoteAddress).toBe("203.0.113.7");
    expect(upgraded[0].remotePort).toBe(51000);
  });
});
