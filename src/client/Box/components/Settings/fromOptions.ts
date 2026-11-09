import { AccountsGetResponse } from "server";

/**
 * The addresses offered as the default From: every account on the user's
 * domain that has received or sent mail, plus the saved choice so it stays
 * selectable after its mail is gone. Sorted, without duplicates.
 */
export const fromOptions = (
  accounts: AccountsGetResponse | undefined,
  domainName: string,
  current: string
): string[] => {
  const suffix = "@" + domainName.toLowerCase();
  const keys = new Set<string>();
  if (domainName) {
    for (const { key } of [...(accounts?.received ?? []), ...(accounts?.sent ?? [])]) {
      if (key.toLowerCase().endsWith(suffix)) keys.add(key);
    }
  }
  if (current) keys.add(current);
  return [...keys].sort((a, b) => a.localeCompare(b));
};
