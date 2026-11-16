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
import { Category, call } from "client";

// The search box (design doc §9): center-column box with the scope label,
// clear (×) restoring the pre-search account and folder, and the list —
// not the "Welcome to Inbox!" landing page — as the pre-search state.
// These tests mount the real Mails component (same harness as
// `reading.test.ts`) and drive the box.
beforeAll(() => {
  GlobalRegistrator.register();
  // React 18 only lets `act` flush work when this flag is set.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const address = (name: string, email: string) => ({
  name,
  address: email
});

const mailOne = {
  id: "mail-1",
  subject: "Weekend tasting event",
  date: new Date("2026-11-07T10:00:00Z").toISOString(),
  read: false,
  saved: false,
  sent: false,
  from: {
    value: [address("Harbor Coffee", "harbor@example.com")],
    text: "Harbor Coffee"
  },
  to: { value: [address("Me", "maple@example.com")], text: "Me" },
  snippet: "Saturday at 10 works for us"
};

const mailTwo = {
  id: "mail-2",
  subject: "Invoice #4812 is due Friday",
  date: new Date("2026-11-06T10:00:00Z").toISOString(),
  read: true,
  saved: true,
  sent: false,
  from: {
    value: [address("Northwind Traders", "northwind@example.com")],
    text: "Northwind Traders"
  },
  to: { value: [address("Me", "maple@example.com")], text: "Me" },
  snippet: "A reminder that invoice 4812 is due this Friday."
};

let originalGet: typeof call.get;

beforeEach(() => {
  window.localStorage.clear();
  originalGet = call.get;
  call.get = (async (url: string) => {
    // The search endpoint answers the committed term; the headers endpoint
    // answers the folder list. Both return the same two mails here — the
    // tests assert which view renders, not the server's matching.
    if (url.startsWith("/api/mails/search/"))
      return { status: "success", body: [mailTwo] };
    if (url.startsWith("/api/mails/headers/"))
      return { status: "success", body: { next_cursor: null, headers: [mailOne, mailTwo] } };
    return { status: "success", body: [] };
  }) as typeof call.get;
});

afterEach(() => {
  call.get = originalGet;
});

// Drive a field the way real typing does: focus, then the value change
// with an input event and a key event (same helper as
// writer-compose.test.ts — React's change-event polyfill only notices a
// changed value on keyup/keydown of the focused element when react-dom
// was first evaluated before the DOM globals existed).
const setInputValue = (el: HTMLInputElement, value: string) => {
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(
    new KeyboardEvent("keyup", {
      bubbles: true,
      key: value.slice(-1) || "a"
    })
  );
};

type MountOptions = {
  category?: Category;
  selectedAccount?: string;
  preSearchAccount?: string;
  preSearchCategory?: Category;
};

const mountMails = async (options: MountOptions = {}) => {
  const {
    category = Category.AllMails,
    selectedAccount = "maple@example.com",
    preSearchAccount = "maple@example.com",
    preSearchCategory = Category.AllMails
  } = options;

  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { MemoryRouter } = await import("react-router-dom");
  const { Context, IsOnlineProvider } = await import("client");
  const Mails = (await import("./index")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });

  // The setters are recorded, not stubbed away: the fix under test is
  // exactly which setters the search box calls.
  const selectedAccountCalls: string[] = [];
  const categoryCalls: Category[] = [];
  const enterSearchCalls: number[] = [];
  const exitSearchCalls: number[] = [];

  const contextValue = {
    viewSize: { width: 1920, height: 1080 },
    domainName: "example.com",
    userInfo: undefined,
    setUserInfo: () => {},
    isAccountsOpen: true,
    setIsAccountsOpen: () => {},
    isWriterOpen: false,
    setIsWriterOpen: () => {},
    replyData: {},
    setReplyData: () => {},
    selectedAccount,
    setSelectedAccount: (value: string) => {
      selectedAccountCalls.push(value);
    },
    selectedCategory: category,
    setSelectedCategory: (value: Category) => {
      categoryCalls.push(value);
    },
    newMailsTotal: 2,
    setNewMailsTotal: () => {},
    preSearchAccount: { current: preSearchAccount },
    preSearchCategory: { current: preSearchCategory },
    enterSearch: () => {
      enterSearchCalls.push(1);
    },
    exitSearch: () => {
      exitSearchCalls.push(1);
      // The real exitSearch restores the parked account and folder; the
      // test double records the calls so the box's wiring is observable.
      selectedAccountCalls.push(preSearchAccount);
      categoryCalls.push(preSearchCategory);
    },
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
            // Rows navigate to a mail's page, so the list needs a router.
            createElement(
              MemoryRouter,
              null,
              createElement(Mails, { page: 0 })
            )
          )
        )
      )
    );
  });

  const waitFor = async (fn: () => Element | null) => {
    for (let i = 0; i < 100; i++) {
      const el = fn();
      if (el) return el;
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    throw new Error("waitFor timed out");
  };

  return {
    container,
    root,
    waitFor,
    act,
    selectedAccountCalls,
    categoryCalls,
    enterSearchCalls,
    exitSearchCalls,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    }
  };
};

const searchInput = (container: Element) =>
  container.querySelector(
    '.search-box input[aria-label="Search messages and accounts"]'
  ) as HTMLInputElement | null;

const mailCards = (container: Element) =>
  Array.from(container.querySelectorAll(".mailcard"));

describe("search box — center column", () => {
  it("renders in the center column with the scope label while searching", async () => {
    const mount = await mountMails({
      category: Category.Search,
      selectedAccount: "invoice"
    });
    try {
      const box = await mount.waitFor(() =>
        mount.container.querySelector(".search-box")
      );
      expect(
        box.querySelector(".search-scope")?.textContent
      ).toBe("Searching messages and accounts");
      expect(searchInput(mount.container)).not.toBeNull();
      // The box sits above the list in the center column — the results
      // render under it, not in the accounts panel.
      expect(mailCards(mount.container).length).toBe(1);
    } finally {
      await mount.teardown();
    }
  });

  it("does not render outside search", async () => {
    const mount = await mountMails({ category: Category.AllMails });
    try {
      await mount.waitFor(() => mailCards(mount.container)[0] ?? null);
      expect(mount.container.querySelector(".search-box")).toBeNull();
    } finally {
      await mount.teardown();
    }
  });

  it("Enter commits the typed term immediately", async () => {
    const mount = await mountMails({
      category: Category.Search,
      selectedAccount: ""
    });
    try {
      const input = await mount.waitFor(() => searchInput(mount.container));
      await mount.act(async () => {
        setInputValue(input, "invoice");
        input.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
        );
      });
      expect(mount.selectedAccountCalls).toContain("invoice");
    } finally {
      await mount.teardown();
    }
  });

  it("typing commits the term after the debounce", async () => {
    const mount = await mountMails({
      category: Category.Search,
      selectedAccount: ""
    });
    try {
      const input = await mount.waitFor(() => searchInput(mount.container));
      await mount.act(async () => {
        setInputValue(input, "invoice");
      });
      expect(mount.selectedAccountCalls).not.toContain("invoice");
      await mount.act(async () => {
        await new Promise((r) => setTimeout(r, 650));
      });
      expect(mount.selectedAccountCalls).toContain("invoice");
    } finally {
      await mount.teardown();
    }
  });
});

describe("search box — clear restores the pre-search account and folder", () => {
  it("clear (×) restores the parked account and folder", async () => {
    const mount = await mountMails({
      category: Category.Search,
      selectedAccount: "invoice",
      preSearchAccount: "maple@example.com",
      preSearchCategory: Category.AllMails
    });
    try {
      const input = await mount.waitFor(() => searchInput(mount.container));
      await mount.act(async () => {
        setInputValue(input, "invoice");
      });
      const clear = (await mount.waitFor(() =>
        mount.container.querySelector(
          '.search-box button[aria-label="Clear search"]'
        )
      )) as HTMLElement;
      await mount.act(async () => {
        clear.click();
      });
      expect(mount.exitSearchCalls.length).toBe(1);
      expect(mount.selectedAccountCalls).toContain("maple@example.com");
      expect(mount.categoryCalls).toContain(Category.AllMails);
    } finally {
      await mount.teardown();
    }
  });

  it("shows no clear button while the box is empty", async () => {
    const mount = await mountMails({
      category: Category.Search,
      selectedAccount: ""
    });
    try {
      await mount.waitFor(() => searchInput(mount.container));
      expect(
        mount.container.querySelector(
          '.search-box button[aria-label="Clear search"]'
        )
      ).toBeNull();
    } finally {
      await mount.teardown();
    }
  });
});

describe("search pre-search state — the list, not the landing page", () => {
  it("shows the parked account's list while the term is empty", async () => {
    const mount = await mountMails({
      category: Category.Search,
      selectedAccount: "",
      preSearchAccount: "maple@example.com",
      preSearchCategory: Category.AllMails
    });
    try {
      await mount.waitFor(() => mailCards(mount.container)[0] ?? null);
      expect(mailCards(mount.container).length).toBe(2);
      expect(
        mount.container.querySelector(".getting_started")
      ).toBeNull();
      expect(searchInput(mount.container)).not.toBeNull();
    } finally {
      await mount.teardown();
    }
  });

  it("still shows the landing page outside search with no account", async () => {
    const mount = await mountMails({
      category: Category.AllMails,
      selectedAccount: "",
      preSearchAccount: ""
    });
    try {
      const landing = await mount.waitFor(() =>
        mount.container.querySelector(".getting_started")
      );
      expect(landing).not.toBeNull();
      expect(mailCards(mount.container).length).toBe(0);
    } finally {
      await mount.teardown();
    }
  });
});
