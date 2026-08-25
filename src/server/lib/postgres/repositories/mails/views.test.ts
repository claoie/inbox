
import { describe, it, expect } from "bun:test";
import {
  DRAFTS_VIEW,
  JUNK_VIEW,
  isUtilityView,
  membershipCondition,
  membershipExpression,
  membershipFilter,
  usesDomainUidSpace,
  domainViewForDestination,
  isInboxTree,
  INBOX_VIEW,
} from "./views";

describe("utility views", () => {
  it("select their rows by flag", () => {
    expect(membershipExpression(DRAFTS_VIEW, false)).toBe("draft = TRUE");
    expect(membershipExpression(JUNK_VIEW, false)).toBe("is_spam = TRUE");
    expect(membershipCondition(DRAFTS_VIEW, false)).toBe(" AND draft = TRUE");
    expect(membershipCondition(JUNK_VIEW, false)).toBe(" AND is_spam = TRUE");
  });

  it("qualify the column with the caller's alias", () => {
    expect(membershipExpression(DRAFTS_VIEW, false, "m.")).toBe("m.draft = TRUE");
    expect(membershipCondition(JUNK_VIEW, false, "m.")).toBe(" AND m.is_spam = TRUE");
  });

  it("read the domain UID space — they hold no mapping rows to join", () => {
    // The whole point of naming them: a utility view reaches the repository as a
    // string (so its predicate can be looked up) but must still take the
    // `uid_domain` branch. Routing it to the JOIN would match zero mapping rows
    // and report a permanently empty mailbox.
    expect(usesDomainUidSpace(DRAFTS_VIEW)).toBe(true);
    expect(usesDomainUidSpace(JUNK_VIEW)).toBe(true);
    expect(usesDomainUidSpace(null)).toBe(true);
    expect(usesDomainUidSpace("INBOX/accounts/alice")).toBe(false);
    expect(usesDomainUidSpace("Archive")).toBe(false);
  });

  it("are matched exactly, not by prefix", () => {
    // A user-created `Drafts2` is an ordinary mapped box; treating it as a view
    // would hand it INBOX's UID space and hide every mail it actually holds.
    expect(isUtilityView("Drafts2")).toBe(false);
    expect(isUtilityView("INBOX/Drafts")).toBe(false);
    expect(isUtilityView(null)).toBe(false);
    expect(usesDomainUidSpace("Drafts2")).toBe(false);
  });

  it("do not inherit a prototype key as a view name", () => {
    // Mailbox names are user input and `"toString" in {}` is true, so the
    // lookup is a Map — a box called `constructor` must not resolve to a
    // predicate and silently take the domain branch.
    expect(isUtilityView("constructor")).toBe(false);
    expect(isUtilityView("toString")).toBe(false);
    expect(membershipExpression("constructor", false)).toBe("TRUE");
  });

  it("match case-insensitively, like the IMAP-side folder lookup", () => {
    // `Store.listMailboxesOrThrow` de-dups user boxes against these names
    // case-insensitively and `utilityFolder` matches the same way. If the
    // read side ever stops lowercasing, `APPEND drafts` still stamps
    // draft = TRUE while `SELECT drafts` routes to the mapping join instead
    // of the flag view — the message lands somewhere the client can't read.
    expect(isUtilityView("drafts")).toBe(true);
    expect(isUtilityView("JUNK")).toBe(true);
    expect(usesDomainUidSpace("drafts")).toBe(true);
    expect(membershipExpression("drafts", false)).toBe("draft = TRUE");
    expect(membershipExpression("JUNK", false)).toBe("is_spam = TRUE");
  });
});

describe("INBOX", () => {
  it("hides spam and drafts — each has a view of its own", () => {
    expect(membershipExpression(null, false)).toBe(
      "is_spam = FALSE AND draft = FALSE"
    );
    expect(membershipExpression("INBOX/accounts/alice", false, "m.")).toBe(
      "m.is_spam = FALSE AND m.draft = FALSE"
    );
  });

  it("stops at the accounts prefix boundary", () => {
    // The rule keys on `INBOX/accounts/` with the trailing slash. Dropping it
    // would pull the non-selectable parent and any similarly-named user box
    // into the INBOX tree, so they would start hiding spam with nothing else
    // in the suite noticing.
    expect(membershipExpression("INBOX/accounts", false)).toBe("TRUE");
    expect(membershipExpression("INBOX/accountsish", false)).toBe("TRUE");
  });

  it("does not exclude \\Deleted mail", () => {
    // `mails.deleted` is the IMAP \Deleted flag; RFC 3501 §6.4.3 keeps those
    // messages in the mailbox until EXPUNGE. Assert on what the rule emits
    // rather than on the absence of a string, which would pass just as well on
    // a rule that never had one.
    expect(Object.keys(membershipFilter(null, false))).toEqual([
      "is_spam",
      "draft",
    ]);
  });

  it("leaves sent mail and user-created boxes unfiltered", () => {
    expect(membershipExpression(null, true)).toBe("TRUE");
    expect(membershipExpression("Sent Messages/accounts/alice", true)).toBe("TRUE");
    expect(membershipExpression("Archive", false)).toBe("TRUE");
    expect(membershipCondition("Archive", false)).toBe("");
  });
});

describe("the IMAP-side folder table agrees with the predicate", () => {
  it("names the same domain-scoped boxes", async () => {
    const { UTILITY_FOLDERS } = await import("../../../imap/util");
    const domainScoped = UTILITY_FOLDERS.filter((f) => f.uidSpace === "domain")
      .map((f) => f.name)
      .sort();
    expect(domainScoped).toEqual([DRAFTS_VIEW, JUNK_VIEW].sort());
  });

  it("writes exactly the flags the domain-scoped view reads", async () => {
    // A COPY / MOVE / APPEND into a domain-scoped utility folder sets
    // `placement`; the view selects on `membershipFilter`. If they ever
    // disagree, the write reports success and the message is invisible in
    // the box the client named. Mapped-utility folders have their own
    // placement-write coupling (see the flag-STORE hook), not asserted here.
    const { UTILITY_FOLDERS } = await import("../../../imap/util");
    for (const { name, placement, uidSpace } of UTILITY_FOLDERS) {
      if (uidSpace !== "domain") continue;
      expect(placement, `no placement for ${name}`).toEqual(
        membershipFilter(name, false)
      );
    }
  });

  it("is listed as domain-scoped on the IMAP side too (for domain-scoped views only)", async () => {
    // `isDomainScoped` drives which UID the wire reports (COPYUID / APPENDUID /
    // FETCH); it has to agree with `usesDomainUidSpace`, which drives which UID
    // the query selects. Disagreement emits a UID that addresses nothing.
    // Mapped-utility folders return false from both — their agreement is
    // pinned separately (see the isDomainScoped + isMappedUtilityFolder tests
    // in `utility-mailboxes.test.ts`).
    const { isDomainScoped } = await import("../../../imap/util");
    for (const view of [DRAFTS_VIEW, JUNK_VIEW]) {
      expect(isDomainScoped(view)).toBe(usesDomainUidSpace(view));
    }
  });
});

describe("domainViewForDestination — which writes record INBOX membership", () => {
  it("records the unified view for every box in the INBOX tree", () => {
    expect(domainViewForDestination("INBOX", false)).toBe(INBOX_VIEW);
    expect(domainViewForDestination("INBOX/accounts/admin", false)).toBe(INBOX_VIEW);
  });

  it("matches INBOX case-insensitively and stores the canonical spelling", async () => {
    // RFC 3501 section 5.1 makes INBOX the one case-insensitive mailbox name, so
    // `COPY 1 inbox` has to record the same membership `COPY 1 INBOX` does — and
    // under the one spelling a read would join on.
    const { canonicalMailbox } = await import("../../../imap/util");
    expect(INBOX_VIEW).toBe(canonicalMailbox("inbox"));
    expect(domainViewForDestination("inbox", false)).toBe(INBOX_VIEW);
    // Only INBOX itself is case-insensitive — the sub-tree is an ordinary
    // hierarchical name, which the read side also matches case-sensitively.
    expect(domainViewForDestination("Inbox/accounts/admin", false)).toBeUndefined();
    expect(isInboxTree("Inbox/accounts/admin", false)).toBe(false);
  });

  it("records nothing for a destination outside the tree", () => {
    // The defect this membership exists to close: a COPY / MOVE into any of
    // these creates a received, non-spam row, which the INBOX predicate matches
    // on its own. Recording INBOX for them would carry that over.
    expect(domainViewForDestination("Archive", false)).toBeUndefined();
    expect(domainViewForDestination("Trash", false)).toBeUndefined();
    expect(domainViewForDestination("Starred", false)).toBeUndefined();
    expect(domainViewForDestination("Junk", false)).toBeUndefined();
    expect(domainViewForDestination("Drafts", false)).toBeUndefined();
    expect(domainViewForDestination("Sent Messages", false)).toBeUndefined();
    expect(domainViewForDestination("Sent Messages/accounts/admin", false)).toBeUndefined();
  });

  it("does not treat a user box whose name merely starts with INBOX as the tree", () => {
    // `CREATE INBOXER` and `CREATE "INBOX/keep"` are both legal user boxes. Only
    // the exact name and the accounts/ sub-tree are INBOX.
    expect(domainViewForDestination("INBOXER", false)).toBeUndefined();
    expect(domainViewForDestination("INBOX/keep", false)).toBeUndefined();
  });

  it("never records INBOX for sent mail, whichever box names it", () => {
    expect(domainViewForDestination("INBOX", true)).toBeUndefined();
    expect(domainViewForDestination("INBOX/accounts/admin", true)).toBeUndefined();
  });

  it("agrees with the read-side twin on every box both can name", () => {
    // `isInboxTree` decides which rows INBOX shows; this decides which rows
    // record that membership. A box the first counts and the second skips is a
    // mail INBOX shows with no mapping row to prove it.
    const cases: Array<[string, string | null]> = [
      ["INBOX", null],
      ["INBOX/accounts/admin", "INBOX/accounts/admin"],
      ["Archive", "Archive"],
      ["Sent Messages/accounts/admin", "Sent Messages/accounts/admin"],
    ];
    for (const [destination, readSide] of cases) {
      for (const sent of [false, true]) {
        expect(
          domainViewForDestination(destination, sent) !== undefined,
          `${destination} (sent=${sent})`
        ).toBe(isInboxTree(readSide, sent));
      }
    }
  });
});
