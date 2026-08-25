/** One `mail_mailbox_uid` row a saveMail branch should write for a mail. */
export type MappingWrite = { mailbox: string; uid: number };

export interface MappingWriteInput {
  /** The mapped destination the write named; draws `uid_mailbox`. */
  mailbox?: string;
  uid_mailbox?: number;
  /** A domain view the mail belongs to; draws `uid_domain`. */
  domain_mailbox?: string;
  uid_domain?: number;
  /** The `sent` flag of the row being written, not of the incoming mail. */
  sent: boolean;
}

/**
 * The mapping rows to record for one `mails` row, in order.
 *
 * A box is recorded only when a UID was reserved for it — a write that named
 * no mapped destination reserves no `uid_mailbox`, and the mapping row would
 * address the box at UID 0.
 *
 * `sent` gates the domain view because the two lanes draw `uid_domain` from
 * independent counters. On the merge branch the surviving row can be the sent
 * copy of the same Message-ID, and recording it under a received view would
 * both misfile the mail and put a sent lane's UID into the received lane's
 * number space, where `mail_mailbox_uid`'s unique `(user_id, mailbox, uid)`
 * can collide with a received row that already holds it.
 */
export const decideMappingWrites = ({
  mailbox,
  uid_mailbox,
  domain_mailbox,
  uid_domain,
  sent,
}: MappingWriteInput): MappingWrite[] => {
  const writes: MappingWrite[] = [];
  if (mailbox && (uid_mailbox ?? 0) > 0) writes.push({ mailbox, uid: uid_mailbox as number });
  if (domain_mailbox && !sent && (uid_domain ?? 0) > 0) {
    writes.push({ mailbox: domain_mailbox, uid: uid_domain as number });
  }
  return writes;
};
