import { describe, it, expect } from "bun:test";
import { editorHtmlHasText, hasDraftFields, type DraftFields } from "./draft";

const empty: DraftFields = {
  name: "",
  to: "",
  cc: "",
  bcc: "",
  subject: "",
  sender: "",
  initialContent: "",
  isReply: false
};

describe("editorHtmlHasText", () => {
  it("treats an empty document as empty", () => {
    expect(editorHtmlHasText("")).toBe(false);
    expect(editorHtmlHasText("<p></p>")).toBe(false);
    expect(editorHtmlHasText("<p>&nbsp;</p>")).toBe(false);
    expect(editorHtmlHasText("<p>   </p>")).toBe(false);
  });

  it("treats visible text as content", () => {
    expect(editorHtmlHasText("<p>hi</p>")).toBe(true);
    expect(editorHtmlHasText("<p>hi</p><p></p>")).toBe(true);
  });
});

describe("hasDraftFields", () => {
  it("is false for a blank form", () => {
    expect(hasDraftFields(empty)).toBe(false);
  });

  it("is true when any field holds text", () => {
    for (const key of ["name", "to", "cc", "bcc", "subject", "sender"] as const) {
      expect(hasDraftFields({ ...empty, [key]: "x" })).toBe(true);
    }
    expect(hasDraftFields({ ...empty, to: "   " })).toBe(false);
  });

  it("is true when the editor holds text, false for an empty document", () => {
    expect(hasDraftFields({ ...empty, initialContent: "<p>hi</p>" })).toBe(true);
    expect(hasDraftFields({ ...empty, initialContent: "<p></p>" })).toBe(false);
  });

  it("is true for a reply or forward, even with empty fields", () => {
    expect(hasDraftFields({ ...empty, isReply: true })).toBe(true);
  });

  it("ignores name/sender that still equal the pre-filled values", () => {
    expect(
      hasDraftFields({
        ...empty,
        name: "maple",
        sender: "maple",
        prefilledName: "maple",
        prefilledSender: "maple"
      })
    ).toBe(false);
  });

  it("counts a name/sender the user changed away from the pre-fill", () => {
    expect(
      hasDraftFields({
        ...empty,
        name: "Fern",
        prefilledName: "maple",
        prefilledSender: "maple"
      })
    ).toBe(true);
    expect(
      hasDraftFields({
        ...empty,
        sender: "fern",
        prefilledName: "maple",
        prefilledSender: "maple"
      })
    ).toBe(true);
  });

  it("counts other typed fields alongside the pre-fill", () => {
    expect(
      hasDraftFields({
        ...empty,
        name: "maple",
        sender: "maple",
        to: "bob@example.com",
        prefilledName: "maple",
        prefilledSender: "maple"
      })
    ).toBe(true);
  });
});
