import {
  useState,
  useContext,
  useEffect,
  useMemo,
  Dispatch,
  ReactNode,
  SetStateAction
} from "react";
import { useQuery, useQueryClient } from "react-query";
import { useNavigate } from "react-router-dom";
import { marked } from "marked";
import { MailHeaderData } from "common";

import {
  ApiResponse,
  AccountsGetResponse,
  MarkMailPostBody,
  MarkMailPostResponse,
  SearchGetResponse,
  MailDeleteResponse,
  SpamMarkPostBody,
  SpamMarkPostResponse
} from "server";

import {
  MailHeader,
  SkeletonMail,
  KebabIcon,
  NewTabIcon,
  ReplyIcon,
  ShareIcon,
  TrashIcon,
  EmptyStarIcon,
  SolidStarIcon,
  RobotIcon,
  BanIcon,
  CircleCheckIcon,
  CloseIcon,
  SearchBox
} from "./components";

import {
  Context,
  Category,
  Density,
  QueryCache,
  call,
  isSentMail,
  canMarkSpam,
  useIsOnline,
  revalidateOnMountPolicy,
  formatDataAge,
  isShowingStaleData,
  useFeedback,
  useResolvedTheme
} from "client";
import {
  AccountsCache,
  accountsQueryUrl,
  fetchAccounts
} from "client/Box/components/Accounts";
import { getMailsQueryUrl } from "./mailsQuery";
import {
  fetchList,
  fetchNextListPage,
  hasNextListPage,
  listCountInAccounts,
  restoreListPaging,
  snapshotListPaging
} from "./listPages";

/** Rows kept loaded beyond the ones on screen: three scroll steps of eight. */
const PREFETCH_ROWS = 24;
import { emptyFolderState } from "./emptyState";
import {
  Conversation,
  conversationSenders,
  groupConversations,
  ownAddressesFor
} from "./conversations";
import { openMailInNewTab, useStartReply } from "./mailActions";
import { FROM_LIST_STATE, mailPagePath } from "./mailPage";
import {
  UNDO_WINDOW_MS,
  cancelDelete,
  scheduleDelete,
  withoutPendingDeletes
} from "./pendingDeletes";
import { trackMarkRead, withPendingReads } from "./pendingReads";
import { useRefusedWrites } from "./refusedWrites";
import {
  accountCountForCategory,
  accountForMail,
  allAccountsCount,
  bucketsForMail,
  evictAccountFromCategory,
  updateAccountInBuckets
} from "./accountsBucket";

import "./index.scss";

const GettingStarted = () => {
  const queryUrl = "/text/getting_started.md";

  const fetchMessage = () => call.text(queryUrl).then((r) => marked(r));

  const query = useQuery<string>(queryUrl, fetchMessage);

  return (
    <div className="getting_started">
      <div dangerouslySetInnerHTML={{ __html: query.data || "" }} />
    </div>
  );
};

export class MailsCache extends QueryCache<MailHeaderData[]> {
  constructor(account: string, category: Category, allAccounts = false) {
    super(getMailsQueryUrl(account, category, allAccounts));
  }
}

// List header (design doc §5): the current folder with the selected
// account's count from the accounts buckets. The count is per-account — the
// same doc_count / unread_doc_count the sidebar already carries — not the
// loaded page size.
const ListHeader = ({ countLabel }: { countLabel: string }) => (
  <div className="list-header">
    <div className="list-header-count">{countLabel}</div>
  </div>
);

/**
 * One icon button in a row's action box. A real <button> with a spoken
 * label, so the row's actions are reachable and operable from the keyboard.
 * Clicks stop at the button: the row behind it opens the mail on click.
 */
const RowAction = ({
  label,
  onClick,
  disabled,
  autoFocus,
  ariaHasPopup,
  children
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaHasPopup?: boolean;
  children: ReactNode;
}) => (
  <button
    type="button"
    className={"iconBox cursor" + (disabled ? " disabled" : "")}
    title={label}
    aria-label={label}
    aria-disabled={disabled || undefined}
    aria-haspopup={ariaHasPopup || undefined}
    autoFocus={autoFocus}
    onClick={(e) => {
      e.stopPropagation();
      onClick();
    }}
    onTouchStart={(e) => e.stopPropagation()}
  >
    {children}
  </button>
);

interface RenderedMailProps {
  /** The row's conversation; `mail` is its newest message. */
  conversation: Conversation;
  /** The row's sender line, e.g. "Alice, me". */
  senders: string;
  requestMarkRead: (
    mail: MailHeaderData
  ) => Promise<ApiResponse<MarkMailPostResponse>>;
  markReadInQueryData: (mail: MailHeaderData) => void;
  requestDeleteMail: (
    mail: MailHeaderData
  ) => Promise<ApiResponse<MailDeleteResponse>>;
  requestMarkSpam: (
    mail: MailHeaderData,
    isSpam: boolean
  ) => Promise<ApiResponse<SpamMarkPostResponse>>;
  selectedAccount: string;
  accountsCache: AccountsCache;
  selectedCategory: Category;
  removeAccountFromQueryData: () => void;
  requestMarkSaved: (
    mail: MailHeaderData,
    saved: boolean
  ) => Promise<ApiResponse<MarkMailPostResponse>>;
  markSavedInQueryData: (mail: MailHeaderData, saved: boolean) => void;
  openedKebab: string;
  setOpenedKebab: Dispatch<SetStateAction<string>>;
  density: Density;
  isSent: boolean;
  /**
   * Whether this row renders in the unified "All accounts" list. The row's
   * mail may belong to any account there, so the handlers below resolve the
   * mail's own account for bucket edits and the list cache is the unified
   * one, not the parked account's.
   */
  unified: boolean;
  /** The accounts payload, for resolving a mail to its own account. */
  accountsData: AccountsGetResponse | undefined;
}

const RenderedMail = ({
  conversation,
  senders,
  requestMarkRead,
  markReadInQueryData,
  requestDeleteMail,
  requestMarkSpam,
  selectedAccount,
  accountsCache,
  selectedCategory,
  removeAccountFromQueryData,
  requestMarkSaved,
  markSavedInQueryData,
  openedKebab,
  setOpenedKebab,
  density,
  isSent,
  unified,
  accountsData
}: RenderedMailProps) => {
  // The account a mail in this list belongs to. In the unified view that is
  // the mail's own account, not the parked selection; everywhere else the
  // derivation finds the selected account (or falls back to it when the row
  // carries no recipient naming an account, e.g. from an older cache).
  const resolveMailAccount = (mail: MailHeaderData) =>
    accountForMail(mail, accountsData) ?? selectedAccount;
  const mail = conversation.latest;
  const mails = conversation.mails;
  const { theme = "system" } = useContext(Context);
  const resolvedTheme = useResolvedTheme(theme);

  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  const { isOnline } = useIsOnline();

  const queryClient = useQueryClient();
  const { showToast } = useFeedback();
  const watchWrites = useRefusedWrites();
  const navigate = useNavigate();
  const startReply = useStartReply();

  const onClickOpenInNewTab = () =>
    openMailInNewTab(queryClient, mail.id, resolvedTheme).catch(console.error);

  // A row opens its newest message's page, with the whole conversation.
  const onClickMailcard = () => {
    // Auto-mark-read is a side effect of opening, not a user-clicked
    // control — so gate the request itself when offline rather than
    // disabling a button. The page still opens and renders cached data.
    const unread = isOnline ? mails.filter((m) => !m.read) : [];
    if (unread.length) {
      watchWrites(
        unread.map((m) => {
          const request = requestMarkRead(m);
          trackMarkRead(m.id, request);
          // No direct `m.read` edit: markReadInQueryData already copy-replaces the row with read: true.
          markReadInQueryData(m);
          return request;
        })
      );
    }
    navigate(mailPagePath(mail.id), { state: FROM_LIST_STATE });
  };

  const onClickReply = () => {
    startReply(mail, "reply").catch(console.error);
  };

  const onClickShare = () => {
    startReply(mail, "forward").catch(console.error);
  };

  // Takes the row's messages out of the cached list and their counts out of
  // the accounts payload.
  const removeFromList = (removed: MailHeaderData[]) => {
    const ids = new Set(removed.map((m) => m.id));
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      return removed.reduce((oldData, mail) => {
        const mailAccount = resolveMailAccount(mail);
        return updateAccountInBuckets(
          oldData,
          bucketsForMail(selectedCategory, mail, mailAccount),
          mailAccount,
          ({ doc_count, unread_doc_count }) => ({
            doc_count: doc_count - 1,
            unread_doc_count:
              !mail.read && unread_doc_count
                ? unread_doc_count - 1
                : unread_doc_count
          })
        );
      }, oldData);
    });
    // The unified cache is the list itself, whatever account the row came
    // from; the per-account cache is the parked account's only in the
    // single-account views.
    new MailsCache(selectedAccount, selectedCategory, unified).set(
      (oldData) => {
        if (!oldData) return oldData;
        const newData = oldData.filter((m) => !ids.has(m.id));
        // Emptying the unified list means every account is empty here, not
        // that the parked account left its bucket — never evict it.
        if (!newData.length && !unified) removeAccountFromQueryData();
        return newData;
      }
    );
  };

  // Deletes every message of the conversation in this list.
  const onClickTrash = () => {
    if (!isOnline) return;

    // Snapshot the caches so Undo can put the row back exactly where it was.
    const listUrl = getMailsQueryUrl(selectedAccount, selectedCategory, unified);
    const listBefore = queryClient.getQueryData<MailHeaderData[]>(listUrl);
    const pagingBefore = snapshotListPaging(listUrl);
    const accountsBefore = queryClient.getQueryData<AccountsGetResponse>(
      accountsCache.key
    );

    removeFromList(mails);

    // No confirm: the delete waits out the undo window instead, so a slip
    // costs one tap on Undo rather than the mail.
    mails.forEach((m) =>
      scheduleDelete(m.id, () => {
        watchWrites([requestDeleteMail(m)]).then((landed) => {
          if (landed) queryClient.invalidateQueries(accountsCache.key);
        });
      })
    );

    showToast({
      message: mails.length > 1 ? "Conversation deleted." : "Mail deleted.",
      duration: UNDO_WINDOW_MS,
      action: {
        label: "Undo",
        onClick: () => {
          const cancelled = mails.map((m) => cancelDelete(m.id));
          if (!cancelled.some(Boolean)) return;
          if (listBefore) {
            queryClient.setQueryData(listUrl, listBefore);
            restoreListPaging(listUrl, pagingBefore);
          }
          if (accountsBefore) {
            queryClient.setQueryData(accountsCache.key, accountsBefore);
          }
        }
      }
    });
  };

  // A saved conversation unsaves every saved message in it; an unsaved one
  // saves its newest message.
  const onClickStar = () => {
    if (!isOnline) return;
    const targets = conversation.saved ? mails.filter((m) => m.saved) : [mail];
    watchWrites(
      targets.map((m) => {
        markSavedInQueryData(m, !conversation.saved);
        return requestMarkSaved(m, !conversation.saved);
      })
    );
  };

  const isSpamView = selectedCategory === Category.SpamMails;
  const spamTargets = mails.filter((m) => canMarkSpam(m, selectedCategory));
  const canToggleSpam = spamTargets.length > 0;

  const onClickSpam = () => {
    if (!isOnline) return;

    // In the spam view the button un-marks (Not Spam); everywhere else it
    // marks as spam. Either way the mail leaves the current list.
    const nextIsSpam = !isSpamView;

    // Where the mail lands: the Spam view when marking, the All Mails view
    // when un-marking. Refreshing it on navigation avoids a stale destination.
    // In the unified view a conversation can span accounts, so each mail's
    // destination is its own account's view.
    const destUrls = new Set(
      spamTargets.map((m) =>
        getMailsQueryUrl(
          resolveMailAccount(m),
          nextIsSpam ? Category.SpamMails : Category.AllMails
        )
      )
    );

    watchWrites(spamTargets.map((m) => requestMarkSpam(m, nextIsSpam))).then(
      (landed) => {
        // A refused mark already refetched everything, row and counts.
        if (!landed) return;
        // The mail moved buckets — refresh the destination list so it shows
        // up fresh instead of relying on whatever was cached there.
        destUrls.forEach((destUrl) => queryClient.invalidateQueries(destUrl));
        // Spam is a MOVE between account buckets, not a delete. The optimistic
        // update below only decrements the source bucket; rather than
        // hand-maintain the destination's spam count (and create a spam
        // account row when the account had none), reconcile the whole sidebar
        // from the authoritative accounts payload. Cheap — accounts is one
        // small response.
        queryClient.invalidateQueries(accountsCache.key);
      }
    );

    // Optimistically evict from the current view, mirroring onClickTrash.
    removeFromList(spamTargets);
  };

  const onClickRobot = () => {
    setIsSummaryOpen((v) => !v);
  };

  const classes = ["mailcard"];

  if (conversation.unread) classes.push("unread");
  if (conversation.saved) classes.push("star");

  let searchHighlight;

  if ("highlight" in mail && mail.highlight) {
    searchHighlight = Object.values(mail.highlight).map((e, index) => {
      // Sanitize ts_headline output: escape all HTML, then allow only <em>/<\/em>
      // which are the StartSel/StopSel delimiters set server-side in the ts_headline call
      const sanitize = (fragment: string) =>
        fragment
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/&lt;em&gt;/g, "<em>")
          .replace(/&lt;\/em&gt;/g, "</em>");
      const __html = "..." + e.map(sanitize).join("... ...") + "...";
      return (
        <div key={`highlight_${index}`} dangerouslySetInnerHTML={{ __html }} />
      );
    });
  }

  const isKebabOpen = openedKebab === mail.id;

  // Mutating controls (save, delete) are disabled while offline; the handlers
  // also early-return as a backstop against a stray click.
  const offlineTitle = isOnline
    ? undefined
    : "You're offline — reconnect to make changes";

  const summary = ("insight" in mail ? mail.insight?.summary : undefined)?.map(
    (e, i) => {
      return <li key={`summary_${mail.id}_${i}`}>{e}</li>;
    }
  );

  const actionItems = (
    "insight" in mail ? mail.insight?.action_items : undefined
  )?.map((e, i) => {
    return <li key={`action_items_${mail.id}_${i}`}>{e}</li>;
  });

  return (
    <blockquote
      key={mail.id}
      className={classes.join(" ")}
      onMouseLeave={() => setOpenedKebab("")}
    >
      <MailHeader
        mail={mail}
        density={density}
        isSent={isSent}
        senders={senders}
        count={mails.length}
        unread={conversation.unread}
        onClick={onClickMailcard}
        onMouseLeave={() => setOpenedKebab("")}
      />
      {isSummaryOpen && (
        <div className="insight">
          {!!summary?.length && (
            <div className="summary">
              <ul>{summary}</ul>
            </div>
          )}
          {!!actionItems?.length && (
            <div className="actionItem">
              <ul>{actionItems}</ul>
            </div>
          )}
        </div>
      )}
      {searchHighlight ? (
        <div className="search_highlight">{searchHighlight}</div>
      ) : null}
      <div
        className={
          "actionBox" +
          (isKebabOpen ? " open" : "") +
          (conversation.saved ? " saved" : "")
        }
      >
        {isKebabOpen ? (
          <div
            className="kebab-menu"
            role="toolbar"
            aria-label="Message actions"
            onKeyDown={(e) => {
              // Escape closes the menu and hands focus back to the row.
              if (e.key !== "Escape") return;
              e.stopPropagation();
              setOpenedKebab("");
            }}
          >
            <RowAction
              label={offlineTitle ?? (conversation.saved ? "Unsave" : "Save")}
              disabled={!isOnline}
              onClick={onClickStar}
              autoFocus
            >
              {conversation.saved ? (
                <SolidStarIcon className="star" />
              ) : (
                <EmptyStarIcon />
              )}
            </RowAction>
            <RowAction
              label="Open in new tab"
              onClick={onClickOpenInNewTab}
            >
              <NewTabIcon />
            </RowAction>
            <RowAction label="Reply" onClick={onClickReply}>
              <ReplyIcon />
            </RowAction>
            <RowAction label="Forward" onClick={onClickShare}>
              <ShareIcon />
            </RowAction>
            {canToggleSpam ? (
              <RowAction
                label={
                  offlineTitle ?? (isSpamView ? "Not spam" : "Mark as spam")
                }
                disabled={!isOnline}
                onClick={onClickSpam}
              >
                {isSpamView ? <CircleCheckIcon /> : <BanIcon />}
              </RowAction>
            ) : null}
            <RowAction
              label={offlineTitle ?? "Delete"}
              disabled={!isOnline}
              onClick={onClickTrash}
            >
              <TrashIcon />
            </RowAction>
            <RowAction
              label="Close menu"
              onClick={() => setOpenedKebab("")}
            >
              <CloseIcon />
            </RowAction>
          </div>
        ) : (
          <>
            {summary?.length || actionItems?.length ? (
              <RowAction
                label={isSummaryOpen ? "Hide summary" : "Show summary"}
                onClick={onClickRobot}
              >
                <RobotIcon />
              </RowAction>
            ) : null}
            {conversation.saved ? (
              <RowAction
                label={offlineTitle ?? "Unsave"}
                disabled={!isOnline}
                onClick={onClickStar}
              >
                <SolidStarIcon className="star" />
              </RowAction>
            ) : null}
            <RowAction
              label="More actions"
              ariaHasPopup
              onClick={() => setOpenedKebab(mail.id)}
            >
              <KebabIcon />
            </RowAction>
          </>
        )}
      </div>
    </blockquote>
  );
};

const RenderedMails = ({
  page,
  loadMoreIfShort,
  account: accountProp,
  category: categoryProp
}: {
  page: number;
  /** Shows the next page when the rendered list doesn't fill the column. */
  loadMoreIfShort: () => void;
  /**
   * The account and folder to list, defaulting to the selected ones. The
   * search pre-search state passes the parked account and folder here so
   * the list — not the landing page — shows while the search term is
   * empty (design doc §9). Every query, cache, and handler below uses
   * these two, never the context values directly.
   */
  account?: string;
  category?: Category;
}) => {
  const {
    setSelectedAccount,
    selectedAccount: contextAccount,
    selectedCategory: contextCategory,
    isAllAccounts: contextAllAccounts,
    domains = [],
    density
  } = useContext(Context);
  const selectedAccount = accountProp ?? contextAccount;
  const selectedCategory = categoryProp ?? contextCategory;
  // The unified view is All Mails across accounts only; entering search
  // keeps the flag but the search branch owns the URL there.
  const unified =
    contextAllAccounts && selectedCategory === Category.AllMails;

  const [openedKebab, setOpenedKebab] = useState("");

  const accountsCache = new AccountsCache();

  // Subscribe to the sidebar's accounts query without fetching: the header
  // count re-renders when the accounts data changes (including optimistic
  // mark-read edits), and never triggers its own request.
  const accountsQuery = useQuery<AccountsGetResponse>(
    accountsQueryUrl,
    fetchAccounts,
    { enabled: false }
  );

  const containerClass =
    "mails_container" + (density === "compact" ? " compact" : "");

  const touchStartHandler = () => setOpenedKebab("");

  useEffect(() => {
    window.addEventListener("touchstart", touchStartHandler);
    return () => {
      window.removeEventListener("touchstart", touchStartHandler);
    };
  }, []);

  const queryUrl = getMailsQueryUrl(selectedAccount, selectedCategory, unified);

  const isSearch = selectedCategory === Category.Search;

  const getMails = () =>
    withPendingReads(async () => {
      if (!isSearch) {
        return fetchList(queryUrl, () => {
          const accounts = accountsCache.get();
          return accounts
            ? listCountInAccounts(accounts, selectedAccount, selectedCategory, unified)
            : undefined;
        });
      }
      const { status, body, message } = await call.get<SearchGetResponse>(queryUrl);
      if (status === "success") {
        return withoutPendingDeletes(
          body?.map((d) => new MailHeaderData(d)) || []
        );
      } else throw new Error(message);
    });
  const query = useQuery<MailHeaderData[]>(queryUrl, getMails, {
    refetchOnMount: revalidateOnMountPolicy(queryUrl)
  });

  // A folder lists conversations, one row each; search lists the matching
  // messages themselves, each with its own highlight.
  const rows = useMemo(() => {
    const mails = Array.isArray(query.data) ? query.data : [];
    if (selectedCategory === Category.Search) {
      return mails.map((mail) => ({
        latest: mail,
        mails: [mail],
        unread: !mail.read,
        saved: mail.saved
      }));
    }
    return groupConversations(mails, ownAddressesFor(domains));
  }, [query.data, selectedCategory, domains]);

  const pageSize = 4 + 8 * page;
  const hasNextPage = !isSearch && hasNextListPage(queryUrl);
  const hasMore = rows.length > pageSize || hasNextPage;

  // Keep a few screens of rows loaded past the ones shown, so scrolling
  // reaches loaded rows rather than a spinner.
  useEffect(() => {
    if (!hasNextPage || rows.length - pageSize > PREFETCH_ROWS) return;
    fetchNextListPage(queryUrl).catch(() => undefined);
  }, [hasNextPage, rows.length, pageSize, queryUrl]);
  // A list shorter than the column never scrolls, so the scroll handler alone
  // would never show the rest on a tall screen. Compact rows shrink the list
  // without changing how many rows it shows, so density re-runs the check too.
  useEffect(() => {
    if (!hasMore) return;
    loadMoreIfShort();
    window.addEventListener("resize", loadMoreIfShort);
    return () => window.removeEventListener("resize", loadMoreIfShort);
  }, [hasMore, pageSize, density, loadMoreIfShort]);

  if (query.isLoading) {
    return (
      <div className={containerClass}>
        <SkeletonMail />
        <SkeletonMail />
        <SkeletonMail />
      </div>
    );
  }

  // react-query v3's `error` action keeps `data`, so a failed revalidation
  // leaves the IndexedDB-seeded list intact — fall back to it instead of
  // blanking the pane, and only show the error screen when there is nothing to
  // fall back on. The retained list is labelled by staleNotice below.
  if (query.error && !query.data) {
    return (
      <div className={containerClass + " error"}>Mails List Request Failed</div>
    );
  }

  const requestDeleteMail = (mail: MailHeaderData) => {
    return call.delete<MailDeleteResponse>(`/api/mails/${mail.id}`);
  };

  const requestMarkSpam = (mail: MailHeaderData, isSpam: boolean) => {
    type Response = SpamMarkPostResponse;
    type Body = SpamMarkPostBody;
    const body: Body = { mail_id: mail.id, is_spam: isSpam };
    return call.post<Response, Body>("/api/mails/spam/mark", body);
  };

  const requestMarkRead = async (mail: MailHeaderData) => {
    type Response = MarkMailPostResponse;
    type Body = MarkMailPostBody;
    const body: Body = { mail_id: mail.id, read: true };
    return call.post<Response, Body>("/api/mails/mark", body);
  };

  const requestMarkSaved = (mail: MailHeaderData, save: boolean) => {
    type Response = MarkMailPostResponse;
    type Body = MarkMailPostBody;
    const body: Body = { mail_id: mail.id, save };
    return call.post<Response, Body>("/api/mails/mark", body);
  };

  const removeAccountFromQueryData = () => {
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      return evictAccountFromCategory(
        oldData,
        selectedCategory,
        selectedAccount
      );
    });
  };

  const markReadInQueryData = (mail: MailHeaderData) => {
    const mailId = mail.id;
    // In the unified view the mail belongs to its own account, not the
    // parked selection — the per-account caches and the bucket edit land
    // there, and the unified cache gets the same edit below.
    const mailAccount =
      accountForMail(mail, accountsQuery.data) ?? selectedAccount;

    Object.values(Category).forEach((e) => {
      const mailsCache = new MailsCache(mailAccount, e);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;

        const newData = [...oldData];
        const foundIndex = newData.findIndex((e) => e.id === mailId);
        if (foundIndex !== -1) {
          newData[foundIndex] = new MailHeaderData({
            ...newData[foundIndex],
            read: true
          });
        }

        return newData;
      });
    });

    if (unified) {
      new MailsCache(mailAccount, Category.AllMails, true).set((oldData) => {
        if (!oldData) return oldData;

        const newData = [...oldData];
        const foundIndex = newData.findIndex((e) => e.id === mailId);
        if (foundIndex !== -1) {
          // Copy, don't mutate in place.
          newData[foundIndex] = new MailHeaderData({
            ...newData[foundIndex],
            read: true
          });
        }

        return newData;
      });
    }

    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      return updateAccountInBuckets(
        oldData,
        bucketsForMail(selectedCategory, mail, mailAccount),
        mailAccount,
        ({ unread_doc_count }) => ({
          unread_doc_count: unread_doc_count ? unread_doc_count - 1 : 0
        })
      );
    });
  };

  const markSavedInQueryData = (mail: MailHeaderData, save: boolean) => {
    const mailId = mail.id;
    const mailAccount =
      accountForMail(mail, accountsQuery.data) ?? selectedAccount;
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      return updateAccountInBuckets(
        oldData,
        bucketsForMail(selectedCategory, mail, mailAccount),
        mailAccount,
        ({ saved_doc_count }) => ({
          saved_doc_count: save ? saved_doc_count + 1 : saved_doc_count - 1
        })
      );
    });

    Object.values(Category).forEach((e) => {
      const mailsCache = new MailsCache(mailAccount, e);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;
        const newData = [...oldData];
        const foundIndex = newData.findIndex((e) => e.id === mailId);
        if (foundIndex !== -1) {
          newData[foundIndex] = new MailHeaderData({
            ...newData[foundIndex],
            saved: save
          });
        }
        if (e === Category.SavedMails) {
          if (foundIndex !== -1) newData.splice(foundIndex, 1);
          else if (save) {
            let i = 0;
            while (new Date(newData[i]?.date) > new Date(mail.date)) i++;
            newData.splice(
              i,
              0,
              new MailHeaderData({ ...mail, saved: save })
            );
          }
        }

        return newData;
      });
    });

    if (unified) {
      // The unified list is an All Mails view: a save only flips the star,
      // the row stays — unlike the per-account Saved cache above, which
      // splices the row in or out.
      new MailsCache(mailAccount, Category.AllMails, true).set((oldData) => {
        if (!oldData) return oldData;
        const newData = [...oldData];
        const foundIndex = newData.findIndex((e) => e.id === mailId);
        if (foundIndex !== -1) {
          // Copy, don't mutate in place.
          newData[foundIndex] = new MailHeaderData({
            ...newData[foundIndex],
            saved: save
          });
        }
        return newData;
      });
    }
  };

  // Paired with the error guard above: gating on isSuccess alone would blank
  // the pane the instant a revalidation failed, so render retained data too.
  if (query.isSuccess || query.data) {
    // Retained data must not render as if it were fresh: a failed revalidation
    // leaves a list that can be a week old, and every action on it is
    // optimistic. The offline banner reports connectivity and
    // can only say "—" for the age on a cold offline start, so this carries the
    // age the banner can't know rather than duplicating it.
    const staleNotice =
      query.data && isShowingStaleData(query) ? (
        <div className="mails_stale_notice" role="status" aria-live="polite">
          Couldn&apos;t refresh — showing mail as of{" "}
          {formatDataAge(query.dataUpdatedAt)}
        </div>
      ) : null;
    const mails = Array.isArray(query.data) ? query.data : [];
    const pagedRows = rows.slice(0, pageSize);
    const isSent = (m: MailHeaderData) => isSentMail(m, domains);

    // Search shows the loaded result count; every folder shows the selected
    // account's count from the accounts buckets (null until they load, in
    // which case the header is the category name alone). The unified view
    // sums unread across every account instead.
    const viewName = unified ? "All accounts" : selectedCategory;
    const accountCount =
      selectedCategory === Category.Search
        ? null
        : unified
          ? allAccountsCount(accountsQuery.data)
          : accountCountForCategory(
              accountsQuery.data,
              selectedCategory,
              selectedAccount
            );
    const countLabel =
      selectedCategory === Category.Search
        ? `${mails.length} ${mails.length === 1 ? "result" : "results"}`
        : accountCount
          ? `${viewName} · ${accountCount.count} ${accountCount.noun}`
          : viewName;
    const listHeader = <ListHeader countLabel={countLabel} />;

    const result = pagedRows.map((conversation) => {
      return (
        <RenderedMail
          key={conversation.latest.id}
          conversation={conversation}
          senders={conversationSenders(conversation, isSent)}
          requestMarkRead={requestMarkRead}
          markReadInQueryData={markReadInQueryData}
          requestDeleteMail={requestDeleteMail}
          requestMarkSpam={requestMarkSpam}
          selectedAccount={selectedAccount}
          accountsCache={accountsCache}
          selectedCategory={selectedCategory}
          removeAccountFromQueryData={removeAccountFromQueryData}
          requestMarkSaved={requestMarkSaved}
          markSavedInQueryData={markSavedInQueryData}
          openedKebab={openedKebab}
          setOpenedKebab={setOpenedKebab}
          density={density}
          isSent={isSent(conversation.latest)}
          unified={unified}
          accountsData={accountsQuery.data}
        />
      );
    });

    if (!result.length) {
      const { message, others } = emptyFolderState(
        selectedCategory,
        selectedAccount,
        accountsQuery.data,
        unified
      );
      return (
        <div className={containerClass + " empty"}>
          {listHeader}
          {staleNotice}
          <p className="empty_state">{message}</p>
          {others.length ? (
            <div className="empty_state_others">
              <p>Other accounts have mail here:</p>
              <ul>
                {others.map((a) => (
                  <li key={a.key}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setSelectedAccount(a.key)}
                    >
                      {a.key} ({a.count})
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div className={containerClass}>
        {listHeader}
        {staleNotice}
        {result}
      </div>
    );
  }

  return <></>;
};

const Mails = ({
  page,
  loadMoreIfShort
}: {
  page: number;
  loadMoreIfShort: () => void;
}) => {
  const { selectedAccount, selectedCategory, preSearchAccount, preSearchCategory } =
    useContext(Context);
  const inSearch = selectedCategory === Category.Search;
  if (!selectedAccount) {
    // In search with no term yet, the list is the pre-search state — the
    // parked account's folder shows under the search box (design doc §9),
    // not the "Welcome to Inbox!" landing page. Outside search, no account
    // still means the landing page.
    if (inSearch && preSearchAccount.current) {
      return (
        <div className="mails_container">
          <SearchBox />
          <RenderedMails
            page={page}
            loadMoreIfShort={loadMoreIfShort}
            account={preSearchAccount.current}
            category={preSearchCategory.current}
          />
        </div>
      );
    }
    return <GettingStarted />;
  }
  if (inSearch) {
    return (
      <div className="mails_container">
        <SearchBox />
        <RenderedMails page={page} loadMoreIfShort={loadMoreIfShort} />
      </div>
    );
  }
  return <RenderedMails page={page} loadMoreIfShort={loadMoreIfShort} />;
};

export default Mails;
