import { lazy } from "react";

import { Category } from "../../App";
import { queryClient } from "../../lib/queryClient";
import { AccountsCache } from "./Accounts";
import { MailsCache } from "./Mails";
import { missingFromList } from "./Mails/listPages";

export const Writer = lazy(() => import("./Writer"));
export const Mails = lazy(() => import("./Mails"));
export const Accounts = lazy(() => import("./Accounts"));
export const Settings = lazy(() => import("./Settings"));
export const Thread = lazy(() => import("./Thread"));

export { default as FileIcon } from "./FileIcon";

export class MailsSynchronizer {
  constructor(account: string, category: Category, allAccounts = false) {
    const accountsCache = new AccountsCache();
    this.accountsKey = accountsCache.key;

    const mailsCache = new MailsCache(account, category, allAccounts);
    this.mailsKey = mailsCache.key;

    if (account) {
      const accounts = accountsCache.get();
      const mails = mailsCache.get();

      if (!accounts || !mails) return;

      // The unified list holds received mail from every account, so the
      // expected count is the received total — not the parked account's.
      if (allAccounts) {
        const countInAccounts = accounts.received.reduce(
          (acc, e) => acc + e.doc_count,
          0
        );
        this.difference = missingFromList(
          this.mailsKey,
          countInAccounts,
          mails.length
        );
        return;
      }

      const accountsKey = category === Category.SentMails ? "sent" : "received";
      const accountData = accounts[accountsKey].find((e) => e.key === account);

      let countInAccounts: number;

      if (category === Category.SavedMails)
        countInAccounts =
          (accounts.received.find((e) => e.key === account)?.saved_doc_count ||
            0) +
          (accounts.sent.find((e) => e.key === account)?.saved_doc_count || 0);
      else countInAccounts = accountData?.doc_count || 0;

      const countInMails = mails.reduce((acc, e) => {
        switch (category) {
          case Category.SavedMails:
            if (e.saved) return acc + 1;
            return acc;
          default:
            return acc + 1;
        }
      }, 0);

      this.difference = missingFromList(
        this.mailsKey,
        countInAccounts,
        countInMails
      );
    }
  }

  private accountsKey: string;
  private mailsKey: string;

  /** countInAccounts - countInMails */
  public difference: number = 0;

  public refetchAccounts = () =>
    queryClient.refetchQueries([this.accountsKey], { exact: true });

  public refetchMails = () =>
    queryClient.refetchQueries([this.mailsKey], { exact: true });
}
