/**
 * FETCH response building helpers.
 *
 * Pure/near-pure functions that construct IMAP FETCH response parts.
 * These need session context (selectedMailbox, write fn) passed as parameters.
 */

import { MailType } from "common";
import { logger } from "server";
import {
  formatBodyStructure,
  formatEnvelope,
  formatFlags,
  formatHeaders,
  formatInternalDate,
  isDomainScoped,
} from "./util";
import {
  applyPartialFetch,
  buildMessageSegments,
  computeFullMessageSize,
  streamFromSegments,
  streamPartialFromSegments,
  streamBodyFromSegments,
  streamPartBodyFromSegments,
  selectBodySegments,
  selectPartBodySegments,
  sumSegmentBytes,
  sumBodyBytes,
  sumPartBodyBytes,
  MessageSegment,
  WIRE_TRAILER,
  getBodyPartHeaders,
  getBodySectionKey,
} from "./session-utils";
import {
  BodyFetch,
  BodySection,
  FetchDataItem,
} from "./types";
import { withBodyBudgetStream } from "./body-budget";
import { withStreamMutex } from "./stream-mutex";
import { withYieldedCommandBudget } from "./command-budget-hold";
import { updateRfc822Size } from "../postgres/repositories/mails/core";
// Only the stream form of the budget is used now: every body-bearing
// section streams, and the sections that still materialize (header-like)
// are a few KiB each — gating those would queue them behind multi-MB
// streams for no memory benefit.

// ---------------------------------------------------------------------------
// FetchResponsePart types (local to the fetch subsystem)
// ---------------------------------------------------------------------------

export type FetchResponsePart =
  | { type: "simple"; content: string }
  | { type: "literal"; content: string | Buffer; header: string; length: number }
  | {
      type: "stream";
      stream: AsyncIterable<Buffer>;
      header: string;
      length: number;
    };

// ---------------------------------------------------------------------------
// Body content extraction
// ---------------------------------------------------------------------------

/**
 * The materialized content of a HEADER-LIKE body section — `BODY[HEADER]`,
 * `BODY[HEADER.FIELDS ...]`, and a MIME part's `.HEADER` / `.MIME`. Each
 * returns a few hundred bytes of header text and includes its own delimiting
 * blank line (see `isHeaderLikeSection`).
 *
 * Deliberately NOT a general body reader. Every body-bearing section (FULL,
 * TEXT, bare/`.TEXT` MIME_PART — partial and non-partial alike) is served by
 * the segment-walk streaming path in `buildBodyResponsePart` and returns
 * before reaching the call site here, so a body branch on this function
 * would be dead code that also reintroduces the O(body-length) allocation
 * this path exists to avoid — and would throw outright on the lazy row shape
 * `getMailsByRange` now projects, since there is no materialized `text` /
 * `html` to read.
 */
export function getBodyContent(
  mail: FetchMailInput,
  section: BodySection,
  docId: string
): string | null {
  switch (section.type) {
    case "HEADER":
      // RFC 3501 §6.4.5: a HEADER fetch includes the RFC-2822 delimiting blank
      // line between the header block and the body. `formatHeaders` joins the
      // header lines with `\r\n` and adds no trailing CRLF, so the first `\r\n`
      // terminates the last header line and the second is the delimiting blank
      // line.
      return formatHeaders(mail, docId) + "\r\n\r\n";

    case "HEADER_FIELDS": {
      const allHeaders = formatHeaders(mail, docId);
      const requestedFields = section.fields.map((f: string) => f.toUpperCase());
      const lines = allHeaders.split("\r\n");
      const filtered: string[] = [];
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line === "") break;
        if (line.match(/^[ \t]/) && filtered.length > 0) {
          filtered[filtered.length - 1] += "\r\n" + line;
          i++;
          continue;
        }
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const fieldName = line.substring(0, colonIdx).toUpperCase();
          const include = section.not
            ? !requestedFields.includes(fieldName)
            : requestedFields.includes(fieldName);
          if (include) {
            filtered.push(line);
          }
        }
        i++;
      }
      return filtered.length > 0
        ? filtered.join("\r\n") + "\r\n\r\n"
        : "\r\n";
    }

    case "MIME_PART":
      // RFC 3501 §6.4.5: `.HEADER`/`.MIME` return the part's MIME header
      // fields. `.TEXT` and a bare part number return the part BODY, which
      // streams via `selectPartBodySegments` in `buildBodyResponsePart` and
      // never arrives here.
      if (section.subSection === "HEADER" || section.subSection === "MIME") {
        const headers = getBodyPartHeaders(mail, section.partNumber);
        return headers === null ? null : headers + "\r\n\r\n";
      }
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Requested fields
// ---------------------------------------------------------------------------

/**
 * Union of `MailType`'s materialized field names and the four synthetic
 * streaming fields (`text_octets` / `html_octets` / `mail_id` / `user_id`)
 * the BODY[FULL] / RFC822 path adds to drive the pg SUBSTRING body stream.
 * Widening the set type to include these keeps the strings out of Node's
 * heap for large mails while still passing through the store's field-
 * mapping layer unchanged (unknown fields flow through as-is).
 */
export type FetchRequestedField =
  | keyof MailType
  | "text_octets"
  | "html_octets"
  | "mail_id"
  | "user_id";

export function getRequestedFields(dataItems: FetchDataItem[]): Set<FetchRequestedField> {
  const fields = new Set<FetchRequestedField>(["uid"]);

  for (const item of dataItems) {
    switch (item.type) {
      case "ENVELOPE":
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("replyTo");
        fields.add("date");
        fields.add("messageId");
        break;

      case "FLAGS":
        fields.add("read");
        fields.add("saved");
        fields.add("deleted");
        fields.add("draft");
        fields.add("answered");
        break;

      // BODYSTRUCTURE (RFC 3501 §7.4.2) needs `body-fld-octets` for each
      // text/html part. Project the pre-measured `octet_length()` synthetics
      // rather than the multi-MB text/html columns, which would materialize
      // every body on a bare `UID FETCH X BODYSTRUCTURE` batch.
      case "BODYSTRUCTURE":
        fields.add("text_octets");
        fields.add("html_octets");
        fields.add("attachments");
        break;

      case "BODY":
        addBodyFields(item, fields);
        break;

      case "INTERNALDATE":
        fields.add("date");
        break;

      case "RFC822.SIZE":
        addBodyFields({ type: "BODY", peek: true, section: { type: "FULL" } }, fields);
        fields.add("rfc822_size" as keyof MailType);
        break;

      // RFC822* alias the matching BODY[...] sections (§6.4.5); request the
      // same columns those variants do.
      case "RFC822":
        addBodyFields({ type: "BODY", peek: false, section: { type: "FULL" } }, fields);
        break;

      case "RFC822.HEADER":
        addBodyFields({ type: "BODY", peek: true, section: { type: "HEADER" } }, fields);
        break;

      case "RFC822.TEXT":
        addBodyFields({ type: "BODY", peek: false, section: { type: "TEXT" } }, fields);
        break;
    }
  }

  return fields;
}

export function addBodyFields(
  bodyFetch: BodyFetch,
  fields: Set<FetchRequestedField>
): void {
  switch (bodyFetch.section.type) {
    case "FULL":
      // Both full and partial FULL BODY[] fetches route through the
      // segment-walk streamer (`streamFromSegments` / `streamPartialFromSegments`).
      // The lazy synthetics (`text_octets` / `html_octets` / `mail_id` /
      // `user_id`) let the emitter pull the text/html columns via
      // chunked pg SUBSTRING at emit time instead of materializing the
      // strings up front — peak stays O(chunk) for both variants.
      fields.add("text_octets");
      fields.add("html_octets");
      fields.add("mail_id");
      fields.add("user_id");
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
      fields.add("date");
      fields.add("messageId");
      fields.add("attachments");
      break;

    case "TEXT":
      // BODY[TEXT] — partial AND non-partial now take the segment-walk
      // streaming path (`streamBodyFromSegments` / `streamPartialSubset`
      // over `selectBodySegments`), so neither needs the materialized
      // strings. Projecting only the lazy synthetics keeps
      // `wantsLazyBodies` true, which makes `buildMessageSegments` emit
      // `lazy-text` segments — the text/html columns are read in chunked
      // pg SUBSTRING at emit time instead of being pulled into V8's heap
      // for the fetch's duration. Peak per TEXT fetch drops from
      // O(sizeof(text) + sizeof(html)) to O(chunk), matching FULL.
      fields.add("text_octets");
      fields.add("html_octets");
      fields.add("mail_id");
      fields.add("user_id");
      fields.add("attachments");
      // Header context needed for `formatHeaders` (which
      // `buildMessageSegments` calls to emit the multipart boundary +
      // Content-Type declaration inside the body content).
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
      fields.add("date");
      fields.add("messageId");
      break;

    case "HEADER":
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
      fields.add("date");
      fields.add("messageId");
      break;

    case "HEADER_FIELDS": {
      const headerFieldMap: Record<string, (keyof MailType)[]> = {
        "FROM": ["from"],
        "TO": ["to"],
        "CC": ["cc"],
        "BCC": ["bcc"],
        "REPLY-TO": ["replyTo"],
        "SUBJECT": ["subject"],
        "DATE": ["date"],
        "MESSAGE-ID": ["messageId"],
      };
      const requested = bodyFetch.section.fields ?? [];
      if (bodyFetch.section.not) {
        fields.add("subject");
        fields.add("from");
        fields.add("to");
        fields.add("cc");
        fields.add("bcc");
        fields.add("replyTo");
        fields.add("date");
        fields.add("messageId");
      } else {
        for (const f of requested) {
          const mapped = headerFieldMap[f.toUpperCase()];
          if (mapped) mapped.forEach((k) => fields.add(k));
        }
      }
      break;
    }

    case "MIME_PART":
      fields.add("text_octets");
      fields.add("html_octets");
      fields.add("mail_id");
      fields.add("user_id");
      fields.add("attachments");
      fields.add("subject");
      fields.add("from");
      fields.add("to");
      fields.add("cc");
      fields.add("bcc");
      fields.add("replyTo");
      fields.add("date");
      fields.add("messageId");
      break;
  }
}

// ---------------------------------------------------------------------------
// convertSequenceSet
// ---------------------------------------------------------------------------

export function convertSequenceSet(
  sequenceSet: import("./types").SequenceSet
): { start: number; end: number }[] {
  // RFC 3501 §9: a seq/UID range is order-independent — `3:1` ≡ `1:3`. The
  // wildcard `*` is already expanded to MAX_SAFE_INTEGER by the parser, so
  // normalizing min/max here (the single resolution point shared by FETCH and
  // STORE) covers descending ranges like `3:1`, `5:1`, and `*:1` without the
  // empty `uid >= 3 AND uid <= 1` predicate they would otherwise produce.
  return sequenceSet.ranges.map(({ start, end = start }) => ({
    start: Math.min(start, end),
    end: Math.max(start, end),
  }));
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

// Sections whose `getBodyContent` output already ends in its own delimiting
// blank line, so the builder must not append another trailing CRLF. Covers
// HEADER, HEADER.FIELDS, and a MIME part's `.HEADER`/`.MIME` sub-section.
function isHeaderLikeSection(section: BodySection): boolean {
  return (
    section.type === "HEADER" ||
    section.type === "HEADER_FIELDS" ||
    (section.type === "MIME_PART" &&
      (section.subSection === "HEADER" || section.subSection === "MIME"))
  );
}

/**
 * `BODY[<section>]<start.length>` over an already-selected segment subset.
 *
 * The FULL branch has its own copy of this clamp because it subtracts
 * `WIRE_TRAILER` from a trailer-inclusive total; TEXT and MIME_PART measure
 * their subsets with `sumBodyBytes` / `sumPartBodyBytes`, which are already
 * trailer-free, so `addressableBytes` arrives correct and both share this.
 *
 * RFC 3501 §6.4.5: `start` past the end is a vacuous range — emit NIL rather
 * than a zero-octet literal. Otherwise clamp `length` to what is actually
 * available so the `{N}` literal advertises the true emitted count.
 *
 * Load-bearing: `segments` must be the SAME subset `addressableBytes` was
 * summed over. `streamPartialFromSegments` walks cumulative byte offsets, so
 * clamping against a different subset than the walk would desync the wire.
 */
function streamPartialSubset(
  segments: MessageSegment[],
  addressableBytes: number,
  partial: { start: number; length: number },
  sectionKey: string,
  streamKey: string
): FetchResponsePart {
  const { start, length: requestedLength } = partial;
  if (start >= addressableBytes) {
    return { type: "simple", content: `${sectionKey} NIL` };
  }
  const emittedLength = Math.min(requestedLength, addressableBytes - start);
  const stream = withYieldedCommandBudget(() =>
    withStreamMutex(streamKey, () =>
      withBodyBudgetStream(async function* () {
        yield* streamPartialFromSegments(segments, start, emittedLength);
      })
    )
  );
  // Origin-octet header form is `BODY[<section>]<start>` per §7.4.2
  // msg-att-static — no length echo; the `{N}` literal carries the count.
  return {
    type: "stream",
    stream,
    header: `${sectionKey}<${start}>`,
    length: emittedLength,
  };
}

export async function buildBodyResponsePart(
  mail: Partial<MailType>,
  bodyFetch: BodyFetch,
  docId: string,
  selectedMailbox: string,
  keyOverride?: string
): Promise<FetchResponsePart | null> {
  void selectedMailbox; // reserved for future per-mailbox logic
  const { section, partial } = bodyFetch;

  // RFC822 / RFC822.HEADER / RFC822.TEXT reuse the BODY[...] builders but must
  // label the response part with the item the client requested.
  const sectionKey = keyOverride ?? getBodySectionKey(section);

  if (!isHeaderLikeSection(section) && section.type === "FULL") {
    const segments = buildMessageSegments(mail, docId);
    // `sumSegmentBytes` includes the 2-byte wire trailer (`\r\n`) that the
    // non-partial FULL branch appends after streaming the segments. RFC
    // 3501 §6.4.5 partial fetches address bytes of the RFC 2822
    // serialization only — the wire trailer is IMAP framing, not part of
    // the message. Using the trailer-inclusive total for the partial
    // range would let `<0.total>` (or any range that reaches the end)
    // advertise 2 more bytes than `streamPartialFromSegments` actually
    // emits — a wire desync where the next tagged response's leading
    // bytes get consumed as body.
    const totalBodyLength = sumSegmentBytes(segments);
    const partialAddressableBytes = totalBodyLength - WIRE_TRAILER;
    // Acquire the per-key mutex OUTSIDE the byte-budget so a queued
    // same-key waiter doesn't pin a byte-slot while it waits. When it
    // owns the key, it then acquires the byte budget for its stream.
    const streamKey = `${docId}::${sectionKey}`;
    if (partial) {
      // RFC 3501 §6.4.5: `BODY[]<start.length>` returns bytes
      // [start, start+length) of the RFC 2822 serialization. When
      // `start >= partialAddressableBytes` return NIL — the octet range is
      // vacuous. Otherwise clamp `length` to what's actually available
      // so the `{N}` literal advertises the true emitted count.
      const { start, length: requestedLength } = partial;
      if (start >= partialAddressableBytes) {
        return { type: "simple", content: `${sectionKey} NIL` };
      }
      const emittedLength = Math.min(
        requestedLength,
        partialAddressableBytes - start
      );
      const partialStream = withYieldedCommandBudget(() =>
        withStreamMutex(streamKey, () =>
          withBodyBudgetStream(async function* () {
            yield* streamPartialFromSegments(segments, start, emittedLength);
          })
        )
      );
      // The origin-octet header form is `BODY[<section>]<start>` per
      // §7.4.2 msg-att-static — no length echo; the `{N}` literal
      // already carries the count.
      return {
        type: "stream",
        stream: partialStream,
        header: `${sectionKey}<${start}>`,
        length: emittedLength,
      };
    }
    const stream = withYieldedCommandBudget(() =>
      withStreamMutex(streamKey, () =>
        withBodyBudgetStream(async function* () {
          yield* streamFromSegments(segments);
          yield Buffer.from("\r\n", "utf8");
        })
      )
    );
    return {
      type: "stream",
      stream,
      header: sectionKey,
      length: totalBodyLength,
    };
  }

  if (!isHeaderLikeSection(section) && section.type === "TEXT") {
    // BODY[TEXT] — RFC 3501 §6.4.5 "text body of the message, omitting
    // the header." Streamed by walking the segments and skipping the
    // top-level header literal, then appending the same one-CRLF wire
    // trailer the pre-cache-deletion path did (`raw + "\r\n"`). Both
    // sides are chunk-bounded: `emitBase64` on output, `lazy-text`
    // segments on input (`addBodyFields` projects the synthetics only,
    // so `wantsLazyBodies` holds). Peak per TEXT fetch is O(chunk),
    // same as FULL.
    //
    // `<start.length>` addresses the TEXT section's own octets, which is
    // exactly `bodyBytes` — the one-CRLF wire trailer below is IMAP
    // framing appended after the section, not part of it, so the partial
    // range must NOT include it (same reasoning as the FULL branch's
    // `totalBodyLength - WIRE_TRAILER`).
    const segments = buildMessageSegments(mail, docId);
    const bodyBytes = sumBodyBytes(segments);
    if (bodyBytes === 0) {
      return { type: "simple", content: `${sectionKey} NIL` };
    }
    const streamKey = `${docId}::${sectionKey}`;
    if (partial) {
      return streamPartialSubset(
        selectBodySegments(segments),
        bodyBytes,
        partial,
        sectionKey,
        streamKey
      );
    }
    const stream = withYieldedCommandBudget(() =>
      withStreamMutex(streamKey, () =>
        withBodyBudgetStream(async function* () {
          yield* streamBodyFromSegments(segments);
          yield Buffer.from("\r\n", "utf8");
        })
      )
    );
    return {
      type: "stream",
      stream,
      header: sectionKey,
      length: bodyBytes + WIRE_TRAILER,
    };
  }

  if (!isHeaderLikeSection(section) && section.type === "MIME_PART") {
    // BODY[<part>] — RFC 3501 §6.4.5. `.HEADER` / `.MIME` return the
    // part's MIME header block (materialized, cheap — see the
    // header-like fallthrough below via `getBodyContent`). Bare number
    // and `.TEXT` both return the part's body base64-encoded; in this
    // codebase's synthetic-part scheme (see `getBodyPart`) they
    // resolve identically. Streamed via the same segment walker,
    // filtered to the requested partPath.
    const subSection = section.subSection;
    if (subSection === "HEADER" || subSection === "MIME") {
      // Fall through to the materialized path below — the part MIME
      // header block is small and cheap.
    } else {
      const partPath = section.partNumber;
      const segments = buildMessageSegments(mail, docId);
      const partBytes = sumPartBodyBytes(segments, partPath);
      if (partBytes === 0) {
        // `buildMessageSegments` only pushes a body segment when the
        // source has non-empty content (`hasText`/`hasHtml`/attachment
        // count > 0), so `partBytes === 0` means the requested part
        // doesn't exist in this mail's structure — matches the old
        // `getBodyPart(...) === null` → `kind: "omit"` → return null
        // behavior. Empty-body-of-existing-part is unreachable here.
        return null;
      }
      const streamKey = `${docId}::${sectionKey}`;
      if (partial) {
        return streamPartialSubset(
          selectPartBodySegments(segments, partPath),
          partBytes,
          partial,
          sectionKey,
          streamKey
        );
      }
      const stream = withYieldedCommandBudget(() =>
        withStreamMutex(streamKey, () =>
          withBodyBudgetStream(async function* () {
            yield* streamPartBodyFromSegments(segments, partPath);
            yield Buffer.from("\r\n", "utf8");
          })
        )
      );
      return {
        type: "stream",
        stream,
        header: sectionKey,
        length: partBytes + WIRE_TRAILER,
      };
    }
  }

  // Only header-like sections reach here now: `BODY[HEADER]`,
  // `BODY[HEADER.FIELDS ...]`, and a MIME part's `.HEADER` / `.MIME`.
  // Every body-bearing section (FULL, TEXT, bare/`.TEXT` MIME_PART) is
  // handled above, partial included, so no path below materializes a
  // body and the body budget no longer has anything to protect here —
  // gating a header block behind it would just queue a few-KiB response
  // behind multi-MB streams.
  const content = getBodyContent(mail, section, docId);
  if (content === null) {
    return null;
  }

  let header = sectionKey;
  let finalContent = content;
  let length = Buffer.byteLength(finalContent, "utf8");

  if (finalContent === "" || (partial && partial.start >= length)) {
    return { type: "simple", content: `${sectionKey} NIL` };
  }

  if (partial) {
    const { start, length: partialLength } = partial;
    const end = start + partialLength;
    if (0 < start || end < length) {
      finalContent = applyPartialFetch(content, partial);
      length = Buffer.byteLength(finalContent, "utf8");
    }
    // Response partial marker is the single origin octet only — RFC 3501 §9
    // `msg-att-static` / §7.4.2 allow `"BODY" section ["<" number ">"]`. The
    // `<start.length>` form is request-only grammar (`fetch-att`); echoing the
    // length back is non-conformant. The `{length}` literal already tells the
    // client how many octets follow.
    header += `<${start}>`;
    // A partial fetch returns exactly the requested substring — no trailing
    // CRLF. (The non-partial branch below appends one and recounts `length`;
    // doing that here would emit 2 octets more than the `{length}` literal
    // advertises, desyncing clients that read exactly `length` octets.)
  }
  // (Non-partial, non-header-like branch is handled by the cached fast
  // path above and returns before reaching here.)

  return { type: "literal", content: finalContent, header, length };
}

/**
 * A mail row that may carry the four synthetic streaming/measurement
 * fields the getMailsByRange projection can add alongside the real
 * MailModel columns: `text_octets` / `html_octets` (pre-measured
 * `octet_length()` for the pg SUBSTRING body stream in BODY[] / RFC822,
 * and for the BODYSTRUCTURE cached-size path here) + `mail_id` / `user_id`
 * (identity for the same stream). Widening the fetch handler's input to
 * this shape lets `BODYSTRUCTURE` read the octet count without a runtime
 * cast at every access site.
 */
export type FetchMailInput = Partial<MailType> & {
  text_octets?: number;
  html_octets?: number;
  mail_id?: string;
  user_id?: string;
};

export async function buildFetchResponsePart(
  mail: FetchMailInput,
  item: FetchDataItem,
  docId: string,
  selectedMailbox: string,
  userId?: string
): Promise<FetchResponsePart | null> {
  switch (item.type) {
    case "UID": {
      const isDomainScopedBox = isDomainScoped(selectedMailbox);
      const uid = isDomainScopedBox ? mail.uid!.domain : mail.uid!.account;
      return { type: "simple", content: `UID ${uid}` };
    }

    case "FLAGS": {
      const flags = formatFlags(mail);
      return { type: "simple", content: `FLAGS (${flags.join(" ")})` };
    }

    case "INTERNALDATE": {
      const date = mail.date ? new Date(mail.date) : new Date();
      const internalDate = formatInternalDate(date);
      return { type: "simple", content: `INTERNALDATE "${internalDate}"` };
    }

    case "RFC822.SIZE": {
      if (typeof mail.rfc822_size === "number") {
        return { type: "simple", content: `RFC822.SIZE ${mail.rfc822_size}` };
      }
      const size = computeFullMessageSize(mail, docId);
      // Persist for future requests. `userId` is threaded from the top-level
      // FETCH handler; callers without a userId (unit-test / internal)
      // skip the persist step silently. Fire-and-forget — a persist
      // failure surfaces as a log line and the same fetch re-computes
      // next time; nothing is broken.
      if (userId) {
        void updateRfc822Size(userId, docId, size).catch((err) => {
          logger.warn("Failed to persist rfc822_size", {
            component: "imap.fetch",
            mail_id: docId,
            err: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return { type: "simple", content: `RFC822.SIZE ${size}` };
    }

    case "ENVELOPE": {
      const envelope = formatEnvelope(mail);
      return { type: "simple", content: `ENVELOPE ${envelope}` };
    }

    case "BODYSTRUCTURE": {
      // extensible=false is the bare `BODY` data item: non-extensible structure
      // labelled `BODY` (RFC 3501 §6.4.5). extensible=true is full BODYSTRUCTURE.
      //
      // Metadata-only: the projection carries `text_octets` + `html_octets`
      // (from `octet_length()`), which is everything formatBodyStructure needs.
      // No text/html string is ever loaded, on any row.
      const bodyStructure = formatBodyStructure(mail, item.extensible);
      const label = item.extensible ? "BODYSTRUCTURE" : "BODY";
      return { type: "simple", content: `${label} ${bodyStructure}` };
    }

    case "BODY":
      return buildBodyResponsePart(mail, item, docId, selectedMailbox);

    // RFC 3501 §6.4.5 aliases: RFC822 ≡ BODY[], RFC822.HEADER ≡ BODY[HEADER],
    // RFC822.TEXT ≡ BODY[TEXT]. Delegate to the BODY[...] builders, keeping the
    // RFC822* label on the response part.
    case "RFC822":
      return buildBodyResponsePart(
        mail,
        { type: "BODY", peek: false, section: { type: "FULL" } },
        docId,
        selectedMailbox,
        "RFC822"
      );

    case "RFC822.HEADER":
      return buildBodyResponsePart(
        mail,
        { type: "BODY", peek: true, section: { type: "HEADER" } },
        docId,
        selectedMailbox,
        "RFC822.HEADER"
      );

    case "RFC822.TEXT":
      return buildBodyResponsePart(
        mail,
        { type: "BODY", peek: false, section: { type: "TEXT" } },
        docId,
        selectedMailbox,
        "RFC822.TEXT"
      );

    default:
      return null;
  }
}

export async function buildFetchResponse(
  mail: FetchMailInput,
  dataItems: FetchDataItem[],
  docId: string,
  uid: number,
  isUidFetch: boolean,
  selectedMailbox: string,
  condstoreEnabled: boolean = false,
  userId?: string
): Promise<FetchResponsePart[]> {
  const parts: FetchResponsePart[] = [];

  if (isUidFetch) {
    parts.push({ type: "simple", content: `UID ${uid}` });
  }

  for (const item of dataItems) {
    if (item.type === "UID" && isUidFetch) continue;
    // MODSEQ is emitted once, centrally (below), so the per-item loop skips it —
    // this dedups an explicit `(MODSEQ)` request against the implicit
    // post-ENABLE emission and keeps a single `MODSEQ (n)` in the response.
    if (item.type === "MODSEQ") continue;
    const part = await buildFetchResponsePart(mail, item, docId, selectedMailbox, userId);
    if (part) parts.push(part);
  }

  // RFC 4551 §3.3.2: include MODSEQ when the client asked for it explicitly, or
  // implicitly on every FETCH response once CONDSTORE is enabled. The value is
  // parenthesized (`MODSEQ (n)`) per the msg-att-dynamic grammar.
  const modseqRequested = dataItems.some((item) => item.type === "MODSEQ");
  if ((condstoreEnabled || modseqRequested) && mail.modseq !== undefined) {
    parts.push({ type: "simple", content: `MODSEQ (${mail.modseq})` });
  }

  return parts;
}

/**
 * Async writer for large payloads with socket-level backpressure. Called
 * for `literal` parts whose `content` is a `Buffer` (the residual
 * materialized paths — header-like sections, partial non-FULL sections).
 * Chunks the write so V8 doesn't hold the whole payload in an outbound
 * queue simultaneously, and awaits `drain` when `socket.write` reports
 * back-pressure. `writeChunked` returning without an error means the
 * payload is drained to the OS.
 */
export type WriteChunked = (payload: Buffer) => Promise<void>;

/**
 * Consume an async iterable of chunks and write each to the socket with
 * backpressure. Called for `stream` parts (BODY[] / RFC822 fetches wired
 * through `streamFromSegments`). Peak in-flight allocation stays at
 * one chunk (~64 KiB) — no full-body Buffer is ever materialized.
 */
export type WriteStream = (chunks: AsyncIterable<Buffer>) => Promise<void>;

export async function writeFetchResponse(
  write: (data: string) => boolean | undefined,
  writeChunked: WriteChunked,
  writeStream: WriteStream,
  seqNum: number,
  parts: FetchResponsePart[]
): Promise<void> {
  write(`* ${seqNum} FETCH (`);

  for (let i = 0; i < parts.length; i++) {
    if (i > 0) write(" ");

    const part = parts[i];
    if (part.type === "literal") {
      write(`${part.header} {${part.length}}\r\n`);
      // Buffer content flows through the chunked writer with drain
      // awareness; string content stays on the fast synchronous path.
      if (Buffer.isBuffer(part.content)) {
        await writeChunked(part.content);
      } else {
        write(part.content);
      }
    } else if (part.type === "stream") {
      // {N} literal advertises the sum of upcoming chunk byte-lengths
      // (guaranteed by `computeFullMessageSize` matching the stream's
      // emit-set), then the generator's chunks flow through the
      // stream writer with backpressure.
      write(`${part.header} {${part.length}}\r\n`);
      await writeStream(part.stream);
    } else {
      write(part.content);
    }
  }

  write(")\r\n");
}
