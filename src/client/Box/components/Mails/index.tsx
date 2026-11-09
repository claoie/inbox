import {
  useState,
  useContext,
  useEffect,
  useCallback,
  Dispatch,
  SetStateAction
} from "react";
import { useQuery, useQueryClient } from "react-query";
import { marked } from "marked";
import { MailBodyData, MailHeaderData, ReplyData } from "common";

import {
  ApiResponse,
  AccountsGetResponse,
  BodyGetResponse,
  HeadersGetResponse,
  MarkMailPostBody,
  MarkMailPostResponse,
  SearchGetResponse,
  MailDeleteResponse,
  SpamMarkPostBody,
  SpamMarkPostResponse
} from "server";

import {
  MailHeader,
  MailBody,
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
  processHtmlForViewer,
  useIsOnline,
  revalidateOnMountPolicy,
  formatDataAge,
  isShowingStaleData
} from "client";
import {
  AccountsCache,
  accountsQueryUrl,
  fetchAccounts
} from "client/Box/components/Accounts";
import { getMailsQueryUrl } from "./mailsQuery";
import {
  accountCountForCategory,
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
  constructor(account: string, category: Category) {
    super(getMailsQueryUrl(account, category));
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

interface RenderedMailProps {
  mail: MailHeaderData;
  i: number;
  activeMailId: ActiveMailMap;
  setActiveMailId: Dispatch<SetStateAction<ActiveMailMap>>;
  requestMarkRead: (
    mail: MailHeaderData
  ) => Promise<ApiResponse<MarkMailPostResponse>>;
  markReadInQueryData: (mail: MailHeaderData) => void;
  setReplyData: Dispatch<SetStateAction<ReplyData>>;
  requestDeleteMail: (
    mail: MailHeaderData
  ) => Promise<ApiResponse<MailDeleteResponse>>;
  requestMarkSpam: (
    mail: MailHeaderData,
    isSpam: boolean
  ) => Promise<ApiResponse<SpamMarkPostResponse>>;
  selectedAccount: string;
  domainName: string;
  accountsCache: AccountsCache;
  selectedCategory: Category;
  removeAccountFromQueryData: () => void;
  requestMarkSaved: (mail: MailHeaderData, saved: boolean) => void;
  markSavedInQueryData: (mail: MailHeaderData, saved: boolean) => void;
  isWriterOpen: boolean;
  openedKebab: string;
  setOpenedKebab: Dispatch<SetStateAction<string>>;
  density: Density;
  isSent: boolean;
}

const RenderedMail = ({
  mail,
  i,
  activeMailId,
  setActiveMailId,
  requestMarkRead,
  markReadInQueryData,
  setReplyData,
  requestDeleteMail,
  requestMarkSpam,
  selectedAccount,
  domainName,
  accountsCache,
  selectedCategory,
  removeAccountFromQueryData,
  requestMarkSaved,
  markSavedInQueryData,
  isWriterOpen,
  openedKebab,
  setOpenedKebab,
  density,
  isSent
}: RenderedMailProps) => {
  const { isSettingsOpen } = useContext(Context);
  const isActive = !!activeMailId[mail.id];

  const [isSummaryOpen, setIsSummaryOpen] = useState(false);

  const { isOnline } = useIsOnline();

  const queryClient = useQueryClient();

  const onClickClose = useCallback(() => {
    setActiveMailId((current) => {
      const next = { ...current };
      delete next[mail.id];
      return next;
    });
  }, [mail.id, setActiveMailId]);

  // Esc collapses the open message (design doc §6). The writer owns Esc
  // while it is open, typing in a field keeps its own Esc, an open dialog
  // overlay (the Folders sheet) owns Esc too, and the list stays mounted
  // but hidden under Settings, so all four skip this handler.
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isWriterOpen || isSettingsOpen) return;
      // A dialog overlay owns Esc while it is open — the Folders sheet
      // registers its own window-level Escape handler. Without this, one
      // press closes the dialog and collapses the message behind it.
      // Dialogs are only mounted while open, so presence in the document
      // means one is open.
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      onClickClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive, isWriterOpen, isSettingsOpen, onClickClose]);

  const onClickOpenInNewTab = async () => {
    const queryUrl = `/api/mails/body/${mail.id}`;
    const getMail = () =>
      call.get<BodyGetResponse>(queryUrl).then(({ status, body, message }) => {
        if (status === "success") return new MailBodyData(body);
        throw new Error(message);
      });
    const data = await queryClient.fetchQuery<MailBodyData>(queryUrl, getMail, {
      staleTime: Infinity
    });
    // Render the email inside a sandboxed iframe in the new tab — NOT
    // directly into the top document. A `blob:` document inherits this
    // page's origin, so any script in the email body would otherwise run
    // with full app origin (cookies / session). The inline preview is
    // safe only because its iframe omits `allow-scripts`; the new tab must
    // preserve that backstop. The shell below carries no script of its own
    // and confines the email to an iframe whose sandbox matches the inline
    // viewer (no `allow-scripts`, no top-navigation), so email scripts stay
    // inert and `<meta http-equiv=refresh>` can't redirect the tab. The
    // sanitizer stays defense-in-depth, not the sole barrier.
    // The shell also carries its own <meta name="referrer"> so this path no
    // longer relies on the blob: URL for Referer suppression (the inner
    // srcdoc document gets its own from processHtmlForViewer).
    const processed = processHtmlForViewer(data.html);
    // Escape for embedding in the double-quoted `srcdoc` attribute.
    const srcdoc = processed.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    const shell =
      '<!doctype html><html><head><meta charset="utf-8" />' +
      '<meta name="referrer" content="no-referrer" />' +
      "<style>html,body{margin:0;padding:0;height:100%}" +
      "iframe{border:0;width:100%;height:100%}</style></head>" +
      '<body><iframe sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" ' +
      `srcdoc="${srcdoc}"></iframe></body></html>`;
    const blob = new Blob([shell], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // Revoke after a delay so the new tab has a chance to load. Chrome /
    // Safari hold the blob alive in the open tab regardless once the
    // load is committed.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const onClickMailcard = () => {
    if (isActive) {
      onClickClose();
    } else {
      // Auto-mark-read is a side effect of opening, not a user-clicked
      // control — so gate the request itself when offline rather than
      // disabling a button. The mail still opens and renders cached body.
      if (!mail.read && isOnline) {
        requestMarkRead(mail);
        markReadInQueryData(mail);
        mail.read = true;
      }
      const clonedActiveMailId = { ...activeMailId, [mail.id]: true };
      setActiveMailId(clonedActiveMailId);
    }
  };

  const onClickReply = () => {
    if (!isActive) {
      const clonedActiveMailId = { ...activeMailId, [mail.id]: true };
      setActiveMailId(clonedActiveMailId);
    }
    if (isSentMail(mail, domainName)) {
      const ownAddress = mail.from?.value?.[0]?.address || selectedAccount;
      setReplyData({ ...mail, from: mail.to, to: { address: ownAddress } });
    } else {
      setReplyData({ ...mail, to: { address: selectedAccount } });
    }
  };

  const onClickShare = () => {
    if (!isActive) {
      const clonedActiveMailId = { ...activeMailId, [mail.id]: true };
      setActiveMailId(clonedActiveMailId);
    }
    setReplyData({ ...mail, to: { address: "" } });
  };

  const onClickTrash = () => {
    if (!isOnline) return;
    if (window.confirm("Do you want to delete this mail?")) {
      requestDeleteMail(mail);

      accountsCache.set((oldData) => {
        if (!oldData) return oldData;
        return updateAccountInBuckets(
          oldData,
          bucketsForMail(selectedCategory, mail, selectedAccount),
          selectedAccount,
          ({ doc_count, unread_doc_count }) => ({
            doc_count: doc_count - 1,
            unread_doc_count:
              !mail.read && unread_doc_count
                ? unread_doc_count - 1
                : unread_doc_count
          })
        );
      });

      const mailsCache = new MailsCache(selectedAccount, selectedCategory);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;
        const newData = [...oldData];
        newData.splice(i, 1);
        if (!newData.length) removeAccountFromQueryData();
        return newData;
      });
    }
  };

  const onClickStar = () => {
    if (!isOnline) return;
    requestMarkSaved(mail, !mail.saved);
    markSavedInQueryData(mail, !mail.saved);
  };

  const isSpamView = selectedCategory === Category.SpamMails;
  const canToggleSpam = canMarkSpam(mail, selectedCategory);

  const onClickSpam = () => {
    if (!isOnline) return;

    // In the spam view the button un-marks (Not Spam); everywhere else it
    // marks as spam. Either way the mail leaves the current list.
    const nextIsSpam = !isSpamView;

    const listUrl = getMailsQueryUrl(selectedAccount, selectedCategory);
    // Where the mail lands: the Spam view when marking, the All Mails view
    // when un-marking. Refreshing it on navigation avoids a stale destination.
    const destUrl = getMailsQueryUrl(
      selectedAccount,
      nextIsSpam ? Category.SpamMails : Category.AllMails
    );

    requestMarkSpam(mail, nextIsSpam)
      .then(({ status, message }) => {
        if (status !== "success") throw new Error(message);
        // The mail moved buckets — refresh the destination list so it shows
        // up fresh instead of relying on whatever was cached there.
        queryClient.invalidateQueries(destUrl);
      })
      .catch(() => {
        // The optimistic removal below already took the row out of the view.
        // If the server rejected the mark, re-fetch so the row comes back
        // rather than silently vanishing.
        queryClient.invalidateQueries(listUrl);
      })
      .finally(() => {
        // Spam is a MOVE between account buckets, not a delete. The optimistic
        // update below only decrements the source bucket; rather than
        // hand-maintain the destination's spam count (and create a spam
        // account row when the account had none), reconcile the whole sidebar
        // from the authoritative accounts payload. Also restores the source
        // count if the mark failed. Cheap — accounts is one small response.
        queryClient.invalidateQueries(accountsCache.key);
      });

    // Optimistically evict from the current view, mirroring onClickTrash:
    // decrement the matching account bucket, then splice the row out of this
    // category's cached list.
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      return updateAccountInBuckets(
        oldData,
        bucketsForMail(selectedCategory, mail, selectedAccount),
        selectedAccount,
        ({ doc_count, unread_doc_count }) => ({
          doc_count: doc_count - 1,
          unread_doc_count:
            !mail.read && unread_doc_count
              ? unread_doc_count - 1
              : unread_doc_count
        })
      );
    });

    const mailsCache = new MailsCache(selectedAccount, selectedCategory);

    mailsCache.set((oldData) => {
      if (!oldData) return oldData;
      const newData = [...oldData];
      newData.splice(i, 1);
      if (!newData.length) removeAccountFromQueryData();
      return newData;
    });
  };

  const onClickRobot = () => {
    setIsSummaryOpen((v) => !v);
  };

  const classes = ["mailcard"];

  if (!mail.read) classes.push("unread");
  if (isActive) classes.push("active");
  if (!isWriterOpen) classes.push("shadow");
  if (mail.saved) classes.push("star");

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
  const offlineClass = isOnline ? "" : " disabled";
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
        isActive={isActive}
        density={density}
        isSent={isSent}
        onClick={onClickMailcard}
        onMouseLeave={() => setOpenedKebab("")}
      />
      {isActive && (
        <button
          type="button"
          className="mail-close"
          title="Close"
          aria-label="Close message"
          onClick={onClickClose}
        >
          <CloseIcon />
        </button>
      )}
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
      {isActive ? (
        <div className="actionRow" role="toolbar" aria-label="Message actions">
          {summary?.length || actionItems?.length ? (
            <button
              type="button"
              className="actionButton cursor"
              title={isSummaryOpen ? "Hide summary" : "Show summary"}
              aria-expanded={isSummaryOpen}
              onClick={onClickRobot}
            >
              <RobotIcon />
              <span>Summary</span>
            </button>
          ) : null}
          <button
            type="button"
            className="actionButton cursor"
            title="Reply"
            onClick={onClickReply}
          >
            <ReplyIcon />
            <span>Reply</span>
          </button>
          <button
            type="button"
            className="actionButton cursor"
            title="Forward"
            onClick={onClickShare}
          >
            <ShareIcon />
            <span>Forward</span>
          </button>
          <button
            type="button"
            className={"actionButton cursor" + offlineClass}
            title={offlineTitle ?? (mail.saved ? "Unsave" : "Save")}
            onClick={onClickStar}
          >
            {mail.saved ? (
              <SolidStarIcon className="star" />
            ) : (
              <EmptyStarIcon />
            )}
            <span>{mail.saved ? "Unsave" : "Save"}</span>
          </button>
          <button
            type="button"
            className="actionButton cursor"
            title="Open this email body in a new tab"
            onClick={onClickOpenInNewTab}
          >
            <NewTabIcon />
            <span>Open in new tab</span>
          </button>
          {canToggleSpam ? (
            <button
              type="button"
              className={"actionButton cursor" + offlineClass}
              title={
                offlineTitle ?? (isSpamView ? "Not spam" : "Mark as spam")
              }
              onClick={onClickSpam}
            >
              {isSpamView ? <CircleCheckIcon /> : <BanIcon />}
              <span>{isSpamView ? "Not spam" : "Mark spam"}</span>
            </button>
          ) : null}
          <button
            type="button"
            className={"actionButton cursor" + offlineClass}
            title={offlineTitle ?? "Delete"}
            onClick={onClickTrash}
          >
            <TrashIcon />
            <span>Delete</span>
          </button>
        </div>
      ) : null}
      {isActive ? (
        <MailBody mailId={mail.id} />
      ) : searchHighlight ? (
        <div className="search_highlight">{searchHighlight}</div>
      ) : null}
      {!isActive && (
      <div
        className={
          "actionBox" +
          (isKebabOpen ? " open" : "") +
          (mail.saved ? " saved" : "")
        }
      >
        {isKebabOpen ? (
          <>
            <div
              key="star"
              className={"iconBox cursor" + offlineClass}
              title={offlineTitle ?? (mail.saved ? "Unsave" : "Save")}
              onClick={onClickStar}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
            >
              {mail.saved ? (
                <SolidStarIcon className="star" />
              ) : (
                <EmptyStarIcon />
              )}
            </div>
            <div
              key="openInNewTab"
              className="iconBox cursor"
              onClick={onClickOpenInNewTab}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
              title="Open this email body in a new tab"
            >
              <NewTabIcon />
            </div>
            <div
              key="reply"
              className="iconBox cursor"
              title="Reply"
              onClick={onClickReply}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
            >
              <ReplyIcon />
            </div>
            <div
              key="share"
              className="iconBox cursor"
              title="Forward"
              onClick={onClickShare}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
            >
              <ShareIcon />
            </div>
            {canToggleSpam ? (
              <div
                key="spam"
                className={"iconBox cursor" + offlineClass}
                title={
                  offlineTitle ?? (isSpamView ? "Not spam" : "Mark as spam")
                }
                onClick={onClickSpam}
                onTouchStart={(e) => e.stopPropagation()}
                onMouseEnter={() => setOpenedKebab(mail.id)}
              >
                {isSpamView ? <CircleCheckIcon /> : <BanIcon />}
              </div>
            ) : null}
            <div
              key="trash"
              className={"iconBox cursor" + offlineClass}
              title={offlineTitle ?? "Delete"}
              onClick={onClickTrash}
              onTouchStart={(e) => e.stopPropagation()}
              onMouseEnter={() => setOpenedKebab(mail.id)}
            >
              <TrashIcon />
            </div>
          </>
        ) : (
          <>
            {summary?.length || actionItems?.length ? (
              <div
                key="robot"
                className="iconBox cursor"
                title={isSummaryOpen ? "Hide summary" : "Show summary"}
                onClick={onClickRobot}
              >
                <RobotIcon />
              </div>
            ) : null}
            {mail.saved ? (
              <div
                key="star"
                className={"iconBox cursor" + offlineClass}
                title={offlineTitle ?? "Unsave"}
                onClick={onClickStar}
              >
                <SolidStarIcon className="star" />
              </div>
            ) : null}
            <div
              key="kebab"
              className="iconBox cursor"
              title="More actions"
              onClick={() => setOpenedKebab(mail.id)}
            >
              <KebabIcon />
            </div>
          </>
        )}
      </div>
      )}
    </blockquote>
  );
};

interface ActiveMailMap {
  [k: string]: boolean;
}

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
    isWriterOpen,
    setReplyData,
    selectedAccount: contextAccount,
    selectedCategory: contextCategory,
    domainName,
    density
  } = useContext(Context);
  const selectedAccount = accountProp ?? contextAccount;
  const selectedCategory = categoryProp ?? contextCategory;

  const [activeMailId, setActiveMailId] = useState<ActiveMailMap>({});
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

  useEffect(() => {
    setActiveMailId({});
  }, [selectedAccount]);

  const touchStartHandler = () => setOpenedKebab("");

  useEffect(() => {
    window.addEventListener("touchstart", touchStartHandler);
    return () => {
      window.removeEventListener("touchstart", touchStartHandler);
    };
  }, []);

  const queryUrl = getMailsQueryUrl(selectedAccount, selectedCategory);

  const getMails = async () => {
    const { status, body, message } = await call.get<
      HeadersGetResponse | SearchGetResponse
    >(queryUrl);
    if (status === "success") {
      return body?.map((d) => new MailHeaderData(d)) || [];
    } else throw new Error(message);
  };
  const query = useQuery<MailHeaderData[]>(queryUrl, getMails, {
    refetchOnMount: revalidateOnMountPolicy(queryUrl)
  });

  const mailCount = Array.isArray(query.data) ? query.data.length : 0;
  const pageSize = 4 + 8 * page;
  const hasMore = mailCount > pageSize;
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

    Object.values(Category).forEach((e) => {
      const mailsCache = new MailsCache(selectedAccount, e);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;

        const newData = [...oldData];
        const foundData = newData.find((e) => e.id === mailId);
        if (foundData) foundData.read = true;

        return newData;
      });
    });

    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      return updateAccountInBuckets(
        oldData,
        bucketsForMail(selectedCategory, mail, selectedAccount),
        selectedAccount,
        ({ unread_doc_count }) => ({
          unread_doc_count: unread_doc_count ? unread_doc_count - 1 : 0
        })
      );
    });
  };

  const markSavedInQueryData = (mail: MailHeaderData, save: boolean) => {
    const mailId = mail.id;
    accountsCache.set((oldData) => {
      if (!oldData) return oldData;
      return updateAccountInBuckets(
        oldData,
        bucketsForMail(selectedCategory, mail, selectedAccount),
        selectedAccount,
        ({ saved_doc_count }) => ({
          saved_doc_count: save ? saved_doc_count + 1 : saved_doc_count - 1
        })
      );
    });

    Object.values(Category).forEach((e) => {
      const mailsCache = new MailsCache(selectedAccount, e);

      mailsCache.set((oldData) => {
        if (!oldData) return oldData;
        const newData = [...oldData];
        let foundIndex;
        newData.find((e, i) => {
          if (e.id === mailId) {
            foundIndex = i;
            e.saved = save;
            return true;
          }
          return false;
        });
        if (e === Category.SavedMails) {
          if (foundIndex !== undefined) newData.splice(foundIndex, 1);
          else {
            let i = 0;
            while (new Date(newData[i]?.date) > new Date(mail.date)) i++;
            newData.splice(i, 0, new MailHeaderData({ ...mail }));
          }
        }

        return newData;
      });
    });
  };

  // Paired with the error guard above: gating on isSuccess alone would blank
  // the pane the instant a revalidation failed, so render retained data too.
  if (query.isSuccess || query.data) {
    // Retained data must not render as if it were fresh: a failed revalidation
    // leaves a list that can be a week old, and every action on it is
    // fire-and-forget optimistic. The offline banner reports connectivity and
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
    const pagedMails = mails.slice(0, pageSize);

    // Search shows the loaded result count; every folder shows the selected
    // account's count from the accounts buckets (null until they load, in
    // which case the header is the category name alone).
    const accountCount =
      selectedCategory === Category.Search
        ? null
        : accountCountForCategory(
            accountsQuery.data,
            selectedCategory,
            selectedAccount
          );
    const countLabel =
      selectedCategory === Category.Search
        ? `${mails.length} ${mails.length === 1 ? "result" : "results"}`
        : accountCount
          ? `${selectedCategory} · ${accountCount.count} ${accountCount.noun}`
          : selectedCategory;
    const listHeader = <ListHeader countLabel={countLabel} />;

    const result = pagedMails.map((mail, i) => {
      return (
        <RenderedMail
          key={mail.id}
          mail={mail}
          i={i}
          activeMailId={activeMailId}
          setActiveMailId={setActiveMailId}
          requestMarkRead={requestMarkRead}
          markReadInQueryData={markReadInQueryData}
          setReplyData={setReplyData}
          requestDeleteMail={requestDeleteMail}
          requestMarkSpam={requestMarkSpam}
          selectedAccount={selectedAccount}
          domainName={domainName}
          accountsCache={accountsCache}
          selectedCategory={selectedCategory}
          removeAccountFromQueryData={removeAccountFromQueryData}
          requestMarkSaved={requestMarkSaved}
          markSavedInQueryData={markSavedInQueryData}
          isWriterOpen={isWriterOpen}
          openedKebab={openedKebab}
          setOpenedKebab={setOpenedKebab}
          density={density}
          isSent={isSentMail(mail, domainName)}
        />
      );
    });

    if (!result.length) {
      const emptyMessage = (() => {
        switch (selectedCategory) {
          case Category.NewMails:
            return "All caught up! No unread emails.";
          case Category.SavedMails:
            return "No saved emails.";
          case Category.SentMails:
            return "No sent emails.";
          case Category.SpamMails:
            return "No spam — nice.";
          case Category.Search:
            return "No results found.";
          default:
            return "No emails in this account.";
        }
      })();
      return (
        <div className={containerClass + " empty"}>
          {listHeader}
          {staleNotice}
          <p className="empty_state">{emptyMessage}</p>
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
