/**
 * Tests for the read-only IMAP session guard. Verifies that after
 * authenticating as `ADMIN_RO_USERNAME`, ImapSession refuses every
 * state-mutating IMAP command with `NO [READ-ONLY]` while letting
 * non-mutating ones through. Admin sessions are unaffected.
 *
 * Isolation follows the same pg-FakePool pattern as condstore.test.ts —
 * mock `pg` at process scope so the lazy pool in postgres/client.ts points
 * at a fake, then exercise the real ImapSession.
 */

import { describe, it, expect, mock, beforeAll, beforeEach, afterAll } from "bun:test";
import { restoreLeaves } from "test-helpers";

const STORED_UIDVALIDITY = 1716512400;

const makeUserRow = (username: string) => ({
  user_id: `user-${username}`,
  username,
  password: null,
  email: `${username}@localhost`,
  expiry: null,
  token: null,
  updated: null,
  is_deleted: null,
  imap_uid_validity: STORED_UIDVALIDITY,
});

const mockQuery = mock(async (sql: string) => {
  if (typeof sql === "string" && sql.includes("next_uid")) {
    return { rows: [{ next_uid: "10" }], rowCount: 1 };
  }
  return { rows: [makeUserRow("admin")], rowCount: 1 };
});

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

const { ImapSession } = await import("./session");
const { ADMIN_RO_USERNAME } = await import("../read-only");
const { resetPool } = await import("../postgres/client");

beforeAll(() => {
  mock.module("pg", pgMock);
  resetPool();
});

afterAll(() => {
  restoreLeaves();
  resetPool();
});

// Minimal socket / handler stand-ins. Only .write / .end / .on matter for
// the code paths under test — everything else is enough to keep the class
// constructor happy without a real net.Socket.
const mkSocket = () => {
  const writes: string[] = [];
  const socket = {
    remoteAddress: "127.0.0.1",
    remotePort: 12345,
    writable: true,
    destroyed: false,
    setTimeout: () => {},
    setKeepAlive: () => {},
    on: () => {},
    removeAllListeners: () => {},
    write: (data: string | Buffer) => {
      writes.push(typeof data === "string" ? data : data.toString());
      return true;
    },
    end: () => {},
    destroy: () => {},
  };
  return { socket, writes };
};

const mkHandler = () => ({ setPendingSaslTag: () => {} });

/**
 * Instantiate a session and prime it as authenticated. Reaches into
 * private fields directly rather than driving bcrypt/LOGIN end-to-end,
 * because the guard only depends on `authenticated`, `store`, and the
 * `isReadOnlyUser` / `authenticatedAs` fields.
 */
async function authAs(isReadOnly: boolean, authenticatedAs = "admin") {
  const { socket, writes } = mkSocket();
  const handler = mkHandler();
  const session = new ImapSession(handler as never, socket as never);
  const s = session as unknown as {
    authenticated: boolean;
    isReadOnlyUser: boolean;
    authenticatedAs: string | null;
    store: Record<string, unknown>;
  };
  s.authenticated = true;
  // Enough of a Store to carry a SELECT end to end; the mutating-command
  // cases below only reach `getUser`.
  s.store = {
    getUser: () => ({
      id: "admin-id",
      username: "admin",
      email: "admin@localhost",
    }),
    mailboxExists: async () => true,
    countMessages: async () => ({ total: 2, unread: 0 }),
    getUidNext: async () => 10,
    getAllUids: async () => [8, 9],
    getFirstUnseenUid: async () => null,
    getHighestModseq: async () => 5,
  };
  s.isReadOnlyUser = isReadOnly;
  s.authenticatedAs = authenticatedAs;
  return { session, writes };
}

beforeEach(() => {
  mockQuery.mockClear();
});

describe("read-only IMAP user — constant", () => {
  it("names the reserved read-only username", () => {
    expect(ADMIN_RO_USERNAME).toBe("admin-ro");
  });
});

describe("read-only IMAP user — guard refuses mutating commands", () => {
  const mutatingCases: Array<{
    name: string;
    verb: string;
    run: (session: InstanceType<typeof ImapSession>) => Promise<unknown>;
  }> = [
    {
      name: "STORE",
      verb: "STORE",
      run: (session) =>
        session.storeFlagsTyped("A1", {
          sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
          operation: "REPLACE",
          silent: false,
          flags: ["\\Seen"],
        } as never),
    },
    {
      name: "UID STORE",
      verb: "UID STORE",
      run: (session) =>
        session.storeFlagsTyped(
          "A1",
          {
            sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
            operation: "REPLACE",
            silent: false,
            flags: ["\\Seen"],
          } as never,
          true
        ),
    },
    {
      name: "COPY",
      verb: "COPY",
      run: (session) =>
        session.copyMessageTyped("A1", {
          sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
          mailbox: "Archive",
        } as never),
    },
    {
      name: "UID COPY",
      verb: "UID COPY",
      run: (session) =>
        session.copyMessageTyped(
          "A1",
          {
            sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
            mailbox: "Archive",
          } as never,
          true
        ),
    },
    {
      name: "MOVE",
      verb: "MOVE",
      run: (session) =>
        session.moveMessageTyped("A1", {
          sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
          mailbox: "Archive",
        } as never),
    },
    {
      name: "UID MOVE",
      verb: "UID MOVE",
      run: (session) =>
        session.moveMessageTyped(
          "A1",
          {
            sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
            mailbox: "Archive",
          } as never,
          true
        ),
    },
    {
      name: "APPEND",
      verb: "APPEND",
      run: (session) =>
        session.appendMessage("A1", {
          mailbox: "INBOX",
          message: Buffer.from("From: a@b\r\n\r\nhi"),
        } as never),
    },
    {
      name: "EXPUNGE",
      verb: "EXPUNGE",
      run: (session) => session.expunge("A1"),
    },
    {
      name: "CREATE",
      verb: "CREATE",
      run: (session) => session.createMailbox("A1", "NewBox"),
    },
    {
      name: "DELETE",
      verb: "DELETE",
      run: (session) => session.deleteMailbox("A1", "OldBox"),
    },
    {
      name: "RENAME",
      verb: "RENAME",
      run: (session) => session.renameMailbox("A1", "A", "B"),
    },
    {
      name: "SUBSCRIBE",
      verb: "SUBSCRIBE",
      run: (session) => session.subscribeMailbox("A1", "INBOX"),
    },
    {
      name: "UNSUBSCRIBE",
      verb: "UNSUBSCRIBE",
      run: (session) => session.unsubscribeMailbox("A1", "INBOX"),
    },
  ];

  for (const { name, verb, run } of mutatingCases) {
    it(`refuses ${name} with NO [READ-ONLY] naming the original credential`, async () => {
      const { session, writes } = await authAs(true, ADMIN_RO_USERNAME);
      // STORE / EXPUNGE / COPY / MOVE need a selected mailbox to reach
      // the guard; the guard runs AFTER the selection check so setting
      // the field skips the "no mailbox" BAD path.
      (session as unknown as { selectedMailbox: string | null }).selectedMailbox = "INBOX";
      await run(session);
      const joined = writes.join("");
      // The refusal names the verb, the read-only marker, AND the
      // ORIGINAL credential — not admin's effective username. A wrong
      // attribution would let a compromised read-only credential read as
      // admin in audit logs.
      expect(joined).toContain(`A1 NO [READ-ONLY]`);
      expect(joined).toContain(verb);
      expect(joined).toContain(ADMIN_RO_USERNAME);
    });
  }
});

describe("read-only IMAP user — SELECT announces the enforced mode", () => {
  it("answers a read-only user's SELECT with [READ-ONLY] SELECT completed", async () => {
    // RFC 3501 6.3.1: the announcement has to match what the mutating ops
    // enforce. Announcing READ-WRITE here makes clients queue flag writes
    // that then come back NO [READ-ONLY] in a retry loop.
    const { session, writes } = await authAs(true, ADMIN_RO_USERNAME);
    await session.selectMailbox("A1", "INBOX");
    expect(writes.join("")).toContain("A1 OK [READ-ONLY] SELECT completed\r\n");
    // The same flag the STORE / EXPUNGE / COPY refusals read.
    expect(
      (session as unknown as { mailboxReadOnly: boolean }).mailboxReadOnly
    ).toBe(true);
  });

  it("still answers an ordinary user's SELECT with [READ-WRITE]", async () => {
    // Mutation-test the discriminator: an unconditional READ-ONLY
    // announcement would pass the case above and break every real session.
    const { session, writes } = await authAs(false, "admin");
    await session.selectMailbox("A1", "INBOX");
    expect(writes.join("")).toContain("A1 OK [READ-WRITE] SELECT completed\r\n");
  });

  it("keeps EXAMINE naming EXAMINE for a read-only user", async () => {
    // The response code and the echoed command answer different questions;
    // folding them back together would rename this SELECT.
    const { session, writes } = await authAs(true, ADMIN_RO_USERNAME);
    await session.examineMailbox("A1", "INBOX");
    expect(writes.join("")).toContain("A1 OK [READ-ONLY] EXAMINE completed\r\n");
  });
});

describe("read-only IMAP user — admin session unaffected", () => {
  it("does not emit [READ-ONLY] on STORE for a non-read-only session", async () => {
    // Mutation-test the guard's discriminator. The refusal token must
    // appear ONLY when the isReadOnlyUser flag is set — a wrong-sense
    // conditional would trip either every session or none.
    const { session, writes } = await authAs(false, "admin");
    (session as unknown as { selectedMailbox: string | null }).selectedMailbox = "INBOX";
    try {
      await session.storeFlagsTyped("A1", {
        sequenceSet: { type: "sequence", ranges: [{ start: 1 }] },
        operation: "REPLACE",
        silent: false,
        flags: ["\\Seen"],
      } as never);
    } catch {
      // Ignored — the fake pool can't fulfill the op end-to-end; the
      // load-bearing assertion is that no [READ-ONLY] refusal reaches
      // the wire before the op runs.
    }
    expect(writes.join("")).not.toContain("[READ-ONLY]");
  });
});
