import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { openedFromList } from "./components/Mails/mailPage";
import { Writer, Accounts, Mails, Settings, Thread } from "./components";
import { accountsShellClass } from "./components/Accounts/accountsMenu";
import { Context } from "client";
import "./index.scss";

export * from "./components";

// The shell is a CSS grid (design doc §4): an 80px rail and the centered
// message list, with the accounts list as a 320px column between them on
// wide screens (see `hasAccountsColumn`) and a menu opened from the header
// below that. The rail becomes a bottom bar below 750px (see
// Box/index.scss). Compose docks at the right edge of the grid, fully
// on-screen — there are no negative pane offsets anywhere in this shell, and
// no swipe math: the rail buttons are the explicit controls.
const Box = () => {
  const {
    viewSize,
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen,
    isSettingsOpen,
    selectedAccount,
    selectedCategory,
    isAllAccounts
  } = useContext(Context);

  // `/mail/:mailId` shows that mail's conversation over the list, which
  // stays mounted underneath so Back returns to the same scroll position.
  const { mailId } = useParams<{ mailId?: string }>();
  const navigate = useNavigate();
  const location = useLocation();

  // Switching account or folder while reading is navigation to that list.
  // Entering or leaving the unified view is the same: the list behind the
  // open message changed even though the account and folder did not.
  const listKey = `${selectedCategory}|${selectedAccount}|${isAllAccounts}`;
  const lastListKey = useRef(listKey);
  useEffect(() => {
    if (lastListKey.current === listKey) return;
    lastListKey.current = listKey;
    if (!mailId) return;
    // Opened from the list: step back to it, so history doesn't gain a
    // second list entry. Opened directly: replace the page with the list.
    if (openedFromList(location.state)) navigate(-1);
    else navigate("/", { replace: true });
  }, [listKey, mailId, navigate, location.state]);

  const [page, setPage] = useState(1);
  const centerColRef = useRef<HTMLElement>(null);
  const writerPaneRef = useRef<HTMLDivElement>(null);

  // The writer stays mounted while closed, so its pane keeps the old scroll
  // position; every opening starts at the top, with From and To in view.
  useEffect(() => {
    if (isWriterOpen && writerPaneRef.current) {
      writerPaneRef.current.scrollTop = 0;
    }
  }, [isWriterOpen]);

  const loadMoreNearBottom = useCallback(() => {
    const centerCol = centerColRef.current;
    if (!centerCol) return;
    const { scrollHeight, offsetHeight, scrollTop } = centerCol;
    if (scrollHeight - 100 <= offsetHeight + scrollTop) setPage((p) => p + 1);
  }, []);

  const onClickCenterCurtain = () => {
    if (!isWriterOpen) setIsAccountsOpen(false);
    setIsWriterOpen(false);
  };

  return (
    <div
      className={
        "shell " + accountsShellClass(viewSize.width, isAccountsOpen)
      }
    >
      <Suspense fallback={<></>}>
        <Accounts setPage={setPage} />
      </Suspense>
      <main
        className={
          "center-col" +
          (isAccountsOpen ? " lock-scroll" : "") +
          (isSettingsOpen || mailId ? " behind-settings" : "")
        }
        onScroll={loadMoreNearBottom}
        ref={centerColRef}
      >
        <div
          className={
            "curtain center-curtain" +
            (isWriterOpen || isAccountsOpen ? " on" : "") +
            (isWriterOpen ? " on-writer" : "") +
            (isAccountsOpen ? " on-accounts" : "")
          }
          onClick={onClickCenterCurtain}
        />
        <div className="center-inner">
          <Suspense fallback={<></>}>
            <Mails page={page} loadMoreIfShort={loadMoreNearBottom} />
          </Suspense>
        </div>
      </main>
      {mailId && !isSettingsOpen ? (
        <div className="center-col thread-col">
          <div className="center-inner">
            <Suspense fallback={<></>}>
              <Thread key={mailId} mailId={mailId} />
            </Suspense>
          </div>
        </div>
      ) : null}
      {isSettingsOpen ? (
        <div className="center-col settings-col">
          <div className="center-inner">
            <Suspense fallback={<></>}>
              <Settings />
            </Suspense>
          </div>
        </div>
      ) : null}
      <div
        className={"writer-pane" + (isWriterOpen ? " open" : "")}
        ref={writerPaneRef}
      >
        <Suspense fallback={<></>}>
          <Writer />
        </Suspense>
      </div>
    </div>
  );
};

export default Box;
