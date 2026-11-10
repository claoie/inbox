// Signing back in hydrates the IndexedDB query cache; without a store the
// shared cache marks itself unavailable for every later test file.
import "fake-indexeddb/auto";
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
import { Account, SignedUser } from "common";
import { Category, call, queryClient } from "client";

// Re-entering search while already searching used to re-park the live
// search term as the pre-search account (design doc §9): `enterSearch`
// parked `selectedAccount` unconditionally, so a second tap on the header
// Search trigger (or the rail Search tab) stored "invoice" as the parked
// account — clear then restored search itself and × became a no-op. The
// guard lives in the real `App.enterSearch`, so these tests mount the real
// App (same harness shape as the leaf tests, with `call.get` mocked) and
// drive the header trigger end to end.
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

const accountsPayload = {
  received: [
    new Account({
      key: "maple@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 5,
      unread_doc_count: 3,
      saved_doc_count: 1
    }),
    new Account({
      key: "fern@example.com",
      updated: new Date("2026-01-02"),
      doc_count: 2,
      unread_doc_count: 1,
      saved_doc_count: 0
    })
  ],
  sent: [
    new Account({
      key: "sent@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 4,
      unread_doc_count: 2,
      saved_doc_count: 0
    })
  ],
  spam: [
    new Account({
      key: "spam@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 3,
      unread_doc_count: 2,
      saved_doc_count: 0
    })
  ]
};

let originalGet: typeof call.get;

beforeEach(() => {
  window.localStorage.clear();
  queryClient.clear();
  originalGet = call.get;
  call.get = (async (url: string) => {
    if (url.startsWith("/api/mails/domain"))
      return { status: "success", body: "example.com" };
    if (url.startsWith("/api/mails/search-accounts/"))
      return { status: "success", body: accountsPayload.received };
    if (url.startsWith("/api/mails/search/"))
      return { status: "success", body: [mailTwo] };
    if (url.startsWith("/api/mails/headers/"))
      return { status: "success", body: [mailOne, mailTwo] };
    if (url.startsWith("/api/mails/accounts"))
      return { status: "success", body: accountsPayload };
    return { status: "success", body: [] };
  }) as typeof call.get;
});

afterEach(() => {
  call.get = originalGet;
});

// Drive a field the way real typing does: focus, then the value change
// with an input event and a key event (same helper as
// search.test.ts — React's change-event polyfill only notices a changed
// value on keyup/keydown of the focused element when react-dom was first
// evaluated before the DOM globals existed).
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

const stored = (key: string): unknown =>
  JSON.parse(window.localStorage.getItem(key) ?? "null");

const mountApp = async () => {
  // Seed the pre-search state the way a signed-in session leaves it:
  // maple's All Mails, panel open, writer closed.
  window.localStorage.setItem(
    "selectedAccount",
    JSON.stringify("maple@example.com")
  );
  window.localStorage.setItem(
    "selectedCategory",
    JSON.stringify(Category.AllMails)
  );
  window.localStorage.setItem("isAccountsOpen", JSON.stringify(true));
  window.localStorage.setItem("isWriterOpen", JSON.stringify(false));

  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { App } = await import("client");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  // happy-dom starts at about:blank, whose path ("blank") matches none of
  // App's routes — Box would never render. `history.pushState` is a no-op
  // on about:blank here, so set the URL through happy-dom directly.
  (
    window as unknown as {
      happyDOM: { setURL: (url: string) => void };
    }
  ).happyDOM.setURL("http://localhost/");

  await act(async () => {
    root.render(
      createElement(App, {
        user: new SignedUser({
          id: "user-1",
          email: "maple@example.com",
          username: "maple"
        })
      })
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

  const click = async (el: Element) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };

  return {
    container,
    act,
    waitFor,
    click,
    headerSearchTrigger: () =>
      container.querySelector(
        '.menu.right [aria-label="Search"]'
      ) as HTMLElement | null,
    searchInput: () =>
      container.querySelector(
        '.search-box input[aria-label="Search messages and accounts"]'
      ) as HTMLInputElement | null,
    searchBox: () => container.querySelector(".search-box"),
    mailCards: () => Array.from(container.querySelectorAll(".mailcard")),
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    }
  };
};

describe("search re-entry keeps the parked account", () => {
  it("re-entering search preserves the term, and clear restores the parked account and folder", async () => {
    const mount = await mountApp();
    try {
      await mount.waitFor(() => mount.mailCards()[0] ?? null);
      expect(mount.mailCards().length).toBe(2);

      // First entry parks maple / All Mails and starts from an empty term.
      await mount.click((await mount.waitFor(() =>
        mount.headerSearchTrigger()
      )) as Element);
      await mount.waitFor(() => mount.searchInput());
      expect(stored("selectedAccount")).toBe("");
      expect(stored("selectedCategory")).toBe(Category.Search);

      // Search "invoice" — Enter commits the term immediately.
      const input = mount.searchInput()!;
      await mount.act(async () => {
        setInputValue(input, "invoice");
        input.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
        );
      });
      expect(stored("selectedAccount")).toBe("invoice");

      // Re-enter search while already searching: the term and the park
      // must survive — the box stays open with "invoice" still the term.
      await mount.click((await mount.waitFor(() =>
        mount.headerSearchTrigger()
      )) as Element);
      expect(mount.searchBox()).not.toBeNull();
      expect(stored("selectedAccount")).toBe("invoice");
      expect(stored("selectedCategory")).toBe(Category.Search);

      // Clear (×) restores the original parked account and folder, and
      // the search box closes — it does not restore "invoice" / Search.
      const clear = (await mount.waitFor(() =>
        mount.container.querySelector(
          '.search-box button[aria-label="Clear search"]'
        )
      )) as Element;
      await mount.click(clear);
      expect(mount.searchBox()).toBeNull();
      expect(stored("selectedAccount")).toBe("maple@example.com");
      expect(stored("selectedCategory")).toBe(Category.AllMails);
    } finally {
      await mount.teardown();
    }
  });
});

describe("entering search closes the writer (real App behavior)", () => {
  it("opening the writer then entering search closes the writer", async () => {
    const mount = await mountApp();
    try {
      await mount.waitFor(() => mount.mailCards()[0] ?? null);

      // Open the writer from the header Compose button.
      const compose = (await mount.waitFor(() =>
        mount.container.querySelector(
          '.menu.right [aria-label="Compose new mail"]'
        )
      )) as Element;
      await mount.click(compose);
      await mount.waitFor(() =>
        mount.container.querySelector(".writer-pane.open")
      );
      expect(stored("isWriterOpen")).toBe(true);

      // Entering search closes the writer and opens the search box.
      await mount.click((await mount.waitFor(() =>
        mount.headerSearchTrigger()
      )) as Element);
      await mount.waitFor(() => mount.searchInput());
      expect(mount.container.querySelector(".writer-pane.open")).toBeNull();
      expect(stored("isWriterOpen")).toBe(false);
    } finally {
      await mount.teardown();
    }
  });
});

describe("Settings page (real App behavior)", () => {
  const settingsItem = (mount: Awaited<ReturnType<typeof mountApp>>) =>
    mount.waitFor(() =>
      mount.container.querySelector('.categories [aria-label="Settings"]')
    );

  it("the header search closes the page", async () => {
    const mount = await mountApp();
    try {
      await mount.waitFor(() => mount.mailCards()[0] ?? null);
      await mount.click(await settingsItem(mount));
      await mount.waitFor(() => mount.container.querySelector(".settings"));

      await mount.click((await mount.waitFor(() =>
        mount.headerSearchTrigger()
      )) as Element);
      await mount.waitFor(() => mount.searchInput());
      expect(mount.container.querySelector(".settings")).toBeNull();
    } finally {
      await mount.teardown();
    }
  });

  it("keeps the list mounted underneath, so closing the page returns to the same list", async () => {
    const mount = await mountApp();
    try {
      const firstCard = await mount.waitFor(() => mount.mailCards()[0] ?? null);
      await mount.click(await settingsItem(mount));
      await mount.waitFor(() => mount.container.querySelector(".settings"));
      expect(
        mount.container.querySelector(".center-col.behind-settings")
      ).not.toBeNull();
      expect(firstCard.isConnected).toBe(true);

      await mount.click(await settingsItem(mount));
      expect(mount.container.querySelector(".settings")).toBeNull();
      expect(mount.container.querySelector(".behind-settings")).toBeNull();
      expect(mount.mailCards()[0]).toBe(firstCard);
    } finally {
      await mount.teardown();
    }
  });

  it("Escape in Settings leaves the open message behind it open", async () => {
    // Opening an unread message marks it read.
    const originalPost = call.post;
    call.post = (async () => ({ status: "success" })) as typeof call.post;
    const mount = await mountApp();
    try {
      const firstCard = await mount.waitFor(() => mount.mailCards()[0] ?? null);
      await mount.click(firstCard.querySelector(".header") as Element);
      await mount.waitFor(() => firstCard.querySelector(".actionRow"));

      await mount.click(await settingsItem(mount));
      await mount.waitFor(() => mount.container.querySelector(".settings"));
      const densityButton = mount.container.querySelector(
        ".settings .segmented button"
      ) as HTMLElement;
      await mount.act(async () => {
        densityButton.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
        );
      });

      await mount.click(await settingsItem(mount));
      expect(firstCard.querySelector(".actionRow")).not.toBeNull();
    } finally {
      call.post = originalPost;
      await mount.teardown();
    }
  });

  it("signing out and back in lands on the list, with each user's own compose settings", async () => {
    const originalConfirm = window.confirm;
    const originalDelete = call.delete;
    const originalPost = call.post;
    const originalFetch = globalThis.fetch;
    let signInAs = "user-1";
    window.confirm = () => true;
    // Signing back in shows the getting-started page until an account is
    // selected, and that page fetches its text directly.
    globalThis.fetch = (async () => new Response("")) as unknown as typeof fetch;
    call.delete = (async () => ({ status: "success" })) as typeof call.delete;
    call.post = (async (url: string) =>
      url === "/api/users/login"
        ? {
            status: "success",
            body: { id: signInAs, email: "maple@example.com", username: "maple" }
          }
        : { status: "success" }) as typeof call.post;
    window.localStorage.setItem(
      "composeSettings",
      JSON.stringify({
        "user-1": { signature: "Maple", defaultFrom: "maple@example.com" }
      })
    );
    const mount = await mountApp();

    const signOutAndIn = async (userId: string) => {
      signInAs = userId;
      await mount.click(
        await mount.waitFor(() =>
          mount.container.querySelector(".accounts-logout")
        )
      );
      const form = (await mount.waitFor(() =>
        mount.container.querySelector("form")
      )) as HTMLFormElement;
      setInputValue(
        form.querySelector('input[name="username"]') as HTMLInputElement,
        "maple"
      );
      setInputValue(
        form.querySelector('input[name="password"]') as HTMLInputElement,
        "pw"
      );
      await mount.act(async () => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
      });
      // Sign-in hands the user back after a short delay.
      for (let i = 0; i < 40 && !mount.mailCards().length; i++) {
        await mount.act(async () => {
          await new Promise((r) => setTimeout(r, 50));
        });
      }
    };
    const composeFields = async () => {
      await mount.click(await settingsItem(mount));
      await mount.waitFor(() => mount.container.querySelector(".settings"));
      const fields = {
        signature: (
          mount.container.querySelector("#settings-signature") as HTMLTextAreaElement
        ).value,
        defaultFrom: (
          mount.container.querySelector("#settings-default-from") as HTMLSelectElement
        ).value
      };
      return fields;
    };

    try {
      await mount.waitFor(() => mount.mailCards()[0] ?? null);
      expect(await composeFields()).toEqual({
        signature: "Maple",
        defaultFrom: "maple@example.com"
      });

      // Another user on this browser lands on the list and starts blank.
      await signOutAndIn("user-2");
      expect(mount.mailCards().length).toBeGreaterThan(0);
      expect(mount.container.querySelector(".settings")).toBeNull();
      expect(await composeFields()).toEqual({ signature: "", defaultFrom: "" });

      // The first user gets theirs back.
      await signOutAndIn("user-1");
      expect(await composeFields()).toEqual({
        signature: "Maple",
        defaultFrom: "maple@example.com"
      });
    } finally {
      window.confirm = originalConfirm;
      globalThis.fetch = originalFetch;
      call.delete = originalDelete;
      call.post = originalPost;
      await mount.teardown();
    }
  });
});

describe("Notifications switch (real App behavior)", () => {
  type Globals = Record<string, unknown>;
  let gets: string[];
  let restorePush: () => void;

  // A browser with push notifications granted and no subscription yet, so
  // every subscribe goes as far as fetching the server's public key.
  beforeEach(() => {
    gets = [];
    const mockedGet = call.get;
    call.get = (async (url: string) => {
      gets.push(url);
      if (url === "/api/users/login")
        return { status: "success", body: { user: { id: "user-1" } } };
      return mockedGet(url);
    }) as typeof call.get;
    const registration = {
      pushManager: {
        getSubscription: async () => null,
        subscribe: async () => ({})
      }
    };
    const win = window as unknown as Globals;
    const previous = {
      Notification: win.Notification,
      PushManager: win.PushManager,
      serviceWorker: Object.getOwnPropertyDescriptor(navigator, "serviceWorker"),
      post: call.post,
      now: Date.now
    };
    win.Notification = { permission: "granted" };
    win.PushManager = function PushManager() {};
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        register: async () => registration,
        ready: Promise.resolve(registration),
        getRegistration: async () => registration
      }
    });
    call.post = (async () => ({ status: "success", body: "sub-1" })) as typeof call.post;
    restorePush = () => {
      win.Notification = previous.Notification;
      win.PushManager = previous.PushManager;
      if (previous.serviceWorker)
        Object.defineProperty(navigator, "serviceWorker", previous.serviceWorker);
      else delete (navigator as unknown as Globals).serviceWorker;
      call.post = previous.post;
      Date.now = previous.now;
    };
  });
  afterEach(() => restorePush());

  const subscribes = () =>
    gets.filter((url) => url === "/api/push/public-key").length;

  const settle = async (mount: Awaited<ReturnType<typeof mountApp>>) => {
    for (let i = 0; i < 10; i++) {
      await mount.act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
  };

  // The once-a-day subscribe that runs when the window regains focus.
  const refocusADayLater = async (
    mount: Awaited<ReturnType<typeof mountApp>>
  ) => {
    const realNow = Date.now;
    const later = realNow() + 2 * 24 * 60 * 60 * 1000;
    Date.now = () => later;
    await mount.act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle(mount);
    Date.now = realNow;
  };

  it("signing in and a later refocus subscribe while the switch is on", async () => {
    const mount = await mountApp();
    try {
      await settle(mount);
      expect(subscribes()).toBe(1);
      await refocusADayLater(mount);
      expect(subscribes()).toBe(2);
    } finally {
      await mount.teardown();
    }
  });

  it("signing in doesn't subscribe while the switch is off", async () => {
    window.localStorage.setItem("notificationsEnabled", JSON.stringify(false));
    const mount = await mountApp();
    try {
      await settle(mount);
      expect(subscribes()).toBe(0);
      await refocusADayLater(mount);
      expect(subscribes()).toBe(0);
    } finally {
      await mount.teardown();
    }
  });

  it("turning it off in another tab shows it off here and stops this tab subscribing", async () => {
    const mount = await mountApp();
    try {
      await settle(mount);
      expect(subscribes()).toBe(1);
      await mount.click(
        await mount.waitFor(() =>
          mount.container.querySelector('.categories [aria-label="Settings"]')
        )
      );
      const toggle = () =>
        mount.container.querySelector(
          "#settings-notifications"
        ) as HTMLInputElement;
      expect(toggle().checked).toBe(true);

      window.localStorage.setItem("notificationsEnabled", "false");
      await mount.act(async () => {
        window.dispatchEvent(
          new StorageEvent("storage", {
            key: "notificationsEnabled",
            oldValue: "true",
            newValue: "false"
          })
        );
      });
      expect(toggle().checked).toBe(false);

      await refocusADayLater(mount);
      expect(subscribes()).toBe(1);
    } finally {
      await mount.teardown();
    }
  });
});
