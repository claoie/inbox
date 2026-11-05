/**
 * Migration script: Elasticsearch → PostgreSQL
 *
 * This script:
 * 1. Connects to Elasticsearch via HTTP (no elasticsearch library)
 * 2. Reads all data from index inbox-2
 * 3. Transforms and inserts into PostgreSQL
 *
 * Prerequisites:
 * - PostgreSQL must be initialized by the mail server first (run the server once)
 * - Tables must already exist
 *
 * Usage: npx ts-node scripts/migrate-es-to-pg.ts
 *
 * Environment Variables:
 *   ES_HOST - Elasticsearch host (default: http://localhost:9200)
 *   ES_USERNAME - Elasticsearch username (default: elastic)
 *   ES_PASSWORD - Elasticsearch password (default: elastic)
 */

import { Pool } from "../src/server/lib/postgres/pool";
import crypto from "crypto";
import * as http from "http";
import * as https from "https";

// ES Config
const ES_HOST = process.env.ELASTIC_HOST || "http://localhost:9200";
const ES_USERNAME = process.env.ELASTIC_USERNAME || "";
const ES_PASSWORD = process.env.ELASTIC_PASSWORD || "";
const ES_INDEX = process.env.ELASTIC_INDEX || "inbox-2";

// PG Client
const pgPool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: parseInt(process.env.POSTGRES_PORT || "5432", 10),
  user: process.env.POSTGRES_USER || "",
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DATABASE || "",
  max: 10,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
  statementTimeoutMillis: 0,
  queryTimeoutMillis: 0,
});

interface ESDocument {
  type: "mail" | "user" | "session" | "push_subscription";
  mail?: Record<string, unknown>;
  user?: Record<string, unknown>;
  session?: Record<string, unknown>;
  push_subscription?: Record<string, unknown>;
  updated?: string;
}

interface ESHit {
  _id: string;
  _source: ESDocument;
}

interface ESSearchResponse {
  hits: {
    total: { value: number } | number;
    hits: ESHit[];
  };
  _scroll_id?: string;
}

interface UserIdMap {
  [esId: string]: string; // ES ID -> PG UUID
}

// HTTP fetch helper for Elasticsearch
async function fetchFromES(
  endpoint: string,
  method = "GET",
  body?: object
): Promise<any> {
  const url = new URL(endpoint, ES_HOST);
  const isHttps = url.protocol === "https:";
  const httpModule = isHttps ? https : http;

  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 9200),
    path: url.pathname + url.search,
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization:
        "Basic " +
        Buffer.from(`${ES_USERNAME}:${ES_PASSWORD}`).toString("base64"),
    },
  };

  return new Promise((resolve, reject) => {
    const req = httpModule.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Fetch all documents of a type from ES using scroll API
async function fetchESDocuments(docType: string): Promise<ESHit[]> {
  console.log(`Fetching ${docType} documents from ES...`);

  const allHits: ESHit[] = [];
  const batchSize = 1000;

  // Initial search with scroll
  let response: ESSearchResponse = await fetchFromES(
    `/${ES_INDEX}/_search?scroll=2m`,
    "POST",
    {
      size: batchSize,
      query: { term: { type: docType } },
    }
  );

  // Debug: check response structure
  if (!response.hits) {
    console.error(`  ERROR: No 'hits' in response for ${docType}:`, JSON.stringify(response).slice(0, 500));
    return [];
  }

  let scrollId = response._scroll_id;
  let hits = response.hits.hits;
  allHits.push(...hits);
  console.log(`  Fetched ${allHits.length} ${docType} documents so far...`);

  // Continue scrolling
  while (hits.length > 0 && scrollId) {
    response = await fetchFromES("/_search/scroll", "POST", {
      scroll: "2m",
      scroll_id: scrollId,
    });

    // Debug: check response structure
    if (!response.hits) {
      console.error(`  ERROR: No 'hits' in scroll response for ${docType}:`, JSON.stringify(response).slice(0, 500));
      break;
    }

    scrollId = response._scroll_id;
    hits = response.hits.hits;
    if (hits.length === 0) break;

    allHits.push(...hits);
    console.log(`  Fetched ${allHits.length} ${docType} documents so far...`);
  }

  // Clear scroll context
  if (scrollId) {
    await fetchFromES("/_search/scroll", "DELETE", {
      scroll_id: scrollId,
    }).catch(() => {});
  }

  console.log(`  Total ${docType} documents: ${allHits.length}`);
  return allHits;
}

// Migrate users
async function migrateUsers(): Promise<UserIdMap> {
  const userHits = await fetchESDocuments("user");
  const idMap: UserIdMap = {};

  console.log("Migrating users to PostgreSQL...");

  for (const hit of userHits) {
    const esId = hit._id;
    const user = hit._source.user || {};

    // Generate new UUID for PG
    const pgId = crypto.randomUUID();
    idMap[esId] = pgId;

    // Also map user.id if it exists and is different
    if (user.id && user.id !== esId) {
      idMap[user.id as string] = pgId;
    }

    const sql = `
      INSERT INTO users (user_id, username, password, email, expiry, token, updated, is_deleted)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (user_id) DO UPDATE SET
        username = EXCLUDED.username,
        password = EXCLUDED.password,
        email = EXCLUDED.email,
        expiry = EXCLUDED.expiry,
        token = EXCLUDED.token,
        updated = EXCLUDED.updated
    `;

    await pgPool.query(sql, [
      pgId,
      user.username || `user_${esId.slice(0, 8)}`,
      user.password || null,
      user.email || null,
      user.expiry || null,
      user.token || null,
      hit._source.updated || new Date().toISOString(),
      false,
    ]);
  }

  console.log(`  Migrated ${userHits.length} users.`);
  return idMap;
}

// Migrate sessions
async function migrateSessions(userIdMap: UserIdMap): Promise<void> {
  const sessionHits = await fetchESDocuments("session");

  console.log("Migrating sessions to PostgreSQL...");

  let migrated = 0;
  let skipped = 0;

  for (const hit of sessionHits) {
    const esId = hit._id;
    const session = hit._source.session || {};
    const user = (session.user || {}) as Record<string, unknown>;
    const cookie = (session.cookie || {}) as Record<string, unknown>;

    const esUserId = (user.id as string) || "";
    const pgUserId = userIdMap[esUserId];

    if (!pgUserId) {
      skipped++;
      continue;
    }

    const sql = `
      INSERT INTO sessions (
        session_id, session_user_id, session_username, session_email,
        cookie_original_max_age, cookie_max_age, cookie_signed, cookie_expires,
        cookie_http_only, cookie_path, cookie_domain, cookie_secure, cookie_same_site,
        updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (session_id) DO UPDATE SET
        session_user_id = EXCLUDED.session_user_id,
        session_username = EXCLUDED.session_username,
        session_email = EXCLUDED.session_email,
        cookie_expires = EXCLUDED.cookie_expires,
        updated = EXCLUDED.updated
    `;

    await pgPool.query(sql, [
      esId,
      pgUserId,
      user.username || "unknown",
      user.email || "unknown@localhost",
      cookie.originalMaxAge ?? null,
      cookie.maxAge ?? null,
      cookie.signed ?? null,
      cookie._expires ?? null,
      cookie.httpOnly ?? null,
      cookie.path ?? null,
      cookie.domain ?? null,
      typeof cookie.secure === "string"
        ? cookie.secure
        : JSON.stringify(cookie.secure),
      typeof cookie.sameSite === "string"
        ? cookie.sameSite
        : JSON.stringify(cookie.sameSite),
      hit._source.updated || new Date().toISOString(),
    ]);

    migrated++;
  }

  console.log(
    `  Migrated ${migrated} sessions (skipped ${skipped} without valid user).`
  );
}

// Migrate mails
async function migrateMails(userIdMap: UserIdMap): Promise<void> {
  const mailHits = await fetchESDocuments("mail");

  console.log("Migrating mails to PostgreSQL...");

  let migrated = 0;
  let skipped = 0;

  for (const hit of mailHits) {
    const mail = hit._source.mail || {};
    const docUser = (hit._source as unknown as Record<string, unknown>).user as
      | Record<string, unknown>
      | undefined;
    const esUserId = docUser?.id as string;

    const pgUserId = userIdMap[esUserId];

    if (!pgUserId) {
      skipped++;
      continue;
    }

    // Note: search_vector is auto-populated by trigger.
    // uid_account was dropped in #702 PR 3 — this one-off script no longer
    // populates it (or the per-mailbox mapping table `mail_mailbox_uid`);
    // callers that need per-account UIDs will get them via subsequent
    // receive-path writes going through the standard write path.
    const sql = `
      INSERT INTO mails (
        mail_id, user_id, message_id, subject, date, html, text,
        from_address, from_text, to_address, to_text,
        cc_address, cc_text, bcc_address, bcc_text,
        reply_to_address, reply_to_text,
        envelope_from, envelope_to, attachments,
        read, saved, sent, deleted, draft, insight,
        uid_domain, updated
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17,
        $18, $19, $20,
        $21, $22, $23, $24, $25, $26,
        $27, $28
      )
    `;

    const fromAddr = mail.from as Record<string, unknown> | undefined;
    const toAddr = mail.to as Record<string, unknown> | undefined;
    const ccAddr = mail.cc as Record<string, unknown> | undefined;
    const bccAddr = mail.bcc as Record<string, unknown> | undefined;
    const replyTo = mail.replyTo as Record<string, unknown> | undefined;
    // uid.account was the old per-account UID field, dropped in #702 PR 3.
    const uid = (mail.uid || {}) as Record<string, unknown>;

    // Helper to normalize address values to always be arrays
    const normalizeAddressValue = (value: unknown): string | null => {
      if (!value) return null;
      // If already an array, use as-is
      if (Array.isArray(value)) return JSON.stringify(value);
      // If single object, wrap in array
      if (typeof value === "object") return JSON.stringify([value]);
      return null;
    };

    try {
      await pgPool.query(sql, [
        crypto.randomUUID(),
        pgUserId,
        mail.messageId || `unknown_${crypto.randomUUID()}`,
        mail.subject || "",
        mail.date || new Date().toISOString(),
        mail.html || "",
        mail.text || "",
        normalizeAddressValue(fromAddr?.value),
        fromAddr?.text || null,
        normalizeAddressValue(toAddr?.value),
        toAddr?.text || null,
        normalizeAddressValue(ccAddr?.value),
        ccAddr?.text || null,
        normalizeAddressValue(bccAddr?.value),
        bccAddr?.text || null,
        normalizeAddressValue(replyTo?.value),
        replyTo?.text || null,
        normalizeAddressValue(mail.envelopeFrom),
        normalizeAddressValue(mail.envelopeTo),
        mail.attachments ? JSON.stringify(mail.attachments) : null,
        mail.read ?? false,
        mail.saved ?? false,
        mail.sent ?? false,
        mail.deleted ?? false,
        mail.draft ?? false,
        mail.insight ? JSON.stringify(mail.insight) : null,
        uid.domain ?? 0,
        hit._source.updated || new Date().toISOString(),
      ]);

      migrated++;
    } catch (error) {
      console.error(`  Error migrating mail ${hit._id}:`, error);
      skipped++;
    }
  }

  console.log(`  Migrated ${migrated} mails (skipped ${skipped}).`);
}

// Migrate push subscriptions
async function migratePushSubscriptions(userIdMap: UserIdMap): Promise<void> {
  const subHits = await fetchESDocuments("push_subscription");

  console.log("Migrating push subscriptions to PostgreSQL...");

  let migrated = 0;
  let skipped = 0;

  for (const hit of subHits) {
    const sub = hit._source.push_subscription || {};
    const docUser = (hit._source as unknown as Record<string, unknown>).user as
      | Record<string, unknown>
      | undefined;
    const esUserId = docUser?.id as string;

    const pgUserId = userIdMap[esUserId];

    if (!pgUserId) {
      skipped++;
      continue;
    }

    const keys = (sub.keys || {}) as Record<string, unknown>;

    const sql = `
      INSERT INTO push_subscriptions (
        push_subscription_id, user_id, endpoint, keys_p256dh, keys_auth, last_notified, updated
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;

    await pgPool.query(sql, [
      crypto.randomUUID(),
      pgUserId,
      sub.endpoint || "",
      keys.p256dh || "",
      keys.auth || "",
      sub.lastNotified || null,
      hit._source.updated || new Date().toISOString(),
    ]);

    migrated++;
  }

  console.log(
    `  Migrated ${migrated} push subscriptions (skipped ${skipped}).`
  );
}

// Main migration function
async function migrate() {
  console.log("=".repeat(60));
  console.log("Elasticsearch → PostgreSQL Migration");
  console.log(`Source: ${ES_HOST}, index: ${ES_INDEX}`);
  console.log("=".repeat(60));
  console.log();
  console.log("NOTE: This script assumes PostgreSQL is already initialized.");
  console.log("Run the mail server at least once to create tables first.");
  console.log();

  try {
    // Test ES connection
    const esInfo = await fetchFromES("/");
    console.log(`ES cluster: ${esInfo.cluster_name || "connected"}`);

    // Test PG connection and verify tables exist
    const pgRes = await pgPool.query("SELECT NOW()");
    console.log(`PG connected at: ${pgRes.rows[0].now}`);

    // Check if tables exist
    const tableCheck = await pgPool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('users', 'sessions', 'mails', 'push_subscriptions')
    `);

    if (tableCheck.rows.length < 4) {
      console.error(
        "\nERROR: Not all required tables exist. Please run the mail server first to initialize the database."
      );
      console.error(
        "Required tables: users, sessions, mails, push_subscriptions"
      );
      console.error(`Found tables: ${tableCheck.rows.map((r) => r.table_name).join(", ") || "none"}`);
      process.exit(1);
    }

    console.log("All required tables found. Starting migration...\n");

    // Migrate in order (users first due to foreign keys)
    const userIdMap = await migrateUsers();
    await migrateSessions(userIdMap);
    await migrateMails(userIdMap);
    await migratePushSubscriptions(userIdMap);

    console.log("\n" + "=".repeat(60));
    console.log("Migration completed successfully!");
    console.log("=".repeat(60));
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await pgPool.end();
  }
}

migrate();
