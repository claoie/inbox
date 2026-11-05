import { createHash, randomBytes } from "node:crypto";
import { pool } from "./client";
import { verifyPassword } from "../verify-password";
import {
  writeUser,
  searchUser,
  deleteSessionsAuthenticatedAs,
  deleteSessionsForUser,
} from "./repositories";
import { buildCreateTable, buildCreateIndex, buildIndexName } from "./database";
import { runBootMaintenance, MaintenanceWork, Statement } from "./maintenance";
import { sendAlarm } from "../alarm";
import {
  checkSchemaAtTarget,
  runMigrations,
  writeSchemaMarker,
  MarkerKey,
} from "./migration";
import { searchVectorDdl, searchVectorReindexSql } from "./search-vector";
import { logger } from "../logger";
import { ADMIN_RO_USERNAME } from "../read-only";
import { withTimeout } from "../util";
import {
  Table,
  Schema,
  usersTable,
  sessionsTable,
  mailsTable,
  mailboxesTable,
  pushSubscriptionsTable,
  spamAllowlistTable,
  spamTrainingTable,
  mailUidCountersTable,
  mailMailboxUidTable,
  mailgunEventsTable,
} from "./models";

export const version = "1";
export const index = "mail" + (version ? `-${version}` : "");

/** Every table the app owns, in DDL-creation order (FK dependencies first). */
export const tables: Table<unknown, Schema>[] = [
  usersTable,
  sessionsTable,
  mailboxesTable, // Must be before mails due to foreign key reference
  mailsTable,
  pushSubscriptionsTable,
  spamAllowlistTable,
  spamTrainingTable,
  mailUidCountersTable,
  // Depends on mails (FK to mails.mail_id ON DELETE CASCADE).
  mailMailboxUidTable,
  mailgunEventsTable,
];

// The full-text search index predates `table.indexes` and keeps its original
// name — regenerating it as `idx_mails_search_vector_gin` would leave the
// existing index in place and build a duplicate alongside it.
const MAILS_SEARCH_INDEX_NAME = "idx_mails_search";

/** Gates the row-scaled phase independently of the fatal schema DDL. */
const MAINTENANCE_MARKER_KEY: MarkerKey = "maintenance_hash";

/** Ceiling on alarm delivery, so a wedged webhook cannot delay a stop. */
const MAINTENANCE_ALARM_TIMEOUT_MS = 5_000;

// Raw DDL that isn't captured by `table.schema` / `table.indexes` /
// `searchVector*`.
const IDX_MAILS_SEARCH_SQL = buildCreateIndex("mails", "search_vector", {
  indexName: MAILS_SEARCH_INDEX_NAME,
  using: "gin",
  concurrently: true,
});

/**
 * Every index the app owns, as (name, statement) pairs. Names are exposed
 * alongside the SQL because the maintenance phase has to identify invalid
 * leftovers by name before it can rebuild them.
 */
export const indexSpecs = (): Statement[] => {
  const specs: Statement[] = [];
  for (const table of tables) {
    for (const idx of table.indexes) {
      const options = { using: idx.using, opclass: idx.opclass, concurrently: true };
      specs.push({
        name: buildIndexName(table.name, idx.column, options),
        sql: buildCreateIndex(table.name, idx.column, options),
      });
    }
  }
  specs.push({ name: MAILS_SEARCH_INDEX_NAME, sql: IDX_MAILS_SEARCH_SQL });
  return specs;
};

/** The statements `bootMaintenance` hands to the long-budget session. */
export const maintenanceWork = (): MaintenanceWork => ({
  indexes: indexSpecs(),
  statements: [
    { name: "search_vector reindex", sql: searchVectorReindexSql(), drain: true },
  ],
});

const digest = (parts: string[]): string =>
  createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);

// Digest of every input the slow-path DDL consumes, and of nothing else. Any
// code change to a table schema, its constraints, or `searchVectorDdl()`
// changes it — the fast path only short-circuits when the DB reflects THIS
// exact code's DDL, so a trigger-body-only PR (which a name-check would
// silently miss) correctly falls through to the slow path.
//
// The maintenance inputs are deliberately absent. This marker gates a block
// that throws and exits the process, so folding an index or a tuning constant
// into it would send every container back through that block for a change it
// does not describe.
export const CURRENT_SCHEMA_HASH: string = ((): string => {
  const parts: string[] = [];
  for (const t of tables) {
    parts.push(`t:${t.name}`);
    parts.push(JSON.stringify(t.schema));
    parts.push(JSON.stringify(t.constraints ?? []));
  }
  parts.push(...searchVectorDdl());
  return digest(parts);
})();

// The same discipline for the row-scaled phase: every index statement it
// issues plus the reindex it drains, so an index-only or chunk-size-only
// change re-runs that phase alone.
export const CURRENT_MAINTENANCE_HASH: string = ((): string => {
  const { indexes, statements } = maintenanceWork();
  return digest(
    [...indexes, ...statements].map((s) => `${s.name}:${s.sql}:${s.drain ?? false}`),
  );
})();

export const postgresIsAvailable = async (): Promise<void> => {
  const maxRetries = 30;
  let retries = 0;

  while (retries < maxRetries) {
    try {
      const client = await pool.connect();
      client.release();
      logger.info("PostgreSQL connection established.");
      return;
    } catch (error: unknown) {
      retries++;
      const message = error instanceof Error ? error.message : String(error);
      logger.info(`PostgreSQL connection attempt ${retries}/${maxRetries} failed: ${message}`);
      
      if (retries >= maxRetries) {
        throw new Error("Failed to connect to PostgreSQL after maximum retries");
      }
      
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

export const initializePostgres = async (): Promise<void> => {
  logger.info("PostgreSQL initialization started.");

  await postgresIsAvailable();

  if (await checkSchemaAtTarget(CURRENT_SCHEMA_HASH)) {
    logger.info("[Fast-path] Schema already at target — skipping DDL.");
    logger.info("Database tables created/verified successfully.");
    return;
  }

  try {
    // Create tables if they don't exist
    for (const table of tables) {
      const createTableSql = buildCreateTable(
        table.name,
        table.schema,
        table.constraints
      );
      await pool.query(createTableSql);
    }

    // Run automatic schema migrations for existing tables
    // This must happen BEFORE index creation - new columns from schema
    // must exist before we try to create indexes on them
    await runMigrations(
      tables.map((t) => ({ name: t.name, schema: t.schema }))
    );

    // Trigger function + the INSERT / column-scoped UPDATE trigger pair. The
    // reindex they share an expression with runs in `bootMaintenance` — it is
    // the one statement here whose cost scales with the table.
    for (const sql of searchVectorDdl()) await pool.query(sql);

    // Record the marker so subsequent boots can fast-path. Written AFTER every
    // statement in this block succeeded, and gated only on them: the
    // row-scaled work in `bootMaintenance` has its own marker, because sending
    // every boot back through this throwing block for as long as an index
    // can't build would just move the crashloop rather than remove it.
    await writeSchemaMarker(CURRENT_SCHEMA_HASH);
  } catch (error: unknown) {
    logger.error("Failed to create tables", {}, error);
    throw new Error("Failed to setup PostgreSQL tables.");
  }

  logger.info("Database tables created/verified successfully.");
};

/**
 * The row-count-scaled half of the boot DDL: index builds and the search-vector
 * reindex. Deliberately NOT part of `initializePostgres`, on two counts.
 *
 * It must not be fatal. A statement here failing means "too slow for its
 * budget", not "the schema is broken" — the app serves correctly without an
 * index, and with a stale search vector on rows nothing has touched. Exiting
 * for it just crashloops the container into the same doomed statement, with
 * no port ever bound to diagnose from.
 *
 * And it must not gate the listeners. Index builds are `CONCURRENTLY` so the
 * table stays writable while they run, which buys nothing if HTTP/SMTP/IMAP
 * aren't up yet. `start.ts` calls this after binding and does not await it.
 *
 * It carries its own marker, separate from the schema one. That marker is what
 * lets a steady-state boot skip the phase entirely — without it every restart
 * would re-run a full-table tsvector recompute that changes nothing. Writing
 * it while a statement is still outstanding would strand that work forever,
 * with every later boot fast-pathing past it and no error anywhere, so it is
 * written only on a clean sweep.
 *
 * Never rejects: `start.ts` does not await it, so a rejection here would
 * surface as a contextless unhandled-rejection page.
 */
export const bootMaintenance = async (signal?: AbortSignal): Promise<void> => {
  try {
    if (await checkSchemaAtTarget(CURRENT_MAINTENANCE_HASH, MAINTENANCE_MARKER_KEY)) {
      logger.info("[Maintenance] Already at target — skipping.");
      return;
    }

    const result = await runBootMaintenance(maintenanceWork(), signal);
    if (result === "complete") {
      await writeSchemaMarker(CURRENT_MAINTENANCE_HASH, MAINTENANCE_MARKER_KEY);
      return;
    }
    // `skipped` means another instance is doing the work, or shutdown
    // cancelled it. Every rolling deploy produces one of those; paging for it
    // would train the alarm to be ignored.
    if (result === "skipped") return;

    const message =
      "Boot maintenance did not complete — an index or the search-vector reindex " +
      "is outstanding. The maintenance marker is withheld, so the next boot retries.";
    logger.warn(`[Maintenance] ${message}`);
    // Degrading instead of exiting must not also mean degrading silently. The
    // delivery is raced rather than awaited: `start.ts` awaits this phase on
    // the graceful-shutdown path, and `sendAlarm`'s fetch carries no timeout of
    // its own, so a wedged webhook would hold the stop open until compose's
    // grace period expired and SIGKILL replaced the clean exit.
    await withTimeout(
      sendAlarm("Boot Maintenance Incomplete", message).catch(() => undefined),
      MAINTENANCE_ALARM_TIMEOUT_MS
    );
  } catch (error: unknown) {
    logger.error("[Maintenance] Phase failed unexpectedly.", {}, error);
  }
};

/** Published in `.env.example`, so it is a credential only until an operator
 *  supplies their own. */
const DEFAULT_ADMIN_PASSWORD = "inbox";

export type AdminPasswordPlan =
  /** No admin row yet — this boot creates one and its password is the seed. */
  | { action: "seed"; password: string; usingDefault: boolean }
  /** An operator asked, through the environment, for the stored password to be
   *  replaced by ADMIN_PASSWORD. */
  | { action: "reset"; password: string }
  /** The stored password survives the boot untouched. */
  | { action: "keep"; resetWithoutPassword: boolean; unrecognizedReset: boolean };

/**
 * Decides what a boot may do to admin's password column.
 *
 * The stored password is the live credential: the reset flow writes it, and a
 * boot that re-derives it from the environment silently undoes that write on
 * the next restart. So the environment seeds the column and otherwise only
 * touches it when ADMIN_PASSWORD_RESET explicitly asks.
 *
 * @example
 * planAdminPassword({ adminExists: true, adminPassword: "hunter2" });
 * // => { action: "keep", resetWithoutPassword: false, unrecognizedReset: false }
 */
export const planAdminPassword = ({
  adminExists,
  adminPassword,
  adminPasswordReset,
}: {
  adminExists: boolean;
  adminPassword?: string;
  adminPasswordReset?: string;
}): AdminPasswordPlan => {
  if (!adminExists) {
    return {
      action: "seed",
      password: adminPassword || DEFAULT_ADMIN_PASSWORD,
      usingDefault: !adminPassword || adminPassword === DEFAULT_ADMIN_PASSWORD,
    };
  }
  if (adminPasswordReset !== "1") {
    return {
      action: "keep",
      resetWithoutPassword: false,
      unrecognizedReset: !!adminPasswordReset,
    };
  }
  // Resetting to the published default is the outcome nobody asks for, so an
  // empty ADMIN_PASSWORD refuses the reset rather than honouring it.
  if (!adminPassword)
    return { action: "keep", resetWithoutPassword: true, unrecognizedReset: false };
  return { action: "reset", password: adminPassword };
};

const logAdminPasswordPlan = (plan: AdminPasswordPlan, adminPassword?: string): void => {
  if (plan.action === "seed" && plan.usingDefault) {
    logger.warn(
      `[CONFIG WARNING] The admin account was created with '${DEFAULT_ADMIN_PASSWORD}', the value\n` +
        "  published in .env.example — anyone who can reach this server can sign in as admin.\n" +
        "  Set ADMIN_PASSWORD in your .env file to something else, then boot once with\n" +
        "  ADMIN_PASSWORD_RESET=1 to apply it."
    );
    return;
  }
  if (plan.action === "reset") {
    logger.warn(
      "[CONFIG WARNING] ADMIN_PASSWORD_RESET=1 replaced the stored admin password with ADMIN_PASSWORD.\n" +
        "  Remove ADMIN_PASSWORD_RESET from the environment: while it is set, every restart applies\n" +
        "  ADMIN_PASSWORD again and discards whatever password the admin set afterwards."
    );
    return;
  }
  if (plan.action === "keep" && plan.resetWithoutPassword) {
    logger.warn(
      "[CONFIG WARNING] ADMIN_PASSWORD_RESET=1 is set but ADMIN_PASSWORD is empty.\n" +
        "  The stored admin password is unchanged — set ADMIN_PASSWORD and restart to apply the reset."
    );
    return;
  }
  if (plan.action === "keep" && plan.unrecognizedReset) {
    logger.warn(
      "[CONFIG WARNING] ADMIN_PASSWORD_RESET is set to a value other than '1', so it was ignored\n" +
        "  and the stored admin password is unchanged. Only the exact string '1' requests a reset."
    );
    return;
  }
  if (adminPassword) {
    logger.info(
      "Admin already exists, so ADMIN_PASSWORD was not applied. Boot once with " +
        "ADMIN_PASSWORD_RESET=1 to replace the stored password with it."
    );
  }
};

export const initializeAdminUser = async (): Promise<void> => {
  const { ADMIN_PASSWORD, ADMIN_PASSWORD_RESET } = process.env;

  const existingAdminUser = await searchUser({ username: "admin" });
  const plan = planAdminPassword({
    adminExists: !!existingAdminUser,
    adminPassword: ADMIN_PASSWORD,
    adminPasswordReset: ADMIN_PASSWORD_RESET,
  });

  const indexingAdminUserResult = await writeUser({
    user_id: existingAdminUser?.user_id,
    username: "admin",
    // Undefined drops the column from the INSERT, which drops it from the
    // conflict clause too, so the stored hash survives the boot.
    password: plan.action === "keep" ? undefined : plan.password,
    // A reset replaces the hash, so the credential generation moves in the
    // same write — otherwise a session row restored after the boot-time
    // delete would still stamp the old generation and pass the fence.
    // Boot runs before any listener binds, so no concurrent rotation can
    // interleave with this computed bump; a keep/seed boot must not bump,
    // or every redeploy would log admin out.
    password_version:
      plan.action === "reset"
        ? (existingAdminUser?.password_version ?? 1) + 1
        : undefined,
    // Pull the domain from EMAIL_DOMAIN so admin's identity stays consistent
    // with `getDomain()` everywhere else. Hardcoding `admin@localhost` made the
    // UI's default-account lookup miss every cloned mail in sandbox/dev
    // environments where EMAIL_DOMAIN was set but admin's email kept the
    // localhost fallback — `getAccountStats` filters by domain and returned 0
    // matches, so the inbox rendered empty even though data was present.
    email: `admin@${process.env.EMAIL_DOMAIN || "localhost"}`,
  });
  const createdAdminUserId = indexingAdminUserResult?._id;
  if (!createdAdminUserId) throw new Error("Failed to create admin user");

  if (plan.action === "reset") {
    // Sessions live in Postgres and survive the restart that applies the new
    // password, and the cookie is rolling, so an operator resetting a
    // compromised admin gets nothing from the rotation alone. No mail
    // connection can exist to sweep here: this runs before any listener binds.
    const deletedSessions = await deleteSessionsForUser(createdAdminUserId);
    logger.info(
      "ADMIN_PASSWORD_RESET applied — deleted the sessions the previous password issued.",
      { deletedSessions }
    );
  }

  logger.info("Successfully initialized PostgreSQL database and setup admin user.");

  logAdminPasswordPlan(plan, ADMIN_PASSWORD);

  // Warn if EMAIL_DOMAIN is not explicitly configured.
  // Without a correct domain, getAccountStats() filters all emails out (domain condition)
  // causing the inbox to appear empty even when emails exist.
  if (!process.env.EMAIL_DOMAIN) {
    logger.warn(
      "[CONFIG WARNING] EMAIL_DOMAIN is not set. Defaulting to 'mydomain'.\n" +
        "  The inbox will appear empty if your emails are addressed to a different domain.\n" +
        "  Set EMAIL_DOMAIN=yourdomain.com in your .env file to see incoming emails."
    );
  }
};

/**
 * Reconciles the read-only administrative user (`ADMIN_RO_USERNAME`) with
 * `ADMIN_RO_PASSWORD` on every boot, in both directions:
 *
 * - set — seeds or re-seeds the account. Idempotent: reuses the existing row if
 *   the username is already present, so a redeploy keeps the same user_id.
 *   Authenticating with these credentials produces a session whose effective
 *   identity is admin and whose `isReadOnly` flag refuses every mutating
 *   surface. Changing the value to a new one also deletes the sessions the
 *   previous password issued, so rotating a leaked credential withdraws it
 *   everywhere; a redeploy with an unchanged value logs nobody out.
 * - unset — revokes any account a previous boot seeded and deletes the sessions
 *   it already issued, so removing the env var and redeploying is a complete
 *   revocation rather than a no-op that leaves a working credential behind.
 */
export const initializeAdminReadOnlyUser = async (): Promise<void> => {
  const { ADMIN_RO_PASSWORD } = process.env;

  if (!ADMIN_RO_PASSWORD) {
    await revokeAdminReadOnlyUser();
    return;
  }

  const existing = await searchUser({ username: ADMIN_RO_USERNAME });
  // Compared before the write, which replaces the hash it is compared against.
  const passwordRotated =
    !!existing && !(await verifyPassword(ADMIN_RO_PASSWORD, existing.password));

  // Revoked before the write, not after: the stored hash is the only rotation
  // signal, so a delete that raises once the new hash is persisted leaves the
  // restarted boot comparing equal, skipping the revocation for good. Failing
  // with the old hash still stored keeps the next boot's retry honest.
  let deletedSessions: number | undefined;
  if (passwordRotated) {
    deletedSessions = await deleteSessionsAuthenticatedAs(ADMIN_RO_USERNAME);
  }

  const result = await writeUser({
    user_id: existing?.user_id,
    username: ADMIN_RO_USERNAME,
    password: ADMIN_RO_PASSWORD,
    // Only a rotation moves the generation, in the same write as the new
    // hash: a grant stamped before the rotation then fails the fence even
    // if the session delete missed it (a restored row, another process's
    // connection). An unchanged value must not bump — a steady-state
    // redeploy logs nobody out — and a first seed takes the DEFAULT 1.
    password_version: passwordRotated
      ? (existing?.password_version ?? 1) + 1
      : undefined,
    // Same domain rationale as admin (see initializeAdminUser above) — a
    // consistent `@EMAIL_DOMAIN` local part keeps the account lookup happy
    // across dev / sandbox / prod.
    email: `${ADMIN_RO_USERNAME}@${process.env.EMAIL_DOMAIN || "localhost"}`,
  });
  if (!result?._id) throw new Error("Failed to create read-only admin user");

  if (passwordRotated) {
    logger.info(
      "ADMIN_RO_PASSWORD changed — deleted the sessions the previous password issued.",
      { deletedSessions }
    );
  }

  logger.info("Successfully initialized read-only admin user.");
};

/**
 * Revokes a previously seeded read-only admin account. The row is kept so a
 * later re-enable reuses its user_id; what is destroyed is the credential —
 * the stored password is replaced with a secret that exists nowhere, which no
 * login can present. Retaining the column as a valid hash (rather than
 * clearing it) keeps the three authentication surfaces on their normal
 * wrong-password path.
 *
 * Refusing new logins is only half of it: sessions outlive the password they
 * were minted from, and the cookie is rolling, so the sessions the credential
 * already issued are deleted in the same step.
 */
const revokeAdminReadOnlyUser = async (): Promise<void> => {
  const existing = await searchUser({ username: ADMIN_RO_USERNAME });
  if (!existing) {
    logger.debug(
      "[CONFIG] ADMIN_RO_PASSWORD is not set — skipping read-only admin user seed. " +
        "Set it to enable the read-only role."
    );
    return;
  }

  const revoked = await writeUser({
    user_id: existing.user_id,
    username: ADMIN_RO_USERNAME,
    password: randomBytes(32).toString("hex"),
    email: existing.email ?? undefined,
    // Revocation replaces the hash, so the generation moves in the same
    // write: without the bump, a session row restored after the delete
    // would still stamp the old generation and pass the fence.
    password_version: (existing.password_version ?? 1) + 1,
  });
  if (!revoked?._id) throw new Error("Failed to revoke read-only admin user");

  const deletedSessions = await deleteSessionsAuthenticatedAs(ADMIN_RO_USERNAME);

  logger.info(
    "ADMIN_RO_PASSWORD is not set — revoked the previously seeded read-only admin user.",
    { deletedSessions }
  );
};
