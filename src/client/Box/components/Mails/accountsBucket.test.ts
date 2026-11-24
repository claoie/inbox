import { describe, it, expect } from "bun:test";
import { Account, MailHeaderData } from "common";
import { Category } from "client";
import {
  accountCountForCategory,
  accountForMail,
  allAccountsCount,
  bucketsForMail,
  evictAccountFromCategory,
  removeAccountFromBucket,
  updateAccountInBucket,
  updateAccountInBuckets,
  wholeBucketForCategory,
  withoutUnreadMail
} from "./accountsBucket";

const makeAccount = (key: string, doc = 5, unread = 2, saved = 1) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count: doc,
    unread_doc_count: unread,
    saved_doc_count: saved
  });

// me and other hold 2 unread each, and one unread mail names both of them:
// 4 address rows, 3 unread mails.
const data = () => ({
  received: [makeAccount("me@x.com"), makeAccount("other@x.com")],
  sent: [makeAccount("me@x.com")],
  spam: [makeAccount("spammy@x.com")],
  shared: [],
  unread_mail_count: 3
});

const addresses = (...values: string[]) => ({
  value: values.map((address) => ({ address })),
  text: values.join(", ")
});

const mail = (parts: Partial<MailHeaderData>) => new MailHeaderData(parts);

describe("bucketsForMail", () => {
  const sentByMe = mail({
    from: addresses("me@x.com"),
    to: addresses("them@y.com")
  });
  const sentToMe = mail({
    from: addresses("them@y.com"),
    to: addresses("me@x.com")
  });

  it("follows the addresses under every category that counts them", () => {
    expect(bucketsForMail(Category.SentMails, sentByMe, "me@x.com")).toEqual([
      "sent"
    ]);
    expect(bucketsForMail(Category.SentMails, sentToMe, "me@x.com")).toEqual([
      "received"
    ]);
  });

  // The spam folder is `is_spam = TRUE`, and both counted lists are its
  // complement, so a mail acted on there reaches neither of them.
  it("names the spam list alone under Spam Mails", () => {
    expect(bucketsForMail(Category.SpamMails, sentToMe, "me@x.com")).toEqual([
      "spam"
    ]);
    expect(
      bucketsForMail(Category.SpamMails, sentByMe, "me@x.com")
    ).toEqual(["spam"]);
  });

  // `selectedAccount` holds the live search term there, and the search query
  // applies no address, sent or spam condition — so no account's counters
  // follow from a row being listed.
  it("names no list under Search", () => {
    expect(bucketsForMail(Category.Search, sentToMe, "me@x.com")).toEqual([]);
  });

  // Saved Mails lists `(from_address matches OR a recipient matches)`, and the
  // server groups `sent` by the sender and `received` by the recipients, so an
  // address that only ever sent is counted in `sent` alone.
  it("follows the addresses under Saved Mails", () => {
    expect(bucketsForMail(Category.SavedMails, sentByMe, "me@x.com")).toEqual([
      "sent"
    ]);
    expect(bucketsForMail(Category.SavedMails, sentToMe, "me@x.com")).toEqual([
      "received"
    ]);
  });

  it("counts a mail an account both sent and received in both lists", () => {
    const toSelf = mail({
      from: addresses("me@x.com"),
      to: addresses("me@x.com")
    });
    expect(bucketsForMail(Category.SavedMails, toSelf, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
  });

  // A star applied in one list and removed from another has to cancel: the
  // counters the edits reach are the server's, and it groups the same row into
  // both lists regardless of which view the user was in.
  it("answers the same lists for one mail across every category listing it", () => {
    const ccSelf = mail({
      from: addresses("me@x.com"),
      to: addresses("them@y.com"),
      cc: addresses("me@x.com")
    });
    const both = ["received", "sent"];
    expect(bucketsForMail(Category.AllMails, ccSelf, "me@x.com")).toEqual(both);
    expect(bucketsForMail(Category.SavedMails, ccSelf, "me@x.com")).toEqual(
      both
    );
    expect(bucketsForMail(Category.SentMails, ccSelf, "me@x.com")).toEqual(
      both
    );
  });

  // The received condition covers `envelope_to`, which no header column
  // carries, so a category that lists received mail is the only evidence that
  // a mail the account also sent reached its received counters.
  it("reads a category listing received mail as proof of the received side", () => {
    expect(bucketsForMail(Category.AllMails, sentByMe, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
    expect(bucketsForMail(Category.SavedMails, sentByMe, "me@x.com")).toEqual([
      "sent"
    ]);
  });

  // Copying yourself on your own mail is the case the recipient headers decide
  // on their own: the sender test already answers `sent`, so `received` is
  // reached only if cc and bcc count alongside `to`.
  it("reads cc and bcc as recipients", () => {
    const cced = mail({
      from: addresses("me@x.com"),
      to: addresses("them@y.com"),
      cc: addresses("me@x.com")
    });
    const bcced = mail({
      from: addresses("me@x.com"),
      to: addresses("them@y.com"),
      bcc: addresses("me@x.com")
    });
    expect(bucketsForMail(Category.SavedMails, cced, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
    expect(bucketsForMail(Category.SavedMails, bcced, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
  });

  // `envelope_to` matches the received condition on the server and is absent
  // from the header payload, so a row the account did not send is received
  // whether or not a visible recipient header names it.
  it("reads a mail it did not send as received under Saved Mails", () => {
    const envelopeOnly = mail({
      from: addresses("them@y.com"),
      to: addresses("list@y.com")
    });
    expect(
      bucketsForMail(Category.SavedMails, envelopeOnly, "me@x.com")
    ).toEqual(["received"]);
  });

  // A mail the account sent and was BCC'd on is counted in both lists: the
  // server groups `received` by the recipient headers including envelope_to,
  // and the payload carries the envelope recipient.
  it("counts a self-sent mail its envelope names in both lists", () => {
    const selfBcc = mail({
      from: addresses("me@x.com"),
      to: addresses("them@y.com"),
      envelopeTo: addresses("me@x.com")
    });
    expect(bucketsForMail(Category.SavedMails, selfBcc, "me@x.com")).toEqual([
      "received",
      "sent"
    ]);
  });

  // The header component repairs cc and bcc in place during render, so a click
  // handler reading the same object sees an array only because an unrelated
  // component ran first.
  it("reads a recipient field the payload delivered unwrapped", () => {
    const unwrappedCc = mail({
      from: addresses("them@y.com"),
      to: addresses("them@y.com"),
      cc: { value: { address: "me@x.com" }, text: "me@x.com" }
    } as unknown as Partial<MailHeaderData>);
    expect(bucketsForMail(Category.SavedMails, unwrappedCc, "me@x.com")).toEqual(
      ["received"]
    );
    const unwrappedFrom = mail({
      from: { value: { address: "me@x.com" }, text: "me@x.com" },
      to: addresses("them@y.com")
    } as unknown as Partial<MailHeaderData>);
    expect(
      bucketsForMail(Category.SentMails, unwrappedFrom, "me@x.com")
    ).toEqual(["sent"]);
  });

  it("ignores the sent flag, which names the user rather than the address", () => {
    const fromMyOtherAddress = mail({
      sent: true,
      from: addresses("alias@x.com"),
      to: addresses("me@x.com")
    });
    expect(
      bucketsForMail(Category.SavedMails, fromMyOtherAddress, "me@x.com")
    ).toEqual(["received"]);
  });
});

describe("wholeBucketForCategory", () => {
  it("names the bucket each whole-bucket category shows", () => {
    expect(wholeBucketForCategory(Category.AllMails)).toBe("received");
    expect(wholeBucketForCategory(Category.SentMails)).toBe("sent");
    expect(wholeBucketForCategory(Category.SpamMails)).toBe("spam");
  });

  // Saved Mails filters `received` by a counter, so an emptied list there
  // says the counter hit zero, not that the account left `received`.
  it("names none for the counter-filtered views and Search", () => {
    expect(wholeBucketForCategory(Category.SavedMails)).toBeNull();
    expect(wholeBucketForCategory(Category.Search)).toBeNull();
  });
});

describe("updateAccountInBucket", () => {
  it("applies the update to the matching account", () => {
    const next = updateAccountInBucket(
      data(),
      "received",
      "me@x.com",
      ({ unread_doc_count }) => ({ unread_doc_count: unread_doc_count - 1 })
    );
    expect(next.received.map((a) => a.unread_doc_count)).toEqual([1, 2]);
  });

  // react-query keeps the previous `data` reference when structural sharing
  // finds every element reference-equal, so a mutated account notifies no
  // observer and the sidebar renders the stale count.
  it("replaces the account rather than mutating it", () => {
    const before = data();
    const next = updateAccountInBucket(before, "received", "me@x.com", () => ({
      doc_count: 0
    }));
    expect(before.received[0].doc_count).toBe(5);
    expect(next.received[0]).not.toBe(before.received[0]);
    expect(next.received).not.toBe(before.received);
    expect(next).not.toBe(before);
  });

  it("leaves the untouched accounts and the other buckets reference-equal", () => {
    const before = data();
    const next = updateAccountInBucket(before, "received", "me@x.com", () => ({
      doc_count: 0
    }));
    expect(next.received[1]).toBe(before.received[1]);
    expect(next.sent).toBe(before.sent);
    expect(next.spam).toBe(before.spam);
  });

  it("returns an Account, not a bare object", () => {
    const next = updateAccountInBucket(data(), "sent", "me@x.com", () => ({
      doc_count: 1
    }));
    expect(next.sent[0]).toBeInstanceOf(Account);
    expect(next.sent[0].key).toBe("me@x.com");
    expect(next.sent[0].updated).toEqual(new Date("2026-01-01"));
  });

  it("no-ops when the key is in a different bucket", () => {
    const before = data();
    const next = updateAccountInBucket(before, "spam", "me@x.com", () => ({
      doc_count: 0
    }));
    expect(next.spam.map((a) => a.doc_count)).toEqual([5]);
  });
});

describe("updateAccountInBuckets", () => {
  it("applies the update in every named bucket", () => {
    const next = updateAccountInBuckets(
      data(),
      ["received", "sent"],
      "me@x.com",
      ({ saved_doc_count }) => ({ saved_doc_count: saved_doc_count - 1 })
    );
    expect(next.received.map((a) => a.saved_doc_count)).toEqual([0, 1]);
    expect(next.sent.map((a) => a.saved_doc_count)).toEqual([0]);
    expect(next.spam.map((a) => a.saved_doc_count)).toEqual([1]);
  });

  it("hands the payload back untouched when no bucket is named", () => {
    const before = data();
    expect(updateAccountInBuckets(before, [], "me@x.com", () => ({}))).toBe(
      before
    );
  });
});

describe("removeAccountFromBucket", () => {
  it("drops the account from the named bucket only", () => {
    const before = data();
    const next = removeAccountFromBucket(before, "received", "me@x.com");
    expect(next.received.map((a) => a.key)).toEqual(["other@x.com"]);
    expect(next.sent.map((a) => a.key)).toEqual(["me@x.com"]);
    expect(next.received).not.toBe(before.received);
    expect(before.received).toHaveLength(2);
  });
});

describe("evictAccountFromCategory", () => {
  it("drops the account from the bucket a whole-bucket category lists", () => {
    expect(
      evictAccountFromCategory(
        data(),
        Category.AllMails,
        "me@x.com"
      ).received.map((a) => a.key)
    ).toEqual(["other@x.com"]);
    expect(
      evictAccountFromCategory(data(), Category.SentMails, "me@x.com").sent
    ).toEqual([]);
    expect(
      evictAccountFromCategory(data(), Category.SpamMails, "spammy@x.com").spam
    ).toEqual([]);
  });

  it("leaves the other buckets alone", () => {
    const next = evictAccountFromCategory(
      data(),
      Category.AllMails,
      "me@x.com"
    );
    expect(next.sent.map((a) => a.key)).toEqual(["me@x.com"]);
    expect(next.spam.map((a) => a.key)).toEqual(["spammy@x.com"]);
  });

  // Unsaving the last saved mail empties the Saved Mails list without the
  // account leaving `received` — it still holds every other mail. Evicting on
  // that signal strands a real account out of every other view until a
  // refetch.
  it("keeps the account when the category only filters a bucket", () => {
    for (const category of [Category.SavedMails]) {
      expect(
        evictAccountFromCategory(data(), category, "me@x.com").received.map(
          (a) => a.key
        )
      ).toEqual(["me@x.com", "other@x.com"]);
    }
  });

  it("hands back the same payload for a category that lists no bucket", () => {
    const before = data();
    expect(
      evictAccountFromCategory(before, Category.SavedMails, "me@x.com")
    ).toBe(before);
    expect(evictAccountFromCategory(before, Category.Search, "me@x.com")).toBe(
      before
    );
  });
});

// The helpers are pinned above, but nothing renders `Mails`, so a call site
// that hand-rolls the mapping is invisible to every other assertion here — and
// the counter it writes stays plausible until the next payload lands.
// `getAccountStats` builds `received` under `AND is_spam = FALSE`, so a
describe("accountCountForCategory", () => {
  it("reads unread for All from the received bucket", () => {
    expect(accountCountForCategory(data(), Category.AllMails, "me@x.com")).toEqual({
      count: 2,
      noun: "unread"
    });
  });

  it("reads saved for Saved from the received bucket", () => {
    expect(
      accountCountForCategory(data(), Category.SavedMails, "me@x.com")
    ).toEqual({ count: 1, noun: "saved" });
  });

  it("reads totals for Sent and Spam from their own buckets", () => {
    expect(
      accountCountForCategory(data(), Category.SentMails, "me@x.com")
    ).toEqual({ count: 5, noun: "emails" });
    expect(
      accountCountForCategory(data(), Category.SpamMails, "spammy@x.com")
    ).toEqual({ count: 5, noun: "emails" });
  });

  it("returns null when the payload or the account has not loaded", () => {
    expect(
      accountCountForCategory(undefined, Category.AllMails, "me@x.com")
    ).toBeNull();
    expect(
      accountCountForCategory(data(), Category.AllMails, "nobody@x.com")
    ).toBeNull();
    // A sent-only account has no received row: no count to show in All.
    expect(
      accountCountForCategory(
        { received: [], sent: [makeAccount("solo@x.com")], spam: [] },
        Category.AllMails,
        "solo@x.com"
      )
    ).toBeNull();
  });
});

// Spam-view star credited to `received` goes to the one bucket the server will
// never count it in. Read via `Bun.file` rather than `fs`: sibling suites
// `mock.module("fs", ...)`, which is process-global in Bun. The whole source is
// stripped of whitespace before matching, so reflow and indentation are not
// failures; what it pins is the argument each existing call passes, not the
// absence of an edit written without the helper at all.
describe("the optimistic account edits in Mails", () => {
  it("names its buckets through bucketsForMail at every call site", async () => {
    const source = await Bun.file(
      new URL("./index.tsx", import.meta.url)
    ).text();
    const stripped = source.replace(/\s+/g, "");

    const call = "updateAccountInBuckets(";
    // The account is the mail's own (`mailAccount`, resolved from its
    // recipient headers) — in the single-account views that is the selected
    // account; in the unified view it is whichever account the mail came
    // from. The key argument and the buckets argument must name the same
    // account, or the edit lands on the wrong account's counters.
    const expected =
      "updateAccountInBuckets(oldData,bucketsForMail(selectedCategory,mail," +
      "mailAccount),mailAccount,";

    const sites: string[] = [];
    for (
      let at = stripped.indexOf(call);
      at !== -1;
      at = stripped.indexOf(call, at + 1)
    ) {
      sites.push(stripped.slice(at, at + expected.length));
    }

    // Removing a row (delete and spam share one helper), marking read, and
    // marking saved.
    expect(sites).toEqual([expected, expected, expected]);
  });
});

describe("accountForMail", () => {
  it("finds the receiving account from the recipient headers", () => {
    expect(
      accountForMail(
        mail({ to: addresses("other@x.com"), from: addresses("s@x.com") }),
        data()
      )
    ).toBe("other@x.com");
  });

  it("matches cc and bcc as well as to", () => {
    expect(
      accountForMail(
        mail({ to: addresses("s@x.com"), cc: addresses("me@x.com") }),
        data()
      )
    ).toBe("me@x.com");
    expect(
      accountForMail(
        mail({ to: addresses("s@x.com"), bcc: addresses("other@x.com") }),
        data()
      )
    ).toBe("other@x.com");
  });

  it("resolves an envelope-only delivery through envelopeTo", () => {
    // Delivered by envelope only (BCC): no header column names the account,
    // so the envelope recipient is the only evidence — without it the caller
    // falls back to the parked account and the bucket edit lands there.
    expect(
      accountForMail(
        mail({
          to: addresses("stranger@x.com"),
          envelopeTo: addresses("other@x.com")
        }),
        data()
      )
    ).toBe("other@x.com");
  });

  it("returns null when no recipient field names a receiving account", () => {
    // No header and no envelope recipient names an account — e.g. a row from
    // an older cache — so the caller falls back to the parked selection
    // rather than guessing.
    expect(
      accountForMail(mail({ to: addresses("stranger@x.com") }), data())
    ).toBeNull();
    expect(accountForMail(mail({ to: addresses("me@x.com") }), undefined)).toBeNull();
  });
});

describe("allAccountsCount", () => {
  it("counts each unread mail once, not once per account it names", () => {
    expect(allAccountsCount(data())).toEqual({ count: 3, noun: "unread" });
  });

  it("returns null before the accounts payload loads", () => {
    expect(allAccountsCount(undefined)).toBeNull();
  });
});

describe("withoutUnreadMail", () => {
  const unreadMail = () =>
    mail({ id: "m1", read: false, sent: false, to: addresses("me@x.com", "other@x.com") });

  it("takes an unread received mail off the count once, whatever it names", () => {
    expect(
      withoutUnreadMail(data(), unreadMail(), Category.AllMails, "me@x.com")
        .unread_mail_count
    ).toBe(2);
  });

  it("leaves the count alone for a mail it never held", () => {
    const cases: [MailHeaderData, Category][] = [
      [mail({ ...unreadMail(), read: true }), Category.AllMails],
      [mail({ ...unreadMail(), sent: true }), Category.SentMails],
      [mail({ ...unreadMail(), spam: true }), Category.AllMails],
      [unreadMail(), Category.SpamMails]
    ];
    for (const [m, category] of cases) {
      expect(
        withoutUnreadMail(data(), m, category, "me@x.com").unread_mail_count
      ).toBe(3);
    }
  });

  it("leaves the count alone for a mail of a domain the user only views", () => {
    const viewed = {
      ...data(),
      shared: [
        {
          domain: "team.example",
          owner: "owner",
          received: [makeAccount("ops@team.example")],
          sent: []
        }
      ]
    };
    expect(
      withoutUnreadMail(viewed, unreadMail(), Category.AllMails, "ops@team.example")
        .unread_mail_count
    ).toBe(3);
  });

  it("never goes below zero", () => {
    expect(
      withoutUnreadMail(
        { ...data(), unread_mail_count: 0 },
        unreadMail(),
        Category.AllMails,
        "me@x.com"
      ).unread_mail_count
    ).toBe(0);
  });
});
