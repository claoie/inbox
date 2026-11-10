import { afterEach, describe, expect, it } from "bun:test";
import { connect, createServer, Server, Socket } from "net";
import { isTrustedProxy, parseProxyHeader, readProxyHeader } from "./proxy-protocol";

const own = { address: "10.0.0.2", port: 40000 };

describe("parseProxyHeader", () => {
  it("reads the client of a TCP4 and a TCP6 header", () => {
    expect(parseProxyHeader("PROXY TCP4 203.0.113.7 10.0.0.2 51000 25", own)).toEqual({
      address: "203.0.113.7",
      port: 51000
    });
    expect(parseProxyHeader("PROXY TCP6 2001:db8::7 fd00::2 51000 993", own)).toEqual({
      address: "2001:db8::7",
      port: 51000
    });
  });

  it("keeps the connection's own peer for UNKNOWN", () => {
    expect(parseProxyHeader("PROXY UNKNOWN", own)).toEqual(own);
    expect(parseProxyHeader("PROXY UNKNOWN ffff::1 ffff::2 1 2", own)).toEqual(own);
  });

  it("refuses anything malformed", () => {
    for (const line of [
      "",
      "EHLO mx.example",
      "PROXY",
      "PROXY TCP4 203.0.113.7 10.0.0.2 51000",
      "PROXY TCP4 203.0.113.7 10.0.0.2 51000 25 extra",
      "PROXY TCP4 2001:db8::7 10.0.0.2 51000 25",
      "PROXY TCP6 203.0.113.7 fd00::2 51000 25",
      "PROXY TCP4 203.0.113.256 10.0.0.2 51000 25",
      "PROXY TCP4 203.0.113.7 10.0.0.2 65536 25",
      "PROXY TCP4 203.0.113.7 10.0.0.2 051000 25",
      "PROXY TCP4 203.0.113.7 10.0.0.2 -1 25",
      "PROXY UDP4 203.0.113.7 10.0.0.2 51000 25",
      "proxy TCP4 203.0.113.7 10.0.0.2 51000 25"
    ]) {
      expect([line, parseProxyHeader(line, own)]).toEqual([line, undefined]);
    }
  });
});

describe("isTrustedProxy", () => {
  it("trusts loopback and private networks", () => {
    const trusted = [
      "127.0.0.1",
      "::ffff:127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "::1",
      "fd12:3456::1",
      "fc00::1"
    ];
    expect(trusted.filter((address) => !isTrustedProxy(address))).toEqual([]);
  });

  it("refuses public addresses, the edges of the private ranges, and non-addresses", () => {
    const untrusted = [
      "8.8.8.8",
      "::ffff:8.8.8.8",
      "172.15.255.255",
      "172.32.0.1",
      "192.169.0.1",
      "11.0.0.1",
      "2001:db8::1",
      "fc::1",
      "fe80::1",
      "",
      "localhost"
    ];
    expect(untrusted.filter((address) => isTrustedProxy(address))).toEqual([]);
  });
});

describe("readProxyHeader", () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((socket) => socket.destroy());
    await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
  });

  // A listener that reads the header off each connection, then collects what
  // the client sends after it.
  const listen = async (timeoutMs?: number) => {
    const results: Promise<{ peer?: unknown; error?: string; after: Promise<string> }>[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      results.push(
        readProxyHeader(socket, timeoutMs).then(
          (peer) => {
            const after = new Promise<string>((resolve) => {
              let text = "";
              socket.on("data", (chunk: Buffer) => {
                text += chunk.toString();
                if (text.endsWith("\n")) resolve(text);
              });
            });
            socket.resume();
            return { peer, after };
          },
          (error: Error) => ({ error: error.message, after: Promise.resolve("") })
        )
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const open = async (...writes: string[]) => {
      const client = connect(port, "127.0.0.1");
      sockets.push(client);
      client.on("error", () => {});
      await new Promise((resolve) => client.once("connect", resolve));
      for (const data of writes) {
        client.write(data);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      while (!results.length) await new Promise((resolve) => setTimeout(resolve, 5));
      return results.shift()!;
    };
    return { open };
  };

  it("returns the client and puts back what followed the header in the same write", async () => {
    const { open } = await listen();
    const result = await open("PROXY TCP4 203.0.113.7 10.0.0.2 51000 25\r\nEHLO early\r\n");
    expect(result.peer).toEqual({ address: "203.0.113.7", port: 51000 });
    expect(await result.after).toBe("EHLO early\r\n");
  });

  it("reads a header split across writes", async () => {
    const { open } = await listen();
    const result = await open("PROXY TCP4 203.0.", "113.7 10.0.0.2 51000 25\r", "\nA1 CAPABILITY\r\n");
    expect(result.peer).toEqual({ address: "203.0.113.7", port: 51000 });
    expect(await result.after).toBe("A1 CAPABILITY\r\n");
  });

  it("rejects a connection that starts without a header", async () => {
    const { open } = await listen();
    expect((await open("EHLO mx.example\r\n")).error).toBe("Malformed PROXY header");
  });

  it("rejects a header past the specification's length", async () => {
    const { open } = await listen();
    expect((await open("PROXY " + "x".repeat(120))).error).toBe("PROXY header too long");
  });

  it("rejects when no header arrives in time", async () => {
    const { open } = await listen(50);
    expect((await open()).error).toBe("PROXY header timeout");
  });

  it("rejects a connection from outside the private networks before reading", async () => {
    const socket = { remoteAddress: "8.8.8.8", remotePort: 1 } as Socket;
    await expect(readProxyHeader(socket)).rejects.toThrow("PROXY header from untrusted address 8.8.8.8");
  });
});
