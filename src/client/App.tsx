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
  Header,
  SignIn,
  Box,
  SignUp,
  ErrorBoundary,
  OfflineBanner,
  IsOnlineProvider,
  useLocalStorage,
  Notifier,
  call,
  callUser,
  queryClient,
  registerServiceWorker
} from "client";

export enum Category {
  NewMails = "New Mails",
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
  /** The address From is filled with on a new message when no mailbox is selected. */
  defaultFrom: string;
  setDefaultFrom: Dispatch<SetStateAction<ContextType["defaultFrom"]>>;
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
  const [isAccountsOpen, setIsAccountsOpen] = useLocalStorage(
    "isAccountsOpen",
    window.innerWidth > 1050
  );
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
  const [selectedCategory, setSelectedCategory] = useLocalStorage(
    "selectedCategory",
    Category.AllMails,
    // Search is transient (requires a live search query + preSearchAccount ref
    // that don't survive a page reload). Restoring Category.Search would use
    // the account address as the search term, producing confusing sort order.
    (v) => (v === Category.Search ? Category.AllMails : v)
  );
  const [newMailsTotal, setNewMailsTotal] = useState(0);
  const [density, setDensity] = useLocalStorage<Density>(
    "density",
    "comfortable",
    (v) => (v === "compact" ? "compact" : "comfortable")
  );
  const [signature, setSignature] = useLocalStorage("signature", "");
  const [includeOriginal, setIncludeOriginal] = useLocalStorage(
    "includeOriginal",
    true
  );
  const [defaultFrom, setDefaultFrom] = useLocalStorage("defaultFrom", "");
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
      new Notifier().subscribe();
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
      setIsAccountsOpen(window.innerWidth > 1050);
      setReplyData({});
      setNewMailsTotal(0);
    } else {
      registerServiceWorker();
      new Notifier().subscribe();
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
    isAccountsOpen,
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
    newMailsTotal,
    setNewMailsTotal,
    preSearchAccount,
    preSearchCategory,
    enterSearch,
    exitSearch,
    density,
    setDensity,
    signature,
    setSignature,
    includeOriginal,
    setIncludeOriginal,
    defaultFrom,
    setDefaultFrom,
    hasDraft,
    setHasDraft
  };

  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Context.Provider value={contextValue}>
          <IsOnlineProvider>
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
                </Routes>
              </ErrorBoundary>
            </BrowserRouter>
          </IsOnlineProvider>
        </Context.Provider>
      </QueryClientProvider>
    </StrictMode>
  );
};

export default App;
