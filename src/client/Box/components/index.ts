import { lazy } from "react";

import { Category } from "../../App";
import { queryClient } from "../../lib/queryClient";
import { AccountsCache } from "./Accounts";
import { MailsCache } from "./Mails";
import { listCountInAccounts, missingFromList } from "./Mails/listPages";

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

      const countInAccounts = listCountInAccounts(
        accounts,
        account,
        category,
        allAccounts
      );
      const countInMails =
        !allAccounts && category === Category.SavedMails
          ? mails.filter((e) => e.saved).length
          : mails.length;

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
