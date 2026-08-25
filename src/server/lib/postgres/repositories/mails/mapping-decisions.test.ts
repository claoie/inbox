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
