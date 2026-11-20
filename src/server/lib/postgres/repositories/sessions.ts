import { logger } from "../../logger";
import {
  SessionModel,
  sessionsTable,
  usersTable,
  USER_ID,
  SESSION_ID,
  SESSION_USER_ID,
  SESSION_USERNAME,
  SESSION_EMAIL,
  SESSION_IS_READ_ONLY,
  SESSION_AUTHENTICATED_AS,
  SESSION_PASSWORD_VERSION,
  SESSION_AUTH_SID,
  SESSION_AUTH_REFRESH_TOKEN,
  SESSION_AUTH_RECHECK_AT,
  COOKIE_ORIGINAL_MAX_AGE,
  COOKIE_MAX_AGE,
  COOKIE_SIGNED,
  COOKIE_EXPIRES,
  COOKIE_HTTP_ONLY,
  COOKIE_PATH,
  COOKIE_DOMAIN,
  COOKIE_SECURE,
  COOKIE_SAME_SITE,
} from "../models";

import type { SessionStore } from "../../http/session";
import {
  Cookie,
  RuntimeCookie,
  RuntimeSession,
  RuntimeSessionType,
  Session,
} from "common";

/**
 * Searches session data by id from PostgreSQL.
 * @param session_id
 * @returns A promise to be a SessionModel, or null when no row carries that
 * id. A failed read rejects so callers can tell a store fault from a session
 * that does not exist.
 */
export const searchSession = async (
  session_id: string
): Promise<SessionModel | null> => {
  return sessionsTable.queryOne({ [SESSION_ID]: session_id });
};

/**
 * Updates a session object with given session_id and session data.
 * @param session_id
 * @param session
 * @returns A promise that settles once the row is written. A failed write
 * rejects so callers cannot report an unwritten session as a stored one.
 */
export const updateSession = async (
  session_id: string,
  session: Session
): Promise<void> => {
  const { user, cookie, auth } = session;
  const data = {
    [SESSION_ID]: session_id,
    [SESSION_USER_ID]: user.id,
    [SESSION_USERNAME]: user.username,
    [SESSION_EMAIL]: user.email,
    [SESSION_IS_READ_ONLY]: user.isReadOnly ?? null,
    [SESSION_AUTHENTICATED_AS]: user.authenticatedAs ?? null,
    // The revocation fence: stamp the credential generation the
    // session was minted from. This must be the version the caller
    // authenticated against — NOT a fresh read of the user row — so a login
    // that straddled a password rotation stamps the stale generation and
    // fails its next comparison instead of inheriting the new one.
    [SESSION_PASSWORD_VERSION]: user.passwordVersion ?? 1,
    [SESSION_AUTH_SID]: auth?.sid ?? null,
    [SESSION_AUTH_REFRESH_TOKEN]: auth?.refreshToken ?? null,
    [SESSION_AUTH_RECHECK_AT]: auth?.recheckAt ?? null,
    [COOKIE_ORIGINAL_MAX_AGE]: cookie.originalMaxAge,
    [COOKIE_MAX_AGE]: cookie.maxAge,
    [COOKIE_SIGNED]: cookie.signed,
    [COOKIE_EXPIRES]: cookie._expires,
    [COOKIE_HTTP_ONLY]: cookie.httpOnly,
    [COOKIE_PATH]: cookie.path,
    [COOKIE_DOMAIN]: cookie.domain,
    [COOKIE_SECURE]: cookie.secure,
    [COOKIE_SAME_SITE]: cookie.sameSite,
  };

  await sessionsTable.upsert(data);
};

/**
 * Moves a session's expiry without rewriting the rest of its row. An id with
 * no row stays absent, so a session deleted mid-request is not recreated.
 * @param session_id
 * @param expires
 * @returns A promise that settles once the row is written. A failed write
 * rejects.
 */
export const touchSession = async (
  session_id: string,
  expires: Date
): Promise<void> => {
  await sessionsTable.update(session_id, { [COOKIE_EXPIRES]: expires });
};

/**
 * Deletes a session object with given session_id.
 * @param session_id
 * @returns A promise to be true when a row was deleted, false when no row
 * matched. A failed DELETE rejects so callers can tell failure from a
 * missing row.
 */
export const deleteSession = async (session_id: string): Promise<boolean> => {
  return sessionsTable.hardDelete(session_id);
};

/**
 * Searches all expired session data and delete them.
 * @returns A promise to be a count of deleted sessions. A failed sweep rejects,
 * so a table growing without bound is distinguishable from a sweep that found
 * nothing to purge.
 */
export const purgeSessions = async (): Promise<number> => {
  const now = new Date().toISOString();
  return sessionsTable.deleteWhere({
    [COOKIE_EXPIRES]: { op: "<=", value: now, notNull: true },
  });
};

/**
 * Deletes every session issued to a given authenticating credential.
 * Revoking a credential has to reach the sessions it already issued: the
 * cookie outlives the password it was minted from, and `rolling` renews its
 * window on every request, so a credential that is no longer accepted at login
 * would otherwise stay usable indefinitely through an existing session.
 * @param authenticatedAs
 * @returns A promise to be a count of deleted sessions. A failed delete
 * rejects, so a revocation that left its sessions alive cannot report itself
 * as a revocation that had none to delete.
 */
export const deleteSessionsAuthenticatedAs = async (
  authenticatedAs: string
): Promise<number> => {
  return sessionsTable.deleteWhere({
    [SESSION_AUTHENTICATED_AS]: authenticatedAs,
  });
};

/**
 * Deletes every session issued to a given user, whichever credential minted it.
 * Rotating a user's password has to reach the sessions it already issued: a
 * session row carries no password, and `rolling` renews its window on every
 * request, so a cookie held before the rotation would otherwise stay
 * authenticated for as long as it kept being used.
 *
 * A fault rejects rather than resolving to 0. This is the eviction half of a
 * password rotation, and a caller that cannot tell a failed DELETE from "no
 * sessions to delete" would report the rotation as complete while the sessions
 * it was supposed to revoke are still live.
 * @param userId
 * @returns A promise to be a count of deleted sessions.
 */
export const deleteSessionsForUser = async (
  userId: string
): Promise<number> => {
  return sessionsTable.deleteWhere({ [SESSION_USER_ID]: userId });
};

/**
 * Deletes every session started through the single sign-on session `sid`,
 * which the provider's `session.ended` event names.
 * @returns A promise to be a count of deleted sessions. A failed delete
 * rejects, so the provider retries an event whose sessions are still alive.
 */
export const deleteSessionsByAuthSid = async (sid: string): Promise<number> => {
  return sessionsTable.deleteWhere({ [SESSION_AUTH_SID]: sid });
};

/**
 * Persists HTTP sessions in PostgreSQL.
 */
export class PostgresSessionStore implements SessionStore {
  constructor() {
    this.autoRemoveScheduler();
  }

  /**
   * Repeatedly run every hour to remove expired session data.
   */
  private autoRemoveScheduler = () => {
    purgeSessions().catch((error) => logger.error("Failed to purge expired sessions", {}, error));
    setTimeout(this.autoRemoveScheduler, 1000 * 60 * 60);
  };

  /**
   * Gets session with given session_id.
   * @param session_id
   * @returns The session, or null when no live session carries that id. A
   * failed read rejects.
   */
  get = async (session_id: string): Promise<RuntimeSessionType | null> => {
    const sessionModel = await searchSession(session_id);

    if (!sessionModel) return null;

    const { cookie_expires, cookie_secure, cookie_same_site } = sessionModel;
    if (!cookie_expires || new Date(cookie_expires) < new Date()) {
      this.destroy(session_id).catch((error) =>
        logger.error("Failed to delete session", { session_id }, error)
      );
      return null;
    }

    // The revocation fence: a grant proves itself current on
    // every read, not only at issuance. A session row resurrected by an
    // in-flight request after `deleteSessionsForUser`, or a session minted
    // by a login that straddled the rotation, carries the stale generation
    // and is rejected here — regardless of how the row got written.
    // Rows written before the fence's migration read back null, which is
    // generation 1, the same default the migration gives the user rows.
    const stampedVersion = sessionModel.session_password_version ?? 1;
    const userRow = await usersTable.queryOne({
      [USER_ID]: sessionModel.session_user_id,
    });
    const currentVersion = userRow?.password_version ?? 1;
    if (stampedVersion < currentVersion) {
      logger.info(
        "Session rejected: credential rotated after the session was issued",
        { session_id, user_id: sessionModel.session_user_id }
      );
      await this.destroy(session_id).catch((error) =>
        logger.error("Failed to delete session", { session_id }, error)
      );
      return null;
    }

    const cookie = new RuntimeCookie({
      originalMaxAge: sessionModel.cookie_original_max_age,
      maxAge: sessionModel.cookie_max_age ?? undefined,
      signed: sessionModel.cookie_signed ?? undefined,
      _expires: cookie_expires ? new Date(cookie_expires) : undefined,
      httpOnly: sessionModel.cookie_http_only ?? undefined,
      path: sessionModel.cookie_path ?? undefined,
      domain: sessionModel.cookie_domain ?? undefined,
      secure: cookie_secure ? JSON.parse(cookie_secure) : undefined,
      sameSite: cookie_same_site ? JSON.parse(cookie_same_site) : undefined,
    });

    const runtimeSession = new RuntimeSession();
    runtimeSession.user.id = sessionModel.session_user_id;
    runtimeSession.user.username = sessionModel.session_username;
    runtimeSession.user.email = sessionModel.session_email;
    runtimeSession.user.passwordVersion = stampedVersion;
    if (sessionModel.session_is_read_only) {
      runtimeSession.user.isReadOnly = true;
      runtimeSession.user.authenticatedAs =
        sessionModel.session_authenticated_as ?? undefined;
    }
    runtimeSession.cookie = cookie;
    if (sessionModel.auth_sid && sessionModel.auth_recheck_at) {
      runtimeSession.auth = {
        sid: sessionModel.auth_sid,
        refreshToken: sessionModel.auth_refresh_token,
        recheckAt: new Date(sessionModel.auth_recheck_at),
      };
    }

    return runtimeSession;
  };

  /**
   * Sets session with given session_id and session object.
   * @param session_id
   * @param session
   */
  set = async (session_id: string, session: RuntimeSessionType): Promise<void> => {
    const { cookie, user, auth } = session;
    const {
      secure,
      sameSite,
      originalMaxAge,
      maxAge,
      signed,
      httpOnly,
      path,
      domain,
      _expires,
    } = cookie;

    const storedCookie = new Cookie({
      secure: JSON.stringify(secure),
      sameSite: JSON.stringify(sameSite),
      originalMaxAge,
      maxAge,
      signed,
      httpOnly,
      path,
      domain,
      _expires,
    });

    const storedSession = new Session({ user, cookie: storedCookie, auth });

    await updateSession(session_id, storedSession);
  };

  /**
   * Slides a stored session's expiry.
   * @param session_id
   * @param expires
   */
  touch = async (session_id: string, expires: Date): Promise<void> => {
    await touchSession(session_id, expires);
  };

  /**
   * Removes session data from PostgreSQL by given session_id.
   * @param session_id
   */
  destroy = async (session_id: string): Promise<void> => {
    await deleteSession(session_id);
  };
}
