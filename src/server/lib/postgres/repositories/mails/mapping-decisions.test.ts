import { describe, it, expect } from "bun:test";
import { decideMappingWrites } from "./mapping-decisions";
import { recordMappings } from "./core";

const INBOX = "INBOX";
const ACCOUNT_BOX = "INBOX/accounts/admin";

describe("decideMappingWrites — which mapping rows a saveMail branch records", () => {
  it("records the mapped destination and the domain view as separate rows", () => {
    expect(
      decideMappingWrites({
        mailbox: ACCOUNT_BOX,
        uid_mailbox: 7,
        domain_mailbox: INBOX,
        uid_domain: 42,
        sent: false,
      })
    ).toEqual([
      { mailbox: ACCOUNT_BOX, uid: 7, scope: "mailbox" },
      { mailbox: INBOX, uid: 42, scope: "domain" },
    ]);
  });

  it("records the domain view alone for a write that named no mapped destination", () => {
    // `APPEND INBOX` — the destination is domain-scoped, so no `uid_mailbox`
    // is reserved and there is no mapped box to record.
    expect(
      decideMappingWrites({ domain_mailbox: INBOX, uid_domain: 42, sent: false })
    ).toEqual([{ mailbox: INBOX, uid: 42, scope: "domain" }]);
  });

  it("records the mapped destination alone for a write outside the INBOX tree", () => {
    expect(
      decideMappingWrites({ mailbox: "Archive", uid_mailbox: 3, uid_domain: 42, sent: false })
    ).toEqual([{ mailbox: "Archive", uid: 3, scope: "mailbox" }]);
  });

  it("skips a box whose UID was never reserved rather than recording it at 0", () => {
    expect(
      decideMappingWrites({
        mailbox: ACCOUNT_BOX,
        uid_mailbox: 0,
        domain_mailbox: INBOX,
        uid_domain: 0,
        sent: false,
      })
    ).toEqual([]);
  });

  it("never records a sent row under a domain view, whatever the caller asked for", () => {
    // The merge branch reaches here with the SURVIVING row's `sent`, which can
    // be the sent copy of a Message-ID an inbound delivery is now merging into.
    // Its `uid_domain` comes from the sent lane's counter, so recording it
    // under INBOX both misfiles the mail and drops a sent UID into the
    // received lane's number space.
    expect(
      decideMappingWrites({
        mailbox: "Sent Messages/accounts/admin",
        uid_mailbox: 9,
        domain_mailbox: INBOX,
        uid_domain: 42,
        sent: true,
      })
    ).toEqual([
      { mailbox: "Sent Messages/accounts/admin", uid: 9, scope: "mailbox" },
    ]);
  });
});

describe("the write paths that feed decideMappingWrites", () => {
  // Deleting any one of these three wirings removes every INBOX mapping row on
  // that path and changes nothing else — no read consults them yet, so the
  // whole feature reduces to a no-op with every behavioural test still green.
  // Read the sources: there is no seam to drive these from without a pool.
  const read = async (relative: string) => {
    const fs = await import("fs/promises");
    const path = await import("path");
    return fs.readFile(path.join(import.meta.dir, relative), "utf8");
  };

  it("SMTP delivery files received mail under INBOX", async () => {
    const receive = await read("../../../mails/receive.ts");
    expect(
      receive.includes("domain_mailbox: mail.sent ? undefined : INBOX_VIEW")
    ).toBe(true);
  });

  it("an IMAP write files its destination's domain view", async () => {
    const store = await read("../../../imap/store.ts");
    expect(store.includes("domainViewForDestination(destination)")).toBe(true);
    expect(store.includes("domain_mailbox: domainMailbox")).toBe(true);
  });

  it("saveMail forwards the caller's domain view on both branches", async () => {
    const core = await read("./core.ts");
    const forwards = (core.match(/domain_mailbox:\s*input\.domain_mailbox/g) ?? []).length;
    expect(forwards).toBe(2);
  });
});

describe("recordMappings — the consumer that turns the decisions into rows", () => {
  const DUPLICATE_UID = Object.assign(new Error("duplicate key value"), {
    code: "23505",
  });
  const inboxTreeWrites = () =>
    decideMappingWrites({
      mailbox: ACCOUNT_BOX,
      uid_mailbox: 7,
      domain_mailbox: INBOX,
      uid_domain: 42,
      sent: false,
    });

  it("writes every decided row at its own UID and reports the mapped one", async () => {
    // Distinct UIDs on purpose: a fixture that reused one number would stay
    // green on a consumer that filed both rows at the first row's UID.
    const calls: { mailbox: string; uid: number }[] = [];
    const persisted = await recordMappings(
      "user",
      "mail",
      inboxTreeWrites(),
      ACCOUNT_BOX,
      async (_user_id, mailbox, _mail_id, uid) => {
        calls.push({ mailbox, uid });
        return uid;
      }
    );
    expect(calls).toEqual([
      { mailbox: ACCOUNT_BOX, uid: 7 },
      { mailbox: INBOX, uid: 42 },
    ]);
    expect(persisted).toBe(7);
  });

  it("reports the UID the mapping holds, not the one the caller reserved", async () => {
    // COPY the same mail into the same box twice: the second write merges and
    // `writeMailboxUid` returns the existing row's UID. COPYUID has to
    // advertise that one — the fresh reservation addresses no row.
    expect(
      await recordMappings(
        "user",
        "mail",
        decideMappingWrites({ mailbox: ACCOUNT_BOX, uid_mailbox: 7, sent: false }),
        ACCOUNT_BOX,
        async () => 3
      )
    ).toBe(3);
  });

  it("drops a domain view row whose UID is already taken rather than the mail", async () => {
    // `mail_mailbox_uid` is UNIQUE on (user_id, mailbox, uid) and `mails` does
    // not constrain `uid_domain`, so received rows predating atomic reservation
    // can share one and the merge branch files them at that historical value.
    // Failing here fails the delivery — on SMTP, a NACK the sender retries into
    // the same collision.
    expect(
      await recordMappings(
        "user",
        "mail",
        inboxTreeWrites(),
        ACCOUNT_BOX,
        async (_user_id, mailbox) => {
          if (mailbox === INBOX) throw DUPLICATE_UID;
          return 7;
        }
      )
    ).toBe(7);
  });

  it("still aborts when the mapped destination's UID is taken", async () => {
    // The mapped row is the only UID source its box has: swallowing this one
    // acknowledges a write the client can never read back.
    await expect(
      recordMappings("user", "mail", inboxTreeWrites(), ACCOUNT_BOX, async (
        _user_id,
        mailbox
      ) => {
        if (mailbox === ACCOUNT_BOX) throw DUPLICATE_UID;
        return 42;
      })
    ).rejects.toThrow("duplicate key value");
  });

  it("still aborts on a domain view row for any other fault", async () => {
    // Only the uniqueness collision is expendable. A dropped connection means
    // the row is unknown, not already held.
    await expect(
      recordMappings("user", "mail", inboxTreeWrites(), ACCOUNT_BOX, async (
        _user_id,
        mailbox
      ) => {
        if (mailbox === INBOX) {
          throw Object.assign(new Error("connection terminated"), { code: "57P01" });
        }
        return 7;
      })
    ).rejects.toThrow("connection terminated");
  });
});
