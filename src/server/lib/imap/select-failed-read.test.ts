import { describe, it, expect } from "bun:test";
import { Store } from "./store";
import { selectMailbox } from "./mailbox-ops";
import type { SignedUser } from "common";
import type { SequenceState } from "./sequence-resolver";

const fakeStore = (getAllUids: () => Promise<number[] | null>): Store =>
  ({
    mailboxExists: async () => true,
    countMessages: async () => ({ total: 3, unread: 0 }),
    getAllUids,
    getFirstUnseenUid: async () => null,
    getUidNext: async () => 31,
    getHighestModseq: async () => 0,
    getUser: () => ({ id: "u1", username: "admin" }) as SignedUser,
  }) as unknown as Store;

const seqStateFor = (uids: number[]): SequenceState => ({
  seqToUid: [...uids],
  uidToSeq: new Map(uids.map((uid, index) => [uid, index + 1])),
});

// The fake Store can't reach the OK-response tail (`getImapUidValidity` hits
// postgres directly rather than going through the store), so these assert on
// everything SELECT does before that point. That unreachable read is itself a
// failure, and RFC 3501 §6.3.1 deselects on any of them, so the successful
// case checks that the mailbox was selected at all rather than that it stayed
// selected.
const runSelect = async (
  getAllUids: () => Promise<number[] | null>,
  seqState: SequenceState
) => {
  const lines: string[] = [];
  const selected: Array<{ mailbox: string | null; count: number }> = [];
  let cleared = 0;
  await selectMailbox(
    "A1",
    "INBOX",
    false,
    "SELECT",
    fakeStore(getAllUids),
    (data: string) => {
      lines.push(data);
      return true;
    },
    seqState,
    (mailbox, count) => selected.push({ mailbox, count }),
    () => {
      cleared++;
    }
  );
  return { lines, selected, cleared };
};

describe("SELECT on a mailbox whose UID read fails", () => {
  it("answers NO and deselects rather than keeping a stale mapping", async () => {
    const seqState = seqStateFor([10, 20, 30]);
    const { lines, selected, cleared } = await runSelect(
      async () => null,
      seqState
    );

    expect(lines).toEqual(["A1 NO Failed to read mailbox\r\n"]);
    expect(selected.at(-1)).toEqual({ mailbox: null, count: 0 });
    expect(cleared).toBe(1);
  });

  it("builds the mapping and selects the mailbox when the read succeeds", async () => {
    const seqState = seqStateFor([]);
    const { lines, selected } = await runSelect(async () => [10, 20, 30], seqState);

    expect(lines.some((line) => line.includes("NO Failed to read mailbox"))).toBe(false);
    expect(selected).toContainEqual({ mailbox: "INBOX", count: 3 });
    expect(seqState.seqToUid).toEqual([10, 20, 30]);
    expect(seqState.uidToSeq.get(30)).toBe(3);
  });
});
