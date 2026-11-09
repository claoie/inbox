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

// Logout lives at the bottom of the accounts panel (design doc §4), not in
// the rail — and the move keeps the existing window.confirm gate, so an
// accidental tap can't end the session. These tests mount the real Accounts
// component (same harness as `writer-listener.test.ts`) and drive that flow.
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
      doc_count: 1,
      unread_doc_count: 0,
      saved_doc_count: 0
    })
  ],
  sent: [],
  spam: []
};

let deleteCalls: string[] = [];
let setUserInfoCalls: unknown[] = [];
let setSelectedAccountCalls: string[] = [];
let confirmValue = true;
let originalGet: typeof call.get;
let originalDelete: typeof call.delete;
let originalConfirm: typeof window.confirm;

beforeEach(() => {
  window.localStorage.clear();
  deleteCalls = [];
  setUserInfoCalls = [];
  setSelectedAccountCalls = [];
  confirmValue = true;
  originalGet = call.get;
  originalDelete = call.delete;
  originalConfirm = window.confirm;
  call.get = (async () => ({
    status: "success",
    body: accountsPayload
  })) as typeof call.get;
  call.delete = (async (path: string) => {
    deleteCalls.push(path);
    return { status: "success" };
  }) as typeof call.delete;
  window.confirm = () => confirmValue;
});

afterEach(() => {
  call.get = originalGet;
  call.delete = originalDelete;
  window.confirm = originalConfirm;
});

const mountAccounts = async (online = true, hasDraft = false) => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { Context, IsOnlineProvider } = await import("client");
  const Accounts = (await import("./index")).default;

  // The offline case mounts under the real provider, which reads
  // navigator.onLine on mount — stub it before rendering.
  const originalOnLine = window.navigator.onLine;
  if (!online) {
    Object.defineProperty(window.navigator, "onLine", {
      value: false,
      configurable: true
    });
  }

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });

  // Minimum context `Accounts` reads.
  const contextValue = {
    viewSize: { width: 1920, height: 1080 },
    domainName: "example.com",
    userInfo: undefined,
    setUserInfo: (value: unknown) => {
      setUserInfoCalls.push(value);
    },
    isAccountsOpen: true,
    setIsAccountsOpen: () => {},
    isWriterOpen: false,
    setIsWriterOpen: () => {},
    isSettingsOpen: false,
    setIsSettingsOpen: () => {},
    replyData: {},
    setReplyData: () => {},
    selectedAccount: "",
    setSelectedAccount: (value: string) => {
      setSelectedAccountCalls.push(value);
    },
    selectedCategory: Category.AllMails,
    setSelectedCategory: () => {},
    newMailsTotal: 0,
    setNewMailsTotal: () => {},
    preSearchAccount: { current: "" },
    preSearchCategory: { current: Category.AllMails },
    enterSearch: () => {},
    exitSearch: () => {},
    density: "comfortable",
    setDensity: () => {},
    hasDraft,
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

  // The accounts query resolves asynchronously; poll inside `act` until the
  // footer renders (or fail loudly — a missing button is the finding).
  const waitForLogout = async () => {
    for (let i = 0; i < 100; i++) {
      const el = container.querySelector(".accounts-logout");
      if (el) return el as HTMLButtonElement;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error("Logout button never rendered");
  };

  // Click, then let the async teardown (logout call, cache clear, setters)
  // settle.
  const clickLogout = async (button: HTMLButtonElement) => {
    await act(async () => {
      button.click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  return {
    act,
    container,
    waitForLogout,
    clickLogout,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
      if (!online) {
        Object.defineProperty(window.navigator, "onLine", {
          value: originalOnLine,
          configurable: true
        });
      }
    }
  };
};

describe("Accounts logout placement", () => {
  it("renders Logout in the accounts panel, not in the rail", async () => {
    const { container, waitForLogout, teardown } = await mountAccounts();
    try {
      const button = await waitForLogout();
      expect(button.textContent).toBe("Logout");
      // The button's ancestor chain runs through .accounts, never .categories.
      expect(button.closest(".accounts")).not.toBeNull();
      expect(button.closest(".categories")).toBeNull();
      expect(
        container.querySelector(".categories [aria-label='Logout']")
      ).toBeNull();
      // Six folders + Folders + Compose + Settings + Refresh; Logout no
      // longer counts.
      expect(
        container.querySelectorAll(".categories .rail-item").length
      ).toBe(10);
    } finally {
      await teardown();
    }
  });

  it("is disabled while offline", async () => {
    const { waitForLogout, teardown } = await mountAccounts(false);
    try {
      const button = await waitForLogout();
      expect(button.disabled).toBe(true);
      expect(button.title).toContain("offline");
    } finally {
      await teardown();
    }
  });
});

describe("Accounts compose draft dot", () => {
  const composeItem = (container: HTMLElement) =>
    Array.from(container.querySelectorAll(".categories .rail-item")).find(
      (el) => el.textContent?.includes("Compose")
    ) as HTMLElement;

  it("shows a dot on Compose while a draft exists", async () => {
    const { container, waitForLogout, teardown } = await mountAccounts(
      true,
      true
    );
    try {
      await waitForLogout();
      expect(
        composeItem(container).querySelector(".numberBall")
      ).not.toBeNull();
    } finally {
      await teardown();
    }
  });

  it("shows no dot without a draft", async () => {
    const { container, waitForLogout, teardown } = await mountAccounts();
    try {
      await waitForLogout();
      expect(composeItem(container).querySelector(".numberBall")).toBeNull();
    } finally {
      await teardown();
    }
  });
});

describe("Accounts footer pinning", () => {
  it("pins Logout to the panel bottom for short lists and while scrolling", async () => {
    // happy-dom has no layout engine, so the pinning rules themselves are
    // pinned here in the stylesheet: the panel is a flex column, the footer
    // takes the free space with margin-top: auto (short list), and keeps
    // position: sticky + bottom: 0 for the scrolling case. The sandbox
    // screenshots verify the rendered result at both widths.
    const scss = await Bun.file(
      path.join(import.meta.dir, "index.scss")
    ).text();
    expect(scss).toMatch(
      /\.accounts\s*\{[^}]*?display:\s*flex;\s*flex-direction:\s*column;/s
    );
    expect(scss).toMatch(
      /\.accounts_footer\s*\{[^}]*?margin-top:\s*auto;/s
    );
    expect(scss).toMatch(
      /\.accounts_footer\s*\{[^}]*?position:\s*sticky;\s*bottom:\s*0;/s
    );
  });
});

describe("Accounts logout confirm", () => {
  it("cancel keeps the session: no logout call, no state cleared", async () => {
    confirmValue = false;
    const { waitForLogout, clickLogout, teardown } = await mountAccounts();
    try {
      const button = await waitForLogout();
      await clickLogout(button);
      expect(deleteCalls).toEqual([]);
      expect(setUserInfoCalls).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it("confirm logs out: session torn down and selection cleared", async () => {
    confirmValue = true;
    const { waitForLogout, clickLogout, teardown } = await mountAccounts();
    try {
      const button = await waitForLogout();
      await clickLogout(button);
      expect(deleteCalls).toEqual(["/api/users/login"]);
      expect(setUserInfoCalls).toEqual([undefined]);
      expect(setSelectedAccountCalls).toContain("");
    } finally {
      await teardown();
    }
  });
});
