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

// A mail's own page (Thread): the whole conversation, oldest first, with the
// opened, newest and unread messages open; Back / Esc return to the list.
// Mounts the real component in a MemoryRouter with a stubbed `call.get`.
beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const address = (name: string, email: string) => ({ name, address: email });

const message = (
  id: string,
  day: number,
  fields: Record<string, unknown> = {}
) => ({
  id,
  subject: day === 1 ? "Budget" : "Re: Budget",
  date: new Date(`2026-11-0${day}T10:00:00Z`).toISOString(),
  read: true,
  saved: false,
  sent: false,
  from: { value: [address("Alice", "alice@x.com")], text: "Alice" },
  to: { value: [address("Me", "maple@example.com")], text: "Me" },
  snippet: `snippet ${id}`,
  ...fields
});

let thread: unknown[];
let bodyResolvers: Record<string, (value: unknown) => void>;
let originalGet: typeof call.get;

beforeEach(() => {
  window.localStorage.clear();
  bodyResolvers = {};
  thread = [
    message("m1", 1),
    message("m2", 2, {
      sent: true,
      from: { value: [address("Me", "maple@example.com")], text: "Me" },
      to: { value: [address("Alice", "alice@x.com")], text: "Alice" }
    }),
    message("m3", 3, {
      to: {
        value: [
          address("Me", "maple@example.com"),
          address("Bob", "bob@x.com"),
          address("Carol", "carol@x.com")
        ],
        text: "Me, Bob, Carol"
      }
    })
  ];
  originalGet = call.get;
  call.get = (async (url: string) => {
    if (url.startsWith("/api/mails/thread/")) return { status: "success", body: thread };
    if (url.startsWith("/api/mails/body/")) {
      const id = url.split("/").pop() as string;
      return new Promise((resolve) => {
        bodyResolvers[id] = resolve;
      });
    }
    return { status: "success", body: [] };
  }) as typeof call.get;
});

afterEach(() => {
  call.get = originalGet;
});

interface MountOptions {
  mailId?: string;
  fromList?: boolean;
  context?: Record<string, unknown>;
}

const mountThread = async ({
  mailId = "m1",
  fromList = false,
  context = {}
}: MountOptions = {}) => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { MemoryRouter, Routes, Route, useLocation, useParams } = await import(
    "react-router-dom"
  );
  const { Context, IsOnlineProvider } = await import("client");
  const { FeedbackProvider } = await import("client/lib/feedback");
  const Thread = (await import("./index")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const calls: Record<string, unknown[]> = {
    replyData: [],
    writer: []
  };
  const contextValue = {
    domainName: "example.com",
    selectedAccount: "maple@example.com",
    selectedCategory: Category.AllMails,
    isWriterOpen: false,
    isSettingsOpen: false,
    setReplyData: (v: unknown) => calls.replyData.push(v),
    setIsWriterOpen: (v: unknown) => calls.writer.push(v),
    ...context
  };

  // As in the app: the page is keyed by, and reads, the route's mail id.
  const ThreadRoute = () => {
    const params = useParams<{ mailId: string }>();
    return createElement(Thread, {
      key: params.mailId,
      mailId: params.mailId as string
    });
  };

  let pathname = "";
  const Probe = () => {
    pathname = useLocation().pathname;
    return null;
  };

  const entries = fromList
    ? ["/", { pathname: `/mail/${mailId}`, state: { fromList: true } }]
    : [`/mail/${mailId}`];

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
            createElement(
              FeedbackProvider,
              null,
              createElement(
                MemoryRouter,
                { initialEntries: entries, initialIndex: entries.length - 1 },
                createElement(Probe),
                createElement(
                  Routes,
                  null,
                  createElement(Route, { path: "/", element: null }),
                  createElement(Route, {
                    path: "/mail/:mailId",
                    element: createElement(ThreadRoute)
                  })
                )
              )
            )
          )
        )
      )
    );
  });

  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  const waitFor = async <T>(fn: () => T | null | undefined): Promise<T> => {
    for (let i = 0; i < 100; i++) {
      const value = fn();
      if (value) return value;
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
    await flush();
  };
  const escape = async (target: EventTarget = window) => {
    await act(async () => {
      target.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    await flush();
  };

  await waitFor(() =>
    container.querySelector(".thread-messages, .thread-empty")
  );

  return {
    container,
    act,
    flush,
    waitFor,
    click,
    escape,
    calls,
    queryClient,
    resolveBody: (id: string, html: string) =>
      act(async () => {
        bodyResolvers[id]?.({
          status: "success",
          body: { id, html, messageId: `<${id}@x>` }
        });
      }),
    path: () => pathname,
    messages: () => Array.from(container.querySelectorAll(".thread-message")),
    expandedIds: () =>
      Array.from(container.querySelectorAll(".thread-message.expanded")).map(
        (el) => el.getAttribute("data-mail-id")
      ),
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
    }
  };
};

describe("mail page — conversation", () => {
  it("shows every message, oldest first, under the conversation subject", async () => {
    const mount = await mountThread();
    try {
      expect(mount.container.querySelector(".thread-subject")?.textContent).toBe(
        "Budget"
      );
      expect(mount.container.querySelector(".thread-count")?.textContent).toBe(
        "3 messages"
      );
      expect(mount.messages().length).toBe(3);
      // The sent reply reads as "Me".
      expect(mount.messages()[1].textContent).toContain("Me");
    } finally {
      await mount.teardown();
    }
  });

  it("opens the opened and the newest message, and collapses the rest", async () => {
    const mount = await mountThread({ mailId: "m1" });
    try {
      expect(mount.expandedIds()).toEqual(["m1", "m3"]);
      const collapsed = mount.container.querySelector(
        ".thread-message.collapsed"
      ) as Element;
      expect(collapsed.textContent).toContain("snippet m2");
      await mount.click(collapsed.querySelector("button") as Element);
      expect(mount.expandedIds()).toEqual(["m1", "m2", "m3"]);
    } finally {
      await mount.teardown();
    }
  });

  it("also opens unread messages", async () => {
    thread[1] = { ...(thread[1] as object), read: false };
    const mount = await mountThread({ mailId: "m3" });
    try {
      expect(mount.expandedIds()).toEqual(["m2", "m3"]);
    } finally {
      await mount.teardown();
    }
  });

  it("folds a long run of collapsed messages into one row", async () => {
    thread = [1, 2, 3, 4, 5, 6].map((d) => message(`m${d}`, d));
    const mount = await mountThread({ mailId: "m6" });
    try {
      const fold = mount.container.querySelector(".thread-fold button") as Element;
      expect(fold.textContent).toBe("4 more messages");
      await mount.click(fold);
      expect(mount.container.querySelector(".thread-fold")).toBeNull();
      expect(mount.messages().length).toBe(6);
    } finally {
      await mount.teardown();
    }
  });

  it("says so when the mail can't be found", async () => {
    thread = [];
    const mount = await mountThread();
    try {
      expect(mount.container.querySelector(".thread-empty")?.textContent).toContain(
        "couldn't be found"
      );
      expect(mount.container.querySelector(".thread-back")).not.toBeNull();
    } finally {
      await mount.teardown();
    }
  });
});

describe("mail page — message actions", () => {
  it("labels each open message's actions", async () => {
    const mount = await mountThread();
    try {
      const row = mount.container.querySelector(
        '[data-mail-id="m3"] .actionRow'
      ) as Element;
      const labels = Array.from(row.querySelectorAll("button")).map(
        (b) => b.textContent
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
      await mount.teardown();
    }
  });

  it("Reply quotes that message and opens the composer", async () => {
    const mount = await mountThread();
    try {
      const reply = Array.from(
        mount.container.querySelectorAll('[data-mail-id="m3"] .actionRow button')
      ).find((b) => b.textContent === "Reply") as Element;
      await mount.click(reply);
      await mount.resolveBody("m3", "<p>third</p>");
      await mount.flush();
      expect(mount.calls.writer).toEqual([true]);
      const data = mount.calls.replyData[0] as {
        id: string;
        html: string;
        to: { address: string };
      };
      expect(data.id).toBe("m3");
      expect(data.html).toBe("<p>third</p>");
      expect(data.to.address).toBe("maple@example.com");
    } finally {
      await mount.teardown();
    }
  });

  it("collapses a long To list after two with a show-all toggle", async () => {
    const mount = await mountThread();
    try {
      const m3 = mount.container.querySelector('[data-mail-id="m3"]') as Element;
      const toggle = m3.querySelector(".address-toggle") as HTMLButtonElement;
      expect(toggle.textContent).toBe("show all 3");
      expect(m3.textContent).not.toContain("Carol");
      await mount.click(toggle);
      expect(
        (mount.container.querySelector('[data-mail-id="m3"]') as Element)
          .textContent
      ).toContain("Carol");
    } finally {
      await mount.teardown();
    }
  });

  it("shows a skeleton while a body loads, then the body", async () => {
    const mount = await mountThread();
    try {
      const m1 = () =>
        mount.container.querySelector('[data-mail-id="m1"]') as Element;
      expect(m1().querySelector(".body-skeleton[role='status']")).not.toBeNull();
      await mount.resolveBody("m1", "<p>Hello</p>");
      const iframe = await mount.waitFor(() => m1().querySelector("iframe"));
      expect(iframe.getAttribute("srcdoc")).toContain("Hello");
    } finally {
      await mount.teardown();
    }
  });
});

describe("mail page — delete", () => {
  it("takes the message off the page and holds the delete for Undo", async () => {
    const { pendingDeleteCount, flushDeletes } = await import(
      "../Mails/pendingDeletes"
    );
    const originalFetch = globalThis.fetch;
    const deleted: string[] = [];
    globalThis.fetch = (async (url: string) => {
      deleted.push(url);
      return new Response("{}");
    }) as unknown as typeof fetch;
    const mount = await mountThread();
    try {
      const del = Array.from(
        mount.container.querySelectorAll('[data-mail-id="m3"] .actionRow button')
      ).find((b) => b.textContent === "Delete") as Element;
      await mount.click(del);
      expect(mount.messages().length).toBe(2);
      // Nothing is sent until the undo window passes.
      expect(pendingDeleteCount()).toBe(1);
      expect(deleted).toEqual([]);
      flushDeletes();
      expect(deleted).toEqual(["/api/mails/m3"]);
    } finally {
      flushDeletes();
      globalThis.fetch = originalFetch;
      await mount.teardown();
    }
  });
});

describe("mail page — a refused delete", () => {
  it("puts the message back on the page and says why", async () => {
    const { flushDeletes } = await import("../Mails/pendingDeletes");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "failed", message: "not permitted" })
      )) as unknown as typeof fetch;
    const mount = await mountThread();
    try {
      const del = Array.from(
        mount.container.querySelectorAll('[data-mail-id="m3"] .actionRow button')
      ).find((b) => b.textContent === "Delete") as Element;
      await mount.click(del);
      expect(mount.container.querySelector('[data-mail-id="m3"]')).toBeNull();
      await mount.act(async () => flushDeletes());
      await mount.waitFor(() =>
        mount.container.querySelector('[data-mail-id="m3"]')
      );
      expect(mount.messages().length).toBe(3);
      expect(
        document.querySelector(".feedback-toast.error span")?.textContent
      ).toBe("not permitted");
    } finally {
      flushDeletes();
      globalThis.fetch = originalFetch;
      await mount.teardown();
    }
  });
});

describe("mail page — removing the opened mail", () => {
  it("moves to the newest remaining message when the opened one is deleted", async () => {
    const { flushDeletes } = await import("../Mails/pendingDeletes");
    const mount = await mountThread({ mailId: "m1", fromList: true });
    try {
      const del = Array.from(
        mount.container.querySelectorAll('[data-mail-id="m1"] .actionRow button')
      ).find((b) => b.textContent === "Delete") as Element;
      await mount.click(del);
      // Addressed by a mail that still exists, so a refetch finds the rest.
      expect(mount.path()).toBe("/mail/m3");
      // The server still holds m1 until the undo window ends (the stub
      // returns it), but the page doesn't show it.
      await mount.flush();
      expect(mount.container.querySelector(".thread-count")?.textContent).toBe(
        "2 messages"
      );
      expect(mount.container.querySelector('[data-mail-id="m1"]')).toBeNull();
      await mount.act(async () => {
        await mount.queryClient.refetchQueries("/api/mails/thread/m3");
      });
      expect(mount.container.querySelector(".thread-count")?.textContent).toBe(
        "2 messages"
      );
    } finally {
      flushDeletes();
      await mount.teardown();
    }
  });

  it("moves off a mail marked as spam, and sends is_spam for a non-spam message", async () => {
    const originalPost = call.post;
    const posts: unknown[] = [];
    call.post = (async (url: string, body: unknown) => {
      posts.push([url, body]);
      return { status: "success" };
    }) as typeof call.post;
    const mount = await mountThread({ mailId: "m3", fromList: true });
    try {
      const spam = Array.from(
        mount.container.querySelectorAll('[data-mail-id="m3"] .actionRow button')
      ).find((b) => b.textContent === "Mark spam") as Element;
      expect(spam).toBeDefined();
      await mount.click(spam);
      expect(posts).toEqual([
        ["/api/mails/spam/mark", { mail_id: "m3", is_spam: true }]
      ]);
      expect(mount.path()).toBe("/mail/m2");
    } finally {
      call.post = originalPost;
      await mount.teardown();
    }
  });

  it("labels a spam message's button Not spam and moves it out", async () => {
    thread[2] = { ...(thread[2] as object), spam: true };
    const originalPost = call.post;
    const posts: unknown[] = [];
    call.post = (async (url: string, body: unknown) => {
      posts.push([url, body]);
      return { status: "success" };
    }) as typeof call.post;
    const mount = await mountThread({ mailId: "m1" });
    try {
      const notSpam = Array.from(
        mount.container.querySelectorAll('[data-mail-id="m3"] .actionRow button')
      ).find((b) => b.textContent === "Not spam") as Element;
      await mount.click(notSpam);
      expect(posts).toEqual([
        ["/api/mails/spam/mark", { mail_id: "m3", is_spam: false }]
      ]);
    } finally {
      call.post = originalPost;
      await mount.teardown();
    }
  });
});

describe("mail page — leaving", () => {
  it("Back from a page opened from the list steps back to it", async () => {
    const mount = await mountThread({ fromList: true });
    try {
      expect(mount.path()).toBe("/mail/m1");
      await mount.click(mount.container.querySelector(".thread-back") as Element);
      expect(mount.path()).toBe("/");
    } finally {
      await mount.teardown();
    }
  });

  it("Back from a page opened directly goes to the list", async () => {
    const mount = await mountThread({ fromList: false });
    try {
      await mount.click(mount.container.querySelector(".thread-back") as Element);
      expect(mount.path()).toBe("/");
    } finally {
      await mount.teardown();
    }
  });

  it("Escape goes back to the list", async () => {
    const mount = await mountThread({ fromList: true });
    try {
      await mount.escape();
      expect(mount.path()).toBe("/");
    } finally {
      await mount.teardown();
    }
  });

  it("Escape stays on the page while the writer is open", async () => {
    const mount = await mountThread({ context: { isWriterOpen: true } });
    try {
      await mount.escape();
      expect(mount.path()).toBe("/mail/m1");
    } finally {
      await mount.teardown();
    }
  });

  it("Escape stays on the page while the accounts menu is open", async () => {
    const mount = await mountThread({ context: { isAccountsOpen: true } });
    try {
      await mount.escape();
      expect(mount.path()).toBe("/mail/m1");
    } finally {
      await mount.teardown();
    }
  });

  it("Escape stays on the page while typing in a field", async () => {
    const mount = await mountThread();
    const input = document.createElement("input");
    document.body.appendChild(input);
    try {
      await mount.escape(input);
      expect(mount.path()).toBe("/mail/m1");
    } finally {
      input.remove();
      await mount.teardown();
    }
  });

  it("Escape stays on the page while a dialog is open", async () => {
    const mount = await mountThread();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      await mount.escape();
      expect(mount.path()).toBe("/mail/m1");
    } finally {
      dialog.remove();
      await mount.teardown();
    }
  });
});
