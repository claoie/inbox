// These tests mount the real App (same harness shape as
// search-reentry.test.ts, with `call.get`/`call.post` mocked) and drive a
// row open and back. The thread mock mirrors the server: the mark POST
// lands before the thread GET, so the thread data already says read — which
// is what makes the Thread's own mirror effect a no-op and leaves the list
// edit as the only thing that can clear the dot.
//
// A second describe below pins the same copy-replace class in the saved
// path: starring from All Mails splices the mail into the Saved cache, and
// the spliced row must carry the new saved value — and unstarring a mail
// the Saved cache does not hold must not insert a row there at all.
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

beforeAll(() => {
  GlobalRegistrator.register();
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

// Saved, but beyond the Saved list's loaded page: the Saved mock below
// returns only mailTwo, so mailThree is absent from the Saved cache while
// present in All Mails.
const mailThree = {
  id: "mail-3",
  subject: "Quarterly report is ready",
  date: new Date("2026-11-05T10:00:00Z").toISOString(),
  read: true,
  saved: true,
  sent: false,
  from: {
    value: [address("Acme Billing", "acme@example.com")],
    text: "Acme Billing"
  },
  to: { value: [address("Me", "maple@example.com")], text: "Me" },
  snippet: "The quarterly report is attached."
};

const accountsPayload = {
  received: [
    new Account({
      key: "maple@example.com",
      updated: new Date("2026-01-01"),
      doc_count: 5,
      unread_doc_count: 3,
      saved_doc_count: 1
    })
  ],
  sent: [],
  spam: []
};

// Whether the mark POST has landed — the thread mock reads it, the way the
// server's thread query reads the row the POST just updated.
let markedRead = false;

let originalGet: typeof call.get;
let originalPost: typeof call.post;

beforeEach(() => {
  window.localStorage.clear();
  queryClient.clear();
  markedRead = false;
  originalGet = call.get;
  originalPost = call.post;
  call.get = (async (url: string) => {
    if (url.startsWith("/api/mails/domain"))
      return { status: "success", body: "example.com" };
    if (url.startsWith("/api/mails/search-accounts/"))
      return { status: "success", body: accountsPayload.received };
    if (url.startsWith("/api/mails/headers/"))
      return { status: "success", body: { next_cursor: null, headers: [mailOne, mailTwo] } };
    if (url.startsWith("/api/mails/accounts"))
      return { status: "success", body: accountsPayload };
    if (url.startsWith("/api/mails/thread/"))
      return {
        status: "success",
        body: [{ ...mailOne, read: markedRead }]
      };
    if (url.startsWith("/api/mails/body/"))
      return {
        status: "success",
        body: { id: mailOne.id, html: "<p>body</p>", messageId: "<m1@x>" }
      };
    return { status: "success", body: [] };
  }) as typeof call.get;
  call.post = (async (url: string) => {
    if (url.startsWith("/api/mails/mark")) markedRead = true;
    return { status: "success", body: undefined };
  }) as typeof call.post;
});

afterEach(() => {
  call.get = originalGet;
  call.post = originalPost;
});

const mountApp = async () => {
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
    mailCards: () => Array.from(container.querySelectorAll(".mailcard")),
    threadBack: () =>
      container.querySelector(".thread-back") as HTMLElement | null,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    }
  };
};

describe("opening a mail clears its unread dot without a refresh", () => {
  it("the row loses the unread dot after opening and going back", async () => {
    const mount = await mountApp();
    try {
      await mount.waitFor(() => mount.mailCards()[0] ?? null);
      const card = mount
        .mailCards()
        .find((c) => c.textContent?.includes("Weekend tasting event"))!;
      expect(card.querySelector(".unread-dot")).not.toBeNull();

      // Open the mail, then go back to the list — no refresh anywhere. The
      // row's click handler lives on the inner header element (MailHeader),
      // not the .mailcard blockquote, so click that.
      const rowHeader = card.querySelector(".header.cursor")!;
      await mount.click(rowHeader);
      await mount.waitFor(() => mount.threadBack());
      await mount.click(mount.threadBack()!);

      // The dot must clear on the cached list, not only after a refetch.
      let dotGone = false;
      for (let i = 0; i < 100; i++) {
        const current = mount
          .mailCards()
          .find((c) => c.textContent?.includes("Weekend tasting event"));
        if (current && !current.querySelector(".unread-dot")) {
          dotGone = true;
          break;
        }
        await mount.act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
      expect(dotGone).toBe(true);
    } finally {
      await mount.teardown();
    }
  });
});

// Starring from All Mails splices the mail into the Saved cache — the
// spliced row must carry the new saved value, and unstarring a mail the
// Saved cache does not hold must not insert a row there at all. The mock
// below is category-aware so the Saved list loads with only the saved mail
// (mailTwo), the way a loaded first page would: mailThree is saved but
// absent from that page.
describe("starring updates the Saved cache without a refetch", () => {
  const savedUrl = "/api/mails/headers/maple@example.com?saved=1";

  const installSavedMocks = () => {
    const markCalls: Array<{ url: string; body: unknown }> = [];
    call.get = (async (url: string) => {
      if (url.startsWith("/api/mails/domain"))
        return { status: "success", body: "example.com" };
      if (url.startsWith("/api/mails/search-accounts/"))
        return { status: "success", body: accountsPayload.received };
      if (url.includes("?saved=1"))
        return { status: "success", body: { next_cursor: null, headers: [mailTwo] } };
      if (url.startsWith("/api/mails/headers/"))
        return {
          status: "success",
          body: { next_cursor: null, headers: [mailOne, mailTwo, mailThree] }
        };
      if (url.startsWith("/api/mails/accounts"))
        return { status: "success", body: accountsPayload };
      if (url.startsWith("/api/mails/thread/"))
        return {
          status: "success",
          body: [{ ...mailOne, read: markedRead }]
        };
      if (url.startsWith("/api/mails/body/"))
        return {
          status: "success",
          body: { id: mailOne.id, html: "<p>body</p>", messageId: "<m1@x>" }
        };
      return { status: "success", body: [] };
    }) as typeof call.get;
    call.post = (async (url: string, body?: unknown) => {
      markCalls.push({ url, body });
      return { status: "success", body: undefined };
    }) as typeof call.post;
    return markCalls;
  };

  const savedCache = () =>
    queryClient.getQueryData<Array<{ id: string; saved: boolean }>>(
      savedUrl
    ) ?? [];

  // The folder tabs are role="tab" with the category name (plus a badge
  // count) as the accessible name; the rail renders them at any width.
  const clickTab = async (
    mount: Awaited<ReturnType<typeof mountApp>>,
    prefix: string
  ) => {
    const tab = Array.from(
      mount.container.querySelectorAll('[role="tab"]')
    ).find((t) =>
      t.getAttribute("aria-label")?.startsWith(prefix)
    ) as HTMLElement;
    await mount.click(tab);
  };

  // Load the Saved cache through the real folder tab, then return to All
  // Mails so the star clicks below start from the list view.
  const loadSavedCache = async (
    mount: Awaited<ReturnType<typeof mountApp>>
  ) => {
    await mount.waitFor(() => mount.mailCards()[0] ?? null);
    await clickTab(mount, "Saved Mails");
    await mount.waitFor(() => {
      const cards = mount.mailCards();
      return cards.length === 1 &&
        cards[0].textContent?.includes("Invoice #4812")
        ? cards[0]
        : null;
    });
    await clickTab(mount, "All Mails");
    await mount.waitFor(
      () =>
        mount
          .mailCards()
          .find((c) => c.textContent?.includes("Weekend tasting event")) ??
        null
    );
  };

  it("starring from All Mails inserts the mail into the Saved cache as saved", async () => {
    installSavedMocks();
    const mount = await mountApp();
    try {
      await loadSavedCache(mount);
      expect(
        savedCache().some((m) => m.id === "mail-1")
      ).toBe(false);

      const card = mount
        .mailCards()
        .find((c) => c.textContent?.includes("Weekend tasting event"))!;
      // An unsaved row keeps its star behind the kebab menu.
      await mount.click(
        card.querySelector('button[aria-label="More actions"]')!
      );
      const saveButton = await mount.waitFor(
        () =>
          mount.container.querySelector(
            'button[aria-label="Save"]'
          ) as HTMLElement | null
      );
      await mount.click(saveButton);

      const spliced = savedCache().find((m) => m.id === "mail-1");
      expect(spliced).toBeDefined();
      expect(spliced!.saved).toBe(true);
      // And the All Mails row itself flips to the filled star.
      const current = mount
        .mailCards()
        .find((c) => c.textContent?.includes("Weekend tasting event"))!;
      expect(
        current.querySelector('button[aria-label="Unsave"]')
      ).not.toBeNull();
    } finally {
      await mount.teardown();
    }
  });

  it("unstarring a mail absent from the Saved cache inserts nothing", async () => {
    const markCalls = installSavedMocks();
    const mount = await mountApp();
    try {
      await loadSavedCache(mount);
      expect(savedCache().map((m) => m.id)).toEqual(["mail-2"]);

      // mailThree is saved but beyond the Saved list's loaded page, so
      // its row offers the direct Unsave button in All Mails.
      const card = mount
        .mailCards()
        .find((c) => c.textContent?.includes("Quarterly report is ready"))!;
      await mount.click(
        card.querySelector('button[aria-label="Unsave"]')!
      );

      expect(
        markCalls.some(
          (c) =>
            c.url === "/api/mails/mark" &&
            (c.body as { save?: boolean } | undefined)?.save === false
        )
      ).toBe(true);
      // No phantom row: the Saved cache still holds only the mail that
      // was already there.
      expect(savedCache().map((m) => m.id)).toEqual(["mail-2"]);
    } finally {
      await mount.teardown();
    }
  });
});
