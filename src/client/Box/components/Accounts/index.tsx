import {
  useState,
  useContext,
  useEffect,
  Dispatch,
  SetStateAction
} from "react";
import { useQuery } from "react-query";

import {
  SkeletonAccount,
  SkeletonCategory,
  SearchIcon,
  RefreshIcon,
  LogoutIcon,
  SettingsIcon,
  InboxIcon,
  FoldersIcon,
  SortDownIcon,
  SortUpIcon,
  FoldersSheet
} from "./components";
import { EmptyStarIcon, BanIcon } from "../Mails/components";
import { SendIcon } from "../Writer/components";
import WriteIcon from "../../../Header/components/RightMenu/components/WriteIcon";

import { Account } from "common";
import {
  AccountsGetResponse,
  LoginDeleteResponse,
  SearchAccountsGetResponse
} from "server";
import {
  Context,
  Category,
  useLocalStorage,
  QueryCache,
  call,
  onKeyboardActivate,
  clearCachedQueries,
  unregisterServiceWorker,
  getLocalStorageItem,
  useIsOnline,
  useFeedback
} from "client";
import { MailsSynchronizer } from "client/Box";
import {
  accountsForCategory,
  categoryForAccount
} from "./selectableAccounts";
import {
  accountBadge,
  displayNameFor,
  duplicatedDisplayNames,
  filterAccounts,
  folderBadge,
  folderBadgeCounts
} from "./accountList";
import { useAnchoredSelectedAccount } from "./useAnchoredSelectedAccount";
import { opensAccountsAfterFolderChange } from "./accountsMenu";
import { sharedAccountKeys, withSharedAccounts } from "./sharedAccounts";

import "./index.scss";

export const accountsQueryUrl = "/api/mails/accounts";

export class AccountsCache extends QueryCache<AccountsGetResponse> {
  constructor() {
    super(accountsQueryUrl);
  }
}

// Shared by the Accounts sidebar and by the list header, which subscribes to
// the same query key (enabled: false — it never fetches, it only re-renders
// when the sidebar's data changes) to show the selected account's count.
export const fetchAccounts = async () => {
  const { status, body, message } = await call.get<AccountsGetResponse>(
    accountsQueryUrl
  );
  if (status === "success") return withSharedAccounts(body as AccountsGetResponse);
  else throw new Error(message);
};

let isFetched = false;

enum SortBy {
  Date = "Sort by Date",
  Size = "Sort by Size",
  Name = "Sort by Name"
}

const Accounts = ({
  setPage
}: {
  setPage: Dispatch<SetStateAction<number>>;
}) => {
  const [sortBy, setSortBy] = useLocalStorage<SortBy>("sortBy", SortBy.Name);
  const [sortAscending, setSortAscending] = useLocalStorage(
    "sortAscending",
    true
  );
  const [showSortOptions, setShowSortOptions] = useState(false);
  // The narrow-nav Folders sheet (design doc §4, option A): open from the
  // bottom bar's Folders entry, which only the ≤750px bar shows.
  const [isFoldersSheetOpen, setIsFoldersSheetOpen] = useState(false);
  // Substring filter for the accounts list (design doc §8): local view state
  // only — it never touches the selection or the folder.
  const [accountFilter, setAccountFilter] = useState("");

  const {
    viewSize,
    setUserInfo,
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory,
    isAllAccounts,
    setIsAllAccounts,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen,
    isSettingsOpen,
    setIsSettingsOpen,
    newMailsTotal,
    setNewMailsTotal,
    preSearchAccount,
    enterSearch,
    hasDraft
  } = useContext(Context);

  const { isOnline } = useIsOnline();
  const { confirm } = useFeedback();

  const getAccounts = async () => {
    const accounts = await fetchAccounts();
    // Cleared on arrival, not on request: onSuccess also runs for cache
    // edits made while the request is in flight.
    isFetched = false;
    return accounts;
  };

  const onSuccess = (data: AccountsGetResponse) => {
    setNewMailsTotal(data.unread_mail_count);

    if (!isFetched) {
      const sync = new MailsSynchronizer(
        selectedAccount,
        selectedCategory,
        isAllAccounts
      );
      if (sync.difference > 0) sync.refetchMails();
      isFetched = true;
    }
  };

  const query = useQuery<AccountsGetResponse>(accountsQueryUrl, getAccounts, {
    onSuccess,
    cacheTime: Infinity,
    refetchInterval: 1000 * 60 * 10,
    refetchIntervalInBackground: true,
    refetchOnMount: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: false,
    retry: false
  });

  // In search mode `selectedAccount` holds the search term. Fetch the accounts
  // that own a matching mail so the side-tab can list them (clicking one jumps
  // to that account's All view). Empty term → disabled, so the tab stays empty
  // until the user types.
  const searchValue =
    selectedCategory === Category.Search ? selectedAccount : "";
  const searchAccountsQuery = useQuery<SearchAccountsGetResponse>(
    ["/api/mails/search-accounts", searchValue],
    async () => {
      const { status, body, message } =
        await call.get<SearchAccountsGetResponse>(
          `/api/mails/search-accounts/${encodeURIComponent(searchValue)}`
        );
      if (status === "success") return body as SearchAccountsGetResponse;
      throw new Error(message);
    },
    { enabled: !!searchValue, cacheTime: 0, retry: false }
  );

  // The folder-level badge totals (design doc §5/§9): the same per-folder
  // rule as the Folders sheet — saved for Saved, unread everywhere else —
  // summed over the accounts payload already in hand. Shared by the rail
  // folder tabs below and the narrow-nav sheet.
  const folderCounts = folderBadgeCounts(query.data);

  const touchStartHandler = () => setShowSortOptions(false);

  useAnchoredSelectedAccount(
    selectedAccount,
    selectedCategory,
    query.isSuccess ? query.data : undefined,
    setSelectedAccount
  );

  useEffect(() => {
    window.addEventListener("touchstart", touchStartHandler);
    return () => {
      window.removeEventListener("touchstart", touchStartHandler);
    };
  }, []);

  if (query.isLoading) {
    return (
      <div className="tab-holder">
        <div className="categories skeleton">
          <div>
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
            <SkeletonCategory />
          </div>
          <div>
            <SkeletonCategory />
            <SkeletonCategory />
          </div>
        </div>
        <div className="accounts">
          <div className="sort_box">
            <div />
          </div>
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
          <SkeletonAccount />
        </div>
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="tab-holder">
        <div className="categories"></div>
        <div className="accounts">Accounts List Request Failed</div>
      </div>
    );
  }

  if (query.isSuccess) {
    const { received = [], sent = [], spam = [] } = query.data || {};
    const sharedKeys = sharedAccountKeys(query.data);

    const renderAccount = (data: Account, i: number) => {
      const accountName = data.key;
      const badge = accountBadge(data, selectedCategory);
      const displayName = displayNameFor(accountName);
      const onClickAccount = () => {
        // A found account in the search side-tab jumps to the category that
        // lists it (the search term lives in selectedAccount, so we must
        // switch category as well as the account).
        if (selectedCategory === Category.Search) {
          setPage(1);
          // Jumping to the account's folder is navigation: close the
          // writer, like onClickCategory does.
          setIsWriterOpen(false);
          setIsSettingsOpen(false);
          setSelectedCategory(
            categoryForAccount(accountName, { received, sent, spam })
          );
          setSelectedAccount(accountName);
          // Picking an account leaves the unified view: the list is that
          // account's folder, not all accounts.
          setIsAllAccounts(false);
          setIsAccountsOpen(false);
          return;
        }
        // Picking an account is navigation, like a folder tap: the writer
        // docks over the list it switches to.
        setIsWriterOpen(false);
        setIsSettingsOpen(false);
        if (selectedAccount !== accountName) {
          setPage(1);
          setSelectedAccount(accountName);
        }
        // Picking an account leaves the unified view: the list is that
        // account's folder, not all accounts.
        setIsAllAccounts(false);
        // Picking an account is the menu's job done.
        setIsAccountsOpen(false);
      };

      const isSelected = selectedAccount === accountName;
      const isShared = sharedKeys.has(accountName);
      const classes = ["tag", "cursor"];
      if (isSelected) classes.push("clicked");
      if (isShared) classes.push("shared");

      // One full-width row per account: the name truncates instead of
      // wrapping, and the count sits at the row's end rather than over its
      // corner, so long names and big counts never collide.
      return (
        <button
          key={i}
          type="button"
          className={classes.join(" ")}
          aria-current={isSelected ? "true" : undefined}
          title={isShared ? `${accountName} (read-only)` : accountName}
          onClick={onClickAccount}
        >
          <span className="tag-text">
            <span className="account-name">{displayName}</span>
            {duplicatedNames.has(displayName) || isShared ? (
              <span className="account-address">
                {accountName}
                {isShared ? " · read-only" : ""}
              </span>
            ) : null}
          </span>
          {badge.count ? (
            <span
              className={"count-badge " + badge.tone}
              aria-label={badge.label}
              title={badge.label}
            >
              {badge.count}
            </span>
          ) : null}
        </button>
      );
    };

    // The rows rendered here and the selections `resolveSelectedAccount`
    // accepts have to be the same set, or a highlighted name sits over an empty
    // pane again. Search is the one list the resolver does not decide: its
    // side-tab is fed by the search query, and `selectedAccount` holds the term.
    const sortedAccountData: Account[] =
      selectedCategory === Category.Search
        ? searchAccountsQuery.data || []
        : accountsForCategory(selectedCategory, { received, sent, spam });

    const sortingFactor = 2 * +sortAscending - 1;

    if (sortBy === SortBy.Name) {
      sortedAccountData.sort(
        (a, b) => (2 * +(a.key > b.key) - 1) * sortingFactor
      );
    } else if (sortBy === SortBy.Date) {
      sortedAccountData.sort(
        (a, b) => (+new Date(a.updated) - +new Date(b.updated)) * sortingFactor
      );
    } else if (sortBy === SortBy.Size) {
      const sortKey =
        selectedCategory === Category.SavedMails
          ? "saved_doc_count"
          : "doc_count";
      sortedAccountData.sort(
        (a, b) => (a[sortKey] - b[sortKey]) * sortingFactor
      );
    }

    // The filter narrows the visible rows only; the selection, the sort, and
    // the folder are untouched. Duplicates are judged over the visible list,
    // so a filter that hides one of a pair needs no disambiguation.
    const filteredAccountData = filterAccounts(
      sortedAccountData,
      accountFilter
    );
    const duplicatedNames = duplicatedDisplayNames(filteredAccountData);
    const accountComponents = filteredAccountData.map(renderAccount);

    const categoryIcons = {
      [Category.AllMails]: InboxIcon,
      [Category.SavedMails]: EmptyStarIcon,
      [Category.SentMails]: SendIcon,
      [Category.SpamMails]: BanIcon,
      [Category.Search]: SearchIcon
    };

    // Shared by the rail items and the narrow-nav Folders sheet: tapping a
    // folder is navigation, so it closes the writer (design doc §4; the
    // draft is safe — fields persist in localStorage and the writer stays
    // mounted when closed).
    const onClickCategory = (category: Category) => {
      if (category === Category.Search) {
        // Entering search parks the current account and folder and starts
        // from an empty term (design doc §9). The search box lives in the
        // center column, so the accounts menu stays closed — it would cover
        // the box. The unified flag is untouched: search parks it with the
        // account, and clearing the search returns to the view.
        enterSearch();
        return;
      }

      // Navigating closes the writer: the writer docks over the list,
      // so leaving it open would hide the view the tap just switched to.
      setIsWriterOpen(false);
      setIsSettingsOpen(false);

      // Folder navigation is per-account: switching folders leaves the
      // unified view (the "All accounts" entry below is the way back in).
      setIsAllAccounts(false);

      // Leaving search restores the pre-search account (selectedAccount
      // currently holds the search term, so we can't read it here).
      // Otherwise the selection is left alone: changing folders never
      // changes the selected mailbox (design doc §8). A name no list holds
      // is cleaned up by the anchor hook, not by re-anchoring here.
      if (selectedCategory === Category.Search && preSearchAccount.current) {
        setSelectedAccount(preSearchAccount.current);
      }
      setSelectedCategory(category);
      // On a phone the account list is hidden behind the header, so moving
      // to another folder opens it: picking the account is the next step.
      setIsAccountsOpen(
        opensAccountsAfterFolderChange(
          viewSize.width,
          selectedCategory,
          category
        )
      );
    };

    // The "All accounts" entry (design doc §8, Phase 2 item 10): the unified
    // view is a view, not an account — picking it never touches
    // `selectedAccount`, so leaving it restores the previous account and
    // folder exactly. Picking it is the menu's job done, like picking an
    // account: the panel closes rather than staying open for a next pick.
    const onClickAllAccounts = () => {
      if (isAllAccounts && selectedCategory === Category.AllMails) {
        setIsAccountsOpen(false);
        return;
      }
      setIsWriterOpen(false);
      setIsSettingsOpen(false);
      // Leaving search restores the pre-search account into the parked
      // selection, like onClickCategory does — the unified view keeps it
      // parked behind the flag.
      if (selectedCategory === Category.Search && preSearchAccount.current) {
        setSelectedAccount(preSearchAccount.current);
      }
      setPage(1);
      setSelectedCategory(Category.AllMails);
      setIsAllAccounts(true);
      setIsAccountsOpen(false);
    };

    // While Settings is open no folder is the current view.
    const currentFolder = isSettingsOpen ? undefined : selectedCategory;

    const categoryComponents = Object.values(Category).map((e, i) => {
      const classes = ["rail-item"];
      if (currentFolder === e) classes.push("clicked");
      // The four folder items hide on the narrow bar — the Folders entry
      // opens them as a sheet instead (design doc §4, option A). Search
      // stays: it is one of the narrow bar's five items.
      if (e !== Category.Search) classes.push("folder-rail-item");

      const Icon = categoryIcons[e];
      // Numeric unread count per folder tab (design doc §5/§9) — the
      // folder-level totals from the accounts payload. The highlighted tab
      // shows no badge.
      type FolderCategory = Exclude<Category, Category.Search>;
      const badge =
        e === Category.Search
          ? undefined
          : folderBadge(e as FolderCategory, folderCounts);
      const showBadge = !!badge && badge.count > 0;

      return (
        <div
          key={i}
          className={classes.join(" ")}
          role="tab"
          tabIndex={0}
          aria-selected={currentFolder === e}
          aria-label={
            showBadge ? `${e}, ${badge.label}` : e
          }
          onClick={() => onClickCategory(e)}
          onKeyDown={onKeyboardActivate(() => onClickCategory(e))}
        >
          <Icon />
          <span className="rail-label">{e.split(" ")[0]}</span>
          {showBadge ? (
            <div
              className={"numberBall" + (badge.tone === "neutral" ? " neutral" : "")}
              aria-hidden="true"
            >
              {badge.count}
            </div>
          ) : null}
        </div>
      );
    });

    const sortOptionComponents = Object.values(SortBy).map((e, i) => {
      const onClickSortOption = () => {
        if (e !== sortBy) {
          setSortBy(e);
          if (e === SortBy.Name) setSortAscending(true);
          else setSortAscending(false);
        }
        setShowSortOptions(false);
      };

      return (
        <button
          key={i}
          type="button"
          className="sort_option cursor"
          role="option"
          aria-selected={e === sortBy}
          autoFocus={e === sortBy}
          onClick={onClickSortOption}
          onTouchStart={(e) => e.stopPropagation()}
        >
          {e}
        </button>
      );
    });

    const onClickCompose = () => {
      // One overlay at a time on narrow screens: the writer docks over the
      // list, so the accounts overlay (which also covers the list) closes.
      if (!isWriterOpen && isAccountsOpen) setIsAccountsOpen(false);
      setIsWriterOpen(!isWriterOpen);
    };

    // Opening Settings is navigation: the writer and, on narrow screens, the
    // accounts overlay both cover the center column the page opens in.
    const onClickSettings = () => {
      if (!isSettingsOpen) {
        setIsWriterOpen(false);
        if (isAccountsOpen) setIsAccountsOpen(false);
      }
      setIsSettingsOpen(!isSettingsOpen);
    };

    // Refresh re-fetches without moving the selection: the account, folder,
    // scroll position, and open/closed state all stay where they were
    // (design doc §8). `query.isFetching` drives the spinner on the rail
    // item while the round-trip runs.
    const onClickRefresh = () => {
      query.refetch();
    };

    const onClickLogout = async () => {
      const confirmed = await confirm({
        title: "Log out?",
        message: "Drafts and cached mail on this device are cleared.",
        confirmLabel: "Log out"
      });
      if (!confirmed) return;
      // Drop the server-side push subscription while the session is still live —
      // the unsubscribe route is authenticated, so this must run before the
      // logout call below tears the session down. Best-effort: call.delete never
      // throws.
      const pushSubscriptionId = getLocalStorageItem("push_subscription_id");
      if (pushSubscriptionId) {
        await call.delete("/api/push/subscribe/" + pushSubscriptionId);
      }
      const response = await call.delete<LoginDeleteResponse>(
        "/api/users/login"
      );
      if (response.status !== "success") return;
      await clearCachedQueries();
      await unregisterServiceWorker();
      [
        "name",
        "to",
        "cc",
        "bcc",
        "subject",
        "sender",
        "initialContent",
        "originalMessage",
        "originalMessageMeta",
        "isCcOpen",
        "push_subscription_id"
      ].forEach((key) => localStorage.removeItem(key));
      setUserInfo(undefined);
      setSelectedAccount("");
      // A single sign-on session ends at the provider too, which sends the
      // browser back here afterwards.
      const logoutUrl = response.body?.logoutUrl;
      if (logoutUrl) window.location.assign(logoutUrl);
    };

    // The Folders sheet rows (design doc §4, option A): the four folders
    // with their badge totals from the accounts payload already in hand.
    const sheetFolders = (
      [
        Category.AllMails,
        Category.SavedMails,
        Category.SentMails,
        Category.SpamMails
      ] as const
    ).map((category) => {
      const badge = folderBadge(category, folderCounts);
      return { category, count: badge.count, tone: badge.tone };
    });

    return (
      <div className="tab-holder">
        <nav className="categories" aria-label="Folders">
          <div>
            <div
              className="rail-item folders-rail-item"
              role="button"
              tabIndex={0}
              aria-haspopup="dialog"
              aria-expanded={isFoldersSheetOpen}
              onClick={() => setIsFoldersSheetOpen(true)}
              onKeyDown={onKeyboardActivate(() =>
                setIsFoldersSheetOpen(true)
              )}
            >
              <FoldersIcon />
              <span className="rail-label">Folders</span>
            </div>
            {categoryComponents}
            <div
              className={"rail-item" + (isWriterOpen ? " clicked" : "")}
              role="button"
              tabIndex={0}
              aria-pressed={isWriterOpen}
              aria-label={
                isWriterOpen
                  ? "Close compose"
                  : hasDraft
                    ? "Compose new mail (draft saved)"
                    : "Compose new mail"
              }
              onClick={onClickCompose}
              onKeyDown={onKeyboardActivate(onClickCompose)}
            >
              <WriteIcon />
              <span className="rail-label">Compose</span>
              {hasDraft ? <div className="numberBall" /> : null}
            </div>
          </div>
          <div>
            <div
              className={"rail-item" + (isSettingsOpen ? " clicked" : "")}
              role="button"
              tabIndex={0}
              aria-label="Settings"
              aria-pressed={isSettingsOpen}
              onClick={onClickSettings}
              onKeyDown={onKeyboardActivate(onClickSettings)}
            >
              <SettingsIcon />
              <span className="rail-label">Settings</span>
            </div>
            <div
              className={"rail-item" + (query.isFetching ? " refreshing" : "")}
              role="button"
              tabIndex={0}
              aria-label="Refresh"
              aria-busy={query.isFetching}
              onClick={onClickRefresh}
              onKeyDown={onKeyboardActivate(onClickRefresh)}
            >
              <RefreshIcon />
              <span className="rail-label">Refresh</span>
            </div>
          </div>
        </nav>
        {isFoldersSheetOpen ? (
          <FoldersSheet
            folders={sheetFolders}
            selectedCategory={currentFolder}
            onSelectFolder={onClickCategory}
            onClose={() => setIsFoldersSheetOpen(false)}
          />
        ) : null}
        <aside className="accounts" id="accounts-menu" aria-label="Accounts">
          <div className="accounts_header">
            {/* The unified "All accounts" entry (design doc §8, Phase 2 item
             * 10): received mail across every alias, unread-then-recent.
             * It sits in the sticky header — always at the top of the
             * column, above the filter — and reuses the account row's shape
             * and unread badge. It is a view, not an account: picking it
             * never changes the selected account. */}
            <button
              type="button"
              className={
                "tag cursor" +
                (isAllAccounts && selectedCategory === Category.AllMails
                  ? " clicked"
                  : "")
              }
              aria-current={
                isAllAccounts && selectedCategory === Category.AllMails
                  ? "true"
                  : undefined
              }
              title="All accounts"
              onClick={onClickAllAccounts}
            >
              <span className="tag-text">
                <span className="account-name">All accounts</span>
              </span>
              {newMailsTotal ? (
                <span
                  className="count-badge unread"
                  aria-label={`${newMailsTotal} unread`}
                  title={`${newMailsTotal} unread`}
                >
                  {newMailsTotal}
                </span>
              ) : null}
            </button>
            <div className="filter_box">
              <input
                type="search"
                value={accountFilter}
                onChange={(e) => setAccountFilter(e.target.value)}
                placeholder="Filter accounts…"
                aria-label="Filter accounts"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck="false"
              />
              {accountFilter ? (
                <button
                  type="button"
                  className="clear-button"
                  aria-label="Clear filter"
                  onClick={() => setAccountFilter("")}
                >
                  ×
                </button>
              ) : null}
            </div>
            <div className="sort_box">
            {showSortOptions ? (
              <></>
            ) : (
              <button
                type="button"
                className="sort_icon cursor"
                aria-label={
                  sortAscending ? "Sort ascending" : "Sort descending"
                }
                title={
                  sortAscending
                    ? "Ascending — click for descending"
                    : "Descending — click for ascending"
                }
                onClick={() => setSortAscending(!sortAscending)}
              >
                <div>
                  <SortDownIcon className={sortAscending ? "" : "highlight"} />
                  <SortUpIcon className={sortAscending ? "highlight" : ""} />
                </div>
              </button>
            )}
            <div className="sort_text">
              {showSortOptions ? (
                <></>
              ) : (
                <button
                  type="button"
                  className="sort_current cursor"
                  aria-haspopup="listbox"
                  aria-expanded={false}
                  onClick={() => setShowSortOptions(true)}
                >
                  {sortBy}
                </button>
              )}
              {showSortOptions ? (
                <div
                  className="sort_select"
                  role="listbox"
                  aria-label="Sort accounts by"
                  onMouseLeave={() => setShowSortOptions(false)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setShowSortOptions(false);
                  }}
                >
                  {sortOptionComponents}
                </div>
              ) : (
                <></>
              )}
            </div>
          </div>
          </div>
          <div className="tags_container">
            {accountComponents.length ? (
              accountComponents
            ) : accountFilter ? (
              <p className="accounts_empty">
                No accounts match “{accountFilter}”.
              </p>
            ) : null}
          </div>
          <div className="accounts_footer">
            <button
              type="button"
              className="accounts-logout"
              onClick={onClickLogout}
              aria-label="Logout"
              disabled={!isOnline}
              title={
                isOnline
                  ? "Logout"
                  : "You're offline — reconnect to log out"
              }
            >
              <LogoutIcon />
              <span>Logout</span>
            </button>
          </div>
        </aside>
      </div>
    );
  }

  return <></>;
};

export default Accounts;
