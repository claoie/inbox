import { describe, it, expect } from "bun:test";
import { Account } from "common";
import { Category } from "client";
import {
  accountBadge,
  accountBadgeCount,
  displayNameFor,
  duplicatedDisplayNames,
  filterAccounts,
  folderBadge,
  folderBadgeCounts
} from "./accountList";

const makeAccount = (key: string, unread = 0, saved = 0) =>
  new Account({
    key,
    updated: new Date("2026-01-01"),
    doc_count: 1,
    unread_doc_count: unread,
    saved_doc_count: saved
  });

describe("displayNameFor", () => {
  it("takes the local part of the address", () => {
    expect(displayNameFor("annie@x.com")).toBe("annie");
    expect(displayNameFor("maple@shop.example")).toBe("maple");
  });

  it("falls back to Unknown when there is no local part", () => {
    expect(displayNameFor("")).toBe("Unknown");
    expect(displayNameFor("@x.com")).toBe("Unknown");
  });
});

describe("duplicatedDisplayNames", () => {
  it("returns the display names that appear more than once", () => {
    const accounts = [
      makeAccount("annie@x.com"),
      makeAccount("annie@y.com"),
      makeAccount("maple@x.com")
    ];
    expect(duplicatedDisplayNames(accounts)).toEqual(new Set(["annie"]));
  });

  it("returns an empty set when every name is unique", () => {
    const accounts = [makeAccount("annie@x.com"), makeAccount("maple@x.com")];
    expect(duplicatedDisplayNames(accounts)).toEqual(new Set());
  });

  it("treats two Unknowns as duplicates", () => {
    const accounts = [makeAccount(""), makeAccount("@x.com")];
    expect(duplicatedDisplayNames(accounts)).toEqual(new Set(["Unknown"]));
  });
});

describe("filterAccounts", () => {
  const accounts = [
    makeAccount("annie@x.com"),
    makeAccount("Annie@y.com"),
    makeAccount("maple@shop.example")
  ];

  it("matches a case-insensitive substring of the address", () => {
    expect(filterAccounts(accounts, "ANNIE").map((a) => a.key)).toEqual([
      "annie@x.com",
      "Annie@y.com"
    ]);
    expect(filterAccounts(accounts, "shop").map((a) => a.key)).toEqual([
      "maple@shop.example"
    ]);
  });

  it("returns everything for an empty or blank filter", () => {
    expect(filterAccounts(accounts, "")).toEqual(accounts);
    expect(filterAccounts(accounts, "   ")).toEqual(accounts);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterAccounts(accounts, "zzz")).toEqual([]);
  });

  it("keeps the input order", () => {
    expect(filterAccounts(accounts, "x.com").map((a) => a.key)).toEqual([
      "annie@x.com"
    ]);
  });
});

describe("accountBadgeCount", () => {
  it("reads unread everywhere except Saved", () => {
    const account = makeAccount("me@x.com", 3, 2);
    expect(accountBadgeCount(account, Category.AllMails)).toBe(3);
    expect(accountBadgeCount(account, Category.SentMails)).toBe(3);
    expect(accountBadgeCount(account, Category.SpamMails)).toBe(3);
  });

  it("reads saved for Saved", () => {
    const account = makeAccount("me@x.com", 3, 2);
    expect(accountBadgeCount(account, Category.SavedMails)).toBe(2);
  });
});

describe("folderBadgeCounts", () => {
  it("sums the badge rule over each folder's bucket, and All counts mails", () => {
    const data = {
      received: [
        makeAccount("maple@x.com", 2, 1),
        makeAccount("fern@x.com", 1, 0)
      ],
      sent: [makeAccount("maple@x.com", 1, 0)],
      spam: [makeAccount("spam@x.com", 3, 0)],
      shared: [],
      // One unread mail names both maple and fern.
      unread_mail_count: 2
    };
    expect(folderBadgeCounts(data)).toEqual({
      [Category.AllMails]: 2,
      [Category.SavedMails]: 1,
      [Category.SentMails]: 1,
      [Category.SpamMails]: 3
    });
  });

  it("returns zeros when the payload has not loaded", () => {
    expect(folderBadgeCounts(undefined)).toEqual({
      [Category.AllMails]: 0,
      [Category.SavedMails]: 0,
      [Category.SentMails]: 0,
      [Category.SpamMails]: 0
    });
  });
});

describe("accountBadge", () => {
  const account = new Account({
    key: "a@x.com",
    updated: new Date("2026-01-01"),
    doc_count: 9,
    unread_doc_count: 3,
    saved_doc_count: 2
  });

  it("shows unread in red outside Saved and Search", () => {
    expect(accountBadge(account, Category.AllMails)).toEqual({
      count: 3,
      tone: "unread",
      label: "3 unread"
    });
  });

  it("shows saved in the neutral style for Saved", () => {
    expect(accountBadge(account, Category.SavedMails)).toEqual({
      count: 2,
      tone: "neutral",
      label: "2 saved"
    });
  });

  it("shows the match count in the neutral style for Search", () => {
    expect(accountBadge(account, Category.Search)).toEqual({
      count: 9,
      tone: "neutral",
      label: "9 matching"
    });
  });
});

describe("folderBadge", () => {
  const counts = {
    [Category.AllMails]: 4,
    [Category.SavedMails]: 6,
    [Category.SentMails]: 0,
    [Category.SpamMails]: 2
  };

  it("shows the received unread total on All", () => {
    expect(folderBadge(Category.AllMails, counts)).toEqual({
      count: 4,
      tone: "unread",
      label: "4 unread"
    });
  });

  it("shows saved mail in the neutral style", () => {
    expect(folderBadge(Category.SavedMails, counts).tone).toBe("neutral");
  });

  it("shows spam as unread", () => {
    expect(folderBadge(Category.SpamMails, counts)).toEqual({
      count: 2,
      tone: "unread",
      label: "2 unread"
    });
  });
});
