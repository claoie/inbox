/**
 * Mailbox management operations.
 *
 * Free functions for CREATE, DELETE, RENAME, SUBSCRIBE, UNSUBSCRIBE,
 * STATUS, LIST, LSUB, and SELECT/EXAMINE.
 */

import {
  createMailbox as dbCreateMailbox,
  deleteMailboxByName,
  renameMailbox as dbRenameMailbox,
  setMailboxSubscribed,
  getImapUidValidity,
  MAILBOX_NAME_MAX_BYTES,
  MAILBOX_COUNT_MAX,
} from "server";
import { logger } from "server";
import {
  ACCOUNTS_FOLDER,
  isAccountsFolder,
  isInbox,
  isSentMessagesAccountsFolder,
  isUtilityFolder,
  utilityFolder,
  canonicalMailbox,
  quoteString,
  SENT_MESSAGES_ACCOUNTS_FOLDER,
} from "./util";
import { MailboxEntry, Store } from "./store";
import { StatusItem } from "./types";
import {
  buildSequenceMapping,
  SequenceState,
} from "./sequence-resolver";

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

const exceedsNameLimit = (name: string): boolean =>
  Buffer.byteLength(name, "utf8") > MAILBOX_NAME_MAX_BYTES;

export async function createMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  if (!cleanName) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }
  // RFC 3501 §6.3.3: "It is an error to attempt to create INBOX or a
  // mailbox with a name that refers to an existent mailbox." INBOX always
  // exists as a synthetic mailbox — any casing of the name refers to it.
  // Without this guard, the DB would accept the INSERT (no row named
  // "inbox" exists) and leave a phantom user-mailbox row that's de-duped
  // out of LIST but lingers in the table.
  if (isInbox(cleanName) || isUtilityFolder(cleanName)) {
    write(`${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
    return;
  }
  if (exceedsNameLimit(cleanName)) {
    write(`${tag} NO [LIMIT] Mailbox name exceeds ${MAILBOX_NAME_MAX_BYTES} bytes\r\n`);
    return;
  }
  try {
    const userId = store.getUser().id;
    const created = await dbCreateMailbox({ user_id: userId, name: cleanName });
    if (created.status === "exists") {
      write(`${tag} NO [ALREADYEXISTS] Mailbox already exists\r\n`);
      return;
    }
    if (created.status === "at_limit") {
      write(`${tag} NO [LIMIT] Mailbox limit of ${MAILBOX_COUNT_MAX} reached\r\n`);
      return;
    }
    logger.info("Mailbox created", { component: "imap", mailbox: cleanName });
    write(`${tag} OK CREATE completed\r\n`);
  } catch (error) {
    logger.error("Error creating mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} NO CREATE failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

export async function deleteMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  if (!cleanName) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }
  // RFC 3501 §6.3.4: deletion of INBOX is forbidden. Short-circuit on every
  // casing — without this guard, `deleteMailboxByName` would return
  // "not_found" (no DB row matches lowercase 'inbox') and the client would
  // get a misleading "does not exist" instead of the correct refusal.
  if (isInbox(cleanName)) {
    write(`${tag} NO [CANNOT] Cannot delete INBOX\r\n`);
    return;
  }
  // Same reason INBOX is refused: a utility folder is a server-defined view
  // with no row behind it, so `deleteMailboxByName` would report "does not
  // exist" for a box the client can see in LIST.
  if (isUtilityFolder(cleanName)) {
    write(`${tag} NO [CANNOT] Cannot delete system mailbox\r\n`);
    return;
  }
  try {
    const userId = store.getUser().id;
    const result = await deleteMailboxByName(userId, cleanName);
    if (result === "not_found") {
      write(`${tag} NO [NONEXISTENT] Mailbox does not exist\r\n`);
      return;
    }
    if (result === "protected") {
      write(`${tag} NO [CANNOT] Cannot delete system mailbox\r\n`);
      return;
    }
    logger.info("Mailbox deleted", { component: "imap", mailbox: cleanName });
    write(`${tag} OK DELETE completed\r\n`);
  } catch (error) {
    logger.error("Error deleting mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} NO DELETE failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// RENAME
// ---------------------------------------------------------------------------

export async function renameMailbox(
  tag: string,
  oldName: string,
  newName: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanOld = oldName.replace(/^"(.*)"$/, "$1");
  const cleanNew = newName.replace(/^"(.*)"$/, "$1");
  if (!cleanOld || !cleanNew) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }
  // RFC 3501 §6.3.5 defines special RENAME-INBOX semantics (move all
  // messages to the new name, leave INBOX empty). The current backing
  // implementation doesn't support that, so guard explicitly rather than
  // returning the misleading "[NONEXISTENT] Mailbox does not exist" the
  // DB layer would otherwise produce for any casing of `inbox` (no DB
  // row → not_found). Filed as a follow-up if the workflow needs it.
  if (isInbox(cleanOld)) {
    write(`${tag} NO [CANNOT] RENAME INBOX is not supported\r\n`);
    return;
  }
  if (isUtilityFolder(cleanOld)) {
    write(`${tag} NO [CANNOT] Cannot rename system mailbox\r\n`);
    return;
  }
  // Target must not collide with a synthetic mailbox either.
  if (isInbox(cleanNew) || isUtilityFolder(cleanNew)) {
    write(`${tag} NO [ALREADYEXISTS] Target mailbox already exists\r\n`);
    return;
  }
  if (exceedsNameLimit(cleanNew)) {
    write(`${tag} NO [LIMIT] Mailbox name exceeds ${MAILBOX_NAME_MAX_BYTES} bytes\r\n`);
    return;
  }
  try {
    const userId = store.getUser().id;
    const result = await dbRenameMailbox(userId, cleanOld, cleanNew);
    if (result === "not_found") {
      write(`${tag} NO [NONEXISTENT] Mailbox does not exist\r\n`);
      return;
    }
    if (result === "protected") {
      write(`${tag} NO [CANNOT] Cannot rename system mailbox\r\n`);
      return;
    }
    if (result === "name_taken") {
      write(`${tag} NO [ALREADYEXISTS] Target mailbox already exists\r\n`);
      return;
    }
    logger.info("Mailbox renamed", { component: "imap", from: cleanOld, to: cleanNew });
    write(`${tag} OK RENAME completed\r\n`);
  } catch (error) {
    logger.error("Error renaming mailbox", { component: "imap" }, error);
    write(`${tag} NO RENAME failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// SUBSCRIBE / UNSUBSCRIBE
// ---------------------------------------------------------------------------

export async function subscribeMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  try {
    const userId = store.getUser().id;
    await setMailboxSubscribed(userId, cleanName, true);
    write(`${tag} OK SUBSCRIBE completed\r\n`);
  } catch (error) {
    logger.error("Error subscribing mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} OK SUBSCRIBE completed\r\n`);
  }
}

export async function unsubscribeMailbox(
  tag: string,
  mailbox: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  const cleanName = mailbox.replace(/^"(.*)"$/, "$1");
  try {
    const userId = store.getUser().id;
    await setMailboxSubscribed(userId, cleanName, false);
    write(`${tag} OK UNSUBSCRIBE completed\r\n`);
  } catch (error) {
    logger.error("Error unsubscribing mailbox", { component: "imap", mailbox: cleanName }, error);
    write(`${tag} OK UNSUBSCRIBE completed\r\n`);
  }
}

/** Re-throw a settled rejection, so a batched read still fails the command. */
const unwrap = <T>(result: PromiseSettledResult<T>): T => {
  if (result.status === "rejected") throw result.reason;
  return result.value;
};

// ---------------------------------------------------------------------------
// STATUS
// ---------------------------------------------------------------------------

export async function statusMailbox(
  tag: string,
  mailboxArg: string,
  items: StatusItem[],
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  // RFC 3501 §5.1: INBOX is case-insensitive. Canonicalize so downstream
  // responses (* STATUS "INBOX" ...) echo the canonical name regardless of
  // the casing the client used.
  const mailbox = canonicalMailbox(mailboxArg);
  try {
    if (!(await store.mailboxExists(mailbox))) {
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    const countResult = await store.countMessages(mailbox);

    if (countResult === null) {
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    const { total, unread } = countResult;

    let uidValidity: number | null = null;
    if (items.includes("UIDVALIDITY")) {
      uidValidity = await getImapUidValidity(store.getUser().id);
    }

    // RFC 4551 §3.1.2: STATUS may request HIGHESTMODSEQ. Resolve it once here
    // (a single MAX(modseq) query) rather than per-item inside the loop.
    let highestModseq: number | null = null;
    if (items.includes("HIGHESTMODSEQ")) {
      highestModseq = await store.getHighestModseq(mailbox);
    }

    // Same lazy shape: UIDNEXT is its own counter read, so only pay for
    // it when the client asked for it.
    let uidNext: number | null = null;
    if (items.includes("UIDNEXT")) {
      uidNext = await store.getUidNext(mailbox);
    }

    const statusItems: string[] = [];
    items.forEach((item) => {
      switch (item) {
        case "MESSAGES":
          statusItems.push("MESSAGES", total.toString());
          break;
        case "UIDNEXT":
          statusItems.push("UIDNEXT", uidNext!.toString());
          break;
        case "UIDVALIDITY":
          statusItems.push("UIDVALIDITY", uidValidity!.toString());
          break;
        case "UNSEEN":
          statusItems.push("UNSEEN", unread.toString());
          break;
        case "RECENT":
          statusItems.push("RECENT", "0");
          break;
        case "HIGHESTMODSEQ":
          statusItems.push("HIGHESTMODSEQ", highestModseq!.toString());
          break;
      }
    });

    write(`* STATUS ${quoteString(mailbox)} (${statusItems.join(" ")})\r\n`);
    write(`${tag} OK STATUS completed\r\n`);
  } catch (error) {
    logger.error("Error getting mailbox status", { component: "imap", mailbox }, error);
    write(`${tag} NO STATUS failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// LIST / LSUB helpers
// ---------------------------------------------------------------------------

/**
 * Every proper ancestor path of the given names — `Projects/Work/Q3`
 * contributes `Projects` and `Projects/Work`. Built in one pass
 * (O(names × depth)) rather than re-scanning the set per candidate, which
 * would be quadratic on an account with thousands of per-address boxes, and
 * keyed on path segments so a `Project` that is merely a string prefix of
 * `Projects/Work` is not treated as its parent.
 */
export const collectAncestors = (names: string[]): Set<string> => {
  const ancestors = new Set<string>();
  names.forEach((name) => {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      ancestors.add(parts.slice(0, i).join("/"));
    }
  });
  return ancestors;
};

/**
 * Attributes for one LIST/LSUB row. `parentPaths` is the ancestor set of the
 * whole listable mailbox set — build it once per command with
 * `collectAncestors`, never per row, or the response goes quadratic on an
 * account carrying thousands of per-address boxes.
 *
 * ```ts
 * const parentPaths = collectAncestors(boxes);
 * boxes.forEach((box) => write(`* LIST (${getMailboxAttributes(box, parentPaths)}) …`));
 * ```
 */
export function getMailboxAttributes(box: string, parentPaths: ReadonlySet<string>): string {
  // RFC 5258 §3: \HasChildren / \HasNoChildren is what a client keys its
  // expand affordance off, so it has to follow the names actually listed.
  const hierarchy = parentPaths.has(box) ? "\\HasChildren" : "\\HasNoChildren";
  // RFC 6154 §2: the special-use attribute travels alongside the ordinary ones
  // in a plain LIST response, which is how a client maps a role to a box name
  // without guessing at the name.
  const utility = utilityFolder(box);
  if (utility) {
    return `${utility.specialUse} ${hierarchy}`;
  }
  if (isAccountsFolder(box) || isSentMessagesAccountsFolder(box)) {
    return `${hierarchy} \\Noselect`;
  }
  return hierarchy;
}

/**
 * Collapse each run of adjacent wildcards to the single widest one it
 * contains: a run holding any "*" spans the hierarchy delimiter, so it
 * subsumes every "%" beside it, and a run of only "%" is no wider than one.
 */
export const collapseWildcardRuns = (pattern: string): string => {
  let collapsed = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char !== "*" && char !== "%") {
      collapsed += char;
      continue;
    }
    let widest = char;
    while (index + 1 < pattern.length) {
      const next = pattern[index + 1];
      if (next !== "*" && next !== "%") break;
      if (next === "*") widest = "*";
      index++;
    }
    collapsed += widest;
  }
  return collapsed;
};

/**
 * Sweep the mailbox name one character at a time, carrying the set of pattern
 * positions that can still consume the prefix scanned so far. Position j is
 * reachable when "*" or "%" there matches the character just consumed (only
 * "%" is barred from the "/" delimiter), when a wildcard matches nothing, or
 * when a literal is exactly the character consumed. The cost is the product of
 * the two lengths, with no search space to backtrack through.
 */
const isReachableByPattern = (source: string, target: string): boolean => {
  let reachable = new Array<boolean>(source.length + 1).fill(false);
  let scratch = new Array<boolean>(source.length + 1).fill(false);
  reachable[0] = true;
  for (let j = 0; j < source.length; j++) {
    const char = source[j];
    if (char !== "*" && char !== "%") break;
    reachable[j + 1] = true;
  }

  for (let i = 1; i <= target.length; i++) {
    const consumed = target[i - 1];
    let anyReachable = false;
    scratch[0] = false;
    for (let j = 1; j <= source.length; j++) {
      const char = source[j - 1];
      let position: boolean;
      if (char === "*") {
        position = scratch[j - 1] || reachable[j];
      } else if (char === "%") {
        position =
          scratch[j - 1] || (reachable[j] && consumed !== "/");
      } else {
        position = reachable[j - 1] && char === consumed;
      }
      scratch[j] = position;
      anyReachable = anyReachable || position;
    }
    // An empty reachable set is absorbing: position 0 is unreachable once any
    // character has been consumed, so nothing downstream can revive it.
    if (!anyReachable) return false;
    const consumedRow = reachable;
    reachable = scratch;
    scratch = consumedRow;
  }

  return reachable[source.length];
};

/**
 * Build a matcher for an IMAP LIST reference + pattern (RFC 3501 §6.3.8),
 * reusable across every mailbox name in one response. The reference and
 * pattern are concatenated; within the result "*" matches across the "/"
 * hierarchy delimiter while "%" matches only within a single level. Every
 * other character matches literally.
 *
 * @example
 * const matches = createListPatternMatcher("INBOX/", "%");
 * matches("INBOX/accounts"); // true
 * matches("INBOX/accounts/work"); // false
 */
export function createListPatternMatcher(
  reference: string,
  pattern: string
): (box: string) => boolean {
  const combined = reference + pattern;
  const collapsed = collapseWildcardRuns(combined);
  // RFC 3501 §5.1: INBOX is matched case-insensitively, and that applies to
  // LIST/LSUB patterns too — `LIST "" "inbox"` must surface the canonical
  // INBOX row. Fold case ONLY when the target box is INBOX, so every other
  // mailbox name stays strictly case-sensitive (Archive ≠ archive).
  const foldedForInbox = collapseWildcardRuns(combined.toUpperCase());

  return (box: string): boolean =>
    isInbox(box)
      ? isReachableByPattern(foldedForInbox, box.toUpperCase())
      : isReachableByPattern(collapsed, box);
}

export async function listMailboxes(
  tag: string,
  reference: string,
  pattern: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    // An empty pattern is a special request for the hierarchy delimiter and the
    // root name of the reference (RFC 3501 §6.3.8); no mailboxes are returned.
    if (pattern === "") {
      write(`* LIST (\\Noselect) "/" ${quoteString(reference)}\r\n`);
      write(`${tag} OK LIST completed\r\n`);
      return;
    }
    const boxes = await store.listMailboxes();
    // Ancestors come from the unfiltered set: a child the pattern excludes
    // still makes its parent \HasChildren.
    const parentPaths = collectAncestors(boxes);
    const matchesPattern = createListPatternMatcher(reference, pattern);
    boxes
      .filter(matchesPattern)
      .forEach((box) => {
        const attrs = getMailboxAttributes(box, parentPaths);
        write(`* LIST (${attrs}) "/" ${quoteString(box)}\r\n`);
      });
    write(`${tag} OK LIST completed\r\n`);
  } catch (error) {
    logger.error("Error listing mailboxes", { component: "imap" }, error);
    write(`${tag} NO LIST failed\r\n`);
  }
}

export async function listSubscribedMailboxes(
  tag: string,
  reference: string,
  pattern: string,
  store: Store,
  write: (data: string) => boolean | undefined
): Promise<void> {
  try {
    if (pattern === "") {
      write(`* LSUB (\\Noselect) "/" ${quoteString(reference)}\r\n`);
      write(`${tag} OK LSUB completed\r\n`);
      return;
    }
    const entries = await store.listMailboxEntries();
    const matchesPattern = createListPatternMatcher(reference, pattern);
    // Hierarchy is a property of the full listable set, not of the subscribed
    // subset, so filtering a child out of the response cannot change what its
    // parent reports.
    const allBoxes = entries.map((entry) => entry.name);
    const parentPaths = collectAncestors(allBoxes);

    const promoteAncestors = (reference + pattern).includes("%");
    const ancestorsOfSubscribed = promoteAncestors
      ? collectAncestors(entries.filter((entry) => entry.subscribed).map((e) => e.name))
      : new Set<string>();

    // An ancestor need not exist as a mailbox of its own. Nothing here creates
    // the superior names on CREATE (RFC 3501 §6.3.3 only says SHOULD), so
    // `Projects/Work` can be subscribed with no `Projects` row at all — and
    // §6.3.9's own example is precisely such a name, which is why the rule
    // marks it \Noselect rather than assuming it is selectable.
    const listed = new Set(allBoxes);
    const synthesized: MailboxEntry[] = [...ancestorsOfSubscribed]
      .filter((name) => !listed.has(name))
      .sort()
      .map((name) => ({ name, subscribed: false }));

    [...entries, ...synthesized]
      .filter((entry) => entry.subscribed || ancestorsOfSubscribed.has(entry.name))
      .filter((entry) => matchesPattern(entry.name))
      .forEach((entry) => {
        // An unsubscribed name is in this response only because it has a
        // subscribed descendant, hence \HasChildren unconditionally.
        const attrs = entry.subscribed
          ? getMailboxAttributes(entry.name, parentPaths)
          : "\\HasChildren \\Noselect";
        write(`* LSUB (${attrs}) "/" ${quoteString(entry.name)}\r\n`);
      });
    write(`${tag} OK LSUB completed\r\n`);
  } catch (error) {
    logger.error("Error listing subscribed mailboxes", { component: "imap.lsub" }, error);
    write(`${tag} NO LSUB failed\r\n`);
  }
}

// ---------------------------------------------------------------------------
// SELECT / EXAMINE
// ---------------------------------------------------------------------------

export interface SelectResult {
  selectedMailbox: string;
  selectedMailboxMessageCount: number;
}

export async function selectMailbox(
  tag: string,
  name: string,
  readOnly: boolean,
  command: "SELECT" | "EXAMINE",
  store: Store,
  write: (data: string) => boolean | undefined,
  seqState: SequenceState,
  setSelected: (mailbox: string | null, count: number) => void,
  clearSeqState: () => void
): Promise<void> {
  const unquoted = name.replace(/^"(.*)"$/, "$1");

  if (!unquoted) {
    write(`${tag} NO Empty mailbox name\r\n`);
    return;
  }

  // RFC 3501 §5.1: INBOX is case-insensitive. Canonicalize so the selected
  // mailbox stored on the session and every downstream response (`* OK
  // [READ-WRITE]`, EXISTS/RECENT, FETCH responses) reflect "INBOX" rather
  // than whatever casing the client sent.
  const cleanName = canonicalMailbox(unquoted);

  if (isAccountsFolder(cleanName)) {
    write(`${tag} NO [CANNOT] ${ACCOUNTS_FOLDER} is not selectable\r\n`);
    return;
  }

  if (isSentMessagesAccountsFolder(cleanName)) {
    write(`${tag} NO [CANNOT] ${SENT_MESSAGES_ACCOUNTS_FOLDER} is not selectable\r\n`);
    return;
  }

  try {
    if (!(await store.mailboxExists(cleanName))) {
      // RFC 3501 §6.3.1: a failed SELECT leaves no mailbox selected. Without
      // this the session keeps serving the previously selected mailbox behind
      // a `NO`, and the two failure exits below would disagree with this one.
      setSelected(null, 0);
      clearSeqState();
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    setSelected(cleanName, 0);

    if (!(await buildSequenceMapping(store, cleanName, seqState))) {
      setSelected(null, 0);
      clearSeqState();
      write(`${tag} NO Failed to read mailbox\r\n`);
      return;
    }

    const countResult = await store.countMessages(cleanName);

    if (countResult === null) {
      setSelected(null, 0);
      clearSeqState();
      write(`${tag} NO Mailbox does not exist\r\n`);
      return;
    }

    const { total } = countResult;
    setSelected(cleanName, total);

    // Everything the untagged block needs is resolved BEFORE the first
    // untagged write. Two reasons, both load-bearing:
    //
    // - `getUidNext` throws on a DB fault (deliberately — a swallowed fault
    //   would surface as a too-low UIDNEXT, which is the bug itself). Reading it
    //   after `* EXISTS` had gone out would leave the client holding a
    //   half-written SELECT response followed by `NO SELECT failed`.
    // - The four reads are mutually independent, so paying four serial
    //   round-trips on a command iOS Mail issues per mailbox per sync is waste.
    //
    // [UNSEEN <n>] is the sequence number of the first unseen message, not the
    // unread count (RFC 3501 §7.1). Map the lowest-UID unread message to its
    // 1-based sequence position; omit the response code entirely when all read.
    //
    // UIDNEXT comes from the UID counter, never from the last entry of
    // `seqToUid` nor from a MAX over the mailbox's surviving rows. Both of
    // those decrease whenever the highest-UID message leaves the mailbox —
    // hidden by INBOX's spam quarantine, expunged, or hard-deleted — which RFC
    // 3501 §2.3.1.1 forbids and which re-promises a UID already handed out.
    // STATUS reads the same counter, so the two agree by construction.
    //
    // RFC 4551 §3.1.1: a CONDSTORE-capable server reports the mailbox's
    // HIGHESTMODSEQ so the client can detect changes since its last-known
    // mod-sequence without a full resync.
    //
    // `allSettled`, not `all`: a DB outage rejects several of these at once,
    // and `Promise.all` would leave every rejection after the first unhandled —
    // firing the process-level `unhandledRejection` alarm on top of the tagged
    // NO this already answers with. `unwrap` re-throws the first failure from
    // an already-settled result, so nothing is left dangling.
    const settled = await Promise.allSettled([
      getImapUidValidity(store.getUser().id),
      store.getFirstUnseenUid(cleanName),
      store.getUidNext(cleanName),
      store.getHighestModseq(cleanName),
    ]);
    const uidValidity = unwrap(settled[0]);
    const firstUnseenUid = unwrap(settled[1]);
    const uidNext = unwrap(settled[2]);
    const highestModseq = unwrap(settled[3]);
    const firstUnseenSeq =
      firstUnseenUid !== null ? seqState.uidToSeq.get(firstUnseenUid) : undefined;

    write(`* ${total} EXISTS\r\n`);
    write(`* 0 RECENT\r\n`);
    if (firstUnseenSeq) {
      write(`* OK [UNSEEN ${firstUnseenSeq}] Message ${firstUnseenSeq} is first unseen\r\n`);
    }
    write(`* OK [UIDVALIDITY ${uidValidity}] UIDs valid\r\n`);
    write(`* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n`);
    write(`* OK [HIGHESTMODSEQ ${highestModseq}] Highest mod-sequence\r\n`);
    write(`* FLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered)\r\n`);
    write(
      `* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Deleted \\Draft \\Answered \\*)] Flags permitted\r\n`
    );
    // RFC 3501 6.3.1: the response code reports whether the client may modify
    // the mailbox, which is not the same question as which command it issued —
    // a read-only user's SELECT is answered `[READ-ONLY] SELECT completed`.
    const mode = readOnly ? "READ-ONLY" : "READ-WRITE";
    write(`${tag} OK [${mode}] ${command} completed\r\n`);
  } catch (error) {
    // RFC 3501 §6.3.1: after a failed SELECT no mailbox is selected. The
    // happy path calls `setSelected(cleanName, …)` before any of the reads
    // that can throw, so without this the session stays selected (with a
    // populated seqState) while the client has been told the SELECT failed —
    // a later FETCH/STORE it believes is illegal would still execute. Mirrors
    // the `countResult === null` branch above.
    setSelected(null, 0);
    clearSeqState();
    logger.error("Error selecting mailbox", { component: "imap", name }, error);
    write(`${tag} NO SELECT failed\r\n`);
  }
}
