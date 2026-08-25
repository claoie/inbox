/* eslint-disable no-case-declarations */
import {
  Mail,
  SignedUser,
  MailAddressValueType,
  AttachmentType,
  Insight,
} from "common";
import {
  getAccountStats,
  countMessages,
  getMailsByRange,
  setMailFlags,
  searchMailsByUid,
  saveMail as pgSaveMail,
  expungeDeletedMails,
  expungeMailsByUid,
  getAllUids as pgGetAllUids,
  getFirstUnseenUid as pgGetFirstUnseenUid,
  getHighestModseq as pgGetHighestModseq,
  getUidNext as pgGetUidNext,
  UidScope,
  SaveMailInput,
  domainViewForDestination,
  SetMailFlagsResult,
  StoreOperationType,
} from "../postgres/repositories/mails";
import { getMailboxesByUser } from "../postgres/repositories/mailboxes";
import {
  accountToBox,
  accountToSentBox,
  boxToAccount,
  isDomainScoped,
  isInbox,
  isSentBox,
  isAccountsFolder,
  isSentMessagesAccountsFolder,
  utilityFolder,
  utilityPlacement,
  UTILITY_FOLDERS,
  ACCOUNTS_FOLDER,
  SENT_MESSAGES_FOLDER,
  SENT_MESSAGES_ACCOUNTS_FOLDER,
} from "./util";
import {
  SearchCriterion,
  UidCriterion,
} from "./types";
import { logger, getUserDomain } from "server";

type SimplifiedCriterion = { type: string; value?: unknown };

/**
 * A `Partial<Mail>` extended with the four synthetic streaming fields the
 * IMAP BODY[] / RFC822 path opts into (`text_octets` / `html_octets` +
 * `mail_id` / `user_id`). When all four are set and `text` / `html` are
 * absent, `buildMessageSegments` emits `lazy-text` segments — the body is
 * streamed from Postgres via chunked SUBSTRING reads rather than loaded as
 * a string. Existing consumers that never request the octet fields see the
 * same shape as `Partial<Mail>`.
 */
export type StoreFetchedMail = Partial<Mail> & {
  text_octets?: number;
  html_octets?: number;
  mail_id?: string;
  user_id?: string;
};

export interface MailboxEntry {
  name: string;
  subscribed: boolean;
}

export const simplifyCriterion = (
  criterion: SearchCriterion
): SimplifiedCriterion | null => {
  const type = criterion.type.toUpperCase();
  switch (type) {
    // Flag-based: no additional value
    case "ALL":
    case "UNSEEN":
    case "SEEN":
    case "ANSWERED":
    case "UNANSWERED":
    case "DELETED":
    case "UNDELETED":
    case "FLAGGED":
    case "UNFLAGGED":
    case "DRAFT":
    case "UNDRAFT":
    case "NEW":
    case "OLD":
    case "RECENT":
      return { type };

    // Text search: value is embedded in the criterion object
    case "SUBJECT":
    case "FROM":
    case "TO":
    case "CC":
    case "BCC":
    case "BODY":
    case "TEXT": {
      const textCriterion = criterion as { type: string; value: string };
      return { type, value: textCriterion.value };
    }

    // Header search
    case "HEADER": {
      const hdr = criterion as { type: string; field: string; value: string };
      return { type, value: { field: hdr.field, text: hdr.value } };
    }

    // Date criteria: value is a Date object
    case "BEFORE":
    case "ON":
    case "SINCE":
    case "SENTBEFORE":
    case "SENTON":
    case "SENTSINCE": {
      const dateCriterion = criterion as { type: string; date: Date };
      return { type, value: dateCriterion.date };
    }

    // Size criteria
    case "LARGER":
    case "SMALLER": {
      const sizeCriterion = criterion as { type: string; size: number };
      return { type, value: sizeCriterion.size };
    }

    case "NOT": {
      const notCriterion = criterion as { type: string; criterion: SearchCriterion };
      const inner = simplifyCriterion(notCriterion.criterion);
      return inner ? { type: "NOT", value: inner } : null;
    }

    // Logical OR: two (normalised) criteria
    case "OR": {
      const orCriterion = criterion as {
        type: string;
        left: SearchCriterion;
        right: SearchCriterion;
      };
      const left = simplifyCriterion(orCriterion.left);
      const right = simplifyCriterion(orCriterion.right);
      if (left && right) return { type: "OR", value: { left, right } };
      return null;
    }

    // Custom keyword flags. The server stores only the system flag set
    // (\Seen \Flagged \Deleted \Draft \Answered) and no custom keywords, so
    // KEYWORD can never match and UNKEYWORD always matches — the flag value is
    // irrelevant. Preserve the type (no value) and let buildCriterionClause map
    // KEYWORD to match-none and UNKEYWORD to match-all.
    case "KEYWORD":
    case "UNKEYWORD":
      return { type };

    case "UID": {
      const uidCriterion = criterion as UidCriterion;
      return { type: "UID_SET", value: uidCriterion.sequenceSet.ranges };
    }

    default:
      logger.warn("Unsupported search criterion", { component: "imap.store", type });
      return { type };
  }
};

// class that creates "store" object
export class Store {
  constructor(private user: SignedUser) {}

  /**
   * Get the user for this store
   */
  getUser(): SignedUser {
    return this.user;
  }

  /**
   * Resolve an IMAP mailbox name into the counter row that assigns its UIDs.
   *
   * The three branches mirror the three reservation calls the write path makes
   * (`getDomainUidNext` / `getMailboxUidNext` / `getAccountUidNext`), keyed off
   * the same `UTILITY_FOLDERS[].uidSpace` declaration, so a box can never be
   * read from a counter nothing writes.
   */
  private resolveUidScope(box: string): UidScope {
    if (isDomainScoped(box)) return { kind: "domain", sent: isSentBox(box) };
    const utility = utilityFolder(box);
    if (utility?.uidSpace === "mapped") return { kind: "mailbox", mailbox: utility.name };
    return {
      kind: "account",
      account: boxToAccount(this.user.username, box),
      sent: isSentBox(box),
    };
  }

  private resolveMappedBox(box: string): { mailboxArg: string | null; isSent: boolean } {
    const isSent = isSentBox(box);
    const mailboxArg = isInbox(box) || box === SENT_MESSAGES_FOLDER ? null : box;
    return { mailboxArg, isSent };
  }

  private listMailboxEntriesOrThrow = async (): Promise<MailboxEntry[]> => {
    // Match HTTP /api/mails/accounts: filter by user's domain so we only
    // expose addresses that belong to this server, not every external
    // CC/BCC/recipient address found on stored mails.
    const userDomain = getUserDomain(this.user.username);
    const [receivedStats, sentStats, userMailboxes] = await Promise.all([
      getAccountStats(this.user.id, false, userDomain),
      getAccountStats(this.user.id, true, userDomain),
      getMailboxesByUser(this.user.id),
    ]);

    const seen = new Set<string>();
    const addMailbox = (name: string) => {
      const trimmed = name.trim();
      if (!seen.has(trimmed)) {
        seen.add(trimmed);
        mailboxes.push({ name: trimmed, subscribed: true });
      }
    };

    const mailboxes: MailboxEntry[] = [];
    addMailbox("INBOX");

    // Utility folders are listed unconditionally: a client needs `Drafts` to
    // exist before it has a draft to APPEND into it, and RFC 6154 role
    // discovery only works if the box is in LIST. They are added ahead of the
    // user-created boxes below so a same-named user box de-dupes into the
    // server-defined view rather than shadowing it.
    UTILITY_FOLDERS.forEach(({ name }) => addMailbox(name));

    // Add Sent Messages (unified across all accounts) if any sent mail exists
    if (sentStats.length > 0) {
      addMailbox(SENT_MESSAGES_FOLDER);
    }

    // Add accounts/ parent folder if any received-mail accounts exist
    if (receivedStats.length > 0) {
      addMailbox(ACCOUNTS_FOLDER);
    }

    // Add received mail accounts under accounts/ (deduplicated)
    receivedStats.forEach((stat) => {
      if (stat.address) {
        addMailbox(accountToBox(stat.address));
      }
    });

    // Add Sent Messages/accounts/ parent folder if any per-account sent mail exists
    if (sentStats.length > 0) {
      addMailbox(SENT_MESSAGES_ACCOUNTS_FOLDER);
    }

    // Add per-account sent mailboxes under Sent Messages/accounts/ (deduplicated)
    sentStats.forEach((stat) => {
      if (stat.address) {
        addMailbox(accountToSentBox(stat.address));
      }
    });

    // Add user-created mailboxes (those without a special_use and no address tie-in)
    const systemNames = new Set(mailboxes.map((m) => m.name.toLowerCase()));
    userMailboxes
      .filter((mb) => mb.special_use === null && mb.address === null)
      .forEach((mb) => {
        if (!systemNames.has(mb.name.toLowerCase())) {
          mailboxes.push({ name: mb.name, subscribed: mb.subscribed });
        }
      });

    return mailboxes;
  };

  private listMailboxesOrThrow = async (): Promise<string[]> => {
    const entries = await this.listMailboxEntriesOrThrow();
    return entries.map((entry) => entry.name);
  };

  /**
   * LIST-facing version: on backend error, log + return a single `["INBOX"]`
   * fallback so the LIST command can still respond. The fallback is fine for
   * LIST (the client just sees a minimal view) but NOT fine for the existence
   * gate — see `mailboxExists` below.
   */
  listMailboxes = async (): Promise<string[]> => {
    try {
      return await this.listMailboxesOrThrow();
    } catch (error) {
      logger.error("Error listing mailboxes", { component: "imap.store" }, error);
      return ["INBOX"];
    }
  };

  listMailboxEntries = async (): Promise<MailboxEntry[]> => {
    try {
      return await this.listMailboxEntriesOrThrow();
    } catch (error) {
      logger.error(
        "Error listing mailboxes with subscription state",
        { component: "imap.store" },
        error
      );
      return [{ name: "INBOX", subscribed: true }];
    }
  };

  mailboxExists = async (box: string): Promise<boolean> => {
    if (isInbox(box)) return true;
    const mailboxes = await this.listMailboxesOrThrow();
    return mailboxes.includes(box);
  };

  countMessages = async (
    box: string
  ): Promise<{ total: number; unread: number } | null> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await countMessages(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error counting messages", { component: "imap.store", box }, error);
      return null;
    }
  };

  /**
   * UIDNEXT for `box`, read from the UID counter that actually assigns UIDs.
   *
   * Deliberately NOT wrapped in a catch-and-return-null: a swallowed fault here
   * would surface as a too-low UIDNEXT, which is the bug this reads the counter
   * to avoid. Let it propagate to the SELECT/EXAMINE/STATUS handler's tagged
   * `NO … failed`.
   */
  getUidNext = async (box: string): Promise<number> => {
    return await pgGetUidNext(this.user.id, this.resolveUidScope(box));
  };

  /**
   * Get all UIDs in a mailbox, ordered by UID ascending, or null when the
   * query failed. Used for building sequence number mapping, where an empty
   * mailbox and an unreadable one have opposite meanings.
   */
  getAllUids = async (box: string): Promise<number[] | null> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await pgGetAllUids(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error getting all UIDs", { component: "imap.store", box }, error);
      return null;
    }
  };

  /**
   * UID of the first (lowest-UID) unseen message in a mailbox, or null when
   * everything is read. Used to derive the `[UNSEEN <seq>]` SELECT response.
   */
  getFirstUnseenUid = async (box: string): Promise<number | null> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await pgGetFirstUnseenUid(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error getting first unseen UID", { component: "imap.store", box }, error);
      return null;
    }
  };

  /**
   * HIGHESTMODSEQ for a mailbox (RFC 4551 §3.1.1) — the largest mod-sequence of
   * any message routed to it. Backs the `* OK [HIGHESTMODSEQ N]` SELECT/EXAMINE
   * response code and the STATUS HIGHESTMODSEQ item. Falls back to 1 (the
   * DEFAULT-1 floor, never 0) on error so a transient DB hiccup doesn't signal
   * "no persistent mod-sequences".
   */
  getHighestModseq = async (box: string): Promise<number> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await pgGetHighestModseq(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error getting highest modseq", { component: "imap.store", box }, error);
      return 1;
    }
  };

  getMessages = async (
    box: string,
    start: number,
    end: number,
    fields: string[],
    useUid: boolean = false,
    changedSince?: number
  ): Promise<Map<string, StoreFetchedMail>> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      const mailModels = await getMailsByRange(
        this.user.id,
        mailboxArg,
        isSent,
        start,
        end,
        useUid,
        fields.flatMap((f) => this.mapFieldName(f)),
        changedSince
      );

      const mails = new Map<string, StoreFetchedMail>();

      for (const [id, model] of mailModels) {
        const mail: StoreFetchedMail = {
          messageId: model.message_id,
          subject: model.subject,
          date: model.date,
          html: model.html,
          text: model.text,
          read: model.read,
          saved: model.saved,
          sent: model.sent,
          deleted: model.deleted,
          draft: model.draft,
          answered: model.answered,
        };
        // Streaming-body handoff (BODY[] / RFC822 path). When
        // `getRequestedFields` opted into the pg SUBSTRING stream, these
        // four fields carry the identity + pre-measured octet counts the
        // segment builder needs to emit `lazy-text` segments instead of
        // loading the multi-MB text/html columns. Only-set-if-defined so
        // existing consumers (bare-FLAGS fetches etc.) that never
        // requested them see the same shape as before.
        if (model.text_octets !== undefined) mail.text_octets = model.text_octets;
        if (model.html_octets !== undefined) mail.html_octets = model.html_octets;
        if (model.mail_id !== undefined) mail.mail_id = model.mail_id;
        if (model.user_id !== undefined) mail.user_id = model.user_id;
        if (model.uid_domain !== undefined) {
          mail.uid = {
            domain: model.uid_domain,
            // Per-mailbox UID lives in mail_mailbox_uid.uid, aliased as
            // `uid_mailbox` by getMailsByRange's JOIN for account-scoped
            // and user-created mailboxes. Domain-scoped views (INBOX,
            // unified Sent Messages) don't populate it — 0 signals "use
            // uid.domain instead", matching the domain-only wire path.
            account: model.uid_mailbox ?? 0,
          };
        }
        if (model.modseq !== undefined) {
          mail.modseq = model.modseq;
        }
        // rfc822_size: cached BODY[] byte count. `null` on the DB row means
        // "not computed yet"; `undefined` on the model means "not
        // requested" (getRequestedFields didn't add it, e.g. FLAGS-only
        // fetch). Preserve both — the RFC822.SIZE fetch handler
        // distinguishes stored-value hit (typeof === 'number') from
        // fall-through (compute + persist).
        if (model.rfc822_size !== undefined) {
          mail.rfc822_size = model.rfc822_size;
        }

        if (model.from_address) {
          mail.from = {
            value: model.from_address as MailAddressValueType[],
            text: model.from_text || "",
          };
        }
        if (model.to_address) {
          mail.to = {
            value: model.to_address as MailAddressValueType[],
            text: model.to_text || "",
          };
        }
        if (model.cc_address) {
          mail.cc = {
            value: model.cc_address as MailAddressValueType[],
            text: model.cc_text || "",
          };
        }
        if (model.bcc_address) {
          mail.bcc = {
            value: model.bcc_address as MailAddressValueType[],
            text: model.bcc_text || "",
          };
        }
        if (model.reply_to_address) {
          mail.replyTo = {
            value: model.reply_to_address as MailAddressValueType[],
            text: model.reply_to_text || "",
          };
        }
        if (model.envelope_from) {
          mail.envelopeFrom = model.envelope_from as MailAddressValueType[];
        }
        if (model.envelope_to) {
          mail.envelopeTo = model.envelope_to as MailAddressValueType[];
        }
        if (model.attachments) {
          mail.attachments = model.attachments as AttachmentType[];
        }
        if (model.insight) {
          mail.insight = model.insight as Insight;
        }

        mails.set(id, mail);
      }

      return mails;
    } catch (error) {
      logger.error("Error getting messages", { component: "imap.store", box }, error);
      return new Map();
    }
  };

  private mapFieldName(field: string): string[] {
    const fieldMap: Record<string, string[]> = {
      messageId: ["message_id"],
      uid: ["uid_domain", "uid_mailbox"],
      from: ["from_address", "from_text"],
      to: ["to_address", "to_text"],
      cc: ["cc_address", "cc_text"],
      bcc: ["bcc_address", "bcc_text"],
      replyTo: ["reply_to_address", "reply_to_text"],
    };
    return fieldMap[field] || [field];
  }

  setFlags = async (
    box: string,
    start: number,
    end: number,
    flags: string[],
    useUid: boolean = false,
    operation: StoreOperationType = "FLAGS",
    unchangedSince?: number
  ): Promise<SetMailFlagsResult> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await setMailFlags(
        this.user.id,
        mailboxArg,
        isSent,
        start,
        end,
        flags,
        useUid,
        operation,
        unchangedSince
      );
    } catch (error) {
      logger.error("Error setting flags", { component: "imap.store", box, flags }, error);
      return { updated: [], failed: [] };
    }
  };

  /**
   * Permanently delete messages marked with \Deleted flag
   * Returns the UIDs of deleted messages
   */
  expunge = async (box: string): Promise<number[]> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);
      return await expungeDeletedMails(this.user.id, mailboxArg, isSent);
    } catch (error) {
      logger.error("Error expunging messages", { component: "imap.store", box }, error);
      throw error;
    }
  };

  /**
   * Soft-delete a specific set of UIDs in `box` without touching their
   * `\Deleted` flag. Used by RFC 6851 MOVE (§3.3 forbids the
   * COPY+STORE(\Deleted)+EXPUNGE pattern, since EXPUNGE is mailbox-wide
   * and would also remove pre-existing \Deleted-flagged messages).
   * Propagates errors so the MOVE handler can write `NO MOVE failed`
   * instead of falsely emitting OK + COPYUID against a no-op.
   */
  expungeUids = async (box: string, uids: number[]): Promise<number[]> => {
    if (uids.length === 0) return [];
    const { mailboxArg, isSent } = this.resolveMappedBox(box);
    return await expungeMailsByUid(this.user.id, mailboxArg, isSent, uids);
  };

  search = async (
    box: string,
    criteria: SearchCriterion[]
  ): Promise<number[]> => {
    try {
      const { mailboxArg, isSent } = this.resolveMappedBox(box);

      // Convert criteria to a simpler flat format for searchMailsByUid. Every
      // criterion — UID sets (one UID_SET entry per set), flags, text, dates,
      // and nested NOT/OR operands — normalises through simplifyCriterion.
      const simplifiedCriteria: SimplifiedCriterion[] = [];

      for (const criterion of criteria) {
        const simplified = simplifyCriterion(criterion);
        if (simplified) simplifiedCriteria.push(simplified);
      }

      return await searchMailsByUid(
        this.user.id,
        mailboxArg,
        isSent,
        simplifiedCriteria
      );
    } catch (error) {
      logger.error("Error searching messages", { component: "imap.store", box }, error);
      return [];
    }
  };

  /**
   * Store a new mail message. `destination` is the box the write names
   * (`COPY dest`, `MOVE dest`, `APPEND target`); it decides two things:
   *
   * - **Mapping.** Only a mapped destination gets a `mail_mailbox_uid` row
   *   carrying `uid_mailbox`. Domain-scoped destinations (INBOX, unified
   *   `Sent Messages`, the utility folders) enumerate by `uid_domain`; of
   *   those, a destination in the INBOX tree records a second mapping row
   *   holding that `uid_domain`.
   * - **Placement.** A utility folder selects its rows by flag, so a write that
   *   names one sets that flag here rather than relying on the client to have
   *   sent it — an APPEND to `Drafts` without `\Draft` would otherwise land
   *   somewhere the client did not ask for.
   */
  storeMail = async (mail: Mail, destination?: string): Promise<boolean> => {
    try {
      const placement = destination ? utilityPlacement(destination) : undefined;
      const mailbox =
        destination && !isDomainScoped(destination) ? destination : undefined;
      const domainMailbox = destination
        ? domainViewForDestination(destination, !!mail.sent)
        : undefined;
      const input: SaveMailInput = {
        user_id: this.user.id,
        message_id: mail.messageId,
        subject: mail.subject,
        date: mail.date,
        html: mail.html,
        text: mail.text,
        from_address: mail.from?.value,
        from_text: mail.from?.text,
        to_address: mail.to?.value,
        to_text: mail.to?.text,
        cc_address: mail.cc?.value,
        cc_text: mail.cc?.text,
        bcc_address: mail.bcc?.value,
        bcc_text: mail.bcc?.text,
        reply_to_address: mail.replyTo?.value,
        reply_to_text: mail.replyTo?.text,
        envelope_from: mail.envelopeFrom,
        envelope_to: mail.envelopeTo,
        attachments: mail.attachments,
        read: mail.read,
        saved: mail.saved,
        sent: mail.sent,
        deleted: mail.deleted,
        draft: mail.draft,
        answered: mail.answered,
        insight: mail.insight,
        uid_domain: mail.uid?.domain,
        uid_mailbox: mail.uid?.account,
        mailbox,
        domain_mailbox: domainMailbox,
        placement,
      };

      const result = await pgSaveMail(input);
      if (!result) return false;
      if (mail.uid) {
        if (result.uid_mailbox !== undefined) mail.uid.account = result.uid_mailbox;
        if (result.uid_domain !== undefined) mail.uid.domain = result.uid_domain;
      }
      return true;
    } catch (error) {
      logger.error("Error storing mail", { component: "imap.store" }, error);
      return false;
    }
  };
}
