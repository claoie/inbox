import { EventEmitter } from "events";
import { createServer, Server, Socket } from "net";
import { hostname } from "os";
import { createSecureContext, SecureContext, TLSSocket } from "tls";
import { logger } from "../logger";
import { Peer, readProxyHeader } from "../proxy-protocol";
import { SmtpConnection } from "./connection";
import type { SmtpServerOptions } from "./types";

/** How long an implicit-TLS client may take to complete its handshake. */
const HANDSHAKE_TIMEOUT_MS = 60 * 1000;

/** Context attached to a TLS handshake failure, mirroring where it happened. */
export interface HandshakeErrorMeta {
  protocol: "smtp";
  stage: "connect";
  remoteAddress?: string;
}

/**
 * An SMTP listener: one TCP server whose connections are run by
 * {@link SmtpConnection}. Emits `error` for connection failures worth
 * reporting and `close` once the listener has shut down.
 */
export class SmtpServer extends EventEmitter {
  readonly connections = new Set<SmtpConnection>();
  readonly secureContext?: SecureContext;
  readonly name: string;
  private readonly server: Server;
  private readonly handshaking = new Set<Socket>();
  private closeTimer?: ReturnType<typeof setTimeout>;

  constructor(readonly options: SmtpServerOptions) {
    super();
    this.name = options.name ?? hostname();
    if (options.key && options.cert) {
      this.secureContext = createSecureContext({
        key: options.key,
        cert: options.cert,
        minVersion: options.minVersion,
        ciphers: options.ciphers
      });
    }
    this.server = createServer((socket) => this.accept(socket));
    this.server.on("error", (err) => this.emit("error", err));
    this.server.once("close", () => this.emit("close"));
  }

  get tlsAvailable(): boolean {
    return !!this.secureContext;
  }

  /** True once {@link close} has been called: new commands are answered 421. */
  get isClosing(): boolean {
    return !!this.closeTimer;
  }

  listen(port: number, callback: () => void): void {
    this.server.listen(port, callback);
  }

  address() {
    return this.server.address();
  }

  /**
   * Stops accepting connections and calls `callback` once every open one has
   * ended, or after `closeTimeout` — whichever comes first. Connections still
   * open at the deadline are answered `421 Server shutting down` and closed.
   */
  close(callback?: () => void): void {
    let done = callback;
    const finish = () => {
      const fn = done;
      done = undefined;
      fn?.();
    };
    this.server.close(() => {
      clearTimeout(this.closeTimer);
      finish();
    });
    this.closeTimer = setTimeout(() => {
      this.connections.forEach((connection) => {
        connection.send(421, "Server shutting down");
        connection.close();
      });
      this.handshaking.forEach((socket) => socket.destroy());
      finish();
    }, this.options.closeTimeout);
    this.closeTimer.unref();
  }

  /** Tags a TLS handshake failure so listeners can tell it from a mid-session error. */
  handshakeError(err: Error | undefined, remoteAddress?: string): Error {
    const error: Error & { meta?: HandshakeErrorMeta; code?: string } = err?.message
      ? err
      : Object.assign(new Error("Socket closed while initiating TLS"), { code: "SocketError" });
    error.meta = { protocol: "smtp", stage: "connect", remoteAddress };
    return error;
  }

  private accept(socket: Socket): void {
    socket.on("error", () => {});
    const own = {
      address: (socket.remoteAddress ?? "").replace(/^::ffff:/, ""),
      port: socket.remotePort ?? 0
    };
    if (!this.options.proxyProtocol) {
      this.start(socket, own);
      return;
    }
    this.handshaking.add(socket);
    readProxyHeader(socket).then(
      (peer) => {
        this.handshaking.delete(socket);
        this.start(socket, peer);
      },
      (err: Error) => {
        this.handshaking.delete(socket);
        socket.destroy();
        logger.warn("SMTP: connection dropped before its PROXY header", {
          component: "smtp",
          from: own.address,
          reason: err.message
        });
      }
    );
  }

  private start(socket: Socket, peer: Peer): void {
    const remote = {
      address: peer.address,
      port: peer.port,
      local: (socket.localAddress ?? "").replace(/^::ffff:/, ""),
      localPort: socket.localPort ?? 0
    };
    if (!this.options.secure) {
      this.connect(socket, remote);
      socket.resume();
      return;
    }
    if (!this.secureContext) {
      socket.destroy();
      return;
    }

    this.handshaking.add(socket);
    const secureSocket = new TLSSocket(socket, {
      isServer: true,
      secureContext: this.secureContext
    });
    let settled = false;
    const fail = (err?: Error) => {
      if (settled) return;
      settled = true;
      this.handshaking.delete(socket);
      secureSocket.destroy();
      this.emit("error", this.handshakeError(err, remote.address));
    };
    const onError = (err: Error) => fail(err);
    const onClose = () => fail();
    const onTimeout = () => fail(new Error("TLS handshake timeout"));
    secureSocket.once("error", onError);
    secureSocket.once("close", onClose);
    secureSocket.setTimeout(HANDSHAKE_TIMEOUT_MS, onTimeout);
    secureSocket.once("secure", () => {
      if (settled) return;
      settled = true;
      this.handshaking.delete(socket);
      secureSocket.removeListener("error", onError);
      secureSocket.removeListener("close", onClose);
      secureSocket.removeListener("timeout", onTimeout);
      secureSocket.setTimeout(0);
      this.connect(secureSocket, remote);
    });
  }

  private connect(socket: Socket, remote: ConstructorParameters<typeof SmtpConnection>[2]): void {
    const connection = new SmtpConnection(this, socket, remote);
    this.connections.add(connection);
    connection.init();
  }
}

/** Creates an SMTP listener; call `listen` to start it. */
export const createSmtpServer = (options: SmtpServerOptions): SmtpServer => new SmtpServer(options);
