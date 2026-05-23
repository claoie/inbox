/**
 * Tests for mail repository functions
 */
import { describe, it, expect, beforeAll, beforeEach } from "bun:test";

describe("STORE operation types", () => {
  /**
   * Helper to simulate buildFlagSetClause behavior for testing.
   * This mirrors the logic in mails.ts
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

describe("expungeDeletedMails — `updated` column refresh (regression for #456)", () => {
  // Static source check: the expunge write paths must go through
  // mailsTable.updateWhere with `updated: new Date()` in the data bag so the
  // framework's own auto-`updated` is not bypassed. Source-text scanning is
  // robust against module-mock interactions in the full suite — the
  // alternative (mock pool.query) fails when other tests load mails.ts first.
  let mailsSource: string;
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const expungeDeletedMails[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("expungeDeletedMails not found in mails.ts");
    fnSource = fnMatch[0];
  });

  it("does not contain any raw `SET expunged` UPDATE statement", () => {
    // Regression for #456: every write to `expunged` must go through the
    // framework so `updated` is bumped via the data bag. Raw SQL UPDATEs are
    // forbidden in this function.
    expect(fnSource).not.toMatch(/SET\s+expunged/);
  });

  it("domain-wide branch uses mailsTable.updateWhere with `updated`", () => {
    // The `account === null` branch must use updateWhere with equality filters.
    expect(fnSource).toContain("mailsTable.updateWhere(");
    expect(fnSource).toMatch(/\[EXPUNGED\]:\s*true/);
    expect(fnSource).toMatch(/updated:\s*new Date\(\)/);
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
});

describe("getAccountStats — envelope_to inclusion in received address expansion", () => {
  // Mails sent via listserv-style routing (e.g. GitHub notifications) carry
  // a MIME `to` header that points at the list address (e.g.
  // `<budget@noreply.github.com>`) and an SMTP-level `envelope_to` that
  // points at the actual recipient sub-address (e.g. `<x@hoie.kim>`). If
  // the received-side address expansion ignores envelope_to, those mails
  // never surface in the per-account view — but the push badge counts
  // them via the broader `getUnreadNotifications` query, so the FE shows
  // 0 unread while the iOS badge shows N. Verified against prod on
  // 2026-05-23: admin had badge=26 / FE=0 because 26 GitHub notification
  // mails carried envelope_to=claoie@hoie.kim but MIME to=noreply.github.
  let mailsSource: string;
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const getAccountStats[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getAccountStats not found in mails.ts");
    fnSource = fnMatch[0];
  });

  it("received-branch address expansion unions envelope_to with to/cc/bcc", () => {
    // Locate the addressExpansion ternary's received branch — everything
    // between `addressExpansion = sent ? <sent SQL>` and the final `;`,
    // dropping the sent SQL portion via the backtick boundary.
    const exprMatch = fnSource.match(
      /const\s+addressExpansion\s*=\s*sent\s*\?\s*`[^`]*`\s*:\s*`([^`]*)`\s*;/
    );
    if (!exprMatch) throw new Error("addressExpansion ternary not found");
    const receivedSql = exprMatch[1];
    expect(receivedSql).toContain("to_address");
    expect(receivedSql).toContain("cc_address");
    expect(receivedSql).toContain("bcc_address");
    expect(receivedSql).toContain("envelope_to");
  });

  it("received-branch null-check includes envelope_to", () => {
    // Otherwise rows with only envelope_to populated (no MIME recipient
    // headers, which happens for some listserv-style senders) would be
    // filtered out before the address expansion even fires.
    const exprMatch = fnSource.match(
      /const\s+addressNotNull\s*=\s*sent\s*\?\s*`[^`]*`\s*:\s*`([^`]*)`\s*;/
    );
    if (!exprMatch) throw new Error("addressNotNull ternary not found");
    const receivedSql = exprMatch[1];
    expect(receivedSql).toContain("to_address IS NOT NULL");
    expect(receivedSql).toContain("envelope_to IS NOT NULL");
  });

  it("sent-branch address expansion remains from_address only", () => {
    // Don't accidentally widen the sent view — envelope_from has its own
    // semantics (bounce path) and isn't symmetric with envelope_to here.
    const exprMatch = fnSource.match(
      /const\s+addressExpansion\s*=\s*sent\s*\?\s*`([^`]*)`/
    );
    if (!exprMatch) throw new Error("sent branch not found");
    const sentSql = exprMatch[1];
    expect(sentSql).toContain("from_address");
    expect(sentSql).not.toContain("envelope_to");
    expect(sentSql).not.toContain("envelope_from");
  });
});

describe("getMailHeaders — envelope_to in received-branch address condition", () => {
  // Companion to the getAccountStats change above. When getAccountStats
  // surfaces a per-account row keyed on envelope_to, clicking it calls
  // getMailHeaders with that address — which needs to find the mails by
  // envelope_to too, not just MIME to/cc/bcc, or the list renders empty.
  let mailsSource: string;
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    mailsSource = await fs.readFile(
      path.join(import.meta.dir, "mails.ts"),
      "utf8"
    );
    const fnMatch = mailsSource.match(
      /export const getMailHeaders[\s\S]*?\n};/
    );
    if (!fnMatch) throw new Error("getMailHeaders not found in mails.ts");
    fnSource = fnMatch[0];
  });

  it("received branch's addressCondition unions envelope_to with to/cc/bcc", () => {
    // Source uses `${TO_ADDRESS}` template-literal substitution that expands
    // to "to_address" at runtime; the static text contains the token.
    const exprMatch = fnSource.match(
      /addressCondition\s*=\s*options\.sent\s*\?\s*`[^`]*`\s*:\s*`([^`]*)`\s*;/
    );
    if (!exprMatch) throw new Error("addressCondition ternary not found");
    const receivedSql = exprMatch[1];
    expect(receivedSql).toContain("${TO_ADDRESS}");
    expect(receivedSql).toContain("cc_address @>");
    expect(receivedSql).toContain("bcc_address @>");
    expect(receivedSql).toContain("envelope_to @>");
  });

  it("sent branch's addressCondition remains from_address only", () => {
    const exprMatch = fnSource.match(
      /addressCondition\s*=\s*options\.sent\s*\?\s*`([^`]*)`/
    );
    if (!exprMatch) throw new Error("sent branch not found");
    const sentSql = exprMatch[1];
    expect(sentSql).toContain("${FROM_ADDRESS}");
    expect(sentSql).not.toContain("envelope_to");
    expect(sentSql).not.toContain("envelope_from");
  });
});
