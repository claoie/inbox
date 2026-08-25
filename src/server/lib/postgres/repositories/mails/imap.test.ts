/**
 * Tests for mail repository functions
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";

describe("STORE operation types", () => {
  /**
   * Helper to simulate buildFlagSetClause behavior for testing.
   * This mirrors the logic in the mails/ repository
   */
  function simulateFlagUpdate(
    operation: "FLAGS" | "+FLAGS" | "-FLAGS",
    flags: string[],
    currentFlags: { read: boolean; saved: boolean; deleted: boolean; draft: boolean; answered: boolean }
  ): { read: boolean; saved: boolean; deleted: boolean; draft: boolean; answered: boolean } {
    const hasFlag = (flag: string) => flags.includes(flag);
    const result = { ...currentFlags };

    switch (operation) {
      case "FLAGS":
        // Replace mode: set all flags based on presence in flags array
        return {
          read: hasFlag("\\Seen"),
          saved: hasFlag("\\Flagged"),
          deleted: hasFlag("\\Deleted"),
          draft: hasFlag("\\Draft"),
          answered: hasFlag("\\Answered"),
        };

      case "+FLAGS":
        // Add mode: only set flags that are in the array to true
        if (hasFlag("\\Seen")) result.read = true;
        if (hasFlag("\\Flagged")) result.saved = true;
        if (hasFlag("\\Deleted")) result.deleted = true;
        if (hasFlag("\\Draft")) result.draft = true;
        if (hasFlag("\\Answered")) result.answered = true;
        return result;

      case "-FLAGS":
        // Remove mode: only set flags that are in the array to false
        if (hasFlag("\\Seen")) result.read = false;
        if (hasFlag("\\Flagged")) result.saved = false;
        if (hasFlag("\\Deleted")) result.deleted = false;
        if (hasFlag("\\Draft")) result.draft = false;
        if (hasFlag("\\Answered")) result.answered = false;
        return result;
    }
  }

  describe("FLAGS (replace mode)", () => {
    it("should replace all flags with specified flags", () => {
      const current = { read: true, saved: true, deleted: false, draft: false, answered: true };
      const result = simulateFlagUpdate("FLAGS", ["\\Seen", "\\Deleted"], current);
      expect(result).toEqual({
        read: true,
        saved: false,
        deleted: true,
        draft: false,
        answered: false,
      });
    });

    it("should clear all flags when empty flags list", () => {
      const current = { read: true, saved: true, deleted: true, draft: true, answered: true };
      const result = simulateFlagUpdate("FLAGS", [], current);
      expect(result).toEqual({
        read: false,
        saved: false,
        deleted: false,
        draft: false,
        answered: false,
      });
    });
  });

  describe("+FLAGS (add mode)", () => {
    it("should add flags without affecting others", () => {
      const current = { read: false, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Seen", "\\Deleted"], current);
      expect(result).toEqual({
        read: true,
        saved: true, // unchanged
        deleted: true,
        draft: false, // unchanged
        answered: false, // unchanged
      });
    });

    it("should not change flags when adding flags that are already set", () => {
      const current = { read: true, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Seen"], current);
      expect(result).toEqual({
        read: true,
        saved: true,
        deleted: false,
        draft: false,
        answered: false,
      });
    });

    it("should handle empty flags list without changes", () => {
      const current = { read: true, saved: false, deleted: false, draft: true, answered: false };
      const result = simulateFlagUpdate("+FLAGS", [], current);
      expect(result).toEqual(current);
    });
  });

  describe("-FLAGS (remove mode)", () => {
    it("should remove flags without affecting others", () => {
      const current = { read: true, saved: true, deleted: true, draft: false, answered: true };
      const result = simulateFlagUpdate("-FLAGS", ["\\Seen", "\\Answered"], current);
      expect(result).toEqual({
        read: false,
        saved: true, // unchanged
        deleted: true, // unchanged
        draft: false, // unchanged
        answered: false,
      });
    });

    it("should not change flags when removing flags that are already unset", () => {
      const current = { read: false, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("-FLAGS", ["\\Seen"], current);
      expect(result).toEqual({
        read: false,
        saved: true,
        deleted: false,
        draft: false,
        answered: false,
      });
    });

    it("should handle empty flags list without changes", () => {
      const current = { read: true, saved: false, deleted: false, draft: true, answered: false };
      const result = simulateFlagUpdate("-FLAGS", [], current);
      expect(result).toEqual(current);
    });
  });

  describe("real-world scenarios", () => {
    it("should handle marking as read", () => {
      const current = { read: false, saved: false, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Seen"], current);
      expect(result.read).toBe(true);
      expect(result.deleted).toBe(false); // Should not mark as deleted!
    });

    it("should handle marking for deletion without losing read status", () => {
      const current = { read: true, saved: true, deleted: false, draft: false, answered: false };
      const result = simulateFlagUpdate("+FLAGS", ["\\Deleted"], current);
      expect(result).toEqual({
        read: true,
        saved: true,
        deleted: true,
        draft: false,
        answered: false,
      });
    });

    it("should handle undeleting a message", () => {
      const current = { read: true, saved: false, deleted: true, draft: false, answered: false };
      const result = simulateFlagUpdate("-FLAGS", ["\\Deleted"], current);
      expect(result.deleted).toBe(false);
      expect(result.read).toBe(true); // Should preserve read status
    });
  });
});

describe("buildFlagSetClause — empty/unknown-only STORE is a no-op (#671)", () => {
  // A +FLAGS/-FLAGS that touches no recognized flag must yield NO SET
  // assignment (empty string), not the old `updated = updated` sentinel that
  // collided with the trailing `updated = CURRENT_TIMESTAMP` → Postgres
  // "multiple assignments to same column". setMailFlags treats "" as the
  // legal no-op path (RFC 3501 §6.4.6).
  const load = async () => (await import(".")).buildFlagSetClause;

  it("returns '' for +FLAGS with an empty flag list", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("+FLAGS", [])).toBe("");
  });

  it("returns '' for -FLAGS with an empty flag list", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("-FLAGS", [])).toBe("");
  });

  it("returns '' for +FLAGS with only unknown/custom keywords", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("+FLAGS", ["\\CustomKeyword", "Foo"])).toBe("");
  });

  it("never emits the `updated = updated` double-assignment sentinel", async () => {
    const buildFlagSetClause = await load();
    for (const op of ["+FLAGS", "-FLAGS"] as const) {
      for (const flags of [[], ["Foo"], ["\\Seen"]]) {
        expect(buildFlagSetClause(op, flags)).not.toContain("updated");
      }
    }
  });

  it("still emits real column assignments when a flag is recognized", async () => {
    const buildFlagSetClause = await load();
    expect(buildFlagSetClause("+FLAGS", ["\\Seen"])).toBe("read = TRUE");
    expect(buildFlagSetClause("+FLAGS", ["\\Seen", "\\Deleted"])).toBe(
      "read = TRUE, deleted = TRUE"
    );
    expect(buildFlagSetClause("-FLAGS", ["\\Flagged"])).toBe("saved = FALSE");
  });

  it("FLAGS replace mode is always a full (non-empty) assignment", async () => {
    const buildFlagSetClause = await load();
    // Even `FLAGS ()` (clear all) is a real change, never a no-op.
    const clause = buildFlagSetClause("FLAGS", []);
    expect(clause).toContain("read = false");
    expect(clause).toContain("answered = false");
  });
});

describe("setMailFlags — no-op STORE skips the UPDATE (source regression for #671)", () => {
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
    const fnMatch = mailsSource.match(/export const setMailFlags[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("setMailFlags not found in mails/*.ts");
    fnSource = fnMatch[0];
  });

  it("no longer contains the `updated = updated` sentinel", () => {
    expect(fnSource).not.toContain("updated = updated");
  });

  it("has a no-op branch guarded on an empty setClause", () => {
    expect(fnSource).toMatch(/if\s*\(!setClause\)/);
  });

  it("no-op branch runs the SELECT variant and never touches the UPDATE variant", () => {
    const noopBlock = fnSource.match(/if\s*\(!setClause\)\s*\{[\s\S]*?\n {4}\}/);
    expect(noopBlock).not.toBeNull();
    expect(noopBlock![0]).toContain("selectSql");
    expect(noopBlock![0]).not.toContain("updateSql");
    expect(noopBlock![0]).not.toContain("getNextModseq");
  });
});

describe("account-scoped reads use the raw mailbox path", () => {
  // Reads join mail_mailbox_uid on `x.mailbox = $N` where `$N` is the mailbox
  // path the caller passed in — the SAME string the write side stored via
  // writeMailboxUid. Deriving the JOIN target from the account address (e.g.
  // `INBOX/accounts/${localPart}`) breaks user-created mailboxes: `Archive`
  // stores rows with mail_mailbox_uid.mailbox = "Archive", so a derived
  // `INBOX/accounts/Archive` returns zero rows and the mail is invisible.
  //
  // Static source check. The reader must (a) accept a `mailbox` parameter
  // (nullable for domain-scoped views), (b) bind that parameter directly onto
  // `x.mailbox = $N`, and (c) NOT define a mailboxPathForAccount helper that
  // derives the path.
  let mailsSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = await fs.readFile(path.join(import.meta.dir, "imap.ts"), "utf8");
  });

  it("no longer defines the derived-path helper", () => {
    expect(mailsSource).not.toContain("mailboxPathForAccount");
  });

  const fns = [
    "countMessages",
    "getMailsByRange",
    "setMailFlags",
    "searchMailsByUid",
    "getAllUids",
    "getFirstUnseenUid",
    "expungeDeletedMails",
    "expungeMailsByUid",
  ];

  it.each(fns)("%s takes `mailbox` (not `account`) as the mapping key", (fn) => {
    // Extract the function's signature via the export line. Every refactored
    // reader must name its per-mailbox arg `mailbox` so future edits can't
    // rename it back to `account` (a legacy shape that implied a synthetic
    // address input, which is the pattern that caused the user-created bug).
    const sigMatch = mailsSource.match(
      new RegExp(`export const ${fn}\\s*=\\s*async\\s*\\(([\\s\\S]*?)\\)`)
    );
    expect(sigMatch, `signature not found for ${fn}`).not.toBeNull();
    expect(sigMatch![1]).toMatch(/\bmailbox\s*:\s*string\s*\|\s*null/);
    expect(sigMatch![1]).not.toMatch(/\baccount\s*:\s*string\s*\|\s*null/);
  });

  it("every account-scoped JOIN binds `x.mailbox = $N` with N in scope", () => {
    // Coarse but effective: each per-mailbox branch must contain the
    // parameterised mailbox filter — never a derived literal.
    const branches = mailsSource.match(/x\.\$\{MAILBOX\}\s*=\s*\$\d+/g) ?? [];
    // 8 refactored sites; getMailsByRange has 2 (useUid + seq) and setMailFlags
    // has 3 (useUid selectSql + updateSql + seq target subquery). Bound: ≥8.
    expect(branches.length).toBeGreaterThanOrEqual(8);
  });
});

describe("getMailsByRange — text_octets / html_octets synthetic projection", () => {
  let source: string;
  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    source = await fs.readFile(path.join(import.meta.dir, "imap.ts"), "utf8");
  });

  it("projects octet_length(text) AS text_octets when requested", () => {
    expect(source).toMatch(/octet_length\(\$\{prefix\}text\)\s+AS\s+text_octets/);
  });

  it("projects octet_length(html) AS html_octets when requested", () => {
    expect(source).toMatch(/octet_length\(\$\{prefix\}html\)\s+AS\s+html_octets/);
  });

  it("strips the synthetic names from the mails-column SELECT list", () => {
    // The synthetic names would break the SELECT list if they leaked in
    // (`m.text_octets` is not a column). The strip set names both.
    expect(source).toContain('syntheticNames = new Set(["uid_mailbox", "text_octets", "html_octets"])');
  });

  it("passes the `m.` prefix in the JOIN branch so the octet_length is unambiguous", () => {
    // The JOIN branch calls `octetProjections("m.")` so the alias refers to
    // the mails table under its `m` alias, not the mapping table.
    expect(source).toContain('octetProjections("m.")');
    expect(source).toContain('octetProjections("")');
  });
});

describe("getMailsByRange — CHANGEDSINCE modseq filter (CONDSTORE phase 3, #609)", () => {
  // Source-text scan (robust against module-mock interactions in the full
  // suite): the CHANGEDSINCE modifier must add a `modseq > $N` predicate to the
  // range query in both the domain-wide and per-mailbox branches, so the filter
  // runs in SQL (O(rows-changed)) rather than as a JS post-filter over the
  // whole window.
  let mailsSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = await fs.readFile(path.join(import.meta.dir, "imap.ts"), "utf8");
  });

  it("takes an optional changedSince parameter", () => {
    const sigMatch = mailsSource.match(
      /export const getMailsByRange\s*=\s*async\s*\(([\s\S]*?)\)/
    );
    expect(sigMatch).not.toBeNull();
    expect(sigMatch![1]).toMatch(/changedSince\s*\??\s*:\s*number/);
  });

  it("adds a `modseq > $N` predicate for the domain-wide branch", () => {
    // `${MODSEQ} > $5` — the param after the domain branch's fixed 4 args.
    expect(mailsSource).toMatch(/\$\{MODSEQ\}\s*>\s*\$5/);
  });

  it("adds a qualified `m.modseq > $N` predicate for the per-mailbox branch", () => {
    // `m.${MODSEQ} > $6` — the param after the per-mailbox branch's fixed 5 args.
    expect(mailsSource).toMatch(/m\.\$\{MODSEQ\}\s*>\s*\$6/);
  });

  it("only appends the predicate when changedSince is provided", () => {
    expect(mailsSource).toMatch(/changedSince !== undefined/);
  });
});

describe("expungeDeletedMails — `updated` column refresh (regression for #456, #614)", () => {
  let mailsSource: string;
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
    const fnMatch = mailsSource.match(
      /export const expungeDeletedMails[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("expungeDeletedMails not found in mails/*.ts");
    fnSource = fnMatch[0];
  });

  it("does not contain any raw `SET expunged` UPDATE statement", () => {
    expect(fnSource).not.toMatch(/SET\s+expunged/);
  });

  it("domain-wide branch uses mailsTable.updateWhere with DB-clock `updated`", () => {
    // The `account === null` branch must use updateWhere with equality filters.
    expect(fnSource).toContain("mailsTable.updateWhere(");
    expect(fnSource).toMatch(/\[EXPUNGED\]:\s*true/);
    expect(fnSource).toMatch(/updated:\s*DB_NOW/);
    expect(fnSource).not.toMatch(/updated:\s*new Date\(\)/);
  });

  it("account-specific branch uses mailsTable.updateWhere with IN filter", () => {
    // The `account !== null` branch is 2-step: raw SELECT to resolve mail_ids,
    // then framework updateWhere with op:"IN" so `updated` is bumped.
    expect(fnSource).toMatch(/op:\s*"IN"/);
    expect(fnSource).toMatch(/value:\s*mailIds/);
    // Two updateWhere call sites — one per branch.
    const updateWhereCount =
      (fnSource.match(/mailsTable\.updateWhere\(/g) ?? []).length;
    expect(updateWhereCount).toBe(2);
  });

  it("no mutation path in mails.ts stamps `updated` from the app clock", () => {
    expect(mailsSource).not.toMatch(/updated:\s*new Date\(\)/);
    // And the sentinel is actually the shape in use.
    expect(mailsSource).toMatch(/updated:\s*DB_NOW/);
  });

  it("saveMail envelope_to merge (23505 conflict) stamps DB-clock `updated`", () => {
    const saveMatch = mailsSource.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in mails/*.ts");
    const saveSource = saveMatch[0];
    expect(saveSource).toContain("mailsTable.updateWhere(");
    expect(saveSource).toMatch(/\[ENVELOPE_TO\]:/);
    expect(saveSource).toMatch(/updated:\s*DB_NOW/);
  });

  it("saveMail dual-writes to mail_mailbox_uid on the INSERT branch", () => {
    const saveMatch = mailsSource.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in mails/*.ts");
    const saveSource = saveMatch[0];
    // The call is gated: mailbox present AND uid_mailbox > 0 (no
    // per-mailbox UID reserved → no mapping row).
    expect(saveSource).toMatch(/writeMailboxUid\s*\(/);
    expect(saveSource).toMatch(/input\.mailbox/);
    expect(saveSource).toMatch(/uid_mailbox/);
    // Two mailboxes can be recorded per row — the mapped destination against
    // `uid_mailbox`, and the domain view against `uid_domain` — on each of the
    // two branches (INSERT success + 23505 conflict merge).
    const writeMailboxUidCount =
      (saveSource.match(/writeMailboxUid\s*\(/g) ?? []).length;
    expect(writeMailboxUidCount).toBe(4);
    const mappedCount = (saveSource.match(/input\.mailbox,/g) ?? []).length;
    const domainCount = (saveSource.match(/input\.domain_mailbox,/g) ?? []).length;
    expect([mappedCount, domainCount]).toEqual([2, 2]);
  });

  it("saveMail's outer catch rethrows on non-23505 errors so SMTP replies 5xx", () => {
    const saveMatch = mailsSource.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in mails/*.ts");
    const saveSource = saveMatch[0];
    // 23505 branch returns { _id }; the ONLY remaining `return undefined`
    // is the early-guard when getMailByMessageId misses (rare invariant
    // break, not a transient). The non-23505 outer-catch tail must throw.
    expect(saveSource).toMatch(/logger\.error\("Failed to save mail"/);
    // The line after "Failed to save mail" logger.error must be `throw error;`.
    const outerCatchTail = saveSource.match(
      /logger\.error\("Failed to save mail"[^\n]*\n\s+throw error;/
    );
    expect(outerCatchTail).not.toBeNull();
  });

  it("writeMailboxUid uses DO UPDATE + RETURNING so persisted UID is always returned", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const counters = await fs.readFile(
      path.join(import.meta.dir, "counters.ts"),
      "utf8"
    );
    const fnMatch = counters.match(/export const writeMailboxUid[\s\S]*?\n};/);
    if (!fnMatch) throw new Error("writeMailboxUid not found in counters.ts");
    const fnSource = fnMatch[0];
    expect(fnSource).toMatch(/ON CONFLICT\s*\([^)]+\)\s+DO UPDATE/);
    expect(fnSource).toMatch(/RETURNING\s+\$\{UID\}/);
    // Return type must be `Promise<number>` — callers rely on it.
    expect(fnSource).toMatch(/Promise<number>/);
    // Guard against a future revert to DO NOTHING.
    expect(fnSource).not.toMatch(/ON CONFLICT\s*\([^)]+\)\s+DO NOTHING/);
  });

  it("saveMail returns uid_mailbox on both the INSERT and the 23505 merge branches", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const core = await fs.readFile(
      path.join(import.meta.dir, "core.ts"),
      "utf8"
    );
    const saveMatch = core.match(/export const saveMail[\s\S]*?\n};/);
    if (!saveMatch) throw new Error("saveMail not found in core.ts");
    const saveSource = saveMatch[0];
    // The type annotation on saveMail's return promise must include
    // uid_mailbox as an optional field — callers depend on it for
    // COPYUID / MOVE dest-UID reporting (see storeMail's mail.uid.account
    // reconciliation).
    expect(saveSource).toMatch(/Promise<\{\s*_id:\s*string;\s*uid_mailbox\?/);
    // Both writeMailboxUid call sites (INSERT success + 23505 merge)
    // capture the returned UID into `persistedUid` and thread it into
    // the returned object.
    const persistedUidAssignments = (saveSource.match(/persistedUid\s*=\s*await\s+writeMailboxUid/g) ?? []).length;
    expect(persistedUidAssignments).toBe(2);
    // Both return statements include uid_mailbox: persistedUid.
    const returnSites = (saveSource.match(/return\s*\{\s*_id:[^}]*uid_mailbox:\s*persistedUid/g) ?? []).length;
    expect(returnSites).toBe(2);
  });
});

describe("buildCriterionClause — flag criteria use schema columns", () => {
  const clauseFor = async (type: string) => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    return buildCriterionClause({ type }, "uid_mailbox", values as never);
  };

  it("ANSWERED maps to answered = TRUE", async () => {
    expect(await clauseFor("ANSWERED")).toBe("answered = TRUE");
  });

  it("UNANSWERED maps to answered = FALSE", async () => {
    expect(await clauseFor("UNANSWERED")).toBe("answered = FALSE");
  });

  it("DELETED maps to deleted = TRUE", async () => {
    expect(await clauseFor("DELETED")).toBe("deleted = TRUE");
  });

  it("UNDELETED maps to deleted = FALSE", async () => {
    expect(await clauseFor("UNDELETED")).toBe("deleted = FALSE");
  });

  it("DRAFT maps to draft = TRUE", async () => {
    expect(await clauseFor("DRAFT")).toBe("draft = TRUE");
  });

  it("UNDRAFT maps to draft = FALSE", async () => {
    expect(await clauseFor("UNDRAFT")).toBe("draft = FALSE");
  });

  it("no flag criterion returns a bare FALSE sentinel", async () => {
    for (const type of [
      "ANSWERED",
      "UNANSWERED",
      "DELETED",
      "UNDELETED",
      "DRAFT",
      "UNDRAFT",
    ]) {
      expect(await clauseFor(type)).not.toBe("FALSE");
    }
  });
});

describe("buildCriterionClause — NOT/OR SQL generation (regression for #551)", () => {
  // buildCriterionClause receives the normalised `{ type, value }` shape that
  // store.ts's simplifyCriterion produces. It pushes bound params onto `values`
  // (1-indexed `$N` tracks values.length) and returns the boolean SQL fragment,
  // or null when the criterion imposes no constraint.

  it("NOT wraps the inner clause instead of dropping it", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "SEEN" } },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("NOT (read = TRUE)");
    expect(values).toHaveLength(0);
  });

  it("OR joins both sides with continuous param numbering", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "FROM", value: "alice" },
          right: { type: "FROM", value: "bob" },
        },
      },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(from_text ILIKE $1 OR from_text ILIKE $2)");
    expect(values).toEqual(["%alice%", "%bob%"]);
  });

  it("NOT FROM negates a text predicate and binds its param", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "FROM", value: "spam@x" } },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("NOT (from_text ILIKE $1)");
    expect(values).toEqual(["%spam@x%"]);
  });

  it("continues param numbering from an already-populated values array", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = ["user-1", false]; // e.g. base user_id/sent params
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "SUBJECT", value: "a" },
          right: { type: "TO", value: "b" },
        },
      },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(subject ILIKE $3 OR to_text ILIKE $4)");
    expect(values).toEqual(["user-1", false, "%a%", "%b%"]);
  });

  it("drops an OR whose side imposes no constraint rather than over-narrowing", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      {
        type: "OR",
        value: {
          left: { type: "FROM", value: "alice" },
          right: { type: "ALL" }, // ALL → null fragment
        },
      },
      "uid_mailbox",
      values as never
    );
    // FROM alice OR ALL = everything, so the whole disjunction is dropped.
    expect(frag).toBeNull();
  });

  it("normalised NOT BEFORE flows a Date param through correctly", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const when = new Date("2026-01-01T00:00:00Z");
    const frag = buildCriterionClause(
      { type: "NOT", value: { type: "BEFORE", value: when } },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("NOT (date < $1)");
    expect(values).toEqual([when]);
  });

  it("plain criteria are unaffected by the refactor", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    expect(buildCriterionClause({ type: "SEEN" }, "uid_mailbox", values as never)).toBe(
      "read = TRUE"
    );
    expect(buildCriterionClause({ type: "ALL" }, "uid_mailbox", values as never)).toBeNull();
  });
});

describe("buildCriterionClause — UID_SET ORs its ranges (#659)", () => {

  it("renders a single exact element without an OR wrapper", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 5 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("uid_mailbox = $1");
    expect(values).toEqual([5]);
  });

  it("ORs disjoint exact elements (`1,3`) instead of ANDing to empty", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1 }, { start: 3 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(uid_mailbox = $1 OR uid_mailbox = $2)");
    expect(values).toEqual([1, 3]);
  });

  it("ORs mixed exact + range elements (`2:3,5:7`) with parenthesised ranges", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 2, end: 3 }, { start: 5, end: 7 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe(
      "((uid_mailbox >= $1 AND uid_mailbox <= $2) OR (uid_mailbox >= $3 AND uid_mailbox <= $4))"
    );
    expect(values).toEqual([2, 3, 5, 7]);
  });

  it("renders a lone range without an OR wrapper (common `1:3` client form)", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1, end: 3 }] },
      "uid_mailbox",
      values as never
    );
    expect(frag).toBe("(uid_mailbox >= $1 AND uid_mailbox <= $2)");
    expect(values).toEqual([1, 3]);
  });

  it("ANDs correctly against a sibling flag key (`SEEN 1,3`)", async () => {
    const { buildCriterionClause } = await import(".");
    // Sibling keys are joined with AND by searchMailsByUid; the set stays a
    // single OR-group so the intersection is `read AND (uid∈{1,3})`.
    const values: unknown[] = [];
    const flag = buildCriterionClause({ type: "SEEN" }, "uid_mailbox", values as never);
    const set = buildCriterionClause(
      { type: "UID_SET", value: [{ start: 1 }, { start: 3 }] },
      "uid_mailbox",
      values as never
    );
    expect([flag, set].join(" AND ")).toBe(
      "read = TRUE AND (uid_mailbox = $1 OR uid_mailbox = $2)"
    );
    expect(values).toEqual([1, 3]);
  });

  it("imposes no constraint for an empty set (caller skips it)", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    expect(
      buildCriterionClause({ type: "UID_SET", value: [] }, "uid_mailbox", values as never)
    ).toBeNull();
    expect(values).toHaveLength(0);
  });
});

describe("searchMailsByUid — no result cap (#553)", () => {
  // A `LIMIT 10000` with `ORDER BY uid ASC` made SEARCH/UID SEARCH drop
  // the NEWEST messages once a mailbox exceeded 10000 — the worst-possible
  // truncation for an email client and an RFC 3501 §6.4.4 violation (SEARCH
  // must return all matching messages). The enumeration siblings getAllUids
  // and getMailsByRange are unbounded; the search path must match.
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const mailsSource = (
      await Promise.all(
        (await fs.readdir(import.meta.dir)).sort()
          .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
          .map((f) => fs.readFile(path.join(import.meta.dir, f), "utf8"))
      )
    ).join("\n");
    const fnMatch = mailsSource.match(
      /export const searchMailsByUid[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("searchMailsByUid not found in mails/*.ts");
    fnSource = fnMatch[0];
  });

  it("the search SQL has no LIMIT clause", () => {
    const sqlMatch = fnSource.match(
      /const sql = `([\s\S]*?SELECT[\s\S]*?)`/
    );
    if (!sqlMatch) throw new Error("search SQL not found");
    expect(sqlMatch[1]).not.toMatch(/\bLIMIT\b/i);
  });
});

describe("buildCriterionClause — BODY/TEXT search the message body (#552)", () => {
  // RFC 3501 §6.4.4: BODY matches the message body; TEXT matches header +
  // body. The prior impl ORed only subject/from_text/to_text, so IMAP
  // `SEARCH BODY <s>` / `SEARCH TEXT <s>` never consulted the `text`
  // (plain-text body) column and missed virtually every body-content match.

  it("BODY matches the body column only", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "BODY", value: "needle" },
      "uid_mailbox",
      values as never,
    );
    expect(frag).toBe("text ILIKE $1");
    // Body-only per RFC: must not fold in the header columns.
    expect(frag).not.toContain("subject ILIKE");
    expect(frag).not.toContain("from_text ILIKE");
    expect(values).toEqual(["%needle%"]);
  });

  it("TEXT matches header columns plus the body column", async () => {
    const { buildCriterionClause } = await import(".");
    const values: unknown[] = [];
    const frag = buildCriterionClause(
      { type: "TEXT", value: "needle" },
      "uid_mailbox",
      values as never,
    );
    expect(frag).toContain("subject ILIKE");
    expect(frag).toContain("from_text ILIKE");
    expect(frag).toContain("to_text ILIKE");
    expect(frag).toContain("text ILIKE");
  });
});

describe("buildCriterionClause — unexpressible criteria fail closed (#672)", () => {
  // Before this fix, any criterion the SQL backend couldn't express returned
  // null ("no constraint") and was dropped from the WHERE clause, so it matched
  // EVERY message (fail-open) — RFC 3501 §6.4.4 requires the exact match set,
  // and fail-open is the dangerous direction (a filter that should match none
  // returns all, and a client may bulk-move/flag/delete the whole mailbox).
  // The fix returns a MATCH_NONE sentinel ("FALSE") so the criterion fails
  // closed instead. KEYWORD/UNKEYWORD are exact evaluations (the server stores
  // no custom keywords); LARGER/SMALLER/arbitrary-HEADER are fail-closed until
  // backing data exists.
  const build = async (
    criterion: { type: string; value?: unknown },
    values: unknown[] = [],
  ) => {
    const { buildCriterionClause } = await import(".");
    return buildCriterionClause(criterion, "uid_mailbox", values as never);
  };

  it("MATCH_NONE is a truthy SQL fragment so searchMailsByUid keeps it in the AND", async () => {
    const { MATCH_NONE } = await import(".");
    // searchMailsByUid does `if (frag) conditions.push(frag)`. The sentinel must
    // stay truthy — an empty string would be dropped and re-open the fail-open hole.
    expect(MATCH_NONE).toBe("FALSE");
    expect(Boolean(MATCH_NONE)).toBe(true);
  });

  it("KEYWORD can never match (no custom keywords stored) → match-none", async () => {
    const values: unknown[] = [];
    expect(await build({ type: "KEYWORD", value: "Foo" }, values)).toBe("FALSE");
    expect(values).toHaveLength(0); // no bound param
  });

  it("UNKEYWORD always matches (no message has the keyword) → match-all (null)", async () => {
    expect(await build({ type: "UNKEYWORD", value: "Foo" })).toBeNull();
  });

  it("LARGER / SMALLER fail closed (RFC822.SIZE not persisted) → match-none", async () => {
    const lv: unknown[] = [];
    expect(await build({ type: "LARGER", value: 999999999 }, lv)).toBe("FALSE");
    expect(lv).toHaveLength(0);
    const sv: unknown[] = [];
    expect(await build({ type: "SMALLER", value: 1 }, sv)).toBe("FALSE");
    expect(sv).toHaveLength(0);
  });

  it("HEADER on an unsupported field fails closed → match-none", async () => {
    const values: unknown[] = [];
    expect(
      await build({ type: "HEADER", value: { field: "X-Mailer", text: "z" } }, values),
    ).toBe("FALSE");
    expect(values).toHaveLength(0);
  });

  it("HEADER on a supported field still filters (control — not swept into fail-closed)", async () => {
    const values: unknown[] = [];
    expect(
      await build({ type: "HEADER", value: { field: "Subject", text: "hi" } }, values),
    ).toBe("subject ILIKE $1");
    expect(values).toEqual(["%hi%"]);
  });

  it("an unknown criterion type fails closed → match-none", async () => {
    expect(await build({ type: "SOMETHING-UNSUPPORTED" })).toBe("FALSE");
  });

  it("`SEEN AND KEYWORD` — the KEYWORD fragment is FALSE so the AND matches nothing", async () => {
    // searchMailsByUid ANDs sibling fragments. SEEN → real column, KEYWORD → FALSE.
    expect(await build({ type: "SEEN" })).toBe("read = TRUE");
    expect(await build({ type: "KEYWORD", value: "Foo" })).toBe("FALSE");
    // Joined: "read = TRUE AND FALSE" → empty set (was "read = TRUE" alone before).
  });

  it("`OR SEEN KEYWORD` reduces to the constrained side (X OR none = X)", async () => {
    expect(
      await build({
        type: "OR",
        value: { left: { type: "SEEN" }, right: { type: "KEYWORD", value: "Foo" } },
      }),
    ).toBe("read = TRUE");
  });

  it("`OR KEYWORD KEYWORD` (both match-none) stays match-none", async () => {
    expect(
      await build({
        type: "OR",
        value: {
          left: { type: "KEYWORD", value: "A" },
          right: { type: "KEYWORD", value: "B" },
        },
      }),
    ).toBe("FALSE");
  });

  it("`OR SEEN ALL` still matches everything (match-all side wins — control)", async () => {
    expect(
      await build({
        type: "OR",
        value: { left: { type: "SEEN" }, right: { type: "ALL" } },
      }),
    ).toBeNull();
  });

  it("`NOT KEYWORD` = match-all (every message lacks the keyword)", async () => {
    expect(await build({ type: "NOT", value: { type: "KEYWORD", value: "Foo" } })).toBeNull();
  });

  it("`NOT ALL` = match-none (double-checks NOT of match-all)", async () => {
    expect(await build({ type: "NOT", value: { type: "ALL" } })).toBe("FALSE");
  });
});

describe("buildCriterionClause — combinators don't orphan bound params (#672)", () => {
  // Recursion pushes params onto the shared `values` as a side effect. When a
  // reduction discards a side that already pushed a param (e.g. an OR that
  // reduces to match-all because the OTHER side is ALL/UNKEYWORD), the discarded
  // param must be rolled back — otherwise values.length exceeds the max `$N`
  // referenced and Postgres rejects the Bind ("supplies N parameters, but
  // prepared statement requires M"), so searchMailsByUid throws and returns [].
  const build = async (
    criterion: { type: string; value?: unknown },
    values: unknown[],
  ) => {
    const { buildCriterionClause } = await import(".");
    return buildCriterionClause(criterion, "uid_mailbox", values as never);
  };

  it("`OR SUBJECT x ALL` → match-all, and rolls back SUBJECT's param", async () => {
    const values: unknown[] = ["user-1", false]; // base user_id/sent seed
    const frag = await build(
      { type: "OR", value: { left: { type: "SUBJECT", value: "x" }, right: { type: "ALL" } } },
      values,
    );
    expect(frag).toBeNull(); // X OR match-all = match-all
    expect(values).toEqual(["user-1", false]); // %x% rolled back — no orphan
  });

  it("`OR SUBJECT x UNKEYWORD Foo` → match-all, param rolled back (was a hard throw)", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "OR",
        value: { left: { type: "SUBJECT", value: "x" }, right: { type: "UNKEYWORD" } },
      },
      values,
    );
    expect(frag).toBeNull();
    expect(values).toEqual(["user-1", false]);
  });

  it("`OR ALL SUBJECT x` (null on the left) also rolls back", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      { type: "OR", value: { left: { type: "ALL" }, right: { type: "SUBJECT", value: "x" } } },
      values,
    );
    expect(frag).toBeNull();
    expect(values).toEqual(["user-1", false]);
  });

  it("`NOT (OR SUBJECT x ALL)` → match-none, nested param rolled back", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "NOT",
        value: {
          type: "OR",
          value: { left: { type: "SUBJECT", value: "x" }, right: { type: "ALL" } },
        },
      },
      values,
    );
    // inner OR = match-all (null) → NOT match-all = match-none.
    expect(frag).toBe("FALSE");
    expect(values).toEqual(["user-1", false]);
  });

  it("a real OR with two param-pushing sides keeps BOTH params, contiguously numbered", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "OR",
        value: { left: { type: "SUBJECT", value: "x" }, right: { type: "FROM", value: "y" } },
      },
      values,
    );
    expect(frag).toBe("(subject ILIKE $3 OR from_text ILIKE $4)");
    expect(values).toEqual(["user-1", false, "%x%", "%y%"]);
  });

  it("`X OR none` keeps X's param aligned (match-none side pushed nothing)", async () => {
    const values: unknown[] = ["user-1", false];
    const frag = await build(
      {
        type: "OR",
        value: { left: { type: "SUBJECT", value: "x" }, right: { type: "KEYWORD" } },
      },
      values,
    );
    expect(frag).toBe("subject ILIKE $3"); // KEYWORD = match-none → reduces to X
    expect(values).toEqual(["user-1", false, "%x%"]);
  });
});

describe("every mailbox applies its membership rule (#605, #725)", () => {
  describe("every mailbox-scoped site applies it (source regression)", () => {
    // One missed site desynchronises INBOX's membership: e.g. a filtered
    // `getAllUids` (the seq→UID map) against an unfiltered `countMessages`
    // makes EXISTS exceed the addressable sequence range.
    let source: string;
    let setFlagsSource: string;

    beforeAll(async () => {
      const fs = await import("fs/promises");
      const path = await import("path");
      source = await fs.readFile(path.join(import.meta.dir, "imap.ts"), "utf8");
      setFlagsSource = await fs.readFile(
        path.join(import.meta.dir, "set-flags-query.ts"),
        "utf8"
      );
    });

    const sourceOf = (file: string) => (file === "imap.ts" ? source : setFlagsSource);

    // [public name, symbol that actually builds the SQL, file] —
    // getMailsByRange is a single-flight wrapper whose query lives in the
    // uncoalesced impl, and setMailFlags builds none of its own SQL.
    const fns: [string, string, string][] = [
      ["countMessages", "countMessages", "imap.ts"],
      ["getMailsByRange", "getMailsByRangeUncoalesced", "imap.ts"],
      ["setMailFlags", "buildSetMailFlagsQueries", "set-flags-query.ts"],
      ["searchMailsByUid", "searchMailsByUid", "imap.ts"],
      ["getAllUids", "getAllUids", "imap.ts"],
      ["getFirstUnseenUid", "getFirstUnseenUid", "imap.ts"],
      ["expungeDeletedMails", "expungeDeletedMails", "imap.ts"],
      ["expungeMailsByUid", "expungeMailsByUid", "imap.ts"],
    ];

    // Applications per function — one per SQL-bearing branch. Counting helper
    // CALLS is not enough: several of these call the helper once into a local
    // and interpolate `${membership}` into two or more statements, so deleting
    // one interpolation leaves the call (and a call-count guard) untouched.
    // Count application SITES instead — a helper call that is not assigned to
    // a local, plus every interpolation of a local that is. Dropping the rule
    // from the `mailbox === null` branch of getAllUids (INBOX's own seq->UID
    // map) is one guarded mutation: quarantined UIDs reappear past the
    // filtered EXISTS and `FETCH <last seq>` addresses a message the client
    // was told does not exist. Dropping it from setMailFlags' domain UID
    // branch is the other: `UID STORE 1:* +FLAGS (\Deleted)` on INBOX followed
    // by EXPUNGE destroys quarantined spam the client was never shown.
    // Counts are of SQL application sites only: `applicationSites` strips
    // comments first, so an occurrence of the word "membership" in prose
    // cannot inflate them.
    const applications: Record<string, number> = {
      countMessages: 4, // total + unread FILTER, in each of the two branches
      getMailsByRangeUncoalesced: 4, // UID and sequence range, in each branch
      buildSetMailFlagsQueries: 4, // two domain WHERE clauses, plus the mapping branch's pair
      searchMailsByUid: 1, // one conditions list serves both branches
      getAllUids: 2, // one per branch
      getFirstUnseenUid: 2,
      expungeDeletedMails: 2, // domain filter bag + mapping SELECT
      expungeMailsByUid: 2,
    };

    const HELPERS =
      "(?:membershipCondition|membershipExpression|membershipFilter)";

    const applicationSites = (rawBody: string) => {
      // Comments mention the rule by name constantly; counting them would let a
      // real application be deleted as long as the prose survived.
      const body = rawBody
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      const locals = new Set(
        [...body.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*${HELPERS}\\(`, "g"))].map(
          (m) => m[1]
        )
      );
      // Assignments are the definition, not a use — drop them so only the
      // sites that put the rule into SQL are counted.
      const withoutAssignments = body.replace(
        new RegExp(`const\\s+\\w+\\s*=\\s*${HELPERS}\\([\\s\\S]*?;`, "g"),
        ""
      );
      const direct =
        withoutAssignments.match(new RegExp(`${HELPERS}\\(`, "g"))?.length ?? 0;
      // Count every use of a helper-derived local, not just `${…}` ones: the
      // expunge paths consume `quarantined` as a boolean that gates an
      // `is_spam` key in the data bag, which is an application of the rule
      // that never appears in a template.
      let uses = 0;
      for (const local of locals) {
        uses +=
          withoutAssignments.match(new RegExp(`\\b${local}\\b`, "g"))?.length ?? 0;
      }
      return direct + uses;
    };

    it.each(fns)("%s applies the membership rule in every branch", (_name, symbol, file) => {
      const body = sourceOf(file).match(new RegExp(`const ${symbol}\\s*=[\\s\\S]*?\\n};`));
      expect(body, `body not found for ${symbol}`).not.toBeNull();
      expect(applicationSites(body![0])).toBeGreaterThanOrEqual(
        applications[symbol]
      );
    });

    it("does not compute UIDNEXT — a MAX over live rows can only regress", () => {
      // UIDNEXT now comes from `getUidNext` (mail_uid_counters, the authority
      // that assigns UIDs). Re-deriving it here from any MAX over these rows
      // brings the bug straight back: the rows are the surviving ones, so an
      // EXPUNGE / hard delete / spam-mark of the highest-UID mail lowers it,
      // which RFC 3501 §2.3.1.1 forbids. The counts stay FILTERed.
      const body = source.match(/export const countMessages[\s\S]*?\n};/)![0];
      expect(body).toMatch(/COUNT\(\*\) FILTER \(WHERE \$\{membership\}\)/);
      // Comments stripped — the prose here explains the ban and would match it.
      const code = body.replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(/MAX\s*\(/);
      expect(code).not.toContain("max_uid");
    });

    it("stamps a mod-sequence when a spam flip moves a mail out of INBOX", async () => {
      // The flip is a membership change, so it has to advance HIGHESTMODSEQ or
      // a CONDSTORE client reads an unchanged value and never resyncs. The
      // repository's own tests mock this module, so pin the write at the source.
      const fs = await import("fs/promises");
      const path = await import("path");
      const core = await fs.readFile(path.join(import.meta.dir, "core.ts"), "utf8");
      const body = core.match(/export const markMailSpam[\s\S]*?\n};/)![0];
      expect(body).toMatch(/modseq\s*=\s*\$4/);
      expect(body).toContain("getNextModseq(user_id)");
      // The idempotence guard must survive — a re-mark of the same value has to
      // match no row so the reserved value goes unused.
      expect(body).toContain("is_spam IS DISTINCT FROM $1");
    });

    it("keeps the seq-number OFFSET list in step with getAllUids", () => {
      // Mapping rows outlive the expunge that hid their mail, so the OFFSET
      // subquery has to filter `sent` and `expunged` exactly as getAllUids
      // does — membership alone leaves every position after an expunged row
      // off by one. `membershipExpression` renders `TRUE` on a box that shows
      // spam, so a join gated on the membership rule drops those filters for
      // exactly the boxes that still need them.
      const body = setFlagsSource.match(
        /export const buildSetMailFlagsQueries[\s\S]*?\n};/
      )![0];
      const join = body.match(/const membershipJoin =[\s\S]*?`;/)![0];
      expect(join).toContain("z.${SENT} = $2");
      expect(join).toContain("z.${EXPUNGED} = FALSE");
      expect(join).toContain('membershipExpression(mailbox, sent, "z.")');
      // Both halves of "unconditional": nothing gates the assignment, and
      // nothing gates a filter from inside the template. The positive
      // assertions above pass either way — a ternary branch still contains
      // the text they look for. Optional chains are stripped first so the
      // conditional test is about conditionals only.
      expect(join).toMatch(/^const membershipJoin = `/);
      expect(join.replace(/\?\./g, "")).not.toContain("?");
    });

    it("addresses no expunged mail in any branch", () => {
      // A STORE that reaches an expunged mail bumps a modseq no client can
      // resolve, and on the sequence-number branches it shifts every position
      // after the expunged row — so the EXPUNGE behind a `\Deleted` store
      // destroys the wrong message.
      const body = setFlagsSource.match(
        /export const buildSetMailFlagsQueries[\s\S]*?\n};/
      )![0];
      // Each branch closes by binding its own parameter list, so the text
      // before each `baseValues =` is exactly one branch's SQL construction.
      const branches = body.split("baseValues = ").slice(0, 4);
      expect(branches).toHaveLength(4);
      // Matched on the interpolated form so the prose in the preamble comment
      // cannot satisfy it.
      for (const branch of branches) {
        expect(branch).toContain("${EXPUNGED} = FALSE");
      }
    });

    it("indexes the sequence-number branches 1-based and honours the range end", () => {
      // IMAP sequence numbers are 1-based while OFFSET is 0-based, and a
      // `STORE 2:5` has to reach four messages, not one.
      const body = setFlagsSource.match(
        /export const buildSetMailFlagsQueries[\s\S]*?\n};/
      )![0];
      const seqBindings = [...body.matchAll(/baseValues = \[([^\]]*)\];/g)]
        .map((m) => m[1])
        .filter((binding) => binding.includes("start - 1"));
      expect(seqBindings).toHaveLength(2);
      for (const binding of seqBindings) {
        expect(binding).toContain("end - start + 1");
      }
      expect(body).not.toMatch(/OFFSET \$\d+ LIMIT 1/);
    });
  });
});
