import { describe, it, expect, mock, beforeAll, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";
import type { SignedUser } from "common";
import type { Store } from "./store";
import type { SequenceState } from "./sequence-resolver";

/**
 * SELECT and STATUS must emit the UIDNEXT `Store.getUidNext` returns, and
 * nothing derived from the message count or the sequence map.
 *
 * The counter answer and a count-derived answer coincide on the fixtures used
 * elsewhere in the suite — an empty mailbox reports 1 either way — so those
 * assertions hold against either source. Here the store answers a UIDNEXT that
 * `total + 1` cannot produce, which is the only shape that fails when someone
 * re-derives UIDNEXT from what the mailbox currently holds. A count drops
 * whenever the highest-UID message leaves, and RFC 3501 §2.3.1.1 forbids
 * UIDNEXT decreasing.
 */
const COUNTER_UIDNEXT = 501;
const TOTAL = 4;
const STORED_UIDVALIDITY = 1716512400;

const USER_ROW = {
  user_id: "user-123",
  username: "admin",
  password: null,
  email: null,
  expiry: null,
  token: null,
  updated: null,
  is_deleted: null,
  imap_uid_validity: STORED_UIDVALIDITY,
};

const mockQuery = mock(async () => ({ rows: [USER_ROW], rowCount: 1 }));

class FakePool {
  query = mockQuery;
  end = async () => {};
  connect = async () => ({ query: mockQuery, release: () => {} });
  on() {}
}

const pgMock = () => ({
  Pool: FakePool,
  types: { setTypeParser: () => {}, builtins: {}, getTypeParser: () => null },
  default: { Pool: FakePool, types: { setTypeParser: () => {} } },
});

mock.module("pg", pgMock);

const { selectMailbox, statusMailbox } = await import("./mailbox-ops");
const { resetPool } = await import("../postgres/client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

const fakeStore = (): Store =>
  ({
    getUser: () => ({ id: "user-123", username: "admin" }) as SignedUser,
    listMailboxes: async () => ["INBOX", "Archive"],
    mailboxExists: async () => true,
    countMessages: async () => ({ total: TOTAL, unread: 0 }),
    getUidNext: async () => COUNTER_UIDNEXT,
    getFirstUnseenUid: async () => null,
    getHighestModseq: async () => 10,
    getAllUids: async () => [],
  }) as unknown as Store;

const emptySeqState = (): SequenceState => ({ seqToUid: [], uidToSeq: new Map() });

const runSelect = async (tag: string) => {
  const lines: string[] = [];
  await selectMailbox(
    tag,
    "Archive",
    false,
    "SELECT",
    fakeStore(),
    (data: string) => {
      lines.push(data);
      return true;
    },
    emptySeqState(),
    () => {},
    () => {}
  );
  return lines;
};

const runStatus = async (tag: string, items: string[]) => {
  const lines: string[] = [];
  await statusMailbox(tag, "Archive", items, fakeStore(), (data: string) => {
    lines.push(data);
    return true;
  });
  return lines;
};

describe("UIDNEXT on the wire comes from the counter, not the message count", () => {
  it("SELECT emits the store's UIDNEXT", async () => {
    const lines = await runSelect("A1");
    expect(lines).toContain(`* OK [UIDNEXT ${COUNTER_UIDNEXT}] Predicted next UID\r\n`);
    expect(lines).toContain(`* ${TOTAL} EXISTS\r\n`);
    // Compared as a whole number, not a substring: "UIDNEXT 501" contains
    // "UIDNEXT 5", so an includes() check here would pass on a count-derived
    // value whenever the counter value happens to share its leading digits.
    const emitted = lines.join("").match(/UIDNEXT (\d+)/)?.[1];
    expect(emitted).toBe(String(COUNTER_UIDNEXT));
    expect(emitted).not.toBe(String(TOTAL + 1));
  });

  it("STATUS emits the store's UIDNEXT alongside the count", async () => {
    const lines = await runStatus("A2", ["MESSAGES", "UIDNEXT"]);
    expect(lines).toContain(
      `* STATUS "Archive" (MESSAGES ${TOTAL} UIDNEXT ${COUNTER_UIDNEXT})\r\n`
    );
  });

  it("SELECT and STATUS agree, so a client polling either sees one sequence", async () => {
    const fromSelect = (await runSelect("A3")).join("").match(/UIDNEXT (\d+)/)?.[1];
    const fromStatus = (await runStatus("A4", ["UIDNEXT"])).join("").match(/UIDNEXT (\d+)/)?.[1];
    expect(fromSelect).toBe(String(COUNTER_UIDNEXT));
    expect(fromStatus).toBe(fromSelect);
  });
});
