import { Category } from "client";

/** Widths at or below this use the bottom bar and the Folders sheet. */
export const NARROW_MAX_WIDTH = 750;

/**
 * Widths at or above this show the accounts list as a permanent column
 * between the rail and the message list instead of a menu: the 80px rail,
 * the 320px column, and the list's 950px max width plus its 16px padding.
 * From here up the column never narrows the list below its full width.
 */
export const ACCOUNTS_COLUMN_MIN_WIDTH = 1366;

export const hasAccountsColumn = (width: number): boolean =>
  width >= ACCOUNTS_COLUMN_MIN_WIDTH;

/**
 * Whether the accounts menu is open. Where the list is a column there is no
 * menu to open, so it is never open there, whatever was last requested.
 */
export const isAccountsMenuOpen = (width: number, requested: boolean) =>
  requested && !hasAccountsColumn(width);

/**
 * How the shell lays out the accounts list: a permanent grid column on wide
 * screens, otherwise the header's menu, open or closed.
 */
export const accountsShellClass = (
  width: number,
  isMenuOpen: boolean
): "accounts-column" | "accounts-open" | "accounts-closed" => {
  if (hasAccountsColumn(width)) return "accounts-column";
  return isMenuOpen ? "accounts-open" : "accounts-closed";
};

/**
 * Whether moving from folder `from` to folder `to` opens the accounts menu.
 * On the narrow layout the account list sits behind the header, so a folder
 * change opens it to pick the account next. Wider layouts, Search, and
 * re-picking the current folder leave it closed.
 */
export const opensAccountsAfterFolderChange = (
  width: number,
  from: Category,
  to: Category
): boolean =>
  width <= NARROW_MAX_WIDTH && to !== Category.Search && from !== to;
