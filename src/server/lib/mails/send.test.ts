import { describe, it, expect, beforeAll } from "bun:test";
import {
  addressField,
  envelopeRecipients,
  parseAddressList,
  sentMessageId
} from "./send";

describe("parseAddressList — case normalization (#573)", () => {
  it("lowercases a single address", () => {
    expect(parseAddressList("Hoie@Hoie.Kim")).toEqual([
      { address: "hoie@hoie.kim" }
    ]);
  });

  it("splits, trims, and lowercases a comma-separated list", () => {
    expect(parseAddressList("Alice@X.com,  Bob@Y.COM ")).toEqual([
      { address: "alice@x.com" },
      { address: "bob@y.com" }
    ]);
  });

  it("drops empty entries", () => {
    expect(parseAddressList("a@x.com,, , b@x.com")).toEqual([
      { address: "a@x.com" },
      { address: "b@x.com" }
    ]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("addressField — stored recipient fields", () => {
  it("builds a value/text pair from a populated list", () => {
    expect(addressField("Alice@X.com, bob@y.com")).toEqual({
      value: [{ address: "alice@x.com" }, { address: "bob@y.com" }],
      text: "Alice@X.com, bob@y.com"
    });
  });

  it("returns undefined for an empty list so the column stays NULL", () => {
    expect(addressField("")).toBeUndefined();
    expect(addressField(undefined)).toBeUndefined();
  });
});

describe("envelopeRecipients — stored envelope_to union", () => {
  it("unions the three recipient fields", () => {
    expect(envelopeRecipients("a@x.com", "b@y.com", "c@z.com")).toEqual([
      { address: "a@x.com" },
      { address: "b@y.com" },
      { address: "c@z.com" }
    ]);
  });

  it("keeps a bcc-only submission's recipients", () => {
    expect(envelopeRecipients("", undefined, "hidden@z.com")).toEqual([
      { address: "hidden@z.com" }
    ]);
  });

  it("keeps a cc when the submission has no addressee", () => {
    expect(envelopeRecipients("", "seen@y.com", undefined)).toEqual([
      { address: "seen@y.com" }
    ]);
  });

  it("skips absent fields without leaving empty entries", () => {
    expect(envelopeRecipients("a@x.com", undefined, undefined)).toEqual([
      { address: "a@x.com" }
    ]);
  });
});

describe("getSentMail — fields unreachable without the DB", () => {
  // getSentMail builds the *stored* Mail (delivery uses the raw mailToSend via
  // sendMailgunMail). It hits the DB for UID allocation, so these fields are
  // pinned by source inspection rather than a live call.
  let fnSource: string;

  beforeAll(async () => {
    const fs = await import("fs/promises");
    const path = await import("path");
    const source = await fs.readFile(
      path.join(import.meta.dir, "send.ts"),
      "utf8"
    );
    const match = source.match(/const getSentMail[\s\S]*?\n};/);
    if (!match) throw new Error("getSentMail not found in send.ts");
    fnSource = match[0];
  });

  // A mixed-case sender must not fragment the Sent account list.
  it("lowercases the constructed from email", () => {
    expect(fnSource).toMatch(
      /fromEmail\s*=\s*`\$\{sender\}@\$\{userDomain\}`\.toLowerCase\(\);\n/
    );
  });

  // A bcc-only send names nobody in `To:`, so a to-only envelope list would
  // store no recipients at all.
  it("builds the envelope recipient list from all three fields", () => {
    expect(fnSource).toMatch(
      /envelopeTo:\s*envelopeRecipients\(to,\s*cc,\s*bcc\),\n/
    );
  });
});

describe("sentMessageId — the Sent copy's Message-ID", () => {
  it("keeps a Mailgun id that already names a domain as the recipients saw it", () => {
    expect(sentMessageId("<20260328063118.abc@mail.test>", "u.mail.test")).toBe(
      "<20260328063118.abc@mail.test>"
    );
  });

  it("brackets an unbracketed id that names a domain", () => {
    expect(sentMessageId(" abc@mail.test ", "u.mail.test")).toBe(
      "<abc@mail.test>"
    );
  });

  it("puts a bare token on the user's domain", () => {
    expect(sentMessageId("bare-id", "u.mail.test")).toBe(
      "<bare-id@u.mail.test>"
    );
    expect(sentMessageId("<bare-id>", "u.mail.test")).toBe(
      "<bare-id@u.mail.test>"
    );
  });

  it("mints a UUID on the user's domain when there is no id", () => {
    const uuidOnDomain =
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@u\.mail\.test>$/;
    for (const missing of [undefined, "", "  "]) {
      expect(sentMessageId(missing, "u.mail.test")).toMatch(uuidOnDomain);
    }
  });
});
