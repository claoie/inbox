import { Suspense, UIEventHandler, useContext, useEffect, useRef, useState } from "react";
import { Writer, Accounts, Mails } from "./components";
import { Context } from "client";
import "./index.scss";

export * from "./components";

// The shell is a CSS grid (design doc §4): an 80px rail, the 320px accounts
// column, and the centered message list. The accounts column leaves the grid
// and becomes an overlay below 1050px; the rail becomes a bottom bar below
// 750px (see Box/index.scss). Compose docks at the right edge of the grid,
// fully on-screen — there are no negative pane offsets anywhere in this
// shell, and no swipe math: the rail buttons are the explicit controls.
const Box = () => {
  const {
    isAccountsOpen,
    setIsAccountsOpen,
    isWriterOpen,
    setIsWriterOpen
  } = useContext(Context);

  const [page, setPage] = useState(1);
  const centerColRef = useRef<HTMLDivElement>(null);
  const centerInnerRef = useRef<HTMLDivElement>(null);

  const loadMoreNearBottom = (centerCol: HTMLElement) => {
    const { scrollHeight, offsetHeight, scrollTop } = centerCol;
    if (scrollHeight - 100 <= offsetHeight + scrollTop) setPage((p) => p + 1);
  };

  const onCenterScroll: UIEventHandler<HTMLDivElement> = (e) => {
    loadMoreNearBottom(e.currentTarget);
  };

  // A list shorter than a tall column never scrolls, so the next page would
  // never load. Re-check whenever the list or the column resizes; once every
  // mail is shown the list stops growing and the checks stop.
  useEffect(() => {
    const centerCol = centerColRef.current;
    const centerInner = centerInnerRef.current;
    if (!centerCol || !centerInner) return;
    const observer = new ResizeObserver(() => loadMoreNearBottom(centerCol));
    observer.observe(centerCol);
    observer.observe(centerInner);
    return () => observer.disconnect();
  }, []);

  const onClickCenterCurtain = () => {
    if (!isWriterOpen) setIsAccountsOpen(false);
    setIsWriterOpen(false);
  };

  return (
    <div className={"shell" + (isAccountsOpen ? "" : " accounts-closed")}>
      <Suspense fallback={<></>}>
        <Accounts setPage={setPage} />
      </Suspense>
      <div
        className={
          "center-col" + (isAccountsOpen ? " lock-scroll" : "")
        }
        onScroll={onCenterScroll}
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
        <div className="center-inner" ref={centerInnerRef}>
          <Suspense fallback={<></>}>
            <Mails page={page} />
          </Suspense>
        </div>
      </div>
      <div className={"writer-pane" + (isWriterOpen ? " open" : "")}>
        <Suspense fallback={<></>}>
          <Writer />
        </Suspense>
      </div>
    </div>
  );
};

export default Box;
