import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Pagination, SignedUser, MaskedUser } from "common";

// The rows the list query would return; the id mocks hand out their indexes
// and the batch mock reads the rows back by index, in the order asked for.
let listRows: unknown[] = [];
const listedIds = () => listRows.map((_, i) => String(i));
const mockGetMailHeaderIds = mock(async () => listedIds());
const mockGetMailHeadersByIds = mock(async function* (_userId: string, ids: string[]) {
  if (ids.length) yield ids.map((id) => listRows[Number(id)]);
});
const mockGetMailHeadersDelta = mock(() =>
  Promise.resolve({ as_of: "2024-01-02T00:00:00.000Z", headers: [], expunged_ids: [] })
);
const mockGetUnifiedMailHeaderIds = mock(async () => listedIds());
const mockGetUnifiedMailHeadersDelta = mock(() =>
  Promise.resolve({ as_of: "2024-01-02T00:00:00.000Z", headers: [], expunged_ids: [] })
);

mock.module("../postgres/repositories/mails", () => ({
  getMailHeaderIds: mockGetMailHeaderIds,
  getMailHeadersByIds: mockGetMailHeadersByIds,
  getMailHeadersDelta: mockGetMailHeadersDelta,
  getUnifiedMailHeaderIds: mockGetUnifiedMailHeaderIds,
  getUnifiedMailHeadersDelta: mockGetUnifiedMailHeadersDelta,
}));

import {
  getMailHeaders,
  getMailHeadersDelta,
  getUnifiedMailHeaders,
  getUnifiedMailHeadersDelta,
  toMailHeaderData,
} from "./headers";

const setListRows = (rows: unknown[]) => {
  listRows = rows;
};

const collect = async <R>(batches: Promise<AsyncIterable<R[]>>): Promise<R[]> => {
  const rows: R[] = [];
  for await (const batch of await batches) rows.push(...batch);
  return rows;
};

const makeUser = (overrides: Partial<SignedUser> = {}) => new SignedUser({
  id: "user-123",
  username: "testuser",
  email: "test@example.com",
  ...overrides,
});

const makeMaskedUser = (overrides: Partial<MaskedUser> = {}) => new MaskedUser({
  id: "user-456",
  username: "maskeduser",
  ...overrides,
});

const defaultOptions = {
  sent: false,
  saved: false,
};

describe("getMailHeaders", () => {
  beforeEach(() => {
    mockGetMailHeaderIds.mockClear();
    mockGetMailHeadersByIds.mockClear();
    setListRows([]);
  });

  it("should return empty array when user has no id", async () => {
    const user = { username: "noId" };
    const result = (await collect(getMailHeaders(user, "inbox@example.com", defaultOptions))).map(toMailHeaderData);
    expect(result).toEqual([]);
    expect(mockGetMailHeaderIds).not.toHaveBeenCalled();
  });

  it("should call pgGetMailHeaders with correct parameters for SignedUser", async () => {
    const user = makeUser();
    await getMailHeaders(user, "inbox@example.com", defaultOptions);
    expect(mockGetMailHeaderIds).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({ sent: false, saved: false })
    );
  });

  it("should call pgGetMailHeaders with user_id for MaskedUser", async () => {
    const user = makeMaskedUser();
    await getMailHeaders(user, "inbox@example.com", defaultOptions);
    expect(mockGetMailHeaderIds).toHaveBeenCalledWith(
      "user-456",
      "inbox@example.com",
      expect.any(Object)
    );
  });

  it("should use default pagination when not provided", async () => {
    const user = makeUser();
    await getMailHeaders(user, "inbox@example.com", defaultOptions);
    const defaultPagination = new Pagination();
    expect(mockGetMailHeaderIds).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({
        from: defaultPagination.from,
        size: defaultPagination.size,
      })
    );
  });

  it("should pass pagination options correctly", async () => {
    const user = makeUser();
    const pagination = new Pagination();
    pagination.from = 20;
    pagination.size = 10;

    await getMailHeaders(user, "inbox@example.com", {
      ...defaultOptions,
      pagination,
    });

    expect(mockGetMailHeaderIds).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({ from: 20, size: 10 })
    );
  });

  it("should map mail models to MailHeaderData", async () => {
    const mailModel = {
      mail_id: "mail-abc",
      subject: "Test Email",
      date: "2024-01-15T10:00:00Z",
      from_address: [{ address: "sender@example.com", name: "Sender" }],
      from_text: "Sender <sender@example.com>",
      to_address: [{ address: "recv@example.com", name: "Recv" }],
      to_text: "Recv <recv@example.com>",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: true,
      saved: false,
      sent: false,
      insight: null,
      text_prefix:
        "The new part is here.\nOn Tue, Jan 5, 2021 at 3:00 PM, A <a@x.com> wrote:\n> quoted old part",
    };
    setListRows([mailModel]);

    const user = makeUser();
    const results = (await collect(getMailHeaders(user, "recv@example.com", defaultOptions))).map(toMailHeaderData);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("mail-abc");
    expect(results[0].subject).toBe("Test Email");
    expect(results[0].read).toBe(true);
    expect(results[0].saved).toBe(false);
    expect(results[0].sent).toBe(false);
    expect(results[0].snippet).toBe("The new part is here.");
  });

  it("carries the threading ids the list groups conversations by", async () => {
    setListRows([
      {
        mail_id: "m-2", user_id: "user-1", subject: "Re: x", date: "2026-01-01T00:00:00Z",
        from_address: null, from_text: null, to_address: null, to_text: null,
        cc_address: null, cc_text: null, bcc_address: null, bcc_text: null,
        read: true, saved: false, sent: false, is_spam: false, insight: null, text_prefix: null,
        message_id: "<b@x>", in_reply_to: "<a@x>", reference_ids: ["<a@x>"],
      },
      {
        mail_id: "m-1", user_id: "user-1", subject: "x", date: "2026-01-01T00:00:00Z",
        from_address: null, from_text: null, to_address: null, to_text: null,
        cc_address: null, cc_text: null, bcc_address: null, bcc_text: null,
        read: true, saved: false, sent: false, is_spam: false, insight: null, text_prefix: null,
        message_id: "<a@x>", in_reply_to: null, reference_ids: null,
      },
    ] as never);
    const [reply, original] = (await collect(getMailHeaders(makeUser(), "me@x.com", defaultOptions))).map(toMailHeaderData);
    expect(reply.messageId).toBe("<b@x>");
    expect(reply.inReplyTo).toBe("<a@x>");
    expect(reply.references).toEqual(["<a@x>"]);
    expect(original.messageId).toBe("<a@x>");
    expect("inReplyTo" in original).toBe(false);
    expect("references" in original).toBe(false);
  });

  it("should handle null from/to addresses", async () => {
    const mailModel = {
      mail_id: "mail-null",
      subject: "Null Addresses",
      date: "2024-01-15T10:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: false,
      sent: false,
      insight: null,
    };
    setListRows([mailModel]);

    const user = makeUser();
    const results = (await collect(getMailHeaders(user, "inbox@example.com", defaultOptions))).map(toMailHeaderData);
    expect(results[0].from).toBeUndefined();
    expect(results[0].to).toBeUndefined();
    expect(results[0].cc).toBeUndefined();
    expect(results[0].bcc).toBeUndefined();
  });

  it("should map cc and bcc when present", async () => {
    const mailModel = {
      mail_id: "mail-ccbcc",
      subject: "CC/BCC Email",
      date: "2024-01-15T10:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: [{ address: "cc@example.com" }],
      cc_text: "cc@example.com",
      bcc_address: [{ address: "bcc@example.com" }],
      bcc_text: "bcc@example.com",
      read: false,
      saved: false,
      sent: false,
      insight: null,
    };
    setListRows([mailModel]);

    const user = makeUser();
    const results = (await collect(getMailHeaders(user, "inbox@example.com", defaultOptions))).map(toMailHeaderData);
    expect(results[0].cc).toBeDefined();
    expect(results[0].bcc).toBeDefined();
  });

  it("should map envelope_to when present", async () => {
    // A BCC delivery names no account in to/cc/bcc; the envelope recipient
    // is the only evidence of which account the row belongs to.
    const mailModel = {
      mail_id: "mail-envelope",
      subject: "BCC Email",
      date: "2024-01-15T10:00:00Z",
      from_address: [{ address: "sender@example.com" }],
      from_text: "sender@example.com",
      to_address: [{ address: "list@example.com" }],
      to_text: "list@example.com",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      envelope_to: [{ address: "b@example.com" }],
      read: false,
      saved: false,
      sent: false,
      insight: null,
    };
    setListRows([mailModel]);

    const user = makeUser();
    const results = (await collect(getMailHeaders(user, "b@example.com", defaultOptions))).map(toMailHeaderData);
    expect(results[0].envelopeTo).toBeDefined();
    expect(results[0].envelopeTo?.value).toEqual([
      { address: "b@example.com" },
    ]);
  });

  it("should leave envelopeTo absent when the row carries none", async () => {
    // Rows from older caches predate the field; the key stays absent rather
    // than present-but-undefined, like the threading ids.
    const mailModel = {
      mail_id: "mail-no-envelope",
      subject: "Old Row",
      date: "2024-01-15T10:00:00Z",
      from_address: null,
      from_text: null,
      to_address: null,
      to_text: null,
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: false,
      sent: false,
      insight: null,
    };
    setListRows([mailModel]);

    const user = makeUser();
    const results = (await collect(getMailHeaders(user, "inbox@example.com", defaultOptions))).map(toMailHeaderData);
    expect("envelopeTo" in results[0]).toBe(false);
  });

  it("should pass sent=true option", async () => {
    const user = makeUser();
    await getMailHeaders(user, "sent@example.com", { ...defaultOptions, sent: true });
    expect(mockGetMailHeaderIds).toHaveBeenCalledWith(
      "user-123",
      "sent@example.com",
      expect.objectContaining({ sent: true })
    );
  });

  it("should pass saved=true option", async () => {
    const user = makeUser();
    await getMailHeaders(user, "inbox@example.com", { ...defaultOptions, saved: true });
    expect(mockGetMailHeaderIds).toHaveBeenCalledWith(
      "user-123",
      "inbox@example.com",
      expect.objectContaining({ saved: true })
    );
  });

  it("should return multiple results", async () => {
    const models = [
      { mail_id: "m1", subject: "First", date: "2024-01-01", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: false, saved: false, sent: false, insight: null },
      { mail_id: "m2", subject: "Second", date: "2024-01-02", from_address: null, from_text: null, to_address: null, to_text: null, cc_address: null, cc_text: null, bcc_address: null, bcc_text: null, read: true, saved: true, sent: false, insight: null },
    ];
    setListRows(models);

    const user = makeUser();
    const results = (await collect(getMailHeaders(user, "inbox@example.com", defaultOptions))).map(toMailHeaderData);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("m1");
    expect(results[1].id).toBe("m2");
  });
});

describe("getMailHeadersDelta", () => {
  const since = "2024-01-01T00:00:00.000Z";

  beforeEach(() => {
    mockGetMailHeadersDelta.mockClear();
    mockGetMailHeadersDelta.mockResolvedValue({
      as_of: "2024-01-02T00:00:00.000Z",
      headers: [],
      expunged_ids: [],
    });
  });

  it("returns an empty delta that echoes `since` when user has no id", async () => {
    const user = { username: "noId" };
    const result = await getMailHeadersDelta(user, "inbox@example.com", defaultOptions, since);
    // as_of must NOT advance past `since`, or the client would skip unseen rows.
    expect(result).toEqual({ as_of: since, headers: [], expunged_ids: [] });
    expect(mockGetMailHeadersDelta).not.toHaveBeenCalled();
  });

  it("passes since + folder options to the repository (and never paginates)", async () => {
    const user = makeUser();
    await getMailHeadersDelta(
      user,
      "inbox@example.com",
      { ...defaultOptions, sent: true },
      since
    );
    const callArgs = mockGetMailHeadersDelta.mock.calls[0];
    expect(callArgs[0]).toBe("user-123");
    expect(callArgs[1]).toBe("inbox@example.com");
    expect(callArgs[2]).toMatchObject({ sent: true, saved: false });
    // Delta returns the full changed set, so it must NOT carry pagination.
    expect(callArgs[2]).not.toHaveProperty("from");
    expect(callArgs[2]).not.toHaveProperty("size");
    expect(callArgs[3]).toBe(since);
  });

  it("maps repository header rows to MailHeaderData and passes through as_of + expunged_ids", async () => {
    mockGetMailHeadersDelta.mockResolvedValue({
      as_of: "2024-01-03T12:00:00.000Z",
      headers: [
        {
          mail_id: "mail-delta",
          subject: "Changed",
          date: "2024-01-03T10:00:00Z",
          from_address: [{ address: "s@example.com" }],
          from_text: "s@example.com",
          to_address: null,
          to_text: null,
          cc_address: null,
          cc_text: null,
          bcc_address: null,
          bcc_text: null,
          read: false,
          saved: false,
          sent: false,
          insight: null,
        },
      ],
      expunged_ids: ["gone-1", "gone-2"],
    });

    const user = makeUser();
    const result = await getMailHeadersDelta(user, "inbox@example.com", defaultOptions, since);
    expect(result.as_of).toBe("2024-01-03T12:00:00.000Z");
    expect(result.expunged_ids).toEqual(["gone-1", "gone-2"]);
    expect(result.headers).toHaveLength(1);
    expect(result.headers[0].id).toBe("mail-delta");
    expect(result.headers[0].subject).toBe("Changed");
    expect(result.headers[0].from).toBeDefined();
  });
});

describe("getUnifiedMailHeaders", () => {
  const ADDRESSES = ["a@example.com", "b@example.com"];

  beforeEach(() => {
    mockGetUnifiedMailHeaderIds.mockClear();
    mockGetMailHeadersByIds.mockClear();
    setListRows([]);
  });

  it("should return empty array when user has no id", async () => {
    const user = { username: "noId" };
    const result = (await collect(getUnifiedMailHeaders(user, ADDRESSES, {}))).map(toMailHeaderData);
    expect(result).toEqual([]);
    expect(mockGetUnifiedMailHeaderIds).not.toHaveBeenCalled();
  });

  it("should call pgGetUnifiedMailHeaders with the user id and the address set", async () => {
    const user = makeUser();
    await getUnifiedMailHeaders(user, ADDRESSES, {});
    expect(mockGetUnifiedMailHeaderIds).toHaveBeenCalledWith(
      "user-123",
      ADDRESSES,
      expect.objectContaining({ from: 0, size: 10000 })
    );
  });

  it("should pass pagination options correctly", async () => {
    const user = makeUser();
    const pagination = new Pagination();
    pagination.from = 20;
    pagination.size = 10;

    await getUnifiedMailHeaders(user, ADDRESSES, { pagination });

    expect(mockGetUnifiedMailHeaderIds).toHaveBeenCalledWith(
      "user-123",
      ADDRESSES,
      expect.objectContaining({ from: 20, size: 10 })
    );
  });

  it("should map mail models to MailHeaderData", async () => {
    const mailModel = {
      mail_id: "mail-unified",
      subject: "Unified",
      date: "2024-01-15T10:00:00Z",
      from_address: [{ address: "sender@example.com", name: "Sender" }],
      from_text: "Sender <sender@example.com>",
      to_address: [{ address: "b@example.com", name: "B" }],
      to_text: "B <b@example.com>",
      cc_address: null,
      cc_text: null,
      bcc_address: null,
      bcc_text: null,
      read: false,
      saved: false,
      sent: false,
      insight: null,
      text_prefix: "Hello from the other account.",
    };
    setListRows([mailModel]);

    const user = makeUser();
    const result = (await collect(getUnifiedMailHeaders(user, ADDRESSES, {}))).map(toMailHeaderData);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("mail-unified");
    expect(result[0].subject).toBe("Unified");
    expect(result[0].snippet).toBe("Hello from the other account.");
  });
});

describe("getUnifiedMailHeadersDelta", () => {
  const since = "2024-01-01T00:00:00.000Z";
  const ADDRESSES = ["a@example.com", "b@example.com"];

  beforeEach(() => {
    mockGetUnifiedMailHeadersDelta.mockClear();
    mockGetUnifiedMailHeadersDelta.mockResolvedValue({
      as_of: "2024-01-02T00:00:00.000Z",
      headers: [],
      expunged_ids: [],
    });
  });

  it("returns an empty delta that echoes `since` when user has no id", async () => {
    const user = { username: "noId" };
    const result = await getUnifiedMailHeadersDelta(user, ADDRESSES, since);
    expect(result).toEqual({ as_of: since, headers: [], expunged_ids: [] });
    expect(mockGetUnifiedMailHeadersDelta).not.toHaveBeenCalled();
  });

  it("passes the address set and since to the repository", async () => {
    const user = makeUser();
    await getUnifiedMailHeadersDelta(user, ADDRESSES, since);
    expect(mockGetUnifiedMailHeadersDelta).toHaveBeenCalledWith(
      "user-123",
      ADDRESSES,
      since
    );
  });
});
