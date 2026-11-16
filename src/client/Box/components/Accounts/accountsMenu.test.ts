import { describe, it, expect } from "bun:test";
import { Category } from "client";
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
  // Stylesheets are read with Bun.file, not fs: sibling suites
  // mock.module("fs", ...), which is process-global in Bun.
  const readStyles = (relative: string) =>
    Bun.file(path.join(import.meta.dir, relative)).text();

  const remToPx = (value: string) =>
    value.endsWith("rem") ? parseFloat(value) * 16 : parseFloat(value);

  it("fits the rail, the column and the full-width list", async () => {
    const variables = await readStyles("../../../variables.css");
    const shell = await readStyles("../../index.scss");
    const maxWidth = Number(variables.match(/--maxWidth:\s*(\d+)px;/)![1]);
    const [, rail, column] = shell.match(
      /&\.accounts-column\s*\{[^}]*grid-template-columns:\s*(\d+)px (\d+)px minmax\(0, 1fr\);/s
    )!;
    const [, right, , left] = shell
      .match(/\.center-col\s*\{[^}]*?padding:\s*([^;]+);/s)![1]
      .trim()
      .split(/\s+/)
      .map(remToPx);
    expect(ACCOUNTS_COLUMN_MIN_WIDTH).toBe(
      Number(rail) + Number(column) + right + left + maxWidth
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

  // Every placement the popover sets has to be undone, or the in-grid
  // column inherits its offset, transform, height cap or stacking and sits
  // over the list.
  it("puts the column in the grid's middle track, not over the list", async () => {
    const accounts = await readStyles("index.scss");
    const rule = accounts.match(
      /\.shell\.accounts-column \.tab-holder \.accounts\s*\{([^}]*)\}/s
    );
    expect(rule).not.toBeNull();
    const declarations = Object.fromEntries(
      rule![1]
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => d.split(/:\s*/) as [string, string])
    );
    expect(declarations).toEqual({
      position: "relative",
      top: "auto",
      left: "auto",
      transform: "none",
      width: "320px",
      height: "100%",
      "max-height": "none",
      "z-index": "auto",
      "border-radius": "0",
      "box-shadow": "none",
      "border-right": "1px solid var(--divider)"
    });
  });
});
