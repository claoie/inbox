/**
 * The domain statements against a real Postgres: who holds which role, who
 * reads a domain, the ceilings on claims and viewers, the boot backfill, and
 * the predicate that filters an owner's mail to one domain.
 *
 * Opt-in like the other probes: runs only when INBOX_TEST_PG_URL is set, in a
 * schema of its own that it drops afterwards.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { buildCreateTable } from "../database";
import {
  domainClaimsTable,
  domainRolesTable,
  domainsTable,
  formerDomainsTable,
  mailsTable,
  usersTable,
  DOMAIN_COUNT_MAX,
  DOMAIN_VIEWER_COUNT_MAX,
} from "../models";
import {
  buildBackfillAccountDomains,
  buildDeleteOwnedDomain,
  buildGetDomainAccess,
  buildGrantViewer,
  buildInsertClaim,
  buildListDomainAccess,
  buildReadersOfDomain,
} from "./domains";
import {
  buildFindViewableAttachmentQuery,
  buildFindViewableMailQuery,
  mailInDomainsCondition,
} from "./mails/domain-scope";
import { membershipCondition } from "./mails/views";

const PG_URL = process.env.INBOX_TEST_PG_URL;
const SCHEMA = "domains_probe";

if (PG_URL) describe("domain statements against a real Postgres", () => {
  const poolModule = ((globalThis as Record<string, unknown>).__REAL_POOL ??
    require("../pool")) as typeof import("../pool");
  const url = new URL(PG_URL);
  const pool = new poolModule.Pool({
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: url.pathname.slice(1),
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statementTimeoutMillis: 0,
    queryTimeoutMillis: 0,
  });

  const q = async (sql: string, params: unknown[] = []) => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${SCHEMA}`);
      return await client.query(sql, params as never);
    } finally {
      client.release();
    }
  };
  const run = ({ sql, values }: { sql: string; values: unknown[] }) => q(sql, values);

  const setup = (async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const table of [usersTable, mailsTable, domainsTable, domainClaimsTable, domainRolesTable, formerDomainsTable]) {
      await q(buildCreateTable(table.name, table.schema, table.constraints));
    }
  })();

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  const fresh = async () => {
    await setup;
    await q("DELETE FROM users");
  };

  const addUser = async (username: string, columns: Record<string, unknown> = {}) => {
    const row = { username, password: "$2b$10$x", ...columns };
    const names = Object.keys(row);
    const result = await q(
      `INSERT INTO users (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING user_id`,
      Object.values(row)
    );
    return result.rows[0].user_id as string;
  };

  const addDomain = async (name: string, userId: string) => {
    const result = await q(
      "INSERT INTO domains (name, user_id) VALUES ($1, $2) RETURNING domain_id",
      [name, userId]
    );
    return result.rows[0].domain_id as string;
  };

  const addMail = async (userId: string, columns: Record<string, unknown>) => {
    const row: Record<string, unknown> = { user_id: userId, message_id: crypto.randomUUID(), ...columns };
    for (const key of Object.keys(row)) {
      if (row[key] !== null && typeof row[key] === "object") row[key] = JSON.stringify(row[key]);
    }
    const names = Object.keys(row);
    const result = await q(
      `INSERT INTO mails (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING mail_id`,
      Object.values(row)
    );
    return result.rows[0].mail_id as string;
  };

  it("reads the owner's role from the domain row and a viewer's from domain_roles", async () => {
    await fresh();
    const owner = await addUser("owner");
    const viewer = await addUser("viewer");
    const stranger = await addUser("stranger");
    const domainId = await addDomain("example.com", owner);
    await run(buildGrantViewer(domainId, owner, viewer));

    const role = async (userId: string) =>
      (await run(buildGetDomainAccess(userId, "Example.COM"))).rows[0]?.role ?? null;
    expect(await role(owner)).toBe("owner");
    expect(await role(viewer)).toBe("viewer");
    expect(await role(stranger)).toBeNull();

    const listed = await run(buildListDomainAccess(viewer));
    expect(listed.rows.map((row) => [row.name, row.role, row.owner_username])).toEqual([
      ["example.com", "viewer", "owner"],
    ]);
  });

  it("names everyone who reads a domain: its owner and its viewers", async () => {
    await fresh();
    const owner = await addUser("owner");
    const viewer = await addUser("viewer");
    const domainId = await addDomain("example.com", owner);
    await addDomain("example.org", viewer);
    await run(buildGrantViewer(domainId, owner, viewer));

    const readers = (await run(buildReadersOfDomain("example.com"))).rows.map((row) => row.user_id);
    expect(readers.sort()).toEqual([owner, viewer].sort());
    const onlyOwner = (await run(buildReadersOfDomain("example.org"))).rows.map((r) => r.user_id);
    expect(onlyOwner).toEqual([viewer]);
  });

  it("never grants the owner the viewer role, and caps the viewers of a domain", async () => {
    await fresh();
    const owner = await addUser("owner");
    const domainId = await addDomain("example.com", owner);

    expect((await run(buildGrantViewer(domainId, owner, owner))).rowCount).toBe(0);

    for (let i = 0; i < DOMAIN_VIEWER_COUNT_MAX; i++) {
      const viewer = await addUser(`viewer${i}`);
      expect((await run(buildGrantViewer(domainId, owner, viewer))).rowCount).toBe(1);
    }
    const oneTooMany = await addUser("late");
    expect((await run(buildGrantViewer(domainId, owner, oneTooMany))).rowCount).toBe(0);
  });

  describe("a grant racing a takeover of the domain", () => {
    const viewersOf = async (domainId: string) =>
      (await q("SELECT user_id FROM domain_roles WHERE domain_id = $1", [domainId])).rows.map(
        (row) => row.user_id
      );

    const beginTakeover = async (domainId: string, newOwner: string) => {
      const client = await pool.connect();
      await client.query(`SET search_path TO ${SCHEMA}`);
      await client.query("BEGIN");
      await client.query("SELECT domain_id FROM domains WHERE domain_id = $1 FOR UPDATE", [domainId]);
      await client.query("DELETE FROM domain_roles WHERE domain_id = $1", [domainId]);
      await client.query("UPDATE domains SET user_id = $2 WHERE domain_id = $1", [domainId, newOwner]);
      return {
        commit: async () => {
          await client.query("COMMIT");
          client.release();
        },
      };
    };

    it("drops the roles the previous owner granted", async () => {
      await fresh();
      const [former, claimant, viewer] = [await addUser("a"), await addUser("b"), await addUser("v")];
      const domainId = await addDomain("x.org", former);
      await run(buildGrantViewer(domainId, former, viewer));

      await (await beginTakeover(domainId, claimant)).commit();

      expect(await viewersOf(domainId)).toEqual([]);
      expect((await run(buildGetDomainAccess(viewer, "x.org"))).rows).toEqual([]);
    });

    it("refuses a grant written after the takeover by the former owner", async () => {
      await fresh();
      const [former, claimant, viewer] = [await addUser("a"), await addUser("b"), await addUser("v")];
      const domainId = await addDomain("x.org", former);
      await (await beginTakeover(domainId, claimant)).commit();

      expect((await run(buildGrantViewer(domainId, former, viewer))).rowCount).toBe(0);
      expect(await viewersOf(domainId)).toEqual([]);
      expect((await run(buildGrantViewer(domainId, claimant, viewer))).rowCount).toBe(1);
    });

    it("refuses a grant that arrives while the takeover is in flight", async () => {
      await fresh();
      const [former, claimant, viewer] = [await addUser("a"), await addUser("b"), await addUser("v")];
      const domainId = await addDomain("x.org", former);
      const takeover = await beginTakeover(domainId, claimant);

      let settled = false;
      const grant = run(buildGrantViewer(domainId, former, viewer)).finally(() => {
        settled = true;
      });
      await Bun.sleep(200);
      expect(settled).toBe(false);
      await takeover.commit();

      expect((await grant).rowCount).toBe(0);
      expect(await viewersOf(domainId)).toEqual([]);
    });
  });

  it("removes only the owner's domain, remembering it as a former one", async () => {
    await fresh();
    const owner = await addUser("owner");
    const other = await addUser("other");
    await addDomain("example.org", owner);

    const stranger = await run(buildDeleteOwnedDomain(other, "example.org"));
    expect(stranger.rows[0].removed).toBe(0);

    const removed = await run(buildDeleteOwnedDomain(owner, "Example.ORG"));
    expect(removed.rows[0].removed).toBe(1);
    expect((await q("SELECT name FROM domains")).rows).toEqual([]);
    expect((await q("SELECT user_id, name FROM former_domains")).rows).toEqual([
      { user_id: owner, name: "example.org" },
    ]);

    // Owned and removed again: still one memory of it, and still reported removed.
    await addDomain("example.org", owner);
    expect((await run(buildDeleteOwnedDomain(owner, "example.org"))).rows[0].removed).toBe(1);
    expect((await q("SELECT COUNT(*)::int AS n FROM former_domains")).rows[0].n).toBe(1);
  });

  it("refuses a role a CHECK does not know", async () => {
    await fresh();
    const owner = await addUser("owner");
    const other = await addUser("other");
    const domainId = await addDomain("example.com", owner);
    await expect(
      q("INSERT INTO domain_roles (domain_id, user_id, role) VALUES ($1, $2, 'owner')", [domainId, other])
    ).rejects.toThrow();
  });

  it("caps the claims and domains one person holds together", async () => {
    await fresh();
    const user = await addUser("user");
    await addDomain("user.example.com", user);
    for (let i = 0; i < DOMAIN_COUNT_MAX - 1; i++) {
      expect((await run(buildInsertClaim(user, `d${i}.example`, "t"))).rowCount).toBe(1);
    }
    expect((await run(buildInsertClaim(user, "over.example", "t"))).rowCount).toBe(0);
    // The same name again is the claim the person already has, not a new row.
    expect((await run(buildInsertClaim(user, "d0.example", "t2"))).rowCount).toBe(0);
  });

  it("lets two people claim one name: a claim nobody proves blocks no one", async () => {
    await fresh();
    const a = await addUser("a");
    const b = await addUser("b");
    expect((await run(buildInsertClaim(a, "example.net", "ta"))).rowCount).toBe(1);
    expect((await run(buildInsertClaim(b, "example.net", "tb"))).rowCount).toBe(1);
  });

  it("backfills each account's own name once, skipping deleted and unroutable ones", async () => {
    await fresh();
    const bob = await addUser("bob");
    await addUser("carol", { password: null, auth_sub: "usr_carol" });
    // A sign-up still setting its password: its placeholder is no DNS label,
    // and a routable name gets its domain like any account.
    await addUser("user_1234abcd", { password: null });
    await addUser("frank", { password: null });
    await addUser("dave", { is_deleted: true });
    await addUser("Not_A_Label");
    // A name already taken stays with its owner.
    const eve = await addUser("eve");
    await addDomain("bob.example.com", eve);

    await run(buildBackfillAccountDomains("Example.com"));
    await run(buildBackfillAccountDomains("example.com"));

    const rows = (await q("SELECT name, user_id FROM domains ORDER BY name")).rows;
    expect(rows.map((row) => row.name)).toEqual(["bob.example.com", "carol.example.com", "eve.example.com", "frank.example.com"]);
    expect(rows.find((row) => row.name === "bob.example.com")!.user_id).toBe(eve);
    expect(rows.some((row) => row.user_id === bob)).toBe(false);
  });

  describe("an owner's mail filtered to one domain", () => {
    const visibleIn = async (userId: string, domains: string[]) =>
      (
        await q(
          `SELECT subject FROM mails WHERE user_id = $1 AND ${mailInDomainsCondition(2)} ORDER BY subject`,
          [userId, domains]
        )
      ).rows.map((row) => row.subject);

    it("keeps received mail by its envelope, never by a header the sender wrote", async () => {
      await fresh();
      const owner = await addUser("owner");
      await addMail(owner, {
        subject: "a delivered to example.com",
        envelope_to: [{ address: "info@Example.com" }],
        to_address: [{ address: "info@example.com" }],
      });
      await addMail(owner, {
        // Delivered to the owner's other domain, with a forged To naming the
        // shared one: a viewer of example.com must not see it.
        subject: "b delivered to example.org",
        envelope_to: [{ address: "secret@example.org" }],
        to_address: [{ address: "info@example.com" }],
      });
      await addMail(owner, {
        subject: "c stored before envelopes",
        envelope_to: null,
        to_address: [{ address: "old@example.com" }],
      });

      expect(await visibleIn(owner, ["example.com"])).toEqual([
        "a delivered to example.com",
        "c stored before envelopes",
      ]);
      expect(await visibleIn(owner, ["example.org"])).toEqual(["b delivered to example.org"]);
    });

    it("keeps sent mail by its From, and never matches a name under the domain", async () => {
      await fresh();
      const owner = await addUser("owner");
      await addMail(owner, {
        subject: "a sent from example.com",
        sent: true,
        from_address: [{ address: "me@example.com" }],
        to_address: [{ address: "someone@example.org" }],
      });
      await addMail(owner, {
        subject: "b sent from a subdomain",
        sent: true,
        from_address: [{ address: "me@sub.example.com" }],
      });

      expect(await visibleIn(owner, ["example.com"])).toEqual(["a sent from example.com"]);
      expect(await visibleIn(owner, ["example.org"])).toEqual([]);
    });

    it("renders the same rule through the IMAP membership condition", async () => {
      await fresh();
      const owner = await addUser("owner");
      await addMail(owner, { subject: "in", envelope_to: [{ address: "x@example.com" }] });
      await addMail(owner, { subject: "out", envelope_to: [{ address: "x@example.org" }] });
      const rows = await q(
        `SELECT subject FROM mails WHERE user_id = $1 AND sent = FALSE${membershipCondition(null, false, "", ["example.com"])}`,
        [owner]
      );
      expect(rows.rows.map((row) => row.subject)).toEqual(["in"]);
    });

    it("finds a mail for a viewer only through a domain they view that it belongs to", async () => {
      await fresh();
      const owner = await addUser("owner");
      const viewer = await addUser("viewer");
      const shared = await addDomain("example.com", owner);
      await addDomain("example.org", owner);
      await run(buildGrantViewer(shared, owner, viewer));
      const visible = await addMail(owner, { subject: "s", envelope_to: [{ address: "x@example.com" }] });
      const hidden = await addMail(owner, {
        subject: "h",
        envelope_to: [{ address: "x@example.org" }],
        to_address: [{ address: "x@example.com" }],
      });

      const found = await run(buildFindViewableMailQuery(viewer, visible));
      expect(found.rows).toEqual([{ user_id: owner, domains: ["example.com"] }]);
      expect((await run(buildFindViewableMailQuery(viewer, hidden))).rows).toEqual([]);
      // The owner reads their own rows directly, never through a role.
      expect((await run(buildFindViewableMailQuery(owner, visible))).rows).toEqual([]);
    });

    it("finds an attachment for a viewer only on a mail of a domain they view", async () => {
      await fresh();
      const owner = await addUser("owner");
      const viewer = await addUser("viewer");
      const shared = await addDomain("example.com", owner);
      await addDomain("example.org", owner);
      await run(buildGrantViewer(shared, owner, viewer));
      const attachment = (id: string) => [{ filename: "f", content: { data: id } }];
      await addMail(owner, {
        subject: "s",
        envelope_to: [{ address: "x@example.com" }],
        attachments: attachment("att-shared"),
      });
      await addMail(owner, {
        subject: "h",
        envelope_to: [{ address: "x@example.org" }],
        to_address: [{ address: "x@example.com" }],
        attachments: attachment("att-hidden"),
      });

      expect((await run(buildFindViewableAttachmentQuery(viewer, "att-shared"))).rowCount).toBe(1);
      expect((await run(buildFindViewableAttachmentQuery(viewer, "att-hidden"))).rowCount).toBe(0);
      expect((await run(buildFindViewableAttachmentQuery(viewer, "att-none"))).rowCount).toBe(0);
    });
  });
});
