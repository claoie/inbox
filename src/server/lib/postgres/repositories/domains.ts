import { pool } from "../client";
import type { PreparedQuery } from "../database";
import {
  DOMAINS,
  DOMAIN_CLAIMS,
  DOMAIN_ROLES,
  FORMER_DOMAINS,
  DOMAIN_COUNT_MAX,
  DOMAIN_VIEWER_COUNT_MAX,
  DomainRole,
  USERS,
} from "../models";

/** A domain as one person sees it: its owner and the role they hold on it. */
export interface DomainAccess {
  domainId: string;
  name: string;
  /** The owner, whose `user_id` keys the domain's mail rows. */
  ownerId: string;
  ownerUsername: string;
  role: DomainRole;
  verifiedAt: string | null;
}

interface DomainAccessRow {
  domain_id: string;
  name: string;
  owner_id: string;
  owner_username: string;
  role: DomainRole;
  verified_at: Date | string | null;
}

const toAccess = (row: DomainAccessRow): DomainAccess => ({
  domainId: row.domain_id,
  name: row.name,
  ownerId: row.owner_id,
  ownerUsername: row.owner_username,
  role: row.role,
  verifiedAt:
    row.verified_at instanceof Date ? row.verified_at.toISOString() : row.verified_at,
});

// The role a person holds on `d`, given their user id as $1. The owner is the
// row's `user_id`; anyone else holds the role their `domain_roles` row names.
// A person who is neither matches nothing, so every caller that selects
// through this also refuses a domain the person has no role on.
const ACCESS_COLUMNS = `
  d.domain_id, d.name, d.user_id AS owner_id, o.username AS owner_username,
  d.verified_at,
  CASE WHEN d.user_id = $1 THEN 'owner' ELSE r.role END AS role`;

const ACCESS_FROM = `
  FROM ${DOMAINS} d
  JOIN ${USERS} o ON o.user_id = d.user_id
  LEFT JOIN ${DOMAIN_ROLES} r ON r.domain_id = d.domain_id AND r.user_id = $1`;

const HAS_ACCESS = `(d.user_id = $1 OR r.user_id IS NOT NULL)`;

export const buildListDomainAccess = (userId: string): PreparedQuery => ({
  sql: `SELECT ${ACCESS_COLUMNS} ${ACCESS_FROM} WHERE ${HAS_ACCESS} ORDER BY d.name`,
  values: [userId],
});

/** Every domain the person owns or holds a role on, by name. */
export const listDomainAccess = async (userId: string): Promise<DomainAccess[]> => {
  const { sql, values } = buildListDomainAccess(userId);
  const result = await pool.query<DomainAccessRow>(sql, values);
  return result.rows.map(toAccess);
};

export const buildGetDomainAccess = (userId: string, name: string): PreparedQuery => ({
  sql: `SELECT ${ACCESS_COLUMNS} ${ACCESS_FROM} WHERE d.name = $2 AND ${HAS_ACCESS}`,
  values: [userId, name.toLowerCase()],
});

/** The person's role on `name`, or null when they hold none. */
export const getDomainAccess = async (
  userId: string,
  name: string
): Promise<DomainAccess | null> => {
  const { sql, values } = buildGetDomainAccess(userId, name);
  const result = await pool.query<DomainAccessRow>(sql, values);
  return result.rows[0] ? toAccess(result.rows[0]) : null;
};

export interface DomainRow {
  domainId: string;
  name: string;
  ownerId: string;
  /** The owner's account is soft-deleted: the name stays taken, and nothing is delivered to it. */
  ownerDeleted?: boolean;
}

/** The domain row for `name`, whoever owns it. */
export const findDomain = async (name: string): Promise<DomainRow | null> => {
  const result = await pool.query<{ domain_id: string; name: string; user_id: string; owner_deleted: boolean }>(
    `SELECT d.domain_id, d.name, d.user_id, (u.is_deleted IS TRUE) AS owner_deleted
     FROM ${DOMAINS} d JOIN ${USERS} u ON u.user_id = d.user_id
     WHERE d.name = $1`,
    [name.toLowerCase()]
  );
  const row = result.rows[0];
  return row
    ? { domainId: row.domain_id, name: row.name, ownerId: row.user_id, ownerDeleted: row.owner_deleted }
    : null;
};

export const buildReadersOfDomain = (name: string): PreparedQuery => ({
  sql: `
    SELECT d.user_id FROM ${DOMAINS} d WHERE d.name = $1
    UNION
    SELECT r.user_id FROM ${DOMAIN_ROLES} r
    JOIN ${DOMAINS} d ON d.domain_id = r.domain_id
    WHERE d.name = $1`,
  values: [name.toLowerCase()],
});

/** The user ids of everyone who can read mail delivered to `name`. */
export const readersOfDomain = async (name: string): Promise<string[]> => {
  const { sql, values } = buildReadersOfDomain(name);
  const result = await pool.query<{ user_id: string }>(sql, values);
  return result.rows.map((row) => row.user_id);
};

/**
 * Assigns `name` to `userId` without a DNS check, unless the name is taken.
 * Only for names this server answers for itself (the accounts' own names
 * under EMAIL_DOMAIN) and for the operator's user script.
 *
 * @returns true when the name now belongs to `userId`.
 */
export const assignDomain = async (userId: string, name: string): Promise<boolean> => {
  const result = await pool.query<{ user_id: string }>(
    `WITH inserted AS (
       INSERT INTO ${DOMAINS} (name, user_id) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING user_id
     )
     SELECT user_id FROM inserted
     UNION ALL
     SELECT user_id FROM ${DOMAINS} WHERE name = $1`,
    [name.toLowerCase(), userId]
  );
  return result.rows.some((row) => row.user_id === userId);
};

export const buildBackfillAccountDomains = (zone: string): PreparedQuery => ({
  // An account's own name under the served zone, for every account that is
  // not deleted and whose username is a DNS label. A sign-up still setting
  // its password counts: it completes on the same row, so mail delivered to
  // it meanwhile is kept for it. (Its placeholder name is no DNS label.)
  // Idempotent, and a name already taken stays with its owner.
  sql: `
    INSERT INTO ${DOMAINS} (name, user_id)
    SELECT username || '.' || $1, user_id FROM ${USERS}
    WHERE is_deleted IS NOT TRUE
      AND username ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    ON CONFLICT (name) DO NOTHING`,
  values: [zone.toLowerCase()],
});

/** Gives every account that has none its own name under `zone`. */
export const backfillAccountDomains = async (zone: string): Promise<number> => {
  const { sql, values } = buildBackfillAccountDomains(zone);
  const result = await pool.query(sql, values);
  return result.rowCount ?? 0;
};

export const buildDeleteOwnedDomain = (userId: string, name: string): PreparedQuery => ({
  // One statement: the domain leaves and is remembered as a former one, so
  // its mail, which stays in the owner's rows, keeps its place in their list.
  sql: `
    WITH removed AS (
      DELETE FROM ${DOMAINS} WHERE name = $1 AND user_id = $2 RETURNING user_id, name
    ), remembered AS (
      INSERT INTO ${FORMER_DOMAINS} (user_id, name) SELECT user_id, name FROM removed
      ON CONFLICT (user_id, name) DO NOTHING
    )
    SELECT COUNT(*)::int AS removed FROM removed`,
  values: [name.toLowerCase(), userId],
});

/** Removes a domain its owner no longer wants. Its mail stays with the owner. */
export const deleteOwnedDomain = async (userId: string, name: string): Promise<boolean> => {
  const { sql, values } = buildDeleteOwnedDomain(userId, name);
  const result = await pool.query<{ removed: number }>(sql, values);
  return (result.rows[0]?.removed ?? 0) > 0;
};

/** The domains an account owned and no longer does, whose mail it still holds. */
export const listFormerDomains = async (userId: string): Promise<string[]> => {
  const result = await pool.query<{ name: string }>(
    `SELECT name FROM ${FORMER_DOMAINS} WHERE user_id = $1 ORDER BY name`,
    [userId]
  );
  return result.rows.map((row) => row.name);
};

export interface DomainClaim {
  name: string;
  token: string;
  createdAt: string;
}

const toClaim = (row: { name: string; token: string; created_at: Date | string }) => ({
  name: row.name,
  token: row.token,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

export const listClaims = async (userId: string): Promise<DomainClaim[]> => {
  const result = await pool.query(
    `SELECT name, token, created_at FROM ${DOMAIN_CLAIMS} WHERE user_id = $1 ORDER BY name`,
    [userId]
  );
  return result.rows.map(toClaim);
};

export const getClaim = async (userId: string, name: string): Promise<DomainClaim | null> => {
  const result = await pool.query(
    `SELECT name, token, created_at FROM ${DOMAIN_CLAIMS} WHERE user_id = $1 AND name = $2`,
    [userId, name.toLowerCase()]
  );
  return result.rows[0] ? toClaim(result.rows[0]) : null;
};

export type AddClaimResult =
  | { status: "created" | "exists"; claim: DomainClaim }
  | { status: "at_limit" };

export const buildInsertClaim = (userId: string, name: string, token: string): PreparedQuery => ({
  // The count is a subquery of the INSERT, so the ceiling and the row are
  // decided together. Domains already owned count against it too.
  sql: `
    INSERT INTO ${DOMAIN_CLAIMS} (name, user_id, token)
    SELECT $1, $2, $3
    WHERE (SELECT COUNT(*) FROM ${DOMAIN_CLAIMS} WHERE user_id = $2)
        + (SELECT COUNT(*) FROM ${DOMAINS} WHERE user_id = $2) < $4
    ON CONFLICT (name, user_id) DO NOTHING
    RETURNING name, token, created_at`,
  values: [name.toLowerCase(), userId, token, DOMAIN_COUNT_MAX],
});

/** Records a claim on `name`, or returns the one the person already has. */
export const addClaim = async (
  userId: string,
  name: string,
  token: string
): Promise<AddClaimResult> => {
  const { sql, values } = buildInsertClaim(userId, name, token);
  const result = await pool.query(sql, values);
  if (result.rows[0]) return { status: "created", claim: toClaim(result.rows[0]) };
  const existing = await getClaim(userId, name);
  return existing ? { status: "exists", claim: existing } : { status: "at_limit" };
};

export const deleteClaim = async (userId: string, name: string): Promise<boolean> => {
  const result = await pool.query(
    `DELETE FROM ${DOMAIN_CLAIMS} WHERE user_id = $1 AND name = $2`,
    [userId, name.toLowerCase()]
  );
  return (result.rowCount ?? 0) > 0;
};

export type PromoteClaimResult =
  | { status: "verified"; previousOwnerId: string | null }
  | { status: "missing" };

/**
 * Turns a claim whose DNS record was just proved into the domain, in one
 * transaction. The claim is consumed only if it still carries the token that
 * was checked, so a claim re-made in between is not promoted on a stale proof.
 *
 * A name someone else owns moves to the claimant: the DNS record is what
 * decides who receives a domain's mail. Its roles are dropped with the move,
 * since they were granted by the previous owner and would otherwise let those
 * people read the new owner's mail. The previous owner's stored mail stays
 * with them, and the domain is remembered as one of their former ones.
 */
export const promoteClaim = async (
  userId: string,
  name: string,
  token: string
): Promise<PromoteClaimResult> => {
  const normalized = name.toLowerCase();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query(
      `DELETE FROM ${DOMAIN_CLAIMS} WHERE user_id = $1 AND name = $2 AND token = $3 RETURNING claim_id`,
      [userId, normalized, token]
    );
    if (!claimed.rowCount) {
      await client.query("ROLLBACK");
      return { status: "missing" };
    }
    const existing = await client.query<{ domain_id: string; user_id: string }>(
      `SELECT domain_id, user_id FROM ${DOMAINS} WHERE name = $1 FOR UPDATE`,
      [normalized]
    );
    let previousOwnerId: string | null = null;
    const row = existing.rows[0];
    if (!row) {
      await client.query(
        `INSERT INTO ${DOMAINS} (name, user_id, verified_at) VALUES ($1, $2, CURRENT_TIMESTAMP)`,
        [normalized, userId]
      );
    } else if (row.user_id === userId) {
      await client.query(
        `UPDATE ${DOMAINS} SET verified_at = CURRENT_TIMESTAMP WHERE domain_id = $1`,
        [row.domain_id]
      );
    } else {
      previousOwnerId = row.user_id;
      await client.query(`DELETE FROM ${DOMAIN_ROLES} WHERE domain_id = $1`, [row.domain_id]);
      await client.query(
        `INSERT INTO ${FORMER_DOMAINS} (user_id, name) VALUES ($1, $2) ON CONFLICT (user_id, name) DO NOTHING`,
        [row.user_id, normalized]
      );
      await client.query(
        `UPDATE ${DOMAINS} SET user_id = $2, verified_at = CURRENT_TIMESTAMP WHERE domain_id = $1`,
        [row.domain_id, userId]
      );
    }
    await client.query("COMMIT");
    return { status: "verified", previousOwnerId };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export interface DomainMember {
  userId: string;
  username: string;
  role: DomainRole;
}

/** The people holding a role on a domain, the owner excluded. */
export const listDomainViewers = async (domainId: string): Promise<DomainMember[]> => {
  const result = await pool.query<{ user_id: string; username: string; role: DomainRole }>(
    `SELECT r.user_id, u.username, r.role FROM ${DOMAIN_ROLES} r
     JOIN ${USERS} u ON u.user_id = r.user_id
     WHERE r.domain_id = $1 ORDER BY u.username`,
    [domainId]
  );
  return result.rows.map((row) => ({ userId: row.user_id, username: row.username, role: row.role }));
};

export type GrantViewerResult = "granted" | "exists" | "at_limit" | "not_owner";

/**
 * Grants only while `granterId` owns the domain. The owner check takes a share
 * lock on the domain row, so a grant racing a takeover either lands before it
 * (and its role is dropped with the move) or sees the new owner and is refused.
 */
export const buildGrantViewer = (
  domainId: string,
  granterId: string,
  userId: string
): PreparedQuery => ({
  // Never onto the owner: the owner's role is the domain row itself.
  sql: `
    INSERT INTO ${DOMAIN_ROLES} (domain_id, user_id, role)
    SELECT $1, $3, 'viewer'
    WHERE EXISTS (SELECT 1 FROM ${DOMAINS} WHERE domain_id = $1 AND user_id = $2 FOR SHARE)
      AND $2 <> $3
      AND (SELECT COUNT(*) FROM ${DOMAIN_ROLES} WHERE domain_id = $1) < $4
    ON CONFLICT (domain_id, user_id) DO NOTHING
    RETURNING user_id`,
  values: [domainId, granterId, userId, DOMAIN_VIEWER_COUNT_MAX],
});

export const grantViewer = async (
  domainId: string,
  granterId: string,
  userId: string
): Promise<GrantViewerResult> => {
  const { sql, values } = buildGrantViewer(domainId, granterId, userId);
  const result = await pool.query(sql, values);
  if (result.rowCount) return "granted";
  const probe = await pool.query<{ owns: boolean; holds: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${DOMAINS} WHERE domain_id = $1 AND user_id = $2) AS owns,
            EXISTS (SELECT 1 FROM ${DOMAIN_ROLES} WHERE domain_id = $1 AND user_id = $3) AS holds`,
    [domainId, granterId, userId]
  );
  const { owns, holds } = probe.rows[0];
  if (!owns) return "not_owner";
  return holds ? "exists" : "at_limit";
};

export const revokeRole = async (domainId: string, userId: string): Promise<boolean> => {
  const result = await pool.query(
    `DELETE FROM ${DOMAIN_ROLES} WHERE domain_id = $1 AND user_id = $2`,
    [domainId, userId]
  );
  return (result.rowCount ?? 0) > 0;
};
