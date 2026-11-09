/**
 * Whether the compose form currently holds a draft — the fields, the editor
 * content, or a quoted original. Read by the rail Compose button's dot
 * (design doc §7) and driven by the Writer, which owns the fields.
 */
export interface DraftFields {
  name: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  sender: string;
  /** The editor's HTML (`initialContent`). */
  initialContent: string;
  /**
   * Whether the draft answers or forwards another message, quoted or not:
   * it carries that message's id for threading even when no quote shows.
   */
  isReply: boolean;
  /**
   * Values the program pre-filled for From (the selected mailbox, or the
   * default From when none is selected).
   * A name/sender that still equals its pre-filled value is not user
   * input, so opening a fresh compose leaves the draft dot off.
   */
  prefilledName?: string;
  prefilledSender?: string;
}

/** Whether editor HTML holds visible text — an empty document is `<p></p>`. */
export const editorHtmlHasText = (html: string): boolean => {
  const text = html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
  return text.length > 0;
};

/** Whether a field holds user input — non-blank, and not just the pre-fill. */
const hasUserInput = (value: string, prefilled?: string): boolean =>
  value.trim().length > 0 && value !== prefilled;

export const hasDraftFields = (fields: DraftFields): boolean =>
  fields.isReply ||
  hasUserInput(fields.name, fields.prefilledName) ||
  hasUserInput(fields.sender, fields.prefilledSender) ||
  [fields.to, fields.cc, fields.bcc, fields.subject].some(
    (v) => v.trim().length > 0
  ) ||
  editorHtmlHasText(fields.initialContent);
