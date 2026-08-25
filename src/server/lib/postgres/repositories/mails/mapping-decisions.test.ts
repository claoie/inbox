import { describe, it, expect } from "bun:test";
import { decideMappingWrites } from "./mapping-decisions";

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
      { mailbox: ACCOUNT_BOX, uid: 7 },
      { mailbox: INBOX, uid: 42 },
    ]);
  });

  it("records the domain view alone for a write that named no mapped destination", () => {
    // `APPEND INBOX` — the destination is domain-scoped, so no `uid_mailbox`
    // is reserved and there is no mapped box to record.
    expect(
      decideMappingWrites({ domain_mailbox: INBOX, uid_domain: 42, sent: false })
    ).toEqual([{ mailbox: INBOX, uid: 42 }]);
  });

  it("records the mapped destination alone for a write outside the INBOX tree", () => {
    expect(
      decideMappingWrites({ mailbox: "Archive", uid_mailbox: 3, uid_domain: 42, sent: false })
    ).toEqual([{ mailbox: "Archive", uid: 3 }]);
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
    ).toEqual([{ mailbox: "Sent Messages/accounts/admin", uid: 9 }]);
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
    expect(receive).toMatch(/domain_mailbox:\s*mail\.sent\s*\?\s*undefined\s*:\s*INBOX_VIEW/);
  });

  it("an IMAP write files its destination's domain view", async () => {
    const store = await read("../../../imap/store.ts");
    expect(store).toMatch(/domainViewForDestination\(destination\)/);
    expect(store).toMatch(/domain_mailbox:\s*domainMailbox/);
  });

  it("saveMail forwards the caller's domain view on both branches", async () => {
    const core = await read("./core.ts");
    const forwards = (core.match(/domain_mailbox:\s*input\.domain_mailbox/g) ?? []).length;
    expect(forwards).toBe(2);
  });
});
