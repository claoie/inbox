import type { Readable } from "stream";

/** An address from `MAIL FROM` or `RCPT TO`, with its ESMTP parameters. */
export interface SmtpAddress {
  /** Empty for the null reverse-path `<>`. */
  address: string;
  args: Record<string, string | true> | false;
}

export interface SmtpEnvelope {
  mailFrom: SmtpAddress | false;
  rcptTo: SmtpAddress[];
  bodyType: string;
  smtpUtf8: boolean;
  requireTLS: boolean;
}

export interface SmtpSession {
  id: string;
  remoteAddress: string;
  remotePort: number;
  localAddress: string;
  localPort: number;
  secure: boolean;
  /** The username `onAuth` answered with, once AUTH succeeded. */
  user?: string;
  /** The HELO/EHLO argument, lowercased. */
  hostNameAppearsAs?: string;
  envelope: SmtpEnvelope;
  transaction: number;
}

export interface SmtpAuthRequest {
  method: "PLAIN" | "LOGIN";
  username: string;
  password: string;
}

/** An error a hook answers with; `responseCode` picks the reply code. */
export type SmtpHookError = Error & { responseCode?: number };

export type SmtpCallback = (err?: SmtpHookError | null) => void;

export type SmtpAuthCallback = (
  err?: SmtpHookError | null,
  response?: { user?: string; message?: string; responseCode?: number }
) => void;

export interface SmtpServerOptions {
  /** Implicit TLS: the handshake runs before the greeting (port 465). */
  secure: boolean;
  /** Each connection starts with a PROXY protocol v1 header naming the client. */
  proxyProtocol?: boolean;
  /** Accept AUTH before STARTTLS on a cleartext connection. */
  allowInsecureAuth?: boolean;
  /** Server name for the greeting; the host name when unset. */
  name?: string;
  key?: Buffer;
  cert?: Buffer;
  minVersion?: "TLSv1.2" | "TLSv1.3";
  ciphers?: string;
  /** Advertised in EHLO and enforced against a `MAIL FROM ... SIZE=` declaration. */
  size: number;
  maxClients: number;
  /** How long `close` waits for open connections before answering them 421. */
  closeTimeout: number;
  /** Idle time after which a connection is answered 421 and closed. */
  socketTimeout?: number;
  onAuth: (auth: SmtpAuthRequest, session: SmtpSession, cb: SmtpAuthCallback) => void;
  onMailFrom: (address: SmtpAddress, session: SmtpSession, cb: SmtpCallback) => void;
  onRcptTo: (address: SmtpAddress, session: SmtpSession, cb: SmtpCallback) => void;
  /**
   * Receives the message (dot-unstuffed, terminator removed) as it arrives.
   * The reply goes out once `cb` has been called and `stream` has ended, so a
   * handler that refuses early must still read the stream out.
   */
  onData: (stream: Readable, session: SmtpSession, cb: SmtpCallback) => void;
}
