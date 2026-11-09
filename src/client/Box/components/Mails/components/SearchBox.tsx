import {
  useState,
  useRef,
  useEffect,
  useContext,
  ChangeEventHandler,
  KeyboardEventHandler
} from "react";
import { Context } from "client";

// The search box (design doc §9): at the top of the center column with the
// scope label, not in the accounts column. Typing filters messages and
// accounts; the term commits into `selectedAccount` (debounced, or
// immediately on Enter) exactly as the old accounts-column input did, so
// the search-results query, the found-accounts side-tab, and the
// pre-search restore all keep working unchanged.
//
// The input is controlled by local state: the committed term lives in
// `selectedAccount`, which is blank while the pre-search list shows, so the
// box cannot read its value back from there. Clearing the box (×) exits
// search entirely — it restores the parked account and folder — while
// deleting the text by hand only empties the query and leaves the
// pre-search list showing.
const SearchBox = () => {
  const { setSelectedAccount, exitSearch } = useContext(Context);
  const [term, setTerm] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const searchDelay = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  // Focus on mount: entering search is always a fresh mount of this box,
  // and the box is the reason the user opened search.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(
    () => () => {
      // A pending commit must not fire after the box unmounts (leaving
      // search, or clearing) and overwrite the restored account with a
      // stale term.
      clearTimeout(searchDelay.current);
    },
    []
  );

  const commit = (value: string) => {
    clearTimeout(searchDelay.current);
    searchDelay.current = setTimeout(() => {
      setSelectedAccount(value);
    }, 500);
  };

  const onChange: ChangeEventHandler<HTMLInputElement> = (e) => {
    const value = e.target.value;
    setTerm(value);
    commit(value);
  };

  const onKeyDown: KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter") {
      const target = e.target as HTMLInputElement;
      // Search immediately instead of waiting out the debounce.
      clearTimeout(searchDelay.current);
      setSelectedAccount(target.value);
    }
  };

  const onClickClear = () => {
    clearTimeout(searchDelay.current);
    setTerm("");
    exitSearch();
  };

  return (
    <div className="search-box">
      <span className="search-scope">Searching messages and accounts</span>
      <div className="search-field">
        <input
          type="search"
          value={term}
          onChange={onChange}
          onKeyDown={onKeyDown}
          placeholder="Search…"
          aria-label="Search messages and accounts"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck="false"
          ref={inputRef}
        />
        {term ? (
          <button
            type="button"
            className="clear-button"
            aria-label="Clear search"
            onClick={onClickClear}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
};

export default SearchBox;
