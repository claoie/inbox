import crypto from "crypto";
import { User, SignedUser } from "common";
import {
  searchUser as pgSearchUser,
  rotateUserPassword,
} from "./postgres/repositories/users";
import { deleteSessionsForUser } from "./postgres/repositories/sessions";
import { evictImapSessions } from "./imap/session-registry";
import { evictSmtpConnections } from "./smtp-registry";
import { usersTable, USER_ID, TOKEN, EXPIRY } from "./postgres/models";
import { logger } from "./logger";
import { hashPassword } from "./verify-password";

const { APP_HOSTNAME } = process.env;

export const getSignedUser = (user?: User) => {
  if (!user) return;
  const { id, username, email, password } = user;
  if (!id || !username || !password || !email) return;
  return user as SignedUser;
};

export const getUser = async (
  user: Partial<User>
): Promise<User | undefined> => {
  const pgUser = await pgSearchUser({
    user_id: user.id,
    username: user.username,
    email: user.email
  });

  if (!pgUser) return undefined;

  return new User({
    id: pgUser.user_id,
    username: pgUser.username,
    email: pgUser.email ?? undefined,
    password: pgUser.password,
    token: pgUser.token ?? undefined,
    expiry: pgUser.expiry ?? undefined,
    // Rows that predate the revocation fence read back null; the migration's
    // DEFAULT 1 makes 1 the honest generation for all of them.
    passwordVersion: pgUser.password_version ?? 1
  });
};

export const getUsers = async (users: Partial<User>[]): Promise<User[]> => {
  const results: User[] = [];

  for (const user of users) {
    const found = await getUser(user);
    if (found) results.push(found);
  }

  return results;
};

export const getActiveUsers = async (
  users: Partial<User>[]
): Promise<SignedUser[]> => {
  // For simplicity, just return signed users from the list
  // In the PG version, we don't track "active" sessions the same way
  const results: SignedUser[] = [];

  for (const user of users) {
    const found = await getUser(user);
    const signed = found?.getSigned();
    if (signed) results.push(signed);
  }

  return results;
};

const deleteUser = async (id: string): Promise<boolean> => {
  try {
    return await usersTable.hardDelete(id);
  } catch (error) {
    logger.error("Failed to delete user", {}, error);
    return false;
  }
};

export const expiryTimer: { [k: string]: NodeJS.Timeout } = {};

const TOKEN_DURATION = 1000 * 60 * 60;

export const createToken = async (
  email: string
): Promise<{
  id: string;
  token: string;
  username?: string;
}> => {
  const token = crypto.randomBytes(32).toString("hex");
  const expiry = new Date(Date.now() + TOKEN_DURATION).toISOString();

  const existing = await getUser({ email });
  if (existing?.id) {
    await usersTable.update(existing.id, { [TOKEN]: token, [EXPIRY]: expiry });
    return { id: existing.id, username: existing.username, token };
  }

  const userId = crypto.randomUUID();
  await usersTable.insert({
    [USER_ID]: userId,
    username: `user_${userId.slice(0, 8)}`,
    email,
    token,
    expiry
  });

  return { id: userId, token };
};

export const isValidEmail = (email: string) => {
  const values = email.split("@");
  if (values.length !== 2) return false;
  const [local, domain] = values;
  // Local part: allow letters, digits, dots, underscores, hyphens, plus (case insensitive)
  const localValid = /^[a-zA-Z0-9._%+-]+$/.test(local);
  // Domain: allow letters, digits, dots, hyphens (case insensitive), must have at least one dot
  const domainValid = /^[a-zA-Z0-9.-]+$/.test(domain) && domain.includes(".");
  return localValid && domainValid;
};

/**
 * `token` and `expiry` carry two unrelated meanings on the same columns: on a
 * placeholder row `createToken` inserted for an address with no account yet
 * they are an unclaimed sign-up, on a registered account they are a password
 * reset in flight. A null `password` is what distinguishes them, so an expired
 * placeholder is reclaimed by deleting the row while a registered account
 * keeps its data and loses only the stale token.
 *
 * Reads the row as a model because `toUser` throws on a null password.
 */
export const reclaimExpiredToken = async (userId: string): Promise<void> => {
  const model = await usersTable.queryOne({ [USER_ID]: userId });
  if (!model) return;

  const { expiry } = model;
  if (!expiry || new Date(expiry).getTime() >= Date.now()) return;

  if (model.password !== null) {
    await usersTable.update(userId, { [TOKEN]: null, [EXPIRY]: null });
    return;
  }

  if (await deleteUser(userId)) {
    logger.info("Deleted an unclaimed sign-up.", { userId });
  }
};

export const startTimer = (userId: string) => {
  // Clear any existing timer to prevent duplicate fires
  if (expiryTimer[userId]) clearTimeout(expiryTimer[userId]);

  expiryTimer[userId] = setTimeout(() => {
    delete expiryTimer[userId];
    // A repository fault here would otherwise be an unhandled rejection: the
    // callback runs detached from any request, so nothing above it can catch.
    reclaimExpiredToken(userId).catch((error) =>
      logger.error("Failed to reclaim an expired token", { userId }, error)
    );
  }, TOKEN_DURATION);
};

export const encryptPassword = (password: string) => hashPassword(password);

export const setUserInfo = async (
  userInfo: Partial<User>
): Promise<SignedUser> => {
  const { email, password, token } = userInfo;
  let { username } = userInfo;
  if (!email || !username || !password) {
    throw new Error(
      `Setting userInfo failed because input is invalid: ${userInfo}`
    );
  }

  const existingUser = await getUser({ email });
  if (!existingUser?.id) {
    throw new Error("`setUserInfo` failed because user doesn't exist.");
  }
  if (!existingUser.token || existingUser.token !== token) {
    throw new Error("`setUserInfo` failed because token doesn't match.");
  }

  const { id, expiry } = existingUser;
  if (expiry && new Date(expiry).getTime() < Date.now()) {
    await reclaimExpiredToken(id);
    throw new Error("Setting userInfo failed because user token is expired.");
  }

  const expiryTimeout = expiryTimer[id];
  if (expiryTimeout) clearTimeout(expiryTimeout);

  if (!existingUser.username) {
    const findUserInfoByUsername = await getUser({ username });
    if (findUserInfoByUsername) {
      throw new Error("`setUserInfo` failed because username already exists.");
    }
  } else {
    username = existingUser.username;
  }

  // Evict before the write so a failed DELETE aborts the rotation with the row
  // — and so the reset token — intact, leaving a retryable reset rather than a
  // new password whose old sessions survived. The hash is computed ahead of the
  // DELETE to keep a bcrypt round out of that window.
  const passwordHash = await encryptPassword(password);

  await deleteSessionsForUser(id);

  // The revocation fence: the credential generation is bumped in the SAME
  // UPDATE that writes the new hash, so no interleaving can land a new
  // hash on the old generation. The bump is atomic
  // (`COALESCE(password_version, 1) + 1` in the UPDATE itself), not a
  // read-modify-write in JS: two concurrent rotations used to both read
  // generation N and both write N+1 with different hashes, leaving a grant
  // stamped N+1 by the first rotation alive after the second. Every
  // authentication surface stamps the version its grant was minted from
  // and compares it afterwards — a session or connection minted before
  // this bump fails its next comparison. The signed session below carries
  // the generation the UPDATE actually returned, never a pre-computed one.
  const passwordVersion = await rotateUserPassword(id, {
    passwordHash,
    username,
    token: null,
    expiry: null,
  });
  if (passwordVersion === null) {
    throw new Error("`setUserInfo` failed because the user row is missing.");
  }

  // IMAP and SMTP hold authentication for the life of a connection rather than
  // per request, so a client that authenticated with the old password keeps its
  // grant until its socket is torn down. This runs after the write, not before:
  // until the new hash lands, an evicted client can reconnect on the old one.
  evictImapSessions(username);
  evictSmtpConnections(username);

  // The session this signs carries the bumped generation: the route issues it
  // through `updateSession`, which stamps `passwordVersion` onto the row, and
  // a stamp of the pre-bump generation would fail the fence on its first
  // comparison after issuance.
  const signed = new User({
    id,
    email,
    username,
    password: passwordHash,
    passwordVersion
  }).getSigned();
  if (!signed) {
    throw new Error("`setUserInfo` failed to sign the updated user.");
  }
  return signed;
};

export const createAuthenticationMail = (
  email: string,
  token: string,
  username?: string
) => {
  let href = `https://${APP_HOSTNAME}/set-info/${email}?t=${token}`;
  if (username) href += `&u=${username}`;

  return {
    senderFullName: "Administrator",
    sender: "admin",
    to: email,
    subject: "Please set your password for Inbox",
    html: `
<h2 style="text-align: center;">Thanks for signing up with Inbox!</h2>
<p style="text-align: center;">
  You have requested membership confirmation email for Inbox.
  <br/>
  Please click the button below to complete setting user information.
</p>
<a
  href="${href}"
  target="mail-confirm"
  style="display: flex; align-items: center; justify-content: center; margin: 2rem auto; padding: 5px; background-color: #3291FF; color: white; border: none; height: 40px; width: 400px; font-size: 20px;"
>Confirm Sign Up</a>
<p style="text-align: center;">
  * This email expires in 1 hour.
  <br/>  
  * You should not share this email with other people.
  <br/>  
  * Ignore this email if you have not requested it.
</p>
`
  };
};
