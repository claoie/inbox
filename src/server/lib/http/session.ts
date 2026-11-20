import crypto from "crypto";
import { RuntimeCookie, RuntimeSessionType, SignedUser, SsoSessionType } from "common";

export const SESSION_COOKIE_NAME = "connect.sid";

const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7;

/** How long a live session's expiry may lag a full window before a request slides it. */
export const SESSION_RENEW_INTERVAL_MS = 1000 * 60 * 60;

/** Where sessions persist between requests. */
export interface SessionStore {
  /** Resolves null for an unknown or expired id; rejects on a store fault. */
  get(sessionId: string): Promise<RuntimeSessionType | null>;
  set(sessionId: string, session: RuntimeSessionType): Promise<void>;
  /** Moves a stored session's expiry and nothing else; an unknown id is left absent. */
  touch(sessionId: string, expires: Date): Promise<void>;
  destroy(sessionId: string): Promise<void>;
}

const sign = (value: string, secret: string) =>
  `${value}.${crypto.createHmac("sha256", secret).update(value).digest("base64").replace(/=+$/, "")}`;

/**
 * The session id inside a signed cookie value (`s:<id>.<signature>`), or
 * undefined when the value is unsigned or its signature does not verify.
 */
export const unsignSessionCookie = (value: string, secret: string): string | undefined => {
  if (!value.startsWith("s:")) return undefined;
  const input = value.slice(2);
  const candidate = input.slice(0, input.lastIndexOf("."));
  const expected = new TextEncoder().encode(sign(candidate, secret));
  const provided = new TextEncoder().encode(input);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided)
    ? candidate
    : undefined;
};

export const signSessionCookie = (sessionId: string, secret: string) => `s:${sign(sessionId, secret)}`;

const decodeCookieValue = (value: string) => {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The first cookie of `name` in a Cookie header, unquoted and decoded. */
export const readCookie = (header: string | null, name: string): string | undefined => {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== name) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return decodeCookieValue(value);
  }
  return undefined;
};

const generateSessionId = () => crypto.randomBytes(24).toString("base64url");

const fingerprint = (user: SignedUser | undefined, auth: SsoSessionType | undefined) =>
  JSON.stringify([user ?? null, auth ?? null]);

export interface SessionOptions {
  secret: string;
  /** Sets the cookie's `Secure` attribute, and withholds it from a plain-HTTP request. */
  secure: boolean;
}

/**
 * The session a request carries, persisted in a {@link SessionStore} and keyed
 * by a signed `connect.sid` cookie.
 *
 * A session lasts seven days past its last use. A request that arrives with
 * a live session slides that expiry once it lags a full window by
 * {@link SESSION_RENEW_INTERVAL_MS}, writing only the expiry and returning the
 * cookie; otherwise an unchanged session writes nothing. A request without one
 * gets neither a row nor a cookie until a route attaches a user.
 */
export class HttpSession {
  /** The authenticated identity; undefined while the session is anonymous. */
  get user(): SignedUser | undefined {
    return this.identity;
  }
  set user(value: SignedUser | undefined) {
    this.identity = value;
  }

  /** What a session started through single sign-on keeps from the provider. */
  auth: SsoSessionType | undefined;

  private identity: SignedUser | undefined;
  private id: string;
  private cookie: RuntimeCookie;
  private destroyed = false;
  private readonly arrivedWithId: string | undefined;
  private readonly originalId: string;
  private readonly originalFingerprint: string;

  private constructor(
    private readonly store: SessionStore,
    private readonly options: SessionOptions,
    cookieId: string | undefined,
    stored: { id: string; session: RuntimeSessionType } | null
  ) {
    this.arrivedWithId = cookieId;
    if (stored) {
      this.id = stored.id;
      this.identity = stored.session.user;
      this.auth = stored.session.auth;
      this.cookie = new RuntimeCookie(stored.session.cookie);
    } else {
      this.id = generateSessionId();
      this.cookie = this.freshCookie();
    }
    this.originalId = this.id;
    this.originalFingerprint = fingerprint(this.identity, this.auth);
  }

  /**
   * Resolves the session named by the request's cookie, or starts an
   * anonymous one. A store fault rejects.
   */
  static async load(
    cookieHeader: string | null,
    store: SessionStore,
    options: SessionOptions
  ): Promise<HttpSession> {
    const raw = readCookie(cookieHeader, SESSION_COOKIE_NAME);
    const cookieId = raw ? unsignSessionCookie(raw, options.secret) : undefined;
    const stored = cookieId ? await store.get(cookieId) : null;
    return new HttpSession(store, options, cookieId, stored ? { id: cookieId!, session: stored } : null);
  }

  /** The id the session is stored under, for log correlation. */
  get sessionId(): string {
    return this.id;
  }

  private freshCookie() {
    return new RuntimeCookie({
      originalMaxAge: SESSION_MAX_AGE_MS,
      _expires: new Date(Date.now() + SESSION_MAX_AGE_MS),
      httpOnly: true,
      path: "/",
      secure: this.options.secure,
      sameSite: "strict",
    });
  }

  private snapshot(): RuntimeSessionType {
    const expires = this.cookie._expires;
    return {
      user: this.identity as SignedUser,
      cookie: new RuntimeCookie({
        ...this.cookie,
        maxAge: expires ? expires.getTime() - Date.now() : undefined,
      }),
      auth: this.auth,
    };
  }

  private isModified() {
    return (
      this.originalId !== this.id ||
      this.originalFingerprint !== fingerprint(this.identity, this.auth)
    );
  }

  private isDueForRenewal() {
    const expires = this.cookie._expires?.getTime();
    if (expires === undefined) return true;
    const maxAge = this.cookie.originalMaxAge ?? SESSION_MAX_AGE_MS;
    return expires < Date.now() + maxAge - SESSION_RENEW_INTERVAL_MS;
  }

  private slideExpiry() {
    this.cookie._expires = new Date(Date.now() + (this.cookie.originalMaxAge ?? SESSION_MAX_AGE_MS));
    return this.cookie._expires;
  }

  /** Deletes the stored session and continues under a new, empty one. */
  async regenerate(): Promise<void> {
    const previous = this.id;
    this.id = generateSessionId();
    this.identity = undefined;
    this.auth = undefined;
    this.cookie = this.freshCookie();
    await this.store.destroy(previous);
  }

  /** Writes the session now rather than when the response completes. */
  async save(): Promise<void> {
    await this.store.set(this.id, this.snapshot());
  }

  /** Deletes the stored session. The response sets no cookie. */
  async destroy(): Promise<void> {
    this.destroyed = true;
    await this.store.destroy(this.id);
  }

  /**
   * Persists the session as the response completes and returns the
   * `Set-Cookie` value it should carry, if any. `secureRequest` says whether
   * the request arrived over HTTPS; a `Secure` cookie is never sent otherwise.
   * A failed save is passed to `onSaveError` and does not withhold the cookie.
   */
  async commit(
    secureRequest: boolean,
    onSaveError: (error: unknown) => void
  ): Promise<string | undefined> {
    if (this.destroyed) return undefined;

    if (this.isModified()) {
      this.slideExpiry();
      await this.save().catch(onSaveError);
    } else if (this.arrivedWithId === this.id && this.isDueForRenewal()) {
      await this.store.touch(this.id, this.slideExpiry()).catch(onSaveError);
    } else {
      return undefined;
    }

    if (this.cookie.secure && !secureRequest) return undefined;
    return this.serializeCookie();
  }

  private serializeCookie() {
    const { path, _expires, httpOnly, secure, sameSite } = this.cookie;
    const parts = [
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(signSessionCookie(this.id, this.options.secret))}`,
    ];
    if (path) parts.push(`Path=${path}`);
    if (_expires) parts.push(`Expires=${_expires.toUTCString()}`);
    if (httpOnly) parts.push("HttpOnly");
    if (secure) parts.push("Secure");
    if (sameSite === true || sameSite === "strict") parts.push("SameSite=Strict");
    else if (sameSite === "lax") parts.push("SameSite=Lax");
    else if (sameSite === "none") parts.push("SameSite=None");
    return parts.join("; ");
  }
}
