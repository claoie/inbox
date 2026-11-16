import {
  useState,
  createContext,
  useEffect,
  useRef,
  useCallback,
  StrictMode,
  Dispatch,
  SetStateAction,
  MutableRefObject
} from "react";
import { QueryClientProvider } from "react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { SignedUser, ReplyData } from "common";
import { DomainGetResponse } from "server";
import {
  hasAccountsColumn,
  isAccountsMenuOpen
} from "./Box/components/Accounts/accountsMenu";

import {
  Header,
  SignIn,
  Box,
  SignUp,
  ErrorBoundary,
  NotFound,
  OfflineBanner,
  IsOnlineProvider,
  useLocalStorage,
  Notifier,
  call,
  callUser,
  queryClient,
  registerServiceWorker,
  FeedbackProvider,
  ThemeSetting,
  sanitizeThemeSetting,
  applyThemeSetting
} from "client";

export enum Category {
  AllMails = "All Mails",
  SavedMails = "Saved Mails",
  SentMails = "Sent Mails",
  SpamMails = "Spam Mails",
  Search = "Search"
}

// List density (design doc §5): Comfortable shows the snippet at 12px row
// padding; Compact hides it at 8px. Persisted in localStorage like the other
// UI preferences below.
export type Density = "comfortable" | "compact";

export interface ContextType {
  viewSize: {
    width: number;
    height: number;
  };
  domainName: string;
  userInfo: SignedUser | undefined;
  setUserInfo: Dispatch<SetStateAction<ContextType["userInfo"]>>;
  /** Whether the accounts menu is open; never on widths that show the
   * accounts list as a column instead. */
  isAccountsOpen: boolean;
  setIsAccountsOpen: Dispatch<SetStateAction<ContextType["isAccountsOpen"]>>;
  isWriterOpen: boolean;
  setIsWriterOpen: Dispatch<SetStateAction<ContextType["isWriterOpen"]>>;
  /** Whether the center column shows the Settings page instead of the list. */
  isSettingsOpen: boolean;
  setIsSettingsOpen: Dispatch<SetStateAction<ContextType["isSettingsOpen"]>>;
  replyData: ReplyData;
  setReplyData: Dispatch<SetStateAction<ContextType["replyData"]>>;
  selectedAccount: string;
  setSelectedAccount: Dispatch<SetStateAction<ContextType["selectedAccount"]>>;
  selectedCategory: Category;
  setSelectedCategory: Dispatch<
    SetStateAction<ContextType["selectedCategory"]>
  >;
  /**
   * Whether the list shows the unified "All accounts" view (design doc §8,
   * Phase 2 item 10): received mail across every alias, unread-then-recent.
   * A view flag, not an account — it never touches `selectedAccount`, so
   * leaving the view restores the previous account and folder exactly, and
   * a reload restores the view with the parked account still in place.
   * Only meaningful with `selectedCategory` All Mails; folder navigation and
   * picking an account both clear it.
   */
  isAllAccounts: boolean;
  setIsAllAccounts: Dispatch<SetStateAction<ContextType["isAllAccounts"]>>;
  newMailsTotal: number;
  setNewMailsTotal: Dispatch<SetStateAction<ContextType["newMailsTotal"]>>;
  /**
   * The account and folder in effect before the current search (design doc
   * §9): entering search parks them here so clearing the search — or leaving
   * it for a folder — can restore them. Refs, not state: no component
   * renders from them, they are only read at event time (clear / folder
   * tap) and in the search pre-search branch. They do not survive a reload,
   * by design — Category.Search is sanitized to AllMails on load.
   */
  preSearchAccount: MutableRefObject<string>;
  preSearchCategory: MutableRefObject<Category>;
  /**
   * Enter search mode: park the current account and folder, close the
   * writer, and start from an empty term. Shared by the rail Search tab
   * and the header search trigger so both take the same path. Re-entering
   * while already in search leaves the parked account, folder, and term
   * alone — only the writer still closes.
   */
  enterSearch: () => void;
  /**
   * Leave search mode via the search box's clear control: drop the term
   * and restore the parked account and folder.
   */
  exitSearch: () => void;
  density: Density;
  setDensity: Dispatch<SetStateAction<ContextType["density"]>>;
  /** Plain text added below every sent message; empty for none. */
  signature: string;
  setSignature: Dispatch<SetStateAction<ContextType["signature"]>>;
  /** Whether a new reply quotes the message it answers. */
  includeOriginal: boolean;
  setIncludeOriginal: Dispatch<
    SetStateAction<ContextType["includeOriginal"]>
  >;
  /** Whether this browser subscribes to push notifications for new mail. */
  notificationsEnabled: boolean;
  setNotificationsEnabled: Dispatch<
    SetStateAction<ContextType["notificationsEnabled"]>
  >;
  /** The address From is filled with on a new message when no mailbox is selected. */
  defaultFrom: string;
  setDefaultFrom: Dispatch<SetStateAction<ContextType["defaultFrom"]>>;
  /** Light, dark, or follow the device. */
  theme: ThemeSetting;
  setTheme: Dispatch<SetStateAction<ContextType["theme"]>>;
  /** Whether the compose form currently holds an unsent draft. */
  hasDraft: boolean;
  setHasDraft: Dispatch<SetStateAction<ContextType["hasDraft"]>>;
}

export const Context = createContext<ContextType>({} as ContextType);

interface Props {
  user?: SignedUser;
}

const App = ({ user: session }: Props) => {
  // defines states used for UI control
  const [viewSize, setViewSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });
  const [domainName, setDomainName] = useLocalStorage("domainName", "");
  const [userInfo, setUserInfo] = useState(session);
  // The accounts menu is a popover opened from the header; it starts closed.
  const [isAccountsOpen, setIsAccountsOpen] = useState(false);
  const isAccountsColumn = hasAccountsColumn(viewSize.width);
  // Widening into the column layout closes the menu for good, so narrowing
  // again doesn't bring back a menu opened before.
  useEffect(() => {
    if (isAccountsColumn) setIsAccountsOpen(false);
  }, [isAccountsColumn]);
  const [isWriterOpen, setIsWriterOpen] = useLocalStorage(
    "isWriterOpen",
    false
  );
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [replyData, setReplyData] = useState({});
  const [selectedAccount, setSelectedAccount] = useLocalStorage(
    "selectedAccount",
    ""
  );
  const [isAllAccounts, setIsAllAccounts] = useLocalStorage(
    "isAllAccounts",
    false
  );
  const [selectedCategory, setSelectedCategory] = useLocalStorage(
    "selectedCategory",
    Category.AllMails,
    // Search is transient (requires a live search query + preSearchAccount ref
    // that don't survive a page reload). Restoring Category.Search would use
    // the account address as the search term, producing confusing sort order.
    // A stored value that names no current folder falls back to All Mails
    // too.
    (v) =>
      v === Category.Search || !Object.values(Category).includes(v)
        ? Category.AllMails
        : v
  );
  const [newMailsTotal, setNewMailsTotal] = useState(0);
  const [density, setDensity] = useLocalStorage<Density>(
    "density",
    "comfortable",
    (v) => (v === "compact" ? "compact" : "comfortable")
  );
  const [theme, setTheme] = useLocalStorage<ThemeSetting>(
    "theme",
    "system",
    sanitizeThemeSetting
  );
  useEffect(() => applyThemeSetting(theme), [theme]);
  const [includeOriginal, setIncludeOriginal] = useLocalStorage(
    "includeOriginal",
    true
  );
  // The signature and default From belong to whoever set them, so they are
  // kept per user id: another user signing in on this browser starts blank,
  // and the owner gets them back after signing out or a session expiry.
  const [composeSettings, setComposeSettings] = useLocalStorage<
    Record<string, { signature?: string; defaultFrom?: string }>
  >("composeSettings", {});
  const userKey = userInfo?.id ?? "";
  const signature = composeSettings[userKey]?.signature ?? "";
  const defaultFrom = composeSettings[userKey]?.defaultFrom ?? "";
  const setUserComposeSetting = useCallback(
    (field: "signature" | "defaultFrom", value: SetStateAction<string>) =>
      setComposeSettings((all) => {
        const mine = all[userKey] ?? {};
        const next = value instanceof Function ? value(mine[field] ?? "") : value;
        return { ...all, [userKey]: { ...mine, [field]: next } };
      }),
    [userKey, setComposeSettings]
  );
  const setSignature = useCallback(
    (value: SetStateAction<string>) => setUserComposeSetting("signature", value),
    [setUserComposeSetting]
  );
  const setDefaultFrom = useCallback(
    (value: SetStateAction<string>) =>
      setUserComposeSetting("defaultFrom", value),
    [setUserComposeSetting]
  );
  const [notificationsEnabled, setNotificationsEnabled] = useLocalStorage(
    "notificationsEnabled",
    true
  );
  // Read by the sign-in and refocus subscribes, which run outside render.
  const notificationsEnabledRef = useRef(notificationsEnabled);
  notificationsEnabledRef.current = notificationsEnabled;
  // The switch covers the whole browser, so follow a change made in another tab.
  useEffect(() => {
    const followOtherTabs = (event: StorageEvent) => {
      if (event.key !== "notificationsEnabled") return;
      setNotificationsEnabled(event.newValue !== "false");
    };
    window.addEventListener("storage", followOtherTabs);
    return () => window.removeEventListener("storage", followOtherTabs);
  }, [setNotificationsEnabled]);
  // Draft signal for the rail Compose dot (design doc §7): owned by the
  // Writer, which is the only component that sees the draft fields.
  const [hasDraft, setHasDraft] = useState(false);

  // Search park (design doc §9): the account and folder in effect before
  // the current search. Entering search stores them; clearing the search
  // restores them. Refs — no component renders from them.
  const preSearchAccount = useRef("");
  const preSearchCategory = useRef(Category.AllMails);

  // Shared by the rail Search tab and the header search trigger.
  const enterSearch = useCallback(() => {
    // Navigating closes the writer: the writer docks over the list, so
    // leaving it open would hide the view the tap just switched to.
    setIsWriterOpen(false);
    setIsSettingsOpen(false);
    // Re-entering while already searching must not re-park: the live term
    // sits in selectedAccount, so parking again would store the term as
    // the pre-search account and clear would restore search itself.
    if (selectedCategory === Category.Search) return;
    preSearchAccount.current = selectedAccount;
    preSearchCategory.current = selectedCategory;
    setSelectedCategory(Category.Search);
    // The term lives in selectedAccount while searching, so it starts
    // empty — the list shows the pre-search account's mail until the user
    // types (design doc §9: the list, not the landing page, is the
    // pre-search state).
    setSelectedAccount("");
  }, [selectedAccount, selectedCategory]);

  const exitSearch = useCallback(() => {
    // Restore the parked account and folder. An empty parked account (no
    // account was selected when search opened) stays empty — the anchor
    // hook re-anchors it to the folder's first account on the next pass.
    setSelectedAccount(preSearchAccount.current);
    setSelectedCategory(preSearchCategory.current);
  }, []);

  const lastRefresh = useRef(Date.now());
  const lastFocusCheck = useRef(0);

  useEffect(() => {
    const handleResize = () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    };
    const handleOrientationChange = () => {
      setViewSize({ width: window.innerWidth, height: window.innerHeight });
    };
    const handleScroll = () => {
      window.scrollTo(window.scrollX, window.scrollY);
    };
    const handleFocus = async () => {
      const now = Date.now();
      const fiveSeconds = 5000;
      if (now - lastFocusCheck.current < fiveSeconds) return;
      lastFocusCheck.current = now;

      const user = await callUser();
      if (!user) return;
      const duration = now - lastRefresh.current;
      const oneDay = 1000 * 60 * 60 * 24;
      if (duration < oneDay) return;
      if (notificationsEnabledRef.current) new Notifier().subscribe();
      lastRefresh.current = now;
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleOrientationChange);
    window.addEventListener("scroll", handleScroll);
    window.addEventListener("focus", handleFocus);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    if (!domainName) {
      call
        .get<DomainGetResponse>("/api/mails/domain")
        .then((r) => setDomainName(r.body || ""));
    }
  }, [domainName, setDomainName]);

  useEffect(() => {
    const noti = new Notifier();
    noti.clearBadge();
    noti.setBadge(newMailsTotal);
  }, [newMailsTotal]);

  useEffect(() => {
    if (!userInfo) {
      setSelectedAccount("");
      setSelectedCategory(Category.AllMails);
      setIsWriterOpen(false);
      setIsSettingsOpen(false);
      setIsAccountsOpen(false);
      setReplyData({});
      setNewMailsTotal(0);
    } else {
      registerServiceWorker();
      if (notificationsEnabledRef.current) new Notifier().subscribe();
    }
  }, [
    userInfo,
    setSelectedAccount,
    setSelectedCategory,
    setIsWriterOpen,
    setIsAccountsOpen,
    setReplyData,
    setNewMailsTotal
  ]);

  // stores states to export with `Context`
  const contextValue: ContextType = {
    viewSize,
    userInfo,
    setUserInfo,
    domainName,
    isAccountsOpen: isAccountsMenuOpen(viewSize.width, isAccountsOpen),
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen,
    isSettingsOpen,
    setIsSettingsOpen,
    replyData,
    setReplyData,
    selectedAccount,
    setSelectedAccount,
    selectedCategory,
    setSelectedCategory,
    isAllAccounts,
    setIsAllAccounts,
    newMailsTotal,
    setNewMailsTotal,
    preSearchAccount,
    preSearchCategory,
    enterSearch,
    exitSearch,
    density,
    setDensity,
    theme,
    setTheme,
    signature,
    setSignature,
    includeOriginal,
    setIncludeOriginal,
    defaultFrom,
    setDefaultFrom,
    notificationsEnabled,
    setNotificationsEnabled,
    hasDraft,
    setHasDraft
  };

  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Context.Provider value={contextValue}>
          <IsOnlineProvider>
            <FeedbackProvider>
              <BrowserRouter>
                <ErrorBoundary>
                  <OfflineBanner />
                  <Header />
                  <Routes>
                    <Route
                      path="/"
                      element={
                        userInfo ? <Box /> : <Navigate to="/sign-in" replace />
                      }
                    />
                    <Route
                      path="/mail/:mailId"
                      element={
                        userInfo ? <Box /> : <Navigate to="/sign-in" replace />
                      }
                    />
                    <Route
                      path="/sign-in"
                      element={
                        userInfo ? <Navigate to="/" replace /> : <SignIn />
                      }
                    />
                    <Route
                      path="/set-info"
                      element={
                        userInfo ? <Navigate to="/" replace /> : <SignUp />
                      }
                    />
                    <Route
                      path="/set-info/:email"
                      element={
                        userInfo ? <Navigate to="/" replace /> : <SignUp />
                      }
                    />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </ErrorBoundary>
              </BrowserRouter>
            </FeedbackProvider>
          </IsOnlineProvider>
        </Context.Provider>
      </QueryClientProvider>
    </StrictMode>
  );
};

export default App;
