/**
 * Message operations: FETCH, SEARCH, STORE, COPY, APPEND, EXPUNGE.
 */

import { MailType } from "common";
import {
  markRead,
  getDomainUidNext,
  getAccountUidNext,
  getMailboxUidNext,
  getImapUidValidity,
  syncMailboxPivot,
} from "server";
import { logger } from "server";
import { Store } from "./store";
import { StoreOperationType } from "../postgres/repositories/mails";
import {
  boxToAccount,
  canonicalMailbox,
  deriveCopyMessageId,
  isDomainScoped,
  isMappedUtilityFolder,
  isSentBox,
} from "./util";
import { shouldMarkAsRead } from "./session-utils";
import {
  FetchRequest,
  SearchRequest,
  SearchCriterion,
  StoreRequest,
  CopyRequest,
  MoveRequest,
  AppendRequest,
  UidCriterion,
} from "./types";
import {
  buildFetchResponse,
  writeFetchResponse,
  getRequestedFields,
  convertSequenceSet,
  WriteChunked,
  WriteStream,
} from "./fetch-helpers";
import {
  resolveSeqRangeToUids,
  resolveUidRangeSentinel,
  uidToSeqNumber,
  countSequenceSetMessages,
  clampSequenceSetToFirst,
  reconcileSequenceMapping,
  SequenceState,
} from "./sequence-resolver";

// ---------------------------------------------------------------------------
// FETCH
// ---------------------------------------------------------------------------

export async function fetchMessagesTyped(
  tag: string,
  fetchRequest: FetchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined,
  writeChunked: WriteChunked,
  writeStream: WriteStream,
  condstoreEnabled: boolean = false,
  // Suppresses the auto-\Seen side-effect on FETCH BODY[] / RFC822 /
  // RFC822.TEXT for a read-only session, so reading a message never changes
  // the flag another client is looking at.
  suppressReadMark: boolean = false
): Promise<void> {
  const isFlagsOnly = fetchRequest.dataItems.every(
    (item) =>
      item.type === "FLAGS" ||
      item.type === "UID" ||
      item.type === "RFC822.SIZE" ||
      item.type === "INTERNALDATE"
  );
  const isHeaderOnly = fetchRequest.dataItems.every(
    (item) =>
      item.type === "FLAGS" ||
      item.type === "UID" ||
      item.type === "RFC822.SIZE" ||
      item.type === "INTERNALDATE" ||
      (item.type === "BODY" && item.section?.type === "HEADER") ||
      (item.type === "BODY" && item.section?.type === "HEADER_FIELDS")
  );
  const requestedCount = countSequenceSetMessages(
    seqState.seqToUid,
    fetchRequest.sequenceSet,
    isUidCommand
  );
  const limit = isFlagsOnly ? Infinity : isHeaderOnly ? 500 : 50;
  if (requestedCount > limit) {
    // Return a subset instead of `NO [LIMIT]`. RFC 3501 §6.4.5 lets the
    // server return fewer messages than requested; the client observes
    // the uncovered range and issues a follow-up FETCH for it, walking
    // the mailbox in cap-sized chunks. iOS Mail specifically treats any
    // tagged `NO` as fatal (shows "Cannot Get Mail" modal); a
    // shortened `OK` completes cleanly and iOS keeps syncing.
    const clampedSet = clampSequenceSetToFirst(
      seqState.seqToUid,
      fetchRequest.sequenceSet,
      limit,
      isUidCommand
    );
    // debug, not info — iOS full-sync fires ceil(N/limit) clamp events per session.
    logger.debug("FETCH clamped to server per-command cap", {
      component: "imap",
      tag,
      requestedCount,
      limit,
      clampedRanges: clampedSet.ranges,
    });
    fetchRequest = { ...fetchRequest, sequenceSet: clampedSet };
  }

  // RFC 4551 §3.3.1: a CHANGEDSINCE fetch implies the MODSEQ data item, so the
  // response carries `MODSEQ (n)` even if the client never ENABLEd CONDSTORE.
  // The session separately flips its persistent condstore flag so subsequent
  // plain fetches also carry MODSEQ; this local flag keeps THIS response
  // correct in isolation.
  const emitCondstore =
    condstoreEnabled || fetchRequest.changedSince !== undefined;

  try {
    const messages = await _fetchMessages(
      fetchRequest,
      isUidCommand,
      store,
      selectedMailbox,
      seqState,
      emitCondstore
    );
    await _processFetchMessages(
      messages,
      fetchRequest,
      isUidCommand,
      store,
      selectedMailbox,
      seqState,
      write,
      writeChunked,
      writeStream,
      emitCondstore,
      suppressReadMark
    );
    write(`${tag} OK FETCH completed\r\n`);
  } catch (error) {
    logger.error("FETCH error", { component: "imap" }, error);
    write(`${tag} NO FETCH failed\r\n`);
  }
}

async function _fetchMessages(
  fetchRequest: FetchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  condstoreEnabled: boolean
): Promise<Map<string, Partial<MailType>>> {
  const ranges = convertSequenceSet(fetchRequest.sequenceSet);
  const requestedFields = getRequestedFields(fetchRequest.dataItems);
  // MODSEQ is needed either when explicitly requested or, per RFC 4551 §3.3.2,
  // implicitly on every FETCH response once CONDSTORE is enabled. Pull the
  // column in the same range query rather than issuing a second lookup.
  if (
    condstoreEnabled ||
    fetchRequest.dataItems.some((item) => item.type === "MODSEQ")
  ) {
    requestedFields.add("modseq");
  }
  const isUidFetch =
    fetchRequest.sequenceSet.type === "uid" || isUidCommand;

  const result = new Map<string, Partial<MailType>>();

  await Promise.all(
    ranges.map(async ({ start, end }) => {
      let uidStart = start;
      let uidEnd = end;

      if (!isUidFetch) {
        const resolved = resolveSeqRangeToUids(seqState.seqToUid, start, end);
        if (!resolved) {
          logger.warn("Sequence range matched no messages", {
            component: "imap",
            start,
            end,
          });
          return;
        }
        uidStart = resolved.uidStart;
        uidEnd = resolved.uidEnd;
      } else {
        const resolved = resolveUidRangeSentinel(seqState.seqToUid, start, end);
        uidStart = resolved.uidStart;
        uidEnd = resolved.uidEnd;
      }

      const messages = await store.getMessages(
        selectedMailbox,
        uidStart,
        uidEnd,
        Array.from(requestedFields),
        true,
        fetchRequest.changedSince
      );
      messages.forEach((mail, id) => {
        result.set(id, mail);
      });
    })
  );

  return result;
}

async function _processFetchMessages(
  messages: Map<string, Partial<MailType>>,
  fetchRequest: FetchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined,
  writeChunked: WriteChunked,
  writeStream: WriteStream,
  condstoreEnabled: boolean,
  suppressReadMark: boolean
): Promise<void> {
  const sourceIsDomainScoped = isDomainScoped(selectedMailbox);
  const isUidFetch =
    fetchRequest.sequenceSet.type === "uid" || isUidCommand;

  for (const [id, mail] of Array.from(messages.entries())) {
    const uid = sourceIsDomainScoped ? mail.uid!.domain : mail.uid!.account;
    const seqNum = uidToSeqNumber(seqState.seqToUid, seqState.uidToSeq, uid);

    if (seqNum === undefined) {
      logger.warn("No sequence number found for UID", {
        component: "imap",
        uid,
      });
      continue;
    }

    try {
      const response = await buildFetchResponse(
        mail,
        fetchRequest.dataItems,
        id,
        uid,
        isUidFetch,
        selectedMailbox,
        condstoreEnabled,
        store.getUser().id
      );
      await writeFetchResponse(write, writeChunked, writeStream, seqNum, response);

      if (!suppressReadMark && shouldMarkAsRead(fetchRequest.dataItems)) {
        await markRead(store.getUser().id, id);
      }
    } catch (error) {
      const stack = error instanceof Error ? error.stack : String(error);
      logger.error("Error processing message", { component: "imap", seqNum, stack }, error);
    }
  }
}

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------

// Resolve a UID-axis sequence set's ranges to concrete UIDs, mapping the
// `*` sentinel (Number.MAX_SAFE_INTEGER) to the mailbox's actual highest
// UID. Shared by the bare-set and explicit-`UID <set>`-keyword cases below.
const resolveUidCriterionRanges = (
  criterion: UidCriterion,
  seqState: SequenceState
): SearchCriterion => {
  const uidRanges = convertSequenceSet(criterion.sequenceSet).map(
    ({ start, end }) => {
      const resolved = resolveUidRangeSentinel(seqState.seqToUid, start, end);
      return { start: resolved.uidStart, end: resolved.uidEnd };
    }
  );
  return { type: "UID", sequenceSet: { type: "sequence", ranges: uidRanges } };
};

const resolveOneSearchKey = (
  criterion: SearchCriterion,
  isUidCommand: boolean,
  seqState: SequenceState
): SearchCriterion => {
  if (criterion.type === "NOT") {
    const notCriterion = criterion as { type: "NOT"; criterion: SearchCriterion };
    return {
      type: "NOT",
      criterion: resolveOneSearchKey(notCriterion.criterion, isUidCommand, seqState),
    };
  }
  if (criterion.type === "OR") {
    const orCriterion = criterion as {
      type: "OR";
      left: SearchCriterion;
      right: SearchCriterion;
    };
    return {
      type: "OR",
      left: resolveOneSearchKey(orCriterion.left, isUidCommand, seqState),
      right: resolveOneSearchKey(orCriterion.right, isUidCommand, seqState),
    };
  }
  if (criterion.type === "UID") {
    return resolveUidCriterionRanges(criterion as UidCriterion, seqState);
  }
  if (criterion.type !== "SEQ") return criterion;
  if (isUidCommand) {
    return resolveUidCriterionRanges(
      { type: "UID", sequenceSet: criterion.sequenceSet } as UidCriterion,
      seqState
    );
  }
  const uidRanges = convertSequenceSet(criterion.sequenceSet)
    .map(({ start, end }) => resolveSeqRangeToUids(seqState.seqToUid, start, end))
    .filter((r): r is { uidStart: number; uidEnd: number } => r !== undefined)
    .map(({ uidStart, uidEnd }) => ({ start: uidStart, end: uidEnd }));
  // A set whose sequence numbers all lie past the end of the mailbox matches
  // no messages. It must return the empty set — not vanish from the AND and
  // match everything — so pin it to an impossible UID range (UIDs are ≥ 1).
  if (uidRanges.length === 0) uidRanges.push({ start: -1, end: -1 });
  return { type: "UID", sequenceSet: { type: "sequence", ranges: uidRanges } };
};

// A bare message sequence-set is a top-level SEARCH key (RFC 3501 §6.4.4),
// parsed as a SEQ criterion. In a plain SEARCH it names message sequence
// numbers, so resolve it against the mailbox's seq→uid map before querying; in
// a UID SEARCH the same set already names UIDs, so relabel it as UID and
// resolve its `*` sentinel the same way an explicit `UID <set>` keyword does.
// (`store.search` only understands UID/flag/text/date criteria — it has no
// access to seqState — so the resolution has to happen here.)
export function resolveSeqSearchKeys(
  criteria: SearchCriterion[],
  isUidCommand: boolean,
  seqState: SequenceState
): SearchCriterion[] {
  return criteria.map((criterion) =>
    resolveOneSearchKey(criterion, isUidCommand, seqState)
  );
}

export async function searchTyped(
  tag: string,
  searchRequest: SearchRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  if (!searchRequest.criteria.length) {
    write(`${tag} BAD Search criteria is required\r\n`);
    return;
  }

  // The explicit `UID <set>` keyword is only valid under the UID command; a
  // bare sequence-set (SEQ) is valid in both and is resolved below.
  const hasUidCriteria = searchRequest.criteria.some((c) => c.type === "UID");
  if (!isUidCommand && hasUidCriteria) {
    write(`${tag} NO Not supported\r\n`);
    return;
  }

  const criteria = resolveSeqSearchKeys(
    searchRequest.criteria,
    isUidCommand,
    seqState
  );

  try {
    const uids = await store.search(selectedMailbox, criteria);

    let result: number[];
    if (isUidCommand) {
      result = uids;
    } else {
      result = uids
        .map((uid) =>
          uidToSeqNumber(seqState.seqToUid, seqState.uidToSeq, uid)
        )
        .filter((seq): seq is number => seq !== undefined);
    }

    write(`* SEARCH ${result.join(" ")}\r\n`);
    write(`${tag} OK SEARCH completed\r\n`);
  } catch (error) {
    logger.error("Search failed", { component: "imap" }, error);
    write(`${tag} NO SEARCH failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------

export async function storeFlagsTyped(
  tag: string,
  storeRequest: StoreRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  mailboxReadOnly: boolean,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined,
  condstoreEnabled: boolean = false
): Promise<void> {
  if (mailboxReadOnly) {
    write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
    return;
  }

  const isUidStore =
    storeRequest.sequenceSet.type === "uid" || isUidCommand;

  try {
    const { sequenceSet, operation, flags, silent, unchangedSince } = storeRequest;
    const ranges = convertSequenceSet(sequenceSet);
    // Accumulated across every range in the set so the tagged response can
    // name the conflicts all at once — and so a message the set mentions more
    // than once is judged on its best outcome, not its last one. `7,3:9` is a
    // legal sequence set (RFC 7162 §3.1.3 Example 11): the first pass applies
    // the change to UID 7 and stamps it with this STORE's own mod-sequence,
    // which is by construction above the client's ceiling, so the second pass
    // re-matches it and the guarded UPDATE skips it. Reporting that in
    // MODIFIED would tell the client a write was refused when it landed.
    const succeededUids = new Set<number>();
    const failedUids = new Set<number>();

    const baseOp = operation.replace(".SILENT", "");
    const touchesSaved = baseOp === "FLAGS" || flags.includes("\\Flagged");
    const touchesDeleted = baseOp === "FLAGS" || flags.includes("\\Deleted");

    for (const { start, end } of ranges) {
      let uidStart = start;
      let uidEnd = end;

      if (!isUidStore) {
        const resolved = resolveSeqRangeToUids(seqState.seqToUid, start, end);
        if (!resolved) {
          logger.warn("Sequence range matched no messages", {
            component: "imap",
            start,
            end,
          });
          continue;
        }
        uidStart = resolved.uidStart;
        uidEnd = resolved.uidEnd;
      } else {
        const resolved = resolveUidRangeSentinel(seqState.seqToUid, start, end);
        uidStart = resolved.uidStart;
        uidEnd = resolved.uidEnd;
      }

      const baseOperation = operation.replace(
        ".SILENT",
        ""
      ) as StoreOperationType;

      const { updated: updatedMails, failed } = await store.setFlags(
        selectedMailbox,
        uidStart,
        uidEnd,
        flags,
        true,
        baseOperation,
        unchangedSince
      );

      updatedMails.forEach((mail) => succeededUids.add(mail.uid));
      failed.forEach((uid) => failedUids.add(uid));

      // RFC 3501 §6.4.6: STORE on a UID/sequence range that matches no
      // messages is NOT an error — the server simply emits zero untagged
      // FETCH responses and the command still completes OK. The old code
      // wrote a tagged NO here and then threw, which (a) violated the RFC by
      // failing a valid command and (b) caused the catch block below to write
      // a SECOND tagged NO — two tagged responses for one command, which
      // desynchronizes the client. Skip empty ranges instead.
      if (updatedMails.length === 0) {
        continue;
      }

      if (touchesSaved || touchesDeleted) {
        const userId = store.getUser().id;
        await Promise.all(
          updatedMails.flatMap((mail) => {
            const writes: Promise<void>[] = [];
            if (touchesSaved) {
              writes.push(
                syncMailboxPivot(userId, "Starred", mail.mail_id, mail.saved)
              );
            }
            if (touchesDeleted) {
              writes.push(
                syncMailboxPivot(userId, "Trash", mail.mail_id, mail.deleted)
              );
            }
            return writes;
          })
        );
      }

      // A .SILENT store suppresses the FLAGS echo, but RFC 4551 §3.3.2
      // (Example 14) requires a CONDSTORE session to still receive the new
      // mod-sequence — `* n FETCH (MODSEQ (m))` with no FLAGS — so its cache
      // stays in sync. So emit whenever FLAGS is due OR CONDSTORE is on.
      const isSilent = silent || operation.includes("SILENT");
      const emitFlags = !isSilent;
      // RFC 7162 §3.1.3: on a conditional STORE the server MUST send an
      // untagged FETCH for each message it did change, "even if the .SILENT
      // suffix is specified", and it must carry MODSEQ — otherwise a .SILENT
      // client that got a MODIFIED code has no way to learn the new
      // mod-sequence of the messages that did succeed.
      const emitModseq = condstoreEnabled || unchangedSince !== undefined;
      if (emitFlags || emitModseq) {
        for (const mail of updatedMails) {
          const seq = uidToSeqNumber(
            seqState.seqToUid,
            seqState.uidToSeq,
            mail.uid
          );
          if (seq === undefined) continue;

          const items: string[] = [];
          if (emitFlags) {
            const currentFlags: string[] = [];
            if (mail.read) currentFlags.push("\\Seen");
            if (mail.saved) currentFlags.push("\\Flagged");
            if (mail.deleted) currentFlags.push("\\Deleted");
            if (mail.draft) currentFlags.push("\\Draft");
            if (mail.answered) currentFlags.push("\\Answered");
            items.push(`FLAGS (${currentFlags.join(" ")})`);
          }
          if (emitModseq && mail.modseq !== undefined) {
            items.push(`MODSEQ (${mail.modseq})`);
          }
          // Nothing to say (silent store, CONDSTORE off) — stay quiet.
          if (items.length === 0) continue;

          const uidItem = isUidStore ? `UID ${mail.uid} ` : "";
          write(`* ${seq} FETCH (${uidItem}${items.join(" ")})\r\n`);
        }
      }
    }

    // MODIFIED carries the same addressing the command used: UIDs for
    // UID STORE, sequence numbers for STORE (RFC 7162 §3.1.3). A UID with no
    // sequence number in the current view has been expunged out from under the
    // client — there is nothing to name it by, so it is dropped rather than
    // reported under a wrong number.
    const conflicted = [...failedUids]
      .filter((uid) => !succeededUids.has(uid))
      .map((uid) => (isUidStore ? uid : uidToSeqNumber(seqState.seqToUid, seqState.uidToSeq, uid)))
      .filter((id): id is number => id !== undefined);

    // RFC 7162 §3.1.3: the conflict list rides on the TAGGED response, and the
    // command still completes OK — a conditional STORE that changed nothing is
    // not an error, it is a lost race the client must resolve.
    if (conflicted.length > 0) {
      write(`${tag} OK [MODIFIED ${formatMessageSet(conflicted)}] Conditional STORE failed\r\n`);
      return;
    }
    write(`${tag} OK STORE completed\r\n`);
  } catch (error) {
    logger.error("Error storing flags", { component: "imap" }, error);
    write(`${tag} NO STORE failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// COPY / MOVE shared helpers
// ---------------------------------------------------------------------------

/**
 * The set of destination-mailbox facts every COPY / MOVE code path needs:
 * UID space, address-routing rule, sent axis, mapped-utility branch. Both
 * `copyMessageTyped` and `moveMessageTyped`'s copy-phase read all five,
 * always in the same shape; resolving them here means the two callers can't
 * disagree about what a destination like `Starred` looks like.
 */
export type DestContext = {
  destAccount: string;
  destIsSent: boolean;
  destIsDomainScoped: boolean;
  destIsMappedUtility: boolean;
  destPreservesRecipient: boolean;
};

export const resolveDestContext = (
  username: string,
  destMailbox: string
): DestContext => {
  const destAccount = boxToAccount(username, destMailbox);
  const destIsDomainScoped = isDomainScoped(destMailbox);
  const destIsMappedUtility = isMappedUtilityFolder(destMailbox);
  const destPreservesRecipient = destIsDomainScoped || destIsMappedUtility;
  const destIsSent = isSentBox(destMailbox);
  return {
    destAccount,
    destIsSent,
    destIsDomainScoped,
    destIsMappedUtility,
    destPreservesRecipient,
  };
};

/**
 * Clone `sourceMail` into `destMailbox`, reserve fresh UIDs in the
 * destination's UID space, and persist via `storeMail`. Returns the
 * (source UID, destination UID) pair the caller pushes into its COPYUID
 * source-set / dest-set, or `null` when storeMail failed (the caller
 * emits the appropriate tagged NO).
 *
 * Shared between `copyMessageTyped` (RFC 3501 §6.4.7) and
 * `moveMessageTyped`'s copy phase (RFC 6851 §3.2) — the two operations
 * differ ONLY in the follow-up expunge, so the per-mail clone is exactly
 * the same shape:
 *
 * - Flags carry over per §6.4.7. `cloneFields` at the caller has to name
 *   `read` / `saved` / `deleted` / `draft` / `answered` for these to be
 *   populated; missing any of them would silently reset the flag on the
 *   copy.
 * - Address routing: `destPreservesRecipient` keeps the source's
 *   `to`/`envelope_to` unchanged (domain-scoped + mapped-utility
 *   destinations select rows without an address term). Otherwise the
 *   copy re-anchors `to`/`envelope_to`/`cc`/`bcc` value JSONB to the
 *   destination account so the copy surfaces in the destination and does
 *   NOT stay surfaced in the source's view (`envelope_to`/`cc`/`bcc`
 *   JSONB containment would otherwise re-match).
 * - UID reservation: `newAccountUid` comes from the per-mailbox counter
 *   for a mapped-utility destination (`getMailboxUidNext`, no sent axis)
 *   and from the per-account counter otherwise (`getAccountUidNext`,
 *   sent-scoped). The domain UID is always reserved so the receive path's
 *   per-account counter stays contiguous.
 * - Returned `destUid` is `uid.domain` for a domain-scoped destination
 *   (INBOX / unified `Sent Messages` / `Drafts`/`Junk`) and `uid.account`
 *   otherwise (both per-account boxes AND the mapped-utility Starred/Trash
 *   pair, whose storeMail branch writes into `mail_mailbox_uid` keyed on
 *   the mailbox name).
 */
export const cloneMailToDestination = async (
  store: Store,
  sourceMail: Partial<MailType>,
  srcUid: number,
  destMailbox: string,
  ctx: DestContext
): Promise<{ srcUid: number; destUid: number } | null> => {
  const Mail = (await import("common")).Mail;
  const newMail = new Mail({
    subject: sourceMail.subject,
    date: sourceMail.date,
    html: sourceMail.html,
    text: sourceMail.text,
    from: sourceMail.from,
    cc: sourceMail.cc,
    bcc: sourceMail.bcc,
    replyTo: sourceMail.replyTo,
    envelopeFrom: sourceMail.envelopeFrom,
    attachments: sourceMail.attachments,
    messageId: deriveCopyMessageId(sourceMail.messageId, destMailbox),
    insight: sourceMail.insight,
    read: sourceMail.read,
    saved: sourceMail.saved,
    deleted: sourceMail.deleted,
    draft: sourceMail.draft,
    answered: sourceMail.answered,
  });

  if (ctx.destPreservesRecipient) {
    newMail.to = sourceMail.to;
    newMail.envelopeTo = sourceMail.envelopeTo ?? [];
  } else {
    const destAddr = { address: ctx.destAccount, name: "" };
    newMail.to = {
      value: [destAddr],
      text: sourceMail.to?.text || ctx.destAccount,
    };
    // Re-anchor envelope_to so the OR-clause doesn't re-surface the copy
    // in the source mailbox.
    newMail.envelopeTo = [destAddr];
    // Clear routing JSONB but preserve display text — `cc_text`/`bcc_text`
    // drive the FETCH BODY[HEADER] render on the destination while the
    // empty value arrays keep the copy from re-matching the source
    // mailbox's `addressCondition`.
    newMail.cc = sourceMail.cc
      ? { value: [], text: sourceMail.cc.text }
      : undefined;
    newMail.bcc = sourceMail.bcc
      ? { value: [], text: sourceMail.bcc.text }
      : undefined;
  }
  newMail.sent = ctx.destIsSent;

  const user = store.getUser();
  const newDomainUid = await getDomainUidNext(user.id, ctx.destIsSent);
  const newAccountUid = ctx.destIsMappedUtility
    ? await getMailboxUidNext(user.id, destMailbox)
    : await getAccountUidNext(user.id, ctx.destAccount, ctx.destIsSent);
  newMail.uid.domain = newDomainUid;
  newMail.uid.account = newAccountUid;

  const ok = await store.storeMail(newMail, destMailbox);
  if (!ok) return null;

  const destUid = ctx.destIsDomainScoped
    ? newMail.uid.domain
    : newMail.uid.account;
  return { srcUid, destUid };
};

// ---------------------------------------------------------------------------
// COPY (RFC 3501 §6.4.7 + RFC 4315 COPYUID)
// ---------------------------------------------------------------------------

/**
 * Compact a list of message numbers to the RFC 3501 sequence-set form
 * ("1,3:5,7"). Used by the RFC 4315 COPYUID/APPENDUID response codes and by
 * RFC 7162's MODIFIED — all three carry a sequence set. Deliberately not named
 * for UIDs: MODIFIED carries sequence numbers, not UIDs, when the command was
 * a plain STORE.
 */
const formatMessageSet = (numbers: number[]): string => {
  if (numbers.length === 0) return "";
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const parts: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      parts.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}:${rangeEnd}`);
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }
  parts.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}:${rangeEnd}`);
  return parts.join(",");
};

export async function copyMessageTyped(
  tag: string,
  copyRequest: CopyRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    // Canonicalize destination per RFC 3501 §5.1 (INBOX case-insensitive).
    const destMailbox = canonicalMailbox(copyRequest.mailbox);

    // RFC 4315 §2.1: destination must exist; otherwise NO [TRYCREATE].
    if (!(await store.mailboxExists(destMailbox))) {
      write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
      return;
    }

    // RFC 3501 §6.4.7: COPY source must use the selected mailbox's UID/seq
    // space. `isUidCopy` reflects whether the protocol entry was UID COPY
    // (operating on UIDs directly) or COPY (operating on sequence numbers).
    const isUidCopy =
      copyRequest.sequenceSet.type === "uid" || isUidCommand;
    const ranges = convertSequenceSet(copyRequest.sequenceSet);

    // Resolve each range to a concrete UID list. Sequence-number ranges
    // map through seqState; UID ranges pass through as-is.
    const uidRanges: Array<{ uidStart: number; uidEnd: number }> = [];
    for (const { start, end } of ranges) {
      if (isUidCopy) {
        uidRanges.push(resolveUidRangeSentinel(seqState.seqToUid, start, end));
      } else {
        const resolved = resolveSeqRangeToUids(seqState.seqToUid, start, end);
        if (!resolved) continue;
        uidRanges.push({ uidStart: resolved.uidStart, uidEnd: resolved.uidEnd });
      }
    }

    if (uidRanges.length === 0) {
      // Nothing to copy (every range resolved to no messages). RFC says
      // OK with no COPYUID is fine.
      write(`${tag} OK COPY completed\r\n`);
      return;
    }

    const cloneFields = [
      "subject",
      "date",
      "html",
      "text",
      "from",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "envelopeFrom",
      "envelopeTo",
      "attachments",
      "messageId",
      "insight",
      "read",
      "saved",
      "deleted",
      "draft",
      "answered",
      "uid",
    ];

    // Pull the source mails. `getMessages` queries by the selected
    // mailbox's UID space, so the source UIDs are interpreted correctly.
    const sourceMails: Array<Partial<MailType>> = [];
    for (const { uidStart, uidEnd } of uidRanges) {
      const batch = await store.getMessages(
        selectedMailbox,
        uidStart,
        uidEnd,
        cloneFields,
        true
      );
      // Preserve UID order (Map preserves insertion order from the SQL
      // query; downstream we sort by source UID for the COPYUID response).
      batch.forEach((mail) => sourceMails.push(mail));
    }

    if (sourceMails.length === 0) {
      // Range pointed at deleted/unknown UIDs. RFC 4315 says: still OK,
      // no COPYUID required when no messages were actually copied.
      write(`${tag} OK COPY completed\r\n`);
      return;
    }

    const user = store.getUser();
    // Destination facts shared with the MOVE path — see `resolveDestContext`.
    const dest = resolveDestContext(user.username, destMailbox);

    // Source-side UID extraction for the COPYUID response — domain-scoped for
    // INBOX and the unified Sent folder (both keyed on uid.domain).
    const sourceIsDomainScoped = isDomainScoped(selectedMailbox);
    const srcUidOf = (mail: Partial<MailType>): number =>
      sourceIsDomainScoped ? mail.uid!.domain : mail.uid!.account;

    // RFC 4315 §3: the COPYUID source-set and dest-set must correspond
    // positionally (n-th source UID ↔ n-th dest UID). The two sets are
    // built by `formatMessageSet`, which sorts each independently. To keep
    // that sort from desynchronizing the pairing for an out-of-order
    // sequence-set (e.g. `UID COPY 5,3`), assign dest UIDs in ascending
    // source-UID order: sort the materialized source mails ascending here
    // so the copy loop pushes both `sourceUids` and `destUids` already
    // ascending, and `formatMessageSet`'s independent sorts stay aligned.
    sourceMails.sort((a, b) => srcUidOf(a) - srcUidOf(b));

    // De-duplicate by source UID. A client may send overlapping ranges
    // (`UID COPY 3:5,4:6`); `getMessages` runs once per range, so a UID
    // that falls in two ranges is materialized twice. Cloning it twice
    // would both store a duplicate message and desync the COPYUID sets:
    // `formatMessageSet` collapses the source set via `new Set` while the dest
    // set keeps every clone, so `sourceSet.length !== destSet.length` and
    // the positional n-th-source ↔ n-th-dest correspondence the response
    // promises is broken. Keep the first occurrence of each source UID so
    // each is copied exactly once (RFC 4315 copies a message set, not a
    // bag). The array is already ascending, so dups are adjacent.
    const seenSourceUids = new Set<number>();
    const uniqueSourceMails = sourceMails.filter((mail) => {
      const uid = srcUidOf(mail);
      if (seenSourceUids.has(uid)) return false;
      seenSourceUids.add(uid);
      return true;
    });

    const sourceUids: number[] = [];
    const destUids: number[] = [];

    for (const sourceMail of uniqueSourceMails) {
      const result = await cloneMailToDestination(
        store,
        sourceMail,
        srcUidOf(sourceMail),
        destMailbox,
        dest
      );
      if (!result) {
        write(`${tag} NO [SERVERBUG] COPY partially failed\r\n`);
        return;
      }
      sourceUids.push(result.srcUid);
      destUids.push(result.destUid);
    }

    // RFC 4315 §2: untagged or tagged OK with [COPYUID uidvalidity
    // source-set dest-set] response code. Most servers attach it to the
    // tagged OK; doing the same here.
    const uidValidity = await getImapUidValidity(user.id);
    const sourceSet = formatMessageSet(sourceUids);
    const destSet = formatMessageSet(destUids);
    write(
      `${tag} OK [COPYUID ${uidValidity} ${sourceSet} ${destSet}] COPY completed\r\n`
    );
  } catch (error) {
    logger.error("COPY error", { component: "imap" }, error);
    write(`${tag} NO COPY failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// MOVE (RFC 6851)
// ---------------------------------------------------------------------------

/**
 * RFC 6851 MOVE: atomic copy + targeted expunge. Wire shape mirrors
 * COPY; the difference is the source rows disappear after the move.
 *
 * Response sequence (RFC 6851 §3.2):
 *   * <seq> EXPUNGE                (one per moved message; high→low)
 *   <tag> OK [COPYUID <validity> <src> <dst>] MOVE completed
 *
 * Implementation notes:
 *
 * - The expunge is targeted via `store.expungeUids(box, sourceUids)` —
 *   RFC 6851 §3.3 forbids the COPY+STORE(\\Deleted)+EXPUNGE pattern
 *   (since EXPUNGE is mailbox-wide and would also remove pre-existing
 *   \\Deleted-flagged messages, surfacing untagged EXPUNGE responses
 *   for UIDs not in the COPYUID set).
 * - No transaction wrapper around the per-mail copy loop — a mid-loop
 *   `storeMail` failure leaves the already-stored copies in the
 *   destination AND the source intact; the response is a tagged NO,
 *   client can re-issue MOVE. A mid-expunge failure (`expungeUids`
 *   throws) leaves all copies stored in dest AND all source rows
 *   intact; same NO + re-issue contract.
 * - Address routing: for non-INBOX destinations the new copy's
 *   `to_address` / `envelope_to` / `cc_address` / `bcc_address` JSONB
 *   value arrays are re-anchored to the destination address (or
 *   cleared) so the copy doesn't re-surface in the source mailbox's
 *   view. For INBOX destinations from a non-INBOX source, the same
 *   clearing applies — INBOX has no address filter so cleared routing
 *   is safe, AND it prevents the source account view from re-matching
 *   the copy under its new UID after the source is expunged.
 * - Display text fields (`to_text` / `cc_text` / `bcc_text`) are
 *   preserved so the FETCH BODY[HEADER] render on the destination
 *   still shows the original recipient header.
 */
export async function moveMessageTyped(
  tag: string,
  moveRequest: MoveRequest,
  isUidCommand: boolean,
  store: Store,
  selectedMailbox: string,
  mailboxReadOnly: boolean,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  if (mailboxReadOnly) {
    write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
    return;
  }

  try {
    const destMailbox = canonicalMailbox(moveRequest.mailbox);

    // RFC 6851 §3.4-§3.5: MOVE to the currently-selected mailbox is a
    // no-op (the messages are already where they'd land). Skip the
    // copy+expunge round-trip and respond with a bare OK — clients see
    // the same end-state with no UID churn or surprise EXPUNGE.
    if (destMailbox === selectedMailbox) {
      write(`${tag} OK MOVE completed\r\n`);
      return;
    }

    if (!(await store.mailboxExists(destMailbox))) {
      write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
      return;
    }

    const isUidMove = moveRequest.sequenceSet.type === "uid" || isUidCommand;
    const ranges = convertSequenceSet(moveRequest.sequenceSet);

    const uidRanges: Array<{ uidStart: number; uidEnd: number }> = [];
    for (const { start, end } of ranges) {
      if (isUidMove) {
        uidRanges.push(resolveUidRangeSentinel(seqState.seqToUid, start, end));
      } else {
        const resolved = resolveSeqRangeToUids(seqState.seqToUid, start, end);
        if (!resolved) continue;
        uidRanges.push({ uidStart: resolved.uidStart, uidEnd: resolved.uidEnd });
      }
    }

    if (uidRanges.length === 0) {
      write(`${tag} OK MOVE completed\r\n`);
      return;
    }

    // Same field list as the COPY path — see the docblock there for the
    // RFC 3501 §6.4.7 flag-preservation rationale. MOVE = COPY + expunge,
    // so if the copy loses `saved` the mail vanishes from Starred both
    // on the source side (source gets expunged) and on the destination
    // (copy has no `saved = TRUE`, no Starred pivot).
    const cloneFields = [
      "subject",
      "date",
      "html",
      "text",
      "from",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "envelopeFrom",
      "envelopeTo",
      "attachments",
      "messageId",
      "insight",
      "read",
      "saved",
      "deleted",
      "draft",
      "answered",
      "uid",
    ];

    const sourceMails: Array<Partial<MailType>> = [];
    for (const { uidStart, uidEnd } of uidRanges) {
      const batch = await store.getMessages(
        selectedMailbox,
        uidStart,
        uidEnd,
        cloneFields,
        true
      );
      batch.forEach((mail) => sourceMails.push(mail));
    }

    if (sourceMails.length === 0) {
      write(`${tag} OK MOVE completed\r\n`);
      return;
    }

    const user = store.getUser();
    // Destination facts shared with COPY — see `resolveDestContext`. MOVE =
    // COPY + expunge so the copy phase is byte-for-byte the COPY path.
    const dest = resolveDestContext(user.username, destMailbox);
    const sourceIsDomainScoped = isDomainScoped(selectedMailbox);
    const srcUidOf = (mail: Partial<MailType>): number =>
      sourceIsDomainScoped ? mail.uid!.domain : mail.uid!.account;

    // RFC 4315 §3 (via RFC 6851 §4.3): keep the COPYUID source/dest sets
    // positionally aligned for out-of-order sequence-sets — assign dest
    // UIDs in ascending source-UID order. See copyMessageTyped for the
    // full rationale. (The EXPUNGE emission order is set separately by the
    // explicit high→low sort below, so it is unaffected by this.)
    sourceMails.sort((a, b) => srcUidOf(a) - srcUidOf(b));

    // De-duplicate by source UID before cloning. Overlapping ranges
    // (`UID MOVE 3:5,4:6`) materialize a UID twice; see copyMessageTyped
    // for the full rationale (duplicate clone + COPYUID set-length desync).
    // Deduping here also keeps `sourceUids` — and therefore the EXPUNGE
    // set below — one entry per distinct source UID.
    const seenSourceUids = new Set<number>();
    const uniqueSourceMails = sourceMails.filter((mail) => {
      const uid = srcUidOf(mail);
      if (seenSourceUids.has(uid)) return false;
      seenSourceUids.add(uid);
      return true;
    });

    const sourceUids: number[] = [];
    const destUids: number[] = [];

    // === COPY phase — same helper the COPY handler uses. ===
    for (const sourceMail of uniqueSourceMails) {
      const result = await cloneMailToDestination(
        store,
        sourceMail,
        srcUidOf(sourceMail),
        destMailbox,
        dest
      );
      if (!result) {
        // Pre-deletion failure: copies already stored in the destination
        // linger; the source is untouched. Client can re-issue MOVE.
        write(`${tag} NO [SERVERBUG] MOVE partially failed during copy phase\r\n`);
        return;
      }
      sourceUids.push(result.srcUid);
      destUids.push(result.destUid);
    }

    // === EXPUNGE phase ===
    // RFC 6851 §3.3: MOVE MUST NOT set \\Deleted on source UIDs, and the
    // server MUST NOT expunge messages other than the moved set.
    // `store.expungeUids` directly soft-deletes the specific source UIDs
    // (sets `expunged=TRUE`) without ever touching the `\\Deleted` flag
    // and without affecting pre-existing \\Deleted-flagged messages in
    // the mailbox. Errors propagate so the outer try/catch writes a
    // tagged NO instead of falsely emitting OK + COPYUID against a
    // partial expunge.
    await store.expungeUids(selectedMailbox, sourceUids);

    // Announcing the diff rather than the moved set covers anything that left
    // underneath the session too, so the baseline the next sequence-numbered
    // command resolves against is one the client shares. A rebuild that fails
    // propagates: the outer catch answers NO rather than claiming COPYUID
    // against a mapping neither side agrees on.
    const remaining = await reconcileSequenceMapping(
      store,
      selectedMailbox,
      seqState,
      write
    );
    if (remaining === null) {
      throw new Error("Failed to rebuild the sequence mapping after MOVE");
    }

    const uidValidity = await getImapUidValidity(user.id);
    const sourceSet = formatMessageSet(sourceUids);
    const destSet = formatMessageSet(destUids);
    write(
      `${tag} OK [COPYUID ${uidValidity} ${sourceSet} ${destSet}] MOVE completed\r\n`
    );
  } catch (error) {
    logger.error("MOVE error", { component: "imap" }, error);
    write(`${tag} NO MOVE failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// APPEND
// ---------------------------------------------------------------------------

export async function appendMessage(
  tag: string,
  appendRequest: AppendRequest,
  store: Store,
  selectedMailbox: string | null,
  write: (data: string) => boolean | undefined,
  onAppended: () => Promise<void>
): Promise<void> {
  try {
    // RFC 3501 §5.1: INBOX is case-insensitive. SELECT canonicalizes
    // selectedMailbox to "INBOX"; APPEND must canonicalize the target to
    // match — otherwise a SELECT inbox + APPEND inbox sequence reads
    // `selectedMailbox === appendRequest.mailbox` as `"INBOX" === "inbox"`
    // (false), skipping onAppended (the sequence-mapping rebuild) and
    // leaving the next seq-numbered FETCH for the appended message
    // returning wrong/missing data.
    const targetMailbox = canonicalMailbox(appendRequest.mailbox);

    // RFC 3501 §6.3.11: the target must exist. The server MUST NOT create
    // it, and answers NO [TRYCREATE] so the client can CREATE and retry.
    // Gated ahead of the RFC822 parse so a rejected APPEND neither walks
    // the message nor burns a UID off the counters. (Framing is unaffected
    // either way — `handler.ts` has already consumed the whole literal off
    // the socket before this function is entered.)
    if (!(await store.mailboxExists(targetMailbox))) {
      write(`${tag} NO [TRYCREATE] Mailbox does not exist\r\n`);
      return;
    }

    const messageLines = appendRequest.message.split("\r\n");
    let headerEndIndex = messageLines.findIndex((line) => line === "");
    if (headerEndIndex === -1) headerEndIndex = messageLines.length;

    const headers = messageLines.slice(0, headerEndIndex).join("\r\n");
    const body = messageLines.slice(headerEndIndex + 1).join("\r\n");

    const subjectMatch = headers.match(/^Subject:\s*(.*)$/im);
    const fromMatch = headers.match(/^From:\s*(.*)$/im);
    const toMatch = headers.match(/^To:\s*(.*)$/im);
    const dateMatch = headers.match(/^Date:\s*(.*)$/im);
    const messageIdMatch = headers.match(/^Message-ID:\s*(.*)$/im);

    const mail = new (await import("common")).Mail();

    mail.subject = subjectMatch ? subjectMatch[1].trim() : "";
    mail.text = body;
    mail.html = body.includes("<") ? body : "";
    mail.date = dateMatch
      ? new Date(dateMatch[1]).toISOString()
      : new Date().toISOString();
    mail.messageId = messageIdMatch
      ? messageIdMatch[1].trim().replace(/[<>]/g, "")
      : mail.messageId;

    mail.draft = appendRequest.flags?.includes("\\Draft") || false;
    mail.read = appendRequest.flags?.includes("\\Seen") || false;
    mail.saved = appendRequest.flags?.includes("\\Flagged") || false;
    mail.deleted = appendRequest.flags?.includes("\\Deleted") || false;
    mail.answered = appendRequest.flags?.includes("\\Answered") || false;

    if (fromMatch) {
      mail.from = {
        value: [{ address: fromMatch[1].trim(), name: "" }],
        text: fromMatch[1].trim(),
      };
    }
    if (toMatch) {
      mail.to = {
        value: [{ address: toMatch[1].trim(), name: "" }],
        text: toMatch[1].trim(),
      };
    }

    const user = store.getUser();
    const account = boxToAccount(user.username, targetMailbox);
    // `sent` is what separates the two domain-scoped views — INBOX and the
    // unified Sent folder share `uid_domain` and are told apart by this
    // column alone — so it has to reach both the stored row and the UID
    // counters, which key their per-user sequences on (user, sent). Same
    // shape as COPY/MOVE above.
    const targetIsSent = isSentBox(targetMailbox);
    mail.sent = targetIsSent;
    const domainUid = await getDomainUidNext(user.id, targetIsSent);
    // Same split as COPY/MOVE: a mapped-utility target (`Starred`/`Trash`)
    // reserves from the per-mailbox counter, which has no `sent` axis —
    // those boxes are not domain-scoped, so the pair (user, mailbox) is the
    // whole key. Everything else reserves from the per-account counter,
    // which does key on `sent`.
    const accountUid = isMappedUtilityFolder(targetMailbox)
      ? await getMailboxUidNext(user.id, targetMailbox)
      : await getAccountUidNext(user.id, account, targetIsSent);
    mail.uid.domain = domainUid;
    mail.uid.account = accountUid;

    // storeMail derives the mapping row and the utility-folder placement
    // flag from the target box.
    const result = await store.storeMail(mail, targetMailbox);

    const uid = isDomainScoped(targetMailbox) ? mail.uid.domain : mail.uid.account;

    if (result) {
      if (selectedMailbox === targetMailbox) {
        await onAppended();
      }
      const uidValidity = await getImapUidValidity(user.id);
      write(
        `${tag} OK [APPENDUID ${uidValidity} ${uid}] APPEND completed\r\n`
      );
    } else {
      write(`${tag} NO APPEND failed to store message\r\n`);
    }
  } catch (error) {
    logger.error("APPEND error", { component: "imap" }, error);
    write(`${tag} NO APPEND failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// EXPUNGE
// ---------------------------------------------------------------------------

export async function expunge(
  tag: string,
  store: Store,
  selectedMailbox: string,
  mailboxReadOnly: boolean,
  seqState: SequenceState,
  write: (data: string) => boolean | undefined
): Promise<void> {
  if (mailboxReadOnly) {
    write(`${tag} NO [READ-ONLY] Mailbox is read-only\r\n`);
    return;
  }

  try {
    await store.expunge(selectedMailbox);

    const remaining = await reconcileSequenceMapping(
      store,
      selectedMailbox,
      seqState,
      write
    );
    if (remaining === null) {
      throw new Error("Failed to rebuild the sequence mapping after EXPUNGE");
    }

    write(`${tag} OK EXPUNGE completed\r\n`);
  } catch (error) {
    logger.error("Expunge failed", { component: "imap" }, error);
    write(`${tag} NO EXPUNGE failed\r\n`);
  }
}
