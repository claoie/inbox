import { describe, it, expect } from "bun:test";
import { ReplyData } from "common";
import {
  EMPTY_ORIGINAL_META,
  wrapQuoteHtml,
  replyDataToOriginalMessage,
  getReplyContainerHtml,
  signatureHtml
} from "./lib";

describe("signatureHtml", () => {
  it("is empty for a blank signature", () => {
    expect(signatureHtml("")).toBe("");
    expect(signatureHtml("  \n ")).toBe("");
  });

  it("escapes markup and keeps each line", () => {
    expect(signatureHtml('Maple <maple@example.com>\r\n"A & B"')).toBe(
      "<p>Maple &lt;maple@example.com&gt;<br>&quot;A &amp; B&quot;</p>"
    );
  });
});

describe("wrapQuoteHtml", () => {
  it("wraps content in the quote blockquote", () => {
    const out = wrapQuoteHtml("<p>hi</p>");
    expect(out.startsWith("<blockquote")).toBe(true);
    expect(out).toContain("<p>hi</p>");
    expect(out.endsWith("</blockquote>")).toBe(true);
  });

  it("produces an empty blockquote for empty / falsy html", () => {
    expect(wrapQuoteHtml("")).toContain("></blockquote>");
    // undefined coerces to an empty body, not the string "undefined"
    expect(wrapQuoteHtml(undefined as unknown as string)).not.toContain("undefined");
  });
});

describe("replyDataToOriginalMessage", () => {
  it("returns an all-empty message when replyData is empty or has no id", () => {
    for (const rd of [{} as ReplyData, { messageId: "m" } as ReplyData]) {
      const out = replyDataToOriginalMessage(rd);
      expect(out).toEqual({
        id: "",
        messageId: "",
        subject: "",
        prefix: "",
        html: ""
      });
    }
  });

  it("passes the id / messageId / subject through and wraps the html", () => {
    const rd: ReplyData = {
      id: "mail-1",
      messageId: "<abc@host>",
      date: "2026-01-02T03:04:05.000Z",
      subject: "Hello",
      from: { text: "Alice <alice@x.com>" } as ReplyData["from"],
      html: "<p>body</p>"
    };
    const out = replyDataToOriginalMessage(rd);
    expect(out.id).toBe("mail-1");
    expect(out.messageId).toBe("<abc@host>");
    expect(out.subject).toBe("Hello");
    expect(out.html.startsWith("<blockquote")).toBe(true);
    expect(out.html).toContain("<p>body</p>");
  });

  it("formats the attribution prefix and falls back to Unknown sender", () => {
    const withFrom = replyDataToOriginalMessage({
      id: "x",
      messageId: "<m>",
      date: "2026-01-02T03:04:05.000Z",
      from: { text: "Bob" } as ReplyData["from"]
    } as ReplyData);
    expect(withFrom.prefix.startsWith("On ")).toBe(true);
    expect(withFrom.prefix).toContain(" at ");
    expect(withFrom.prefix.endsWith("Bob wrote:")).toBe(true);

    const noFrom = replyDataToOriginalMessage({
      id: "x",
      messageId: "<m>",
      date: "2026-01-02T03:04:05.000Z"
    } as ReplyData);
    expect(noFrom.prefix.endsWith("Unknown wrote:")).toBe(true);
  });
});

describe("getReplyContainerHtml", () => {
  it("wraps the prefix paragraph and the quoted html in the details container", () => {
    const out = getReplyContainerHtml({
      id: "x",
      messageId: "<m>",
      subject: "s",
      prefix: "On day, Bob wrote:",
      html: "<blockquote>q</blockquote>"
    });
    expect(out.startsWith('<div class="replace_with_details">')).toBe(true);
    expect(out).toContain("<p>On day, Bob wrote:</p>");
    expect(out).toContain("<blockquote>q</blockquote>");
    expect(out.endsWith("</div>")).toBe(true);
  });

  it("escapes the first < and > in the prefix", () => {
    const out = getReplyContainerHtml({
      ...EMPTY_ORIGINAL_META,
      prefix: "On day, <mailer> wrote:",
      html: ""
    });
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
  });
});
