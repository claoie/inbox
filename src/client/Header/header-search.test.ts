import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Category } from "client";

// Header (design doc §4/§9): the title and the unread count pill next to it.
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

// Below the accounts-column breakpoint, where the title is the menu button.
const menuWidth = 1024;

type MountOptions = {
  width?: number;
  newMailsTotal?: number;
  userInfo?: { username: string } | undefined;
  selectedAccount?: string;
  selectedCategory?: Category;
  isAllAccounts?: boolean;
  isSettingsOpen?: boolean;
  accounts?: unknown;
  isAccountsOpen?: boolean;
  setIsAccountsOpen?: (v: unknown) => void;
  isWriterOpen?: boolean;
  setIsWriterOpen?: (v: unknown) => void;
};

const mountHeader = async (options: MountOptions = {}) => {
  const { newMailsTotal = 0, selectedAccount = "maple@example.com" } = options;
  // NB: destructuring defaults apply to an explicit `undefined` too, so a
  // signed-out mount (userInfo: undefined) needs the `in` check — the
  // default only applies when the key is absent.
  const userInfo =
    "userInfo" in options ? options.userInfo : { username: "maple" };

  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { Context } = await import("client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const Header = (await import("./index")).default;
  const queryClient = new QueryClient();
  if (options.accounts) {
    queryClient.setQueryData("/api/mails/accounts", options.accounts);
  }

  const enterSearchCalls: number[] = [];

  const contextValue = {
    viewSize: { width: options.width ?? menuWidth, height: 1080 },
    domainName: "example.com",
    userInfo,
    setUserInfo: () => {},
    isAccountsOpen: options.isAccountsOpen ?? false,
    setIsAccountsOpen: options.setIsAccountsOpen ?? (() => {}),
    isWriterOpen: options.isWriterOpen ?? false,
    setIsWriterOpen: options.setIsWriterOpen ?? (() => {}),
    replyData: {},
    setReplyData: () => {},
    selectedAccount,
    setSelectedAccount: () => {},
    selectedCategory: options.selectedCategory ?? Category.AllMails,
    setSelectedCategory: () => {},
    isAllAccounts: options.isAllAccounts ?? false,
    setIsAllAccounts: () => {},
    isSettingsOpen: options.isSettingsOpen ?? false,
    setIsSettingsOpen: () => {},
    newMailsTotal,
    setNewMailsTotal: () => {},
    preSearchAccount: { current: "" },
    preSearchCategory: { current: Category.AllMails },
    enterSearch: () => {
      enterSearchCalls.push(1);
    },
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
        Context.Provider,
        { value: contextValue as never },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Header)
        )
      )
    );
  });

  return {
    container,
    enterSearchCalls,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
    }
  };
};

const account = (key: string, unread: number) => ({
  key,
  updated: "2026-01-01T00:00:00.000Z",
  doc_count: 5,
  unread_doc_count: unread,
  saved_doc_count: 0
});

describe("header unread count", () => {
  it("shows the selected account's own unread count next to its name", async () => {
    const mount = await mountHeader({
      newMailsTotal: 27,
      selectedAccount: "maple@example.com",
      accounts: {
        received: [account("maple@example.com", 3), account("fern@example.com", 24)],
        sent: [],
        spam: []
      }
    });
    try {
      const pill = mount.container.querySelector(".header-unread-count");
      expect(mount.container.querySelector("h1 .title-text")?.textContent).toBe(
        "maple@example.com"
      );
      expect(pill?.textContent).toBe("3");
      expect(pill?.getAttribute("title")).toBe("3 unread in maple@example.com");
    } finally {
      await mount.teardown();
    }
  });

  it("shows the all-accounts total when no account is selected", async () => {
    const mount = await mountHeader({ newMailsTotal: 4, selectedAccount: "" });
    try {
      const pill = mount.container.querySelector(".header-unread-count");
      expect(pill?.textContent).toBe("4");
      expect(pill?.getAttribute("title")).toBe("4 unread in all accounts");
    } finally {
      await mount.teardown();
    }
  });

  it("titles the unified view All accounts, with the all-accounts total", async () => {
    const mount = await mountHeader({
      newMailsTotal: 27,
      selectedAccount: "maple@example.com",
      isAllAccounts: true,
      accounts: {
        received: [account("maple@example.com", 3), account("fern@example.com", 24)],
        sent: [],
        spam: []
      }
    });
    try {
      // The parked account behind the flag is not the title.
      expect(mount.container.querySelector("h1 .title-text")?.textContent).toBe(
        "All accounts"
      );
      const pill = mount.container.querySelector(".header-unread-count");
      expect(pill?.textContent).toBe("27");
      expect(pill?.getAttribute("title")).toBe("27 unread in all accounts");
    } finally {
      await mount.teardown();
    }
  });

  it("titles search by its mode, not by the search term", async () => {
    const mount = await mountHeader({
      newMailsTotal: 4,
      selectedAccount: "invoice",
      selectedCategory: Category.Search
    });
    try {
      expect(mount.container.querySelector("h1 .title-text")?.textContent).toBe("Search");
      expect(
        mount.container.querySelector(".header-unread-count")?.getAttribute("title")
      ).toBe("4 unread in all accounts");
    } finally {
      await mount.teardown();
    }
  });

  it("titles the Settings page Settings", async () => {
    const mount = await mountHeader({ isSettingsOpen: true });
    try {
      expect(mount.container.querySelector("h1 .title-text")?.textContent).toBe("Settings");
    } finally {
      await mount.teardown();
    }
  });

  it("shows no pill when nothing is unread", async () => {
    const mount = await mountHeader({ newMailsTotal: 0, selectedAccount: "" });
    try {
      expect(
        mount.container.querySelector(".header-unread-count")
      ).toBeNull();
    } finally {
      await mount.teardown();
    }
  });

  it("shows no pill before sign-in", async () => {
    const mount = await mountHeader({
      newMailsTotal: 4,
      selectedAccount: "",
      userInfo: undefined
    });
    try {
      expect(
        mount.container.querySelector(".header-unread-count")
      ).toBeNull();
    } finally {
      await mount.teardown();
    }
  });
});

describe("header controls", () => {
  // Search and Compose are always on screen in the rail (the bottom bar on
  // a phone), so the header does not repeat them.
  it("has no second search or compose trigger", async () => {
    const mount = await mountHeader();
    try {
      expect(mount.container.querySelector('[aria-label="Search"]')).toBeNull();
      expect(
        mount.container.querySelector('[aria-label="Compose new mail"]')
      ).toBeNull();
    } finally {
      await mount.teardown();
    }
  });
});

describe("header accounts menu button", () => {
  it("opens the accounts menu from the account name", async () => {
    const calls: unknown[] = [];
    const mount = await mountHeader({
      setIsAccountsOpen: (v: unknown) => calls.push(v)
    });
    try {
      const button = mount.container.querySelector(
        "h1 button.title-button"
      ) as HTMLButtonElement;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-controls")).toBe("accounts-menu");
      const { act } = await import("react");
      await act(async () => {
        button.click();
      });
      expect(calls).toEqual([true]);
    } finally {
      await mount.teardown();
    }
  });

  it("closes the writer and opens the menu when composing", async () => {
    const accounts: unknown[] = [];
    const writer: unknown[] = [];
    const mount = await mountHeader({
      isWriterOpen: true,
      setIsWriterOpen: (v: unknown) => writer.push(v),
      setIsAccountsOpen: (v: unknown) => accounts.push(v)
    });
    try {
      const { act } = await import("react");
      await act(async () => {
        (
          mount.container.querySelector("button.title-button") as HTMLElement
        ).click();
      });
      expect(writer).toEqual([false]);
      expect(accounts).toEqual([true]);
    } finally {
      await mount.teardown();
    }
  });

  it("Escape closes the open menu", async () => {
    const calls: unknown[] = [];
    const mount = await mountHeader({
      isAccountsOpen: true,
      setIsAccountsOpen: (v: unknown) => calls.push(v)
    });
    try {
      const { act } = await import("react");
      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        cancelable: true
      });
      await act(async () => {
        window.dispatchEvent(event);
      });
      expect(calls).toEqual([false]);
      // Handled here, so a mail page underneath doesn't also go back.
      expect(event.defaultPrevented).toBe(true);
    } finally {
      await mount.teardown();
    }
  });

  it("opens the menu on a phone too", async () => {
    const calls: unknown[] = [];
    const mount = await mountHeader({
      width: 390,
      setIsAccountsOpen: (v: unknown) => calls.push(v)
    });
    try {
      const { act } = await import("react");
      await act(async () => {
        (
          mount.container.querySelector("button.title-button") as HTMLElement
        ).click();
      });
      expect(calls).toEqual([true]);
    } finally {
      await mount.teardown();
    }
  });

  // The accounts list is a column on screen there, so there's no menu to
  // open: the title names the mailbox, with its count, as plain text.
  it("is plain text where the accounts list is a column", async () => {
    const calls: unknown[] = [];
    const mount = await mountHeader({
      width: 1366,
      newMailsTotal: 3,
      selectedAccount: "maple@example.com",
      accounts: {
        received: [account("maple@example.com", 3)],
        sent: [],
        spam: []
      },
      setIsAccountsOpen: (v: unknown) => calls.push(v)
    });
    try {
      expect(mount.container.querySelector("button")).toBeNull();
      expect(mount.container.querySelector("[aria-controls]")).toBeNull();
      expect(mount.container.querySelector("h1 .title-text")?.textContent).toBe(
        "maple@example.com"
      );
      expect(
        mount.container.querySelector("h1 .header-unread-count")?.textContent
      ).toBe("3");
      const { act } = await import("react");
      await act(async () => {
        (mount.container.querySelector("h1") as HTMLElement).click();
      });
      expect(calls).toEqual([]);
    } finally {
      await mount.teardown();
    }
  });

  it("is plain text before sign-in", async () => {
    const mount = await mountHeader({ userInfo: undefined, selectedAccount: "" });
    try {
      expect(mount.container.querySelector("button")).toBeNull();
      expect(mount.container.querySelector("h1")?.textContent).toBe(
        "@example.com"
      );
    } finally {
      await mount.teardown();
    }
  });
});
