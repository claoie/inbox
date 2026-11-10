import { isIP, Socket } from "net";
import { trustLoopbackAndPrivate } from "./http/request";

/** Where a connection came from. */
export interface Peer {
  address: string;
  port: number;
}

/**
 * Whether every mail connection (SMTP and IMAP) starts with a PROXY protocol
 * v1 header naming the client, as a TCP proxy in front of the server sends
 * it (nginx: `proxy_protocol on`). The header is then required.
 */
export const isProxyProtocolEnabled = () => process.env.PROXY_PROTOCOL === "true";

/** The longest v1 header the specification allows, CRLF included. */
const MAX_HEADER_BYTES = 107;
const HEADER_TIMEOUT_MS = 5000;

const unmapped = (address = "") => address.replace(/^::ffff:/i, "");

const isPort = (value: string) => /^(0|[1-9]\d{0,4})$/.test(value) && Number(value) <= 65535;

/**
 * Reads the client from a v1 header line (without its CRLF). `UNKNOWN` means
 * the proxy has no client to name, such as its own health check, so the
 * connection's own peer stands. Returns undefined for anything malformed.
 */
export const parseProxyHeader = (line: string, own: Peer): Peer | undefined => {
  const parts = line.split(" ");
  if (parts[0] !== "PROXY") return undefined;
  if (parts[1] === "UNKNOWN") return own;
  if (parts.length !== 6) return undefined;
  const [, family, source, destination, sourcePort, destinationPort] = parts;
  const version = family === "TCP4" ? 4 : family === "TCP6" ? 6 : 0;
  if (!version || isIP(source) !== version || isIP(destination) !== version) return undefined;
  if (!isPort(sourcePort) || !isPort(destinationPort)) return undefined;
  return { address: unmapped(source), port: Number(sourcePort) };
};

/**
 * Waits for the PROXY header at the start of `socket` and returns the client
 * it names. Bytes after the header are put back, so whatever reads the socket
 * next (a TLS handshake, or the protocol's own reader) starts on the client's
 * first byte. The socket is left paused; the caller resumes it once its reader
 * is attached.
 *
 * Rejects, leaving the socket to the caller, when the connection isn't from a
 * trusted proxy, the header is malformed or too long, or it doesn't arrive in
 * time.
 */
export const readProxyHeader = (socket: Socket, timeoutMs = HEADER_TIMEOUT_MS): Promise<Peer> =>
  new Promise((resolve, reject) => {
    const own = { address: unmapped(socket.remoteAddress), port: socket.remotePort ?? 0 };
    // A client anywhere else could name itself; only the proxy's network may.
    if (!trustLoopbackAndPrivate(own.address)) {
      reject(new Error(`PROXY header from untrusted address ${own.address}`));
      return;
    }

    let buffered = Buffer.alloc(0);
    const finish = (error: Error | undefined, peer?: Peer) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(peer!);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n");
      if (end < 0 || end + 2 > MAX_HEADER_BYTES) {
        if (buffered.length >= MAX_HEADER_BYTES) finish(new Error("PROXY header too long"));
        return;
      }
      const peer = parseProxyHeader(buffered.subarray(0, end).toString("latin1"), own);
      if (!peer) {
        finish(new Error("Malformed PROXY header"));
        return;
      }
      socket.pause();
      const rest = buffered.subarray(end + 2);
      if (rest.length) socket.unshift(rest);
      finish(undefined, peer);
    };
    const onClose = () => finish(new Error("Connection closed before its PROXY header"));
    const onError = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error("PROXY header timeout")), timeoutMs);

    socket.on("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });

/**
 * Makes `socket` report `peer` as its remote end, for the code that reads
 * `remoteAddress` and `remotePort` off the socket.
 */
export const setPeer = (socket: Socket, peer: Peer) => {
  Object.defineProperty(socket, "remoteAddress", { value: peer.address, configurable: true });
  Object.defineProperty(socket, "remotePort", { value: peer.port, configurable: true });
};
