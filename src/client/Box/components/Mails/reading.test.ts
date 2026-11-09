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

// The reading view (design doc §6): close (×) + Esc, labeled action row,
// dark body, collapsible address lists, skeleton loading state, tooltips on
// every action. These tests mount the real Mails component (same harness as
// `folders-sheet.test.ts`) and drive an opened message.
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
  to: {
    value: [
      address("Alice", "alice@example.com"),
      address("Bob", "bob@example.com"),
      address("Carol", "carol@example.com")
    ],
    text: "Alice, Bob, Carol"
  },
  cc: { value: [address("Dave", "dave@example.com")], text: "Dave" },
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

let resolveBody: (value: unknown) => void;
let bodyPromise: Promise<unknown>;

let originalGet: typeof call.get;

beforeEach(() => {
  window.localStorage.clear();
  originalGet = call.get;
  bodyPromise = new Promise((resolve) => {
    resolveBody = resolve;
  });
  call.get = (async (url: string) => {
    if (url.startsWith("/api/mails/body/")) return bodyPromise;
    if (url.startsWith("/api/mails/headers/"))
      return { status: "success", body: [mailOne, mailTwo] };
    return { status: "success", body: [] };
  }) as typeof call.get;
});

afterEach(() => {
  call.get = originalGet;
});

const mountMails = async (options?: { isWriterOpen?: boolean }) => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { Context, IsOnlineProvider } = await import("client");
  const Mails = (await import("./index")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });

  // Minimum context `Mails` reads.
  const contextValue = {
    viewSize: { width: 1920, height: 1080 },
    domainName: "example.com",
    userInfo: undefined,
    setUserInfo: () => {},
    isAccountsOpen: true,
    setIsAccountsOpen: () => {},
    isWriterOpen: options?.isWriterOpen ?? false,
    setIsWriterOpen: () => {},
    replyData: {},
    setReplyData: () => {},
    selectedAccount: "maple@example.com",
    setSelectedAccount: () => {},
    selectedCategory: Category.AllMails,
    setSelectedCategory: () => {},
    newMailsTotal: 2,
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
            createElement(Mails, { page: 0 })
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

  const click = async (el: Element) => {
    await act(async () => {
      (el as HTMLElement).click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  return { container, root, waitFor, click, act };
};

const mailCard = (container: Element, id: string) => {
  const cards = Array.from(container.querySelectorAll(".mailcard"));
  return cards.find((card) =>
    card.querySelector(".mailcard-subject")?.textContent?.includes(
      id === "mail-1" ? "Weekend tasting" : "Invoice #4812"
    )
  ) as Element | undefined;
};

const openMailOne = async (
  mount: Awaited<ReturnType<typeof mountMails>>
) => {
  const card = await mount.waitFor(() => mailCard(mount.container, "mail-1"));
  const header = card.querySelector(".header") as HTMLElement;
  await mount.click(header);
  await mount.waitFor(() =>
    mailCard(mount.container, "mail-1")?.querySelector(".actionRow")
  );
  return mailCard(mount.container, "mail-1") as Element;
};

describe("reading view — close control", () => {
  it("opens on row click and shows the close button", async () => {
    const mount = await mountMails();
    try {
      const card = await openMailOne(mount);
      const close = card.querySelector(".mail-close") as HTMLElement;
      expect(close).not.toBeNull();
      expect(close.getAttribute("title")).toBe("Close");
      expect(close.getAttribute("aria-label")).toBe("Close message");
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("collapses when the close button is clicked", async () => {
    const mount = await mountMails();
    try {
      const card = await openMailOne(mount);
      // The body fetch is still pending, so the open message shows the
      // skeleton — the action row is the proof it is open.
      expect(card.querySelector(".actionRow")).not.toBeNull();
      expect(card.querySelector(".body-skeleton")).not.toBeNull();
      await mount.click(card.querySelector(".mail-close") as HTMLElement);
      const closed = mailCard(mount.container, "mail-1") as Element;
      expect(closed.querySelector(".actionRow")).toBeNull();
      expect(closed.querySelector(".body-skeleton")).toBeNull();
      expect(closed.querySelector(".mail-close")).toBeNull();
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("collapses on Escape", async () => {
    const mount = await mountMails();
    try {
      await openMailOne(mount);
      const open = mailCard(mount.container, "mail-1") as Element;
      expect(open.querySelector(".actionRow")).not.toBeNull();
      await mount.act(async () => {
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true
          })
        );
      });
      const closed = mailCard(mount.container, "mail-1") as Element;
      expect(closed.querySelector(".actionRow")).toBeNull();
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("keeps the message open on Escape while the writer is open", async () => {
    const mount = await mountMails({ isWriterOpen: true });
    try {
      await openMailOne(mount);
      await mount.act(async () => {
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true
          })
        );
      });
      const stillOpen = mailCard(mount.container, "mail-1") as Element;
      expect(stillOpen.querySelector(".actionRow")).not.toBeNull();
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("keeps the message open on Escape while typing in a field", async () => {
    const mount = await mountMails();
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      await openMailOne(mount);
      input.focus();
      await mount.act(async () => {
        input.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true
          })
        );
      });
      const stillOpen = mailCard(mount.container, "mail-1") as Element;
      expect(stillOpen.querySelector(".actionRow")).not.toBeNull();
    } finally {
      input.remove();
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("keeps the message open on Escape while a dialog overlay is open", async () => {
    const mount = await mountMails();
    // Stand-in for the Folders sheet: a role="dialog" overlay with its own
    // unconditional window-level Escape handler, like the real sheet
    // registers. The dialog opens after the message, so its handler
    // registers after the message's — one press must close the dialog only.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const onDialogKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dialog.remove();
    };
    try {
      await openMailOne(mount);
      document.body.appendChild(dialog);
      window.addEventListener("keydown", onDialogKeyDown);
      await mount.act(async () => {
        window.dispatchEvent(
          new window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true
          })
        );
      });
      // One press closes the dialog only; the message stays open.
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const stillOpen = mailCard(mount.container, "mail-1") as Element;
      expect(stillOpen.querySelector(".actionRow")).not.toBeNull();
    } finally {
      window.removeEventListener("keydown", onDialogKeyDown);
      dialog.remove();
      mount.root.unmount();
      mount.container.remove();
    }
  });
});

describe("reading view — labeled action row", () => {
  it("shows all six actions with text labels on the open message", async () => {
    const mount = await mountMails();
    try {
      const card = await openMailOne(mount);
      const row = card.querySelector(".actionRow") as Element;
      expect(row.getAttribute("role")).toBe("toolbar");
      const labels = Array.from(row.querySelectorAll("button")).map((b) =>
        b.textContent?.trim()
      );
      expect(labels).toEqual([
        "Reply",
        "Forward",
        "Save",
        "Open in new tab",
        "Mark spam",
        "Delete"
      ]);
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("keeps the kebab on collapsed rows", async () => {
    const mount = await mountMails();
    try {
      await openMailOne(mount);
      const collapsed = mailCard(mount.container, "mail-2") as Element;
      expect(collapsed.querySelector(".actionBox")).not.toBeNull();
      expect(collapsed.querySelector(".actionRow")).toBeNull();
      const kebab = collapsed.querySelector(
        ".actionBox .iconBox[title='More actions']"
      );
      expect(kebab).not.toBeNull();
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("gives every action a tooltip", async () => {
    const mount = await mountMails();
    try {
      const card = await openMailOne(mount);
      const row = card.querySelector(".actionRow") as Element;
      const titles = Array.from(row.querySelectorAll("button")).map((b) =>
        b.getAttribute("title")
      );
      expect(titles).toEqual([
        "Reply",
        "Forward",
        "Save",
        "Open this email body in a new tab",
        "Mark as spam",
        "Delete"
      ]);
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });
});

describe("reading view — collapsible address lists", () => {
  it("collapses a long To list after two with a show-all toggle", async () => {
    const mount = await mountMails();
    try {
      const card = await openMailOne(mount);
      const toggle = card.querySelector(
        ".address-toggle"
      ) as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      expect(toggle.textContent).toBe("show all 3");
      expect(card.textContent).toContain("Alice");
      expect(card.textContent).toContain("Bob");
      expect(card.textContent).not.toContain("Carol");
      await mount.click(toggle);
      const expanded = mailCard(mount.container, "mail-1") as Element;
      expect(expanded.textContent).toContain("Carol");
      expect(
        (expanded.querySelector(".address-toggle") as HTMLElement).textContent
      ).toBe("show fewer");
      // Expanding the list must not collapse the message.
      expect(expanded.querySelector(".actionRow")).not.toBeNull();
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("renders a short list in full with no toggle", async () => {
    const mount = await mountMails();
    try {
      const card = await mount.waitFor(() =>
        mailCard(mount.container, "mail-2")
      );
      await mount.click(card.querySelector(".header") as HTMLElement);
      const opened = await mount.waitFor(() =>
        mailCard(mount.container, "mail-2")?.querySelector(".actionRow")
          ? mailCard(mount.container, "mail-2")
          : null
      );
      expect(opened.querySelector(".address-toggle")).toBeNull();
      expect(opened.textContent).toContain("Me");
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });
});

describe("reading view — loading state", () => {
  it("shows a skeleton, not the bare loading text, while the body loads", async () => {
    const mount = await mountMails();
    try {
      const card = await openMailOne(mount);
      expect(
        card.querySelector(".body-skeleton[role='status']")
      ).not.toBeNull();
      expect(card.textContent).not.toContain("Loading Mail Data...");
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });

  it("renders the body once the fetch resolves", async () => {
    const mount = await mountMails();
    try {
      await openMailOne(mount);
      await mount.act(async () => {
        resolveBody({
          status: "success",
          body: {
            id: "mail-1",
            html: "<p>Hello</p>",
            messageId: "mid-1",
            attachments: []
          }
        });
      });
      await mount.waitFor(() =>
        mailCard(mount.container, "mail-1")?.querySelector("iframe")
      );
      const iframe = mailCard(mount.container, "mail-1")?.querySelector(
        "iframe"
      ) as HTMLIFrameElement;
      expect(iframe).not.toBeNull();
      expect(iframe.getAttribute("srcdoc")).toContain("Hello");
    } finally {
      mount.root.unmount();
      mount.container.remove();
    }
  });
});
