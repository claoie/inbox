import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Account } from "common";
import { Category, call } from "client";
import path from "path";

// The narrow bottom bar (≤750px) shows five labeled items — Folders, Search,
// Compose, Settings, Refresh — and the Folders entry opens a bottom sheet
// with the five folders and their unread counts (design doc §4, option A).
// These tests mount the real Accounts component (same harness as
// `writer-nav.test.ts`) and drive the rail and the sheet.
beforeAll(() => {
  GlobalRegistrator.register();
  // React 18 only lets `act` flush work when this flag is set.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const accountsPayload = {
  received: [
    new Account({
      key: "maple@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 5,
      unread_doc_count: 2,
      saved_doc_count: 1
    }),
    new Account({
      key: "fern@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 3,
      unread_doc_count: 1,
      saved_doc_count: 0
    })
  ],
  sent: [
    new Account({
      key: "maple@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 4,
      unread_doc_count: 1,
      saved_doc_count: 0
    })
  ],
  spam: [
    new Account({
      key: "spam@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 3,
      unread_doc_count: 3,
      saved_doc_count: 0
    })
  ]
};

let originalGet: typeof call.get;

beforeEach(() => {
  window.localStorage.clear();
  originalGet = call.get;
  // The search side-tab is fed by /api/mails/search-accounts/<term>, which
  // answers an Account array — not the accounts-payload object the main
  // accounts query answers. Route the mock by URL so a Search mount lists
  // the found account.
  call.get = (async (url: string) => ({
    status: "success",
    body: url.includes("/api/mails/search-accounts/")
      ? accountsPayload.received
      : accountsPayload
  })) as typeof call.get;
});

afterEach(() => {
  call.get = originalGet;
});

type MountOptions = {
  width?: number;
  writerOpen?: boolean;
  accountsOpen?: boolean;
  category?: Category;
  selectedAccount?: string;
};

const mountAccounts = async (options: MountOptions = {}) => {
  const {
    width = 1920,
    writerOpen = false,
    accountsOpen = true,
    category = Category.AllMails,
    selectedAccount = ""
  } = options;

  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { Context, IsOnlineProvider } = await import("client");
  const Accounts = (await import("./index")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });

  // The setters are recorded, not stubbed away: the fix under test is
  // exactly which setters the sheet's folder tap calls.
  const writerOpenCalls: boolean[] = [];
  const accountsOpenCalls: boolean[] = [];
  const categoryCalls: Category[] = [];
  const selectedAccountCalls: string[] = [];

  // Minimum context `Accounts` reads.
  const contextValue = {
    viewSize: { width, height: 1080 },
    domainName: "example.com",
    userInfo: undefined,
    setUserInfo: () => {},
    isAccountsOpen: accountsOpen,
    setIsAccountsOpen: (value: boolean) => {
      accountsOpenCalls.push(value);
    },
    isWriterOpen: writerOpen,
    setIsWriterOpen: (value: boolean) => {
      writerOpenCalls.push(value);
    },
    isSettingsOpen: false,
    setIsSettingsOpen: () => {},
    replyData: {},
    setReplyData: () => {},
    selectedAccount: selectedAccount,
    setSelectedAccount: (value: string) => {
      selectedAccountCalls.push(value);
    },
    selectedCategory: category,
    setSelectedCategory: (value: Category) => {
      categoryCalls.push(value);
    },
    newMailsTotal: 3,
    setNewMailsTotal: () => {},
    preSearchAccount: { current: "" },
    preSearchCategory: { current: Category.AllMails },
    enterSearch: () => {},
    exitSearch: () => {},
    density: "comfortable",
    setDensity: () => {},
    hasDraft: false,
    setHasDraft: () => {}
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          IsOnlineProvider,
          null,
          createElement(
            Context.Provider,
            { value: contextValue as never },
            createElement(Accounts, { setPage: () => {} })
          )
        )
      )
    );
  });

  // The rail renders once the accounts query resolves; poll until it is
  // there (or fail loudly — a missing rail is the finding).
  const waitForRail = async () => {
    for (let i = 0; i < 100; i++) {
      const items = container.querySelectorAll(".categories .rail-item");
      if (items.length > 0) return items;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error("Rail items never rendered");
  };

  const clickRailItem = async (label: string) => {
    const items = await waitForRail();
    const item = Array.from(items).find((el) =>
      el.textContent?.includes(label)
    ) as HTMLElement;
    expect(item).not.toBeUndefined();
    await act(async () => {
      item.click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  // The sheet renders through a portal into document.body; poll until its
  // rows are there (or fail loudly — a missing sheet is the finding).
  const waitForSheetRows = async () => {
    for (let i = 0; i < 100; i++) {
      const rows = document.body.querySelectorAll(".folders-sheet-row");
      if (rows.length > 0) return rows;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error("Folders sheet rows never rendered");
  };

  const clickSheetRow = async (label: string) => {
    const rows = await waitForSheetRows();
    const row = Array.from(rows).find((el) =>
      el.textContent?.includes(label)
    ) as HTMLElement;
    expect(row).not.toBeUndefined();
    await act(async () => {
      row.click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  return {
    container,
    writerOpenCalls,
    accountsOpenCalls,
    categoryCalls,
    selectedAccountCalls,
    clickRailItem,
    clickSheetRow,
    waitForRail,
    waitForSheetRows,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    }
  };
};

describe("Folders entry opens the sheet", () => {
  it("lists all five folders with their unread counts", async () => {
    const { clickRailItem, waitForSheetRows, teardown } =
      await mountAccounts({ width: 390 });
    try {
      await clickRailItem("Folders");
      const rows = await waitForSheetRows();
      expect(rows.length).toBe(5);
      const byLabel = new Map(
        Array.from(rows).map((row) => [
          row.querySelector(".folders-sheet-label")?.textContent,
          row.querySelector(".numberBall")?.textContent
        ])
      );
      expect(byLabel.get("New Mails")).toBe("3");
      expect(byLabel.get("All Mails")).toBe("3");
      expect(byLabel.get("Saved Mails")).toBe("1");
      expect(byLabel.get("Sent Mails")).toBe("1");
      expect(byLabel.get("Spam Mails")).toBe("3");
    } finally {
      await teardown();
    }
  });

  it("tapping a folder switches it, closes the sheet, and closes the writer", async () => {
    const {
      writerOpenCalls,
      categoryCalls,
      clickRailItem,
      clickSheetRow,
      teardown
    } = await mountAccounts({ width: 390, writerOpen: true });
    try {
      await clickRailItem("Folders");
      await clickSheetRow("Saved Mails");
      expect(categoryCalls).toContain(Category.SavedMails);
      expect(writerOpenCalls).toContain(false);
      expect(document.body.querySelector(".folders-sheet")).toBeNull();
    } finally {
      await teardown();
    }
  });
});

describe("Sheet opens above the writer", () => {
  it("renders in the body portal while the writer is open", async () => {
    const { clickRailItem, waitForSheetRows, teardown } = await mountAccounts(
      { width: 390, writerOpen: true }
    );
    try {
      await clickRailItem("Folders");
      const rows = await waitForSheetRows();
      expect(rows.length).toBe(5);
      expect(document.body.querySelector(".folders-sheet")).not.toBeNull();
    } finally {
      await teardown();
    }
  });

  it("the sheet overlay sits above the writer pane and the bottom bar", async () => {
    // happy-dom has no layout engine, so the z-order itself is pinned here
    // in the stylesheet: the overlay is on the dialog layer (z-index 1000),
    // above the writer pane (28) and the bottom bar (40), and the panel
    // docks above the 72px bar. The sandbox screenshots verify the rendered
    // result at both widths.
    const scss = await Bun.file(
      path.join(import.meta.dir, "components/FoldersSheet/index.scss")
    ).text();
    expect(scss).toMatch(
      /\.folders-sheet-overlay\s*\{[^}]*?z-index:\s*1000;/s
    );
    expect(scss).toMatch(
      /\.folders-sheet\s*\{[^}]*?margin-bottom:\s*var\(--bottomBarHeight\);/s
    );
    // No light literals: the sheet is dark-themed from the budget tokens.
    expect(scss).not.toContain("#fff");
    expect(scss).not.toContain("#ffffff");
  });
});

describe("Sheet takes focus on open", () => {
  it("focus lands inside the dialog when the sheet opens", async () => {
    const { clickRailItem, teardown } = await mountAccounts({ width: 390 });
    try {
      await clickRailItem("Folders");
      // The close button autoFocuses on open, so a keyboard user tabs
      // from inside the sheet — not through the bar behind the overlay.
      const active = document.activeElement as HTMLElement | null;
      expect(active).not.toBeNull();
      expect(active?.closest(".folders-sheet")).not.toBeNull();
      expect(active?.classList.contains("folders-sheet-close")).toBe(true);
    } finally {
      await teardown();
    }
  });
});

describe("Narrow bar shows five labeled items", () => {
  it("the wide rail renders all ten items with their labels", async () => {
    const { waitForRail, teardown } = await mountAccounts({ width: 1920 });
    try {
      const items = await waitForRail();
      // Six category items + Folders + Compose + Settings + Refresh.
      expect(items.length).toBe(10);
      const labels = Array.from(items).map(
        (el) => el.querySelector(".rail-label")?.textContent
      );
      expect(labels).toContain("Folders");
      expect(labels).toContain("New");
      expect(labels).toContain("All");
      expect(labels).toContain("Saved");
      expect(labels).toContain("Sent");
      expect(labels).toContain("Spam");
      expect(labels).toContain("Search");
      expect(labels).toContain("Compose");
      expect(labels).toContain("Settings");
      expect(labels).toContain("Refresh");
    } finally {
      await teardown();
    }
  });

  it("the narrow bar hides the folder items, shows Folders, and keeps labels", async () => {
    // happy-dom has no layout engine, so the breakpoint rules themselves
    // are pinned here in the stylesheet: the five folder items hide at
    // ≤750px, the Folders entry shows there (and hides above it), and the
    // rail labels are no longer hidden at ≤750px — five labeled items fit
    // a phone width. The sandbox screenshots verify the rendered result.
    const scss = await Bun.file(
      path.join(import.meta.dir, "index.scss")
    ).text();
    // Anchor the pins to the media-query block: the base (wide) rules live
    // before `@media (max-width: 750px)`, the breakpoint rules inside it.
    // Unanchored regexes match the rule text anywhere, so swapping the two
    // `display` values — a complete inversion of the feature — stayed green.
    const mediaStart = scss.indexOf("@media (max-width: 750px)");
    expect(mediaStart).toBeGreaterThan(-1);
    const base = scss.slice(0, mediaStart);
    const breakpoint = scss.slice(mediaStart);
    // Wide: the Folders entry hides; the folder items are not hidden here.
    expect(base).toMatch(/&\.folders-rail-item\s*\{\s*display:\s*none;/);
    expect(base).not.toMatch(/&\.folder-rail-item\s*\{\s*display:\s*none;/);
    // ≤750px: the folder items hide and the Folders entry shows.
    expect(breakpoint).toMatch(/&\.folder-rail-item\s*\{\s*display:\s*none;/);
    expect(breakpoint).toMatch(
      /&\.folders-rail-item\s*\{\s*display:\s*flex;/
    );
    expect(breakpoint).not.toMatch(
      /&\.folders-rail-item\s*\{\s*display:\s*none;/
    );
    expect(scss).not.toMatch(/\.rail-label\s*\{\s*display:\s*none/);
  });
});
