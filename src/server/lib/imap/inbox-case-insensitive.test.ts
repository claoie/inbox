
import { describe, it, expect } from "bun:test";
import { isInbox } from "./util";
import {
  selectMailbox,
  statusMailbox,
  createListPatternMatcher,
  createMailbox,
  deleteMailbox,
  renameMailbox,
} from "./mailbox-ops";
import { Store } from "./store";
import type { SignedUser } from "common";
import type { SequenceState } from "./sequence-resolver";

describe("isInbox util (#600)", () => {
  it("matches the canonical INBOX", () => {
    expect(isInbox("INBOX")).toBe(true);
  });

  it("matches lowercase", () => {
    expect(isInbox("inbox")).toBe(true);
  });

  it("matches mixed case", () => {
    expect(isInbox("Inbox")).toBe(true);
    expect(isInbox("iNbOx")).toBe(true);
  });

  it("rejects non-INBOX names regardless of case", () => {
    expect(isInbox("Archive")).toBe(false);
    expect(isInbox("Sent Messages")).toBe(false);
    expect(isInbox("INBOX/accounts/foo")).toBe(false);
    expect(isInbox("INBOXX")).toBe(false);
    expect(isInbox("")).toBe(false);
  });
});

describe("Store.mailboxExists is case-insensitive for INBOX (#600)", () => {
  const makeStore = (): Store => {
    const store = new Store({ id: "u1", username: "admin" } as SignedUser);
    // Throw on listMailboxes so the test confirms the INBOX path skips it.
    // Non-INBOX names would call listMailboxes — we don't exercise those here.
    store.listMailboxes = async () => {
      throw new Error("listMailboxes should not be called for INBOX");
    };
    return store;
  };

  it("accepts the canonical INBOX", async () => {
    expect(await makeStore().mailboxExists("INBOX")).toBe(true);
  });

  it("accepts lowercase inbox", async () => {
    expect(await makeStore().mailboxExists("inbox")).toBe(true);
  });

  it("accepts mixed-case Inbox", async () => {
    expect(await makeStore().mailboxExists("Inbox")).toBe(true);
  });
});

const fakeStore = (): Store =>
  ({
    listMailboxes: async () => ["INBOX", "Archive"],
    mailboxExists: async (box: string) => isInbox(box) || box === "Archive",
    countMessages: async () => ({ total: 0, unread: 0 }),
    getUidNext: async () => 1,
    getHighestModseq: async () => 1,
    getAllUids: async () => [],
    getFirstUnseenUid: async () => null,
    getUser: () => ({ id: "u1", username: "admin" } as SignedUser),
  }) as unknown as Store;

const emptySeqState = (): SequenceState => ({
  seqToUid: [],
  uidToSeq: new Map(),
});

const runSelect = async (name: string) => {
  const lines: string[] = [];
  // Record EVERY setSelected call, not just the last. The fake Store cannot
  // satisfy the whole happy path (see the describe comment), so SELECT ends in
  // its catch — which now clears the selection to null, as RFC 3501 §6.3.1
  // requires after a failed SELECT. The value under test is the one captured
  // on the way in, so read the first non-null.
  const selections: (string | null)[] = [];
  await selectMailbox(
    "A1",
    name,
    false,
    "SELECT",
    fakeStore(),
    (data: string) => {
      lines.push(data);
      return true;
    },
    emptySeqState(),
    (mailbox) => {
      selections.push(mailbox);
    },
    () => {}
  );
  const selectedMailbox = selections.find((m) => m !== null) ?? null;
  return { lines, selectedMailbox, selections };
};

const runStatus = async (mailbox: string) => {
  const lines: string[] = [];
  await statusMailbox(
    "A1",
    mailbox,
    ["MESSAGES"],
    fakeStore(),
    (data: string) => {
      lines.push(data);
      return true;
    }
  );
  return lines;
};

describe("SELECT canonicalizes INBOX casing (#600)", () => {
  // The fake Store can't satisfy the full SELECT happy-path flow
  // (`getImapUidValidity` calls into postgres directly, not via the store),
  // so the OK-response tail never lands here, and SELECT finishes in its
  // catch — which clears the selection back to null per RFC 3501 §6.3.1.
  // `runSelect` therefore reports the first non-null selection, the one made
  // on the way in. What matters for this fix is
  // the `setSelected(canonicalName, …)` call on line 388 of mailbox-ops.ts:
  // that runs immediately after the existence gate and BEFORE any downstream
  // DB hit, capturing whatever the canonicalization produced. So the
  // `selectedMailbox` value the callback sees IS the canonicalized name the
  // session will store — exactly what every downstream consumer (FETCH UID,
  // APPEND, IDLE, _processFetchMessages) reads. The "NO does not exist"
  // assertion confirms the existence gate passed, i.e. case-insensitive
  // resolution worked end-to-end.

  it("SELECT inbox resolves to INBOX and the session stores INBOX", async () => {
    const { lines, selectedMailbox } = await runSelect("inbox");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
    expect(selectedMailbox).toBe("INBOX");
  });

  it("SELECT Inbox (mixed case) also resolves to INBOX", async () => {
    const { lines, selectedMailbox } = await runSelect("Inbox");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
    expect(selectedMailbox).toBe("INBOX");
  });

  it("SELECT INBOX (canonical) still resolves to INBOX (regression)", async () => {
    const { lines, selectedMailbox } = await runSelect("INBOX");
    expect(lines.some((l) => l.includes("NO Mailbox does not exist"))).toBe(
      false
    );
    expect(selectedMailbox).toBe("INBOX");
  });

  it("SELECT Archive (non-INBOX) is unaffected — still case-sensitive", async () => {
    const { selectedMailbox } = await runSelect("Archive");
    // Non-INBOX names pass through unchanged; only INBOX is canonicalized.
    expect(selectedMailbox).toBe("Archive");

    const lower = await runSelect("archive");
    // "archive" ≠ "Archive" — not a special name, stays case-sensitive,
    // mailboxExists fakeStore returns false for it, setSelected never runs.
    expect(
      lower.lines.some((l) => l.includes("NO Mailbox does not exist"))
    ).toBe(true);
    expect(lower.selectedMailbox).toBeNull();
  });
});

describe("STATUS canonicalizes INBOX casing in response echo (#600)", () => {
  it("STATUS inbox echoes the response as INBOX, not inbox", async () => {
    const lines = await runStatus("inbox");
    expect(lines).toContain(
      '* STATUS "INBOX" (MESSAGES 0)\r\n'
    );
    expect(lines.some((l) => l.startsWith('* STATUS "inbox"'))).toBe(false);
    expect(lines).toContain("A1 OK STATUS completed\r\n");
  });

  it("STATUS Inbox (mixed) echoes the response as INBOX", async () => {
    const lines = await runStatus("Inbox");
    expect(lines).toContain(
      '* STATUS "INBOX" (MESSAGES 0)\r\n'
    );
  });

  it("STATUS INBOX (canonical) is unchanged (regression)", async () => {
    const lines = await runStatus("INBOX");
    expect(lines).toContain(
      '* STATUS "INBOX" (MESSAGES 0)\r\n'
    );
  });
});

describe("createListPatternMatcher is case-insensitive for INBOX target (#600 — review finding 2)", () => {
  // LIST returns the canonical "INBOX" name in its output, but the pattern
  // a client sends may be any casing of "inbox". RFC 3501 §5.1's
  // case-insensitivity applies to the pattern→INBOX match in LIST/LSUB too.
  // The flag-toggle is scoped to box==="INBOX" so every other mailbox
  // name keeps strict case-sensitive matching.

  it('matches lowercase pattern "inbox" against canonical "INBOX"', () => {
    expect(createListPatternMatcher("", "inbox")("INBOX")).toBe(true);
  });

  it('matches mixed-case pattern "Inbox" against canonical "INBOX"', () => {
    expect(createListPatternMatcher("", "Inbox")("INBOX")).toBe(true);
  });

  it('matches canonical "INBOX" pattern against "INBOX" (regression)', () => {
    expect(createListPatternMatcher("", "INBOX")("INBOX")).toBe(true);
  });

  it('does NOT match "inbox" pattern against a non-INBOX mailbox', () => {
    expect(createListPatternMatcher("", "inbox")("Archive")).toBe(false);
    expect(createListPatternMatcher("", "inbox")("Sent Messages")).toBe(false);
  });

  it('non-INBOX names stay case-sensitive — "archive" pattern does NOT match "Archive" mailbox', () => {
    // Wildcards in the pattern would change this — `*` and `%` always match
    // any case — but a literal pattern stays case-sensitive for every
    // mailbox name other than INBOX. (Archive lowercased would have to be
    // its own LIST entry to be matchable.)
    expect(createListPatternMatcher("", "archive")("Archive")).toBe(false);
  });

  it("wildcard patterns work as before — `*` matches everything", () => {
    expect(createListPatternMatcher("", "*")("INBOX")).toBe(true);
    expect(createListPatternMatcher("", "*")("Archive")).toBe(true);
    expect(createListPatternMatcher("", "*")("Sent Messages")).toBe(true);
  });
});

describe("CREATE / DELETE / RENAME reject INBOX (#600 — review finding 3)", () => {
  // INBOX always exists as a synthetic mailbox. CREATE / DELETE / RENAME
  // against any casing of "inbox" must short-circuit at the IMAP layer
  // rather than fall through to the DB (where a `createMailbox` call would
  // INSERT a phantom row that the LIST de-dup logic later hides). RFC
  // refs in the inline comments at the call sites.

  const makeStore = (): Store => {
    const store = new Store({ id: "u1", username: "admin" } as SignedUser);
    // Patch out getUser/listMailboxes so the no-op stubs are never called
    // (we expect the INBOX guard to fire BEFORE any DB work happens).
    return store;
  };

  it("CREATE inbox returns NO [ALREADYEXISTS] (every casing)", async () => {
    for (const name of ["INBOX", "inbox", "Inbox", "iNbOx"]) {
      const lines: string[] = [];
      await createMailbox(
        "A1",
        name,
        makeStore(),
        (data: string) => {
          lines.push(data);
          return true;
        }
      );
      expect(lines).toEqual([
        "A1 NO [ALREADYEXISTS] Mailbox already exists\r\n",
      ]);
    }
  });

  it("DELETE inbox returns NO [CANNOT] (every casing)", async () => {
    for (const name of ["INBOX", "inbox", "Inbox"]) {
      const lines: string[] = [];
      await deleteMailbox(
        "A1",
        name,
        makeStore(),
        (data: string) => {
          lines.push(data);
          return true;
        }
      );
      expect(lines).toEqual([
        "A1 NO [CANNOT] Cannot delete INBOX\r\n",
      ]);
    }
  });

  it("RENAME inbox to NewName returns NO [CANNOT]", async () => {
    const lines: string[] = [];
    await renameMailbox(
      "A1",
      "inbox",
      "NewName",
      makeStore(),
      (data: string) => {
        lines.push(data);
        return true;
      }
    );
    expect(lines).toEqual([
      "A1 NO [CANNOT] RENAME INBOX is not supported\r\n",
    ]);
  });

  it("RENAME Archive to inbox returns NO [ALREADYEXISTS]", async () => {
    const lines: string[] = [];
    await renameMailbox(
      "A1",
      "Archive",
      "Inbox",
      makeStore(),
      (data: string) => {
        lines.push(data);
        return true;
      }
    );
    expect(lines).toEqual([
      "A1 NO [ALREADYEXISTS] Target mailbox already exists\r\n",
    ]);
  });
});

// HIGH review finding 1 (APPEND `selectedMailbox === appendRequest.mailbox`
// comparison) is addressed at the source level in `message-ops.ts:appendMessage`:
// `appendRequest.mailbox` is canonicalized to "INBOX" (when isInbox) at the top
// of the function and the rest of the body uses the canonical name. An
// integration test that asserts the `onAppended` callback fires for an
// APPEND with a casing mismatch needs a FakePool fixture (getDomainUidNext /
// getAccountUidNext / getImapUidValidity are imported directly, not on the
// store), and isn't worth the wiring cost here when the source-level audit
// already shows no remaining `=== "INBOX"` literal in message-ops.ts.
