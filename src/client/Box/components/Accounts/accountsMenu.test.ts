import { describe, it, expect } from "bun:test";
import { Category } from "client";
import fs from "fs";
import path from "path";
import {
  ACCOUNTS_COLUMN_MIN_WIDTH,
  accountsShellClass,
  hasAccountsColumn,
  isAccountsMenuOpen,
  opensAccountsAfterFolderChange
} from "./accountsMenu";

describe("opensAccountsAfterFolderChange", () => {
  it("opens the menu when a phone moves to another folder", () => {
    expect(
      opensAccountsAfterFolderChange(390, Category.AllMails, Category.SpamMails)
    ).toBe(true);
    expect(
      opensAccountsAfterFolderChange(750, Category.Search, Category.SentMails)
    ).toBe(true);
  });

  it("leaves it closed on wider layouts", () => {
    expect(
      opensAccountsAfterFolderChange(751, Category.AllMails, Category.SpamMails)
    ).toBe(false);
  });

  it("leaves it closed when the folder doesn't change", () => {
    expect(
      opensAccountsAfterFolderChange(390, Category.AllMails, Category.AllMails)
    ).toBe(false);
  });

  it("leaves it closed for Search", () => {
    expect(
      opensAccountsAfterFolderChange(390, Category.AllMails, Category.Search)
    ).toBe(false);
  });
});

describe("accounts column", () => {
  it("fits the rail, the column and the full-width list", () => {
    const rail = 80;
    const column = 320;
    const listMaxWidth = 950;
    const listPadding = 16;
    expect(ACCOUNTS_COLUMN_MIN_WIDTH).toBe(
      rail + column + listMaxWidth + listPadding
    );
  });

  it("shows from the breakpoint up", () => {
    expect(hasAccountsColumn(1365)).toBe(false);
    expect(hasAccountsColumn(1366)).toBe(true);
    expect(hasAccountsColumn(1920)).toBe(true);
  });

  it("stays in the shell whether or not the menu was requested", () => {
    expect(accountsShellClass(1920, false)).toBe("accounts-column");
    expect(accountsShellClass(1920, true)).toBe("accounts-column");
    expect(accountsShellClass(1366, false)).toBe("accounts-column");
  });

  it("leaves the menu behaviour below the breakpoint", () => {
    expect(accountsShellClass(1365, false)).toBe("accounts-closed");
    expect(accountsShellClass(1365, true)).toBe("accounts-open");
    expect(accountsShellClass(390, false)).toBe("accounts-closed");
    expect(accountsShellClass(390, true)).toBe("accounts-open");
  });

  // Picking an account asks to close the menu; with the column on screen
  // that request is moot, and a menu opened before widening is moot too —
  // so no curtain and no scroll lock cover the list.
  it("never reports the menu open where the column shows", () => {
    expect(isAccountsMenuOpen(1920, true)).toBe(false);
    expect(isAccountsMenuOpen(1366, true)).toBe(false);
    expect(isAccountsMenuOpen(1365, true)).toBe(true);
    expect(isAccountsMenuOpen(390, true)).toBe(true);
    expect(isAccountsMenuOpen(390, false)).toBe(false);
  });

  it("puts the column in the grid's middle track, not over the list", () => {
    const shell = fs.readFileSync(
      path.join(import.meta.dir, "../../index.scss"),
      "utf8"
    );
    expect(shell).toMatch(
      /&\.accounts-column\s*\{[^}]*grid-template-columns:\s*80px 320px minmax\(0, 1fr\);/s
    );
    const accounts = fs.readFileSync(
      path.join(import.meta.dir, "index.scss"),
      "utf8"
    );
    const rule = accounts.match(
      /\.shell\.accounts-column \.tab-holder \.accounts\s*\{([^}]*)\}/s
    );
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/position:\s*relative;/);
    expect(rule![1]).toMatch(/transform:\s*none;/);
    expect(rule![1]).toMatch(/width:\s*320px;/);
  });
});
