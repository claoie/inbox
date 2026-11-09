import { useEffect, type ComponentType, type SVGProps } from "react";
import { createPortal } from "react-dom";
import { Category, onKeyboardActivate } from "client";
import InboxIcon from "../InboxIcon";
import NewMailIcon from "../NewMailIcon";
import { EmptyStarIcon, BanIcon } from "../../../Mails/components";
import { SendIcon } from "../../../Writer/components";

import "./index.scss";

export type SheetFolder = {
  category: Exclude<Category, Category.Search>;
  count: number;
};

const folderIcons: Record<
  Exclude<Category, Category.Search>,
  ComponentType<SVGProps<SVGSVGElement>>
> = {
  [Category.NewMails]: NewMailIcon,
  [Category.AllMails]: InboxIcon,
  [Category.SavedMails]: EmptyStarIcon,
  [Category.SentMails]: SendIcon,
  [Category.SpamMails]: BanIcon
};

// The narrow-nav Folders sheet (design doc §4, option A): the five folders
// with their unread counts, as a bottom sheet. Rendered through a portal
// over everything so it opens above the writer
// pane while the writer is open — tapping a folder is navigation, so it
// closes the writer like any folder tap does.
const FoldersSheet = ({
  folders,
  selectedCategory,
  onSelectFolder,
  onClose
}: {
  folders: SheetFolder[];
  selectedCategory?: Category;
  onSelectFolder: (category: Category) => void;
  onClose: () => void;
}) => {
  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="folders-sheet-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="folders-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Folders"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="folders-sheet-header">
          <h2>Folders</h2>
          <button
            type="button"
            className="folders-sheet-close"
            aria-label="Close folders"
            autoFocus
            onClick={onClose}
            onKeyDown={onKeyboardActivate(onClose)}
          >
            ×
          </button>
        </header>
        <ul className="folders-sheet-list">
          {folders.map(({ category, count }) => {
            const Icon = folderIcons[category];
            const classes = ["folders-sheet-row"];
            if (selectedCategory === category) classes.push("clicked");
            const onClick = () => {
              onSelectFolder(category);
              onClose();
            };
            return (
              <li key={category}>
                <div
                  className={classes.join(" ")}
                  role="button"
                  tabIndex={0}
                  aria-current={
                    selectedCategory === category ? true : undefined
                  }
                  onClick={onClick}
                  onKeyDown={onKeyboardActivate(onClick)}
                >
                  <Icon />
                  <span className="folders-sheet-label">{category}</span>
                  {count ? (
                    <div className="numberBall">{count}</div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body
  );
};

export default FoldersSheet;
