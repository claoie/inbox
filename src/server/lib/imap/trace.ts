import { logger } from "server";

const TRACE_ON = process.env.IMAP_TRACE === "1";
const LINE_CAP = 512;

// Inbound allow-shape. Requiring `<tag> <VERB>` at the start keeps every
// non-command line (junk, empty, anything a future path forgets to frame) out
// of the journal.
const INBOUND_COMMAND = /^[A-Za-z0-9]+\s+[A-Z]+\b/;

// LOGIN carries the plaintext password as the last quoted arg; AUTHENTICATE
// carries the SASL initial response (RFC 4959) — base64-decoded, PLAIN yields
// `\0user\0password`. Both must be scrubbed before the line lands in the
// journal, whether it gets there via the wire trace or via a debug/parse-error
// log in the handler.
export const redactCredentials = (line: string): string =>
  line
    // The tag is optional in the anchor. A conforming client always sends one,
    // but an untagged `LOGIN admin hunter2` still reaches the parse-failure log
    // — and a redactor that only covers well-formed input is not a redactor.
    // Leading whitespace is skipped for the same reason: `executeCommand`
    // redacts the raw assembled input, which is not pre-trimmed, so a malformed
    // ` LOGIN admin hunter2` would otherwise walk straight past both anchors.
    // `[\s\S]*` rather than `.*` so a payload sitting after a CRLF is covered.
    .replace(/^(\s*(?:\S+\s+)?LOGIN\s+)[\s\S]*$/i, "$1[REDACTED]")
    .replace(/^(\s*(?:\S+\s+)?AUTHENTICATE\s+\S+)\s+[\s\S]*$/i, "$1 [REDACTED]");

// Outbound allowlist. The plain `write()` path also carries FETCH response
// atoms — HEADER.FIELDS literal payload, ENVELOPE strings, BODY[HEADER] data —
// which contain real mail headers (Subject/From/To/Message-ID). Tracing every
// outbound write() would spill that into the journal on any FETCH burst.
//
// This regex keeps only IMAP framing and status lines the diagnostic actually
// needs — tag completions (OK/NO/BAD), untagged server status (`* OK …`,
// `* CAPABILITY`, `* BYE`), sequence updates without a data tuple (EXISTS /
// RECENT / EXPUNGE), and the `+` continuation prompt. Anything else outbound
// is dropped silently.
const OUTBOUND_FRAMING = new RegExp(
  [
    /^\+ /.source, // continuation ("+ go ahead", "+ idling")
    /^\* (?:OK|BAD|NO|BYE|CAPABILITY|ENABLED|PREAUTH)\b/.source,
    /^\* \d+ (?:EXISTS|RECENT|EXPUNGE)\s*$/.source,
    /^[A-Za-z0-9]+ (?:OK|BAD|NO) /.source,
  ].join("|")
);

// Measured in octets, not UTF-16 code units. The wire is decoded with
// `toString("utf8")`, so every octet that is not valid UTF-8 arrives as one
// U+FFFD and leaves as three octets again — a code-unit count lets a line this
// cap names at LINE_CAP reach three times that, on the wire as well as in the
// journal. Sliced on a code point so a surrogate pair is not split.
export const clip = (s: string): string => {
  const octets = Buffer.byteLength(s);
  if (octets <= LINE_CAP) return s;

  let kept = "";
  let keptOctets = 0;
  for (const codePoint of s) {
    const size = Buffer.byteLength(codePoint);
    if (keptOctets + size > LINE_CAP) break;
    kept += codePoint;
    keptOctets += size;
  }
  return `${kept}…[+${octets - keptOctets}]`;
};

export const imapTrace = (
  direction: "in" | "out",
  sessionId: string,
  data: string
): void => {
  if (!TRACE_ON) return;
  for (const raw of data.split("\r\n")) {
    if (!raw) continue;
    if (direction === "in" && !INBOUND_COMMAND.test(raw)) continue;
    if (direction === "out" && !OUTBOUND_FRAMING.test(raw)) continue;
    const sanitized = direction === "in" ? redactCredentials(raw) : raw;
    logger.info(`IMAP wire ${direction}`, {
      component: "imap.trace",
      sessionId,
      line: clip(sanitized),
    });
  }
};

if (TRACE_ON) {
  logger.info("IMAP wire trace ENABLED via IMAP_TRACE=1", {
    component: "imap.trace",
  });
}
