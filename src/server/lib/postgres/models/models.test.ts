
import { describe, it, expect } from "bun:test";
import {
  validateObject,
  ModelValidationError,
  Model,
  resolveMutationFilters
} from "./base";
import { MailModel, PartialMailModel } from "./mail";
import { UserModel } from "./user";
import { SessionModel } from "./session";
import { MailboxModel } from "./mailbox";
import { PushSubscriptionModel } from "./push_subscription";
import { SpamAllowlistModel } from "./spam_allowlist";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMailData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mail_id: "aaaaaaaa-0000-0000-0000-000000000001",
    user_id: "bbbbbbbb-0000-0000-0000-000000000002",
    message_id: "<test@example.com>",
    subject: "Hello",
    date: "2024-01-01T00:00:00+00:00",
    html: "<p>hi</p>",
    text: "hi",
    from_address: { address: "sender@example.com", name: "Sender" },
    from_text: "Sender <sender@example.com>",
    to_address: null,
    to_text: null,
    cc_address: null,
    cc_text: null,
    bcc_address: null,
    bcc_text: null,
    reply_to_address: null,
    reply_to_text: null,
    envelope_from: null,
    envelope_to: null,
    attachments: null,
    read: false,
    saved: false,
    sent: false,
    deleted: false,
    draft: false,
    answered: false,
    expunged: false,
    insight: null,
    uid_domain: 0,
    modseq: 1,
    spam_score: 0,
    spam_reasons: null,
    is_spam: false,
    rfc822_size: null,
    text_line_count: null,
    html_line_count: null,
    updated: "2024-01-01T00:00:00+00:00",
    search_vector: null,
    ...overrides,
  };
}

function makeUserData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user_id: "cccccccc-0000-0000-0000-000000000003",
    username: "alice",
    password: "hashed_password",
    email: "alice@example.com",
    expiry: null,
    token: null,
    updated: "2024-01-01T00:00:00+00:00",
    is_deleted: false,
    imap_uid_validity: null,
    ...overrides,
  };
}

function makeSessionData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-abc-123",
    session_user_id: "cccccccc-0000-0000-0000-000000000003",
    session_username: "alice",
    session_email: "alice@example.com",
    session_is_read_only: null,
    session_authenticated_as: null,
    cookie_original_max_age: 86400000,
    cookie_max_age: 86400000,
    cookie_signed: true,
    cookie_expires: "2024-12-31T00:00:00+00:00",
    cookie_http_only: true,
    cookie_path: "/",
    cookie_domain: null,
    cookie_secure: "true",
    cookie_same_site: "lax",
    updated: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

function makeMailboxData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mailbox_id: "dddddddd-0000-0000-0000-000000000004",
    user_id: "cccccccc-0000-0000-0000-000000000003",
    name: "INBOX",
    address: "alice@example.com",
    parent_id: null,
    uid_validity: 1,
    uid_next: 42,
    subscribed: true,
    special_use: "\\Inbox",
    created: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

function makePushSubData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    push_subscription_id: "eeeeeeee-0000-0000-0000-000000000005",
    user_id: "cccccccc-0000-0000-0000-000000000003",
    endpoint: "https://push.example.com/sub/abc123",
    keys_p256dh: "BNJz...key==",
    keys_auth: "auth==",
    last_notified: null,
    updated: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

function makeSpamAllowlistData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowlist_id: "ffffffff-0000-0000-0000-000000000006",
    user_id: "cccccccc-0000-0000-0000-000000000003",
    pattern: "trusted@example.com",
    created_at: "2024-01-01T00:00:00+00:00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// base.ts — validateObject
// ---------------------------------------------------------------------------

describe("validateObject", () => {
  const checker = {
    name: (v: unknown) => typeof v === "string",
    age: (v: unknown) => typeof v === "number",
  };

  it("returns empty array for valid object", () => {
    expect(validateObject({ name: "Alice", age: 30 }, checker)).toEqual([]);
  });

  it("returns error for non-object input (null)", () => {
    const errors = validateObject(null, checker);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/not a valid object/);
  });

  it("returns error for non-object input (string)", () => {
    const errors = validateObject("oops", checker);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns error for each failing field", () => {
    const errors = validateObject({ name: 42, age: "old" }, checker);
    expect(errors).toHaveLength(2);
    expect(errors.some((e) => e.startsWith("name:"))).toBe(true);
    expect(errors.some((e) => e.startsWith("age:"))).toBe(true);
  });

  it("skips fields listed in skip array", () => {
    // age is wrong type but skipped — should only report name
    const errors = validateObject({ name: 42, age: "wrong" }, checker, ["age"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^name:/);
  });

  it("handles empty checker (always valid)", () => {
    expect(validateObject({ anything: true }, {})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// base.ts — ModelValidationError
// ---------------------------------------------------------------------------

describe("ModelValidationError", () => {
  it("has correct name property", () => {
    const err = new ModelValidationError("TestModel", ["field1: bad"]);
    expect(err.name).toBe("ModelValidationError");
  });

  it("includes model name and errors in message", () => {
    const err = new ModelValidationError("FooModel", ["x: 1 (number)"]);
    expect(err.message).toContain("FooModel");
    expect(err.message).toContain("x: 1 (number)");
  });

  it("exposes errors array", () => {
    const errors = ["a: null (object)", "b: undefined (undefined)"];
    const err = new ModelValidationError("M", errors);
    expect(err.errors).toEqual(errors);
  });

  it("is instanceof Error", () => {
    expect(new ModelValidationError("M", [])).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// MailModel
// ---------------------------------------------------------------------------

describe("MailModel construction", () => {
  it("constructs from valid data and assigns all fields", () => {
    const data = makeMailData();
    const m = new MailModel(data);
    expect(m.mail_id).toBe(data.mail_id);
    expect(m.user_id).toBe(data.user_id);
    expect(m.message_id).toBe(data.message_id);
    expect(m.subject).toBe(data.subject);
    expect(m.read).toBe(false);
    expect(m.spam_score).toBe(0);
    expect(m.is_spam).toBe(false);
    expect(m.from_address).toEqual({ address: "sender@example.com", name: "Sender" });
    expect(m.from_text).toBe("Sender <sender@example.com>");
    expect(m.to_address).toBeNull();
  });

  it("throws ModelValidationError for missing required string fields", () => {
    const data = makeMailData({ mail_id: 999 });
    expect(() => new MailModel(data)).toThrow(ModelValidationError);
  });

  it("throws for non-object input", () => {
    expect(() => new MailModel(null)).toThrow(ModelValidationError);
    expect(() => new MailModel("bad")).toThrow(ModelValidationError);
  });

  it("throws when boolean field gets wrong type", () => {
    const data = makeMailData({ read: "true" }); // string, not boolean
    expect(() => new MailModel(data)).toThrow(ModelValidationError);
  });

  it("throws when number field gets wrong type", () => {
    const data = makeMailData({ uid_domain: "0" }); // string, not number
    expect(() => new MailModel(data)).toThrow(ModelValidationError);
  });

  it("accepts null for nullable fields", () => {
    const data = makeMailData({ insight: null, from_address: null, spam_reasons: null });
    const m = new MailModel(data);
    expect(m.insight).toBeNull();
    expect(m.from_address).toBeNull();
    expect(m.spam_reasons).toBeNull();
  });

  it("accepts arrays for spam_reasons", () => {
    const data = makeMailData({ spam_reasons: ["SPAM_WORD", "BLACKLIST"] });
    const m = new MailModel(data);
    expect(m.spam_reasons).toEqual(["SPAM_WORD", "BLACKLIST"]);
  });

  // The BODYSTRUCTURE `lines` cache columns round-trip as numbers OR null
  // (NULL for pre-migration rows that haven't been observed yet).
  it("accepts numeric text_line_count / html_line_count", () => {
    const m = new MailModel(makeMailData({ text_line_count: 12, html_line_count: 34 }));
    expect(m.text_line_count).toBe(12);
    expect(m.html_line_count).toBe(34);
    const json = m.toJSON();
    expect(json.text_line_count).toBe(12);
    expect(json.html_line_count).toBe(34);
  });

  it("accepts null text_line_count / html_line_count for unbackfilled rows", () => {
    const m = new MailModel(makeMailData({ text_line_count: null, html_line_count: null }));
    expect(m.text_line_count).toBeNull();
    expect(m.html_line_count).toBeNull();
  });

  it("throws when text_line_count is a non-number, non-null value", () => {
    expect(() => new MailModel(makeMailData({ text_line_count: "12" }))).toThrow(
      ModelValidationError
    );
  });
});

describe("MailModel.toJSON", () => {
  it("returns all expected JSON fields", () => {
    const m = new MailModel(makeMailData());
    const json = m.toJSON();
    expect(json.mail_id).toBe(m.mail_id);
    expect(json.user_id).toBe(m.user_id);
    expect(json.subject).toBe(m.subject);
    expect(json.read).toBe(false);
    expect(json.is_spam).toBe(false);
  });

  it("does NOT include updated in toJSON output", () => {
    const m = new MailModel(makeMailData());
    const json = m.toJSON();
    expect("updated" in json).toBe(false);
  });

  it("does NOT include search_vector in toJSON output", () => {
    const m = new MailModel(makeMailData());
    const json = m.toJSON();
    expect("search_vector" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PartialMailModel
// ---------------------------------------------------------------------------

describe("PartialMailModel", () => {
  it("constructs with subset of valid fields", () => {
    const data = { mail_id: "aaaaaaaa-0000-0000-0000-000000000001", subject: "Hey", read: true };
    const pm = new PartialMailModel(["mail_id", "subject", "read"], data);
    expect(pm.mail_id).toBe(data.mail_id);
    expect(pm.subject).toBe("Hey");
    expect(pm.read).toBe(true);
  });

  it("leaves unselected fields undefined", () => {
    const data = { mail_id: "aaaaaaaa-0000-0000-0000-000000000001" };
    const pm = new PartialMailModel(["mail_id"], data);
    expect(pm.mail_id).toBeDefined();
    expect(pm.subject).toBeUndefined();
    expect(pm.read).toBeUndefined();
  });

  it("throws ModelValidationError for unknown field names", () => {
    const data = { nonexistent_field: "x" };
    expect(() => new PartialMailModel(["nonexistent_field"], data)).toThrow(ModelValidationError);
  });

  it("throws for type mismatch on selected fields", () => {
    const data = { read: "yes" }; // should be boolean
    expect(() => new PartialMailModel(["read"], data)).toThrow(ModelValidationError);
  });

  it("exposes selectedFields set", () => {
    const data = { mail_id: "aaaaaaaa-0000-0000-0000-000000000001", read: false };
    const pm = new PartialMailModel(["mail_id", "read"], data);
    expect(pm.selectedFields.has("mail_id")).toBe(true);
    expect(pm.selectedFields.has("read")).toBe(true);
    expect(pm.selectedFields.has("subject")).toBe(false);
  });

  it("accepts empty fields list with empty data", () => {
    const pm = new PartialMailModel([], {});
    expect(pm.selectedFields.size).toBe(0);
  });

  it("PartialMailModel.validFields includes all MailModel checker keys", () => {
    const checkerKeys = Object.keys(MailModel.typeChecker);
    for (const k of checkerKeys) {
      expect(PartialMailModel.validFields.has(k)).toBe(true);
    }
  });

  it("accepts nullable object field as null", () => {
    const data = { from_address: null };
    const pm = new PartialMailModel(["from_address"], data);
    expect(pm.from_address).toBeNull();
  });

  it("error message lists the unknown field name", () => {
    try {
      new PartialMailModel(["totally_fake_col"], {});
      expect(true).toBe(false); // should not reach
    } catch (e) {
      expect(e).toBeInstanceOf(ModelValidationError);
      expect((e as ModelValidationError).message).toContain("totally_fake_col");
    }
  });

  it("accepts the octet-length synthetic fields as numbers", () => {
    // `text_octets` and `html_octets` are populated by `octet_length()` in
    // the IMAP range query, not stored on the row. Verify they validate as
    // numbers alongside a real column, and that they reject non-numbers so a
    // mis-projected row surfaces the mismatch instead of silently coercing.
    const pm = new PartialMailModel(
      ["mail_id", "text_octets", "html_octets"],
      {
        mail_id: "aaaaaaaa-0000-0000-0000-000000000001",
        text_octets: 12345,
        html_octets: 67890,
      }
    );
    expect(pm.text_octets).toBe(12345);
    expect(pm.html_octets).toBe(67890);
  });

  it("rejects non-numeric text_octets / html_octets", () => {
    expect(
      () =>
        new PartialMailModel(["text_octets"], {
          text_octets: "12345" as unknown as number,
        })
    ).toThrow(ModelValidationError);
    expect(
      () =>
        new PartialMailModel(["html_octets"], {
          html_octets: null as unknown as number,
        })
    ).toThrow(ModelValidationError);
  });
});

// ---------------------------------------------------------------------------
// UserModel
// ---------------------------------------------------------------------------

describe("UserModel construction", () => {
  it("constructs from valid data", () => {
    const u = new UserModel(makeUserData());
    expect(u.user_id).toBe("cccccccc-0000-0000-0000-000000000003");
    expect(u.username).toBe("alice");
    expect(u.email).toBe("alice@example.com");
    expect(u.password).toBe("hashed_password");
  });

  it("throws for missing username", () => {
    expect(() => new UserModel(makeUserData({ username: null }))).toThrow(ModelValidationError);
  });

  it("accepts null for optional fields", () => {
    const u = new UserModel(makeUserData({ email: null, password: null, token: null }));
    expect(u.email).toBeNull();
    expect(u.password).toBeNull();
    expect(u.token).toBeNull();
  });
});

describe("UserModel.toJSON / toMaskedUser", () => {
  it("toJSON masks password", () => {
    const u = new UserModel(makeUserData());
    const json = u.toJSON();
    expect("password" in json).toBe(false);
    expect(json.user_id).toBeDefined();
    expect(json.username).toBe("alice");
  });

  it("toMaskedUser returns same as toJSON", () => {
    const u = new UserModel(makeUserData());
    expect(u.toMaskedUser()).toEqual(u.toJSON());
  });
});

describe("UserModel.toUser", () => {
  it("returns full user including password", () => {
    const u = new UserModel(makeUserData());
    const user = u.toUser();
    expect(user.password).toBe("hashed_password");
    expect(user.user_id).toBe(u.user_id);
  });

  it("throws if password is null", () => {
    const u = new UserModel(makeUserData({ password: null }));
    expect(() => u.toUser()).toThrow("no password set");
  });

  it("propagates token + expiry when present", () => {
    const u = new UserModel(
      makeUserData({ token: "tok-abc", expiry: "2026-12-31T00:00:00+00:00" }),
    );
    const user = u.toUser();
    expect(user.token).toBe("tok-abc");
    expect(user.expiry).toBe("2026-12-31T00:00:00+00:00");
  });

  it("propagates null token/expiry without coercing them away", () => {
    const u = new UserModel(makeUserData({ token: null, expiry: null }));
    const user = u.toUser();
    expect(user.token).toBeNull();
    expect(user.expiry).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SessionModel
// ---------------------------------------------------------------------------

describe("SessionModel construction", () => {
  it("constructs from valid data", () => {
    const s = new SessionModel(makeSessionData());
    expect(s.session_id).toBe("sess-abc-123");
    expect(s.session_username).toBe("alice");
    expect(s.session_email).toBe("alice@example.com");
  });

  it("throws for missing session_id", () => {
    expect(() => new SessionModel(makeSessionData({ session_id: 42 }))).toThrow(ModelValidationError);
  });

  it("accepts null for all nullable cookie fields", () => {
    const s = new SessionModel(makeSessionData({
      cookie_original_max_age: null,
      cookie_max_age: null,
      cookie_signed: null,
      cookie_expires: null,
      cookie_http_only: null,
      cookie_path: null,
      cookie_domain: null,
      cookie_secure: null,
      cookie_same_site: null,
    }));
    expect(s.cookie_expires).toBeNull();
    expect(s.cookie_signed).toBeNull();
  });
});

describe("SessionModel.toJSON", () => {
  it("includes all session fields", () => {
    const s = new SessionModel(makeSessionData());
    const json = s.toJSON();
    expect(json.session_id).toBe("sess-abc-123");
    expect(json.cookie_path).toBe("/");
    expect(json.cookie_same_site).toBe("lax");
    expect("updated" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MailboxModel
// ---------------------------------------------------------------------------

describe("MailboxModel construction", () => {
  it("constructs from valid data", () => {
    const m = new MailboxModel(makeMailboxData());
    expect(m.mailbox_id).toBe("dddddddd-0000-0000-0000-000000000004");
    expect(m.name).toBe("INBOX");
    expect(m.uid_validity).toBe(1);
    expect(m.uid_next).toBe(42);
    expect(m.subscribed).toBe(true);
    expect(m.special_use).toBe("\\Inbox");
  });

  it("accepts null for optional fields", () => {
    const m = new MailboxModel(makeMailboxData({ address: null, parent_id: null, special_use: null }));
    expect(m.address).toBeNull();
    expect(m.parent_id).toBeNull();
    expect(m.special_use).toBeNull();
  });

  it("throws when uid_validity is a string", () => {
    expect(() => new MailboxModel(makeMailboxData({ uid_validity: "1" }))).toThrow(ModelValidationError);
  });

  it("throws when subscribed is a string", () => {
    expect(() => new MailboxModel(makeMailboxData({ subscribed: "true" }))).toThrow(ModelValidationError);
  });
});

describe("MailboxModel.toJSON", () => {
  it("returns all expected fields", () => {
    const m = new MailboxModel(makeMailboxData());
    const json = m.toJSON();
    expect(json.mailbox_id).toBe(m.mailbox_id);
    expect(json.uid_next).toBe(42);
    expect(json.special_use).toBe("\\Inbox");
  });
});

// ---------------------------------------------------------------------------
// PushSubscriptionModel
// ---------------------------------------------------------------------------

describe("PushSubscriptionModel construction", () => {
  it("constructs from valid data", () => {
    const p = new PushSubscriptionModel(makePushSubData());
    expect(p.push_subscription_id).toBe("eeeeeeee-0000-0000-0000-000000000005");
    expect(p.endpoint).toBe("https://push.example.com/sub/abc123");
    expect(p.keys_p256dh).toBe("BNJz...key==");
    expect(p.keys_auth).toBe("auth==");
    expect(p.last_notified).toBeNull();
  });

  it("accepts a last_notified timestamp string", () => {
    const p = new PushSubscriptionModel(makePushSubData({ last_notified: "2024-06-01T00:00:00+00:00" }));
    expect(p.last_notified).toBe("2024-06-01T00:00:00+00:00");
  });

  it("throws when endpoint is not a string", () => {
    expect(() => new PushSubscriptionModel(makePushSubData({ endpoint: 42 }))).toThrow(ModelValidationError);
  });
});

describe("PushSubscriptionModel.toJSON", () => {
  it("returns all expected fields", () => {
    const p = new PushSubscriptionModel(makePushSubData());
    const json = p.toJSON();
    expect(json.push_subscription_id).toBe(p.push_subscription_id);
    expect(json.endpoint).toBe(p.endpoint);
    expect(json.last_notified).toBeNull();
    expect("updated" in json).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SpamAllowlistModel
// ---------------------------------------------------------------------------

describe("SpamAllowlistModel construction", () => {
  it("constructs from valid data", () => {
    const s = new SpamAllowlistModel(makeSpamAllowlistData());
    expect(s.allowlist_id).toBe("ffffffff-0000-0000-0000-000000000006");
    expect(s.user_id).toBe("cccccccc-0000-0000-0000-000000000003");
    expect(s.pattern).toBe("trusted@example.com");
    expect(s.created_at).toBe("2024-01-01T00:00:00+00:00");
  });

  it("accepts domain wildcard pattern", () => {
    const s = new SpamAllowlistModel(makeSpamAllowlistData({ pattern: "*@trusted.com" }));
    expect(s.pattern).toBe("*@trusted.com");
  });

  it("throws when pattern is not a string", () => {
    expect(() => new SpamAllowlistModel(makeSpamAllowlistData({ pattern: null }))).toThrow(ModelValidationError);
  });

  it("throws when created_at is missing", () => {
    const data = makeSpamAllowlistData();
    delete (data as Record<string, unknown>).created_at;
    expect(() => new SpamAllowlistModel(data)).toThrow(ModelValidationError);
  });
});

describe("SpamAllowlistModel.toJSON", () => {
  it("returns all expected fields", () => {
    const s = new SpamAllowlistModel(makeSpamAllowlistData());
    const json = s.toJSON();
    expect(json.allowlist_id).toBe(s.allowlist_id);
    expect(json.user_id).toBe(s.user_id);
    expect(json.pattern).toBe("trusted@example.com");
    expect(json.created_at).toBe("2024-01-01T00:00:00+00:00");
  });
});

// ---------------------------------------------------------------------------
// Cross-model: abstract Model base behavior
// ---------------------------------------------------------------------------

describe("Model base class", () => {
  it("throws ModelValidationError (not plain Error) on bad data", () => {
    try {
      new MailModel({ mail_id: 1 }); // wrong type
    } catch (e) {
      expect(e).toBeInstanceOf(ModelValidationError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("does not assign fields listed as invalid type (error is thrown before assignment)", () => {
    const bad = makeMailData({ mail_id: 99 });
    let caught: unknown;
    try {
      new MailModel(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ModelValidationError);
  });

  it("Model instance is not a plain object", () => {
    const m = new MailModel(makeMailData());
    expect(typeof m).toBe("object");
    expect(m.constructor).toBe(MailModel);
  });
});

const USER_ID = "11111111-1111-1111-1111-111111111111";
const MAIL_ID = "22222222-2222-2222-2222-222222222222";

const columnsOf = (entries: [string, unknown][]) => entries.map(([c]) => c);

describe("resolveMutationFilters rejects an undefined filter value", () => {
  it("throws rather than dropping the predicate and widening the statement", () => {
    expect(() =>
      resolveMutationFilters("updateWhere", {
        mail_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow(/updateWhere received undefined for mail_id/);
  });

  it("names the calling method so the error points at the right builder", () => {
    expect(() =>
      resolveMutationFilters("deleteWhere", {
        mail_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow(/deleteWhere received undefined for mail_id/);
  });

  it("names every undefined column, not just the first", () => {
    expect(() =>
      resolveMutationFilters("updateWhere", {
        mail_id: undefined,
        message_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow(/mail_id, message_id/);
  });

  it("refuses even when a scoping column survives — the mailbox-wide case", () => {
    // This is the exact shape `markRead(user.id, undefined)` produced.
    expect(() =>
      resolveMutationFilters("updateWhere", {
        mail_id: undefined,
        user_id: USER_ID,
      })
    ).toThrow();
  });

  it("still refuses an entirely empty filter bag", () => {
    expect(() => resolveMutationFilters("updateWhere", {})).toThrow(
      /updateWhere requires at least one filter/
    );
    expect(() => resolveMutationFilters("deleteWhere", {})).toThrow(
      /deleteWhere requires at least one filter/
    );
  });
});

describe("resolveMutationFilters keeps every legitimate filter shape", () => {
  it("returns both predicates for the scoped id + owner case", () => {
    const entries = resolveMutationFilters("updateWhere", {
      mail_id: MAIL_ID,
      user_id: USER_ID,
    });
    expect(columnsOf(entries)).toEqual(["mail_id", "user_id"]);
    expect(entries).toEqual([
      ["mail_id", MAIL_ID],
      ["user_id", USER_ID],
    ]);
  });

  it("keeps the spread idiom working — an absent key is not an undefined key", () => {
    const quarantined = false;
    const entries = resolveMutationFilters("updateWhere", {
      user_id: USER_ID,
      sent: false,
      expunged: false,
      ...(quarantined ? { is_spam: false } : {}),
    });
    expect(columnsOf(entries)).toEqual(["user_id", "sent", "expunged"]);
  });

  it("includes the conditional key when the spread does fire", () => {
    const quarantined = true;
    const entries = resolveMutationFilters("updateWhere", {
      user_id: USER_ID,
      expunged: false,
      ...(quarantined ? { is_spam: false } : {}),
    });
    expect(columnsOf(entries)).toEqual(["user_id", "expunged", "is_spam"]);
  });

  it("rejects a FilterCondition whose value is undefined", () => {
    // Binds NULL and matches nothing rather than widening, but it is still a
    // caller that named a predicate it had no value for.
    expect(() =>
      resolveMutationFilters("updateWhere", {
        mail_id: { op: "=" as const, value: undefined },
        user_id: USER_ID
      })
    ).toThrow(/updateWhere received undefined for mail_id/);
  });

  it("passes FilterCondition objects through untouched (IN-list expunge path)", () => {
    const condition = { op: "IN" as const, value: [MAIL_ID] };
    const entries = resolveMutationFilters("updateWhere", {
      mail_id: condition,
    });
    expect(entries).toEqual([["mail_id", condition]]);
  });

  it("treats false, 0, empty string and null as real predicates, not as missing", () => {
    const entries = resolveMutationFilters("deleteWhere", {
      expunged: false,
      uid_domain: 0,
      subject: "",
      insight: null,
    });
    expect(columnsOf(entries)).toEqual([
      "expunged",
      "uid_domain",
      "subject",
      "insight",
    ]);
  });
});

describe("Table wires both mutation builders through the guard", () => {
  it("updateWhere and deleteWhere both call resolveMutationFilters", async () => {
    // Source-level assertion in the style of `repositories/mails/imap.test.ts`:
    // the guard is only worth anything if neither builder can drift back to a
    // raw `Object.entries(filters).filter(...)`.
    const source = await Bun.file(
      new URL("./base.ts", import.meta.url).pathname
    ).text();
    const updateWhere = source.slice(source.indexOf("async updateWhere("));
    const deleteWhere = source.slice(source.indexOf("async deleteWhere("));

    // Asserted as booleans so a failure prints a one-line diff, not the file.
    expect(
      updateWhere.includes('resolveMutationFilters("updateWhere", filters)')
    ).toBe(true);
    expect(
      deleteWhere.includes('resolveMutationFilters("deleteWhere", filters)')
    ).toBe(true);
    // The data bag legitimately still drops undefined — only filters are strict.
    expect(
      source.includes(
        "Object.entries(filters).filter(([, v]) => v !== undefined)"
      )
    ).toBe(false);
  });
});
