import { useContext, useEffect, useRef } from "react";
import { useQuery } from "react-query";
import { AccountsGetResponse } from "server";
import { Category, Context } from "client";
import {
  accountsQueryUrl,
  fetchAccounts
} from "client/Box/components/Accounts";
import { hasAccountsColumn } from "client/Box/components/Accounts/accountsMenu";
import "./index.scss";

/**
 * What the header shows: the view's name and the unread count that belongs
 * to it. The count follows the title — an account's own unread count next
 * to that account, the all-accounts total next to anything else — so the
 * header never pairs one mailbox's name with another number.
 */
export const headerTitleAndCount = ({
  selectedAccount,
  selectedCategory,
  isAllAccounts,
  isSettingsOpen,
  isNarrow,
  fullEmailHostName,
  newMailsTotal,
  accounts
}: {
  selectedAccount: string;
  selectedCategory: Category;
  isAllAccounts: boolean;
  isSettingsOpen: boolean;
  isNarrow: boolean;
  fullEmailHostName: string;
  newMailsTotal: number;
  accounts: AccountsGetResponse | undefined;
}): { title: string; fullTitle: string; count: number; countLabel: string } => {
  const total = {
    count: newMailsTotal,
    countLabel: `${newMailsTotal} unread in all accounts`
  };
  if (isSettingsOpen) return { title: "Settings", fullTitle: "Settings", ...total };
  // In search `selectedAccount` holds the search term, not an account.
  if (selectedCategory === Category.Search) {
    return { title: "Search", fullTitle: "Search", ...total };
  }
  // The unified view names the view, with the all-accounts total — the
  // parked account behind the flag is not the title.
  if (isAllAccounts) {
    return { title: "All accounts", fullTitle: "All accounts", ...total };
  }
  if (!selectedAccount) {
    const name = "@" + fullEmailHostName;
    return { title: name, fullTitle: name, ...total };
  }
  const unread =
    accounts?.received.find((a) => a.key === selectedAccount)
      ?.unread_doc_count ?? 0;
  return {
    title: isNarrow ? selectedAccount.split("@")[0] : selectedAccount,
    fullTitle: selectedAccount,
    count: unread,
    countLabel: `${unread} unread in ${selectedAccount}`
  };
};

const Header = () => {
  const {
    viewSize,
    domainName,
    userInfo,
    selectedAccount,
    selectedCategory,
    isAllAccounts,
    isSettingsOpen,
    newMailsTotal,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen
  } = useContext(Context);

  // Subscribe to the sidebar's accounts query without fetching, like the
  // list header does, so the count re-renders with every accounts update.
  const accountsQuery = useQuery<AccountsGetResponse>(
    accountsQueryUrl,
    fetchAccounts,
    { enabled: false }
  );

  const username = userInfo?.username;
  const fullEmailHostName =
    username === "admin"
      ? domainName
      : [username, domainName].filter((e) => e).join(".");

  const { title, fullTitle, count, countLabel } = headerTitleAndCount({
    selectedAccount,
    selectedCategory,
    isAllAccounts: !!isAllAccounts,
    isSettingsOpen: !!isSettingsOpen,
    isNarrow: viewSize.width <= 750,
    fullEmailHostName,
    newMailsTotal,
    accounts: accountsQuery.data
  });

  const onClickTitle = () => {
    // The writer docks over the list, so opening the menu closes it.
    if (isWriterOpen) {
      setIsWriterOpen(false);
      setIsAccountsOpen(true);
    } else setIsAccountsOpen(!isAccountsOpen);
  };

  // Escape closes the accounts menu and returns focus to its button.
  const titleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!isAccountsOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      // Handled: views underneath (a mail page) don't also act on it.
      e.preventDefault();
      setIsAccountsOpen(false);
      titleRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAccountsOpen, setIsAccountsOpen]);

  const pill =
    userInfo && count > 0 ? (
      <span
        className="header-unread-count"
        title={countLabel}
        aria-label={countLabel}
      >
        {count}
      </span>
    ) : null;

  // Signed in, the title is the accounts menu button: it names the current
  // mailbox and opens the account list centred beneath it. Where the list is
  // already a column on screen there is no menu to open, so the title is
  // plain text. Search and Compose live in the rail (the bottom bar on a
  // phone), which is always on screen.
  const isMenuButton = !!userInfo && !hasAccountsColumn(viewSize.width);
  return (
    <header id="title_bar" className="sticky">
      {isMenuButton ? (
        <h1>
          <button
            type="button"
            ref={titleRef}
            className={"title-button" + (isAccountsOpen ? " open" : "")}
            aria-haspopup="true"
            aria-expanded={!!isAccountsOpen}
            aria-controls="accounts-menu"
            title={`${fullTitle} — switch account`}
            onClick={onClickTitle}
          >
            <span className="title-text">{title}</span>
            {pill}
            <ChevronIcon />
          </button>
        </h1>
      ) : (
        <h1 title={fullTitle}>
          <span className="title-text">{title}</span>
          {pill}
        </h1>
      )}
    </header>
  );
};

const ChevronIcon = () => (
  <svg
    className="title-chevron"
    aria-hidden="true"
    viewBox="0 0 16 16"
    width="16"
    height="16"
  >
    <path
      d="M3.5 6l4.5 4.5L12.5 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export default Header;
