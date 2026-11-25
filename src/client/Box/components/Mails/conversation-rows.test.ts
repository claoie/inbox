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

// A folder lists conversations, one row each (conversations.ts); search
// lists the matching messages themselves. Mounts the real Mails list.
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
  messageId: `<${id}@x>`,
  subject: "Budget",
  date: new Date(`2026-11-0${day}T10:00:00Z`).toISOString(),
  read: true,
  saved: false,
  sent: false,
  from: { value: [address("Alice", "alice@x.com")], text: "Alice" },
  to: { value: [address("Me", "maple@example.com")], text: "Me" },
  snippet: `snippet ${id}`,
  ...fields
});

// Two messages of one conversation (the second answers the first) and an
// unrelated one.
const list = [
  message("m3", 3, {
    subject: "Re: Budget",
    inReplyTo: "<m1@x>",
    references: ["<m1@x>"],
    read: false,
    from: { value: [address("Bob", "bob@x.com")], text: "Bob" }
  }),
  message("other", 2, { subject: "Lunch" }),
  message("m1", 1)
];

let originalGet: typeof call.get;
let originalPost: typeof call.post;
let originalFetch: typeof fetch;
let deleted: string[];
let posted: unknown[];

beforeEach(() => {
  window.localStorage.clear();
  deleted = [];
  posted = [];
  originalGet = call.get;
  originalPost = call.post;
  call.post = (async (_url: string, body: unknown) => {
    posted.push(body);
    return { status: "success" };
  }) as typeof call.post;
  originalFetch = globalThis.fetch;
  call.get = (async (url: string) => {
    if (url.startsWith("/api/mails/search/")) {
      return { status: "success", body: structuredClone([list[0], list[2]]) };
    }
    if (url.startsWith("/api/mails/headers/")) {
      return { status: "success", body: { next_cursor: null, headers: structuredClone(list) } };
    }
    return { status: "success", body: [] };
  }) as typeof call.get;
  globalThis.fetch = (async (url: string) => {
    deleted.push(url);
    return new Response("{}");
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  // A delete a failed test left pending must not hide rows in the next one.
  (await import("./pendingDeletes")).flushDeletes();
  call.get = originalGet;
  call.post = originalPost;
  globalThis.fetch = originalFetch;
});

const mountMails = async (category = Category.AllMails, selected = "maple@example.com") => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClientProvider } = await import("react-query");
  const { MemoryRouter } = await import("react-router-dom");
  const { FeedbackProvider } = await import("client/lib/feedback");
  // The app's own client: the list's optimistic edits (MailsCache) write to it.
  const { Context, IsOnlineProvider, queryClient } = await import("client");
  const Mails = (await import("./index")).default;

  queryClient.clear();
  const contextValue = {
    viewSize: { width: 1920, height: 1080 },
    domainName: "example.com",
    userInfo: undefined,
    selectedAccount: selected,
    setSelectedAccount: () => {},
    selectedCategory: category,
    setSelectedCategory: () => {},
    preSearchAccount: { current: "maple@example.com" },
    preSearchCategory: { current: Category.AllMails },
    enterSearch: () => {},
    exitSearch: () => {},
    setReplyData: () => {},
    setIsWriterOpen: () => {},
    density: "comfortable"
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
            createElement(
              FeedbackProvider,
              null,
              createElement(MemoryRouter, null, createElement(Mails, { page: 0, loadMoreIfShort: () => {} }))
            )
          )
        )
      )
    );
  });

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

  await waitFor(() => container.querySelector(".mailcard"));
  const rows = () => Array.from(container.querySelectorAll(".mailcard"));

  return {
    container,
    act,
    waitFor,
    rows,
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    }
  };
};

describe("folder rows are conversations", () => {
  it("shows a conversation as one row with its senders and count", async () => {
    const mount = await mountMails();
    try {
      const rows = mount.rows();
      expect(rows.length).toBe(2);
      const first = rows[0];
      expect(first.querySelector(".sender")?.textContent).toBe("Alice, Bob");
      expect(first.querySelector(".thread-count-badge")?.textContent).toBe("2");
      // The newest message's subject; unread because one message is.
      expect(first.querySelector(".mailcard-subject")?.textContent).toBe(
        "Re: Budget"
      );
      expect(first.classList.contains("unread")).toBe(true);
      expect(rows[1].querySelector(".thread-count-badge")).toBeNull();
    } finally {
      await mount.teardown();
    }
  });

  const openKebabAction = async (
    mount: Awaited<ReturnType<typeof mountMails>>,
    label: string
  ) => {
    const first = mount.rows()[0];
    await mount.act(async () => {
      (first.querySelector('[aria-label="More actions"]') as HTMLElement).click();
    });
    await mount.act(async () => {
      (
        mount.container.querySelector(`[aria-label="${label}"]`) as HTMLElement
      ).click();
    });
  };

  it("deletes every message of the conversation under one Undo window", async () => {
    const { flushDeletes, pendingDeleteCount } = await import("./pendingDeletes");
    const mount = await mountMails();
    try {
      await openKebabAction(mount, "Delete");
      expect(mount.rows().length).toBe(1);
      expect(pendingDeleteCount()).toBe(2);
      expect(deleted).toEqual([]);
      flushDeletes();
      expect(deleted.sort()).toEqual(["/api/mails/m1", "/api/mails/m3"]);
    } finally {
      await mount.teardown();
    }
  });

  it("brings the whole conversation back on Undo and deletes none of it", async () => {
    const { flushDeletes, pendingDeleteCount } = await import("./pendingDeletes");
    const mount = await mountMails();
    try {
      await openKebabAction(mount, "Delete");
      const undo = await mount.waitFor(() =>
        document.querySelector(".feedback-toast-action")
      );
      await mount.act(async () => (undo as HTMLElement).click());
      expect(pendingDeleteCount()).toBe(0);
      expect(mount.rows().length).toBe(2);
      expect(mount.rows()[0].querySelector(".thread-count-badge")?.textContent).toBe("2");
      flushDeletes();
      expect(deleted).toEqual([]);
    } finally {
      await mount.teardown();
    }
  });

  it("loads again, after Undo, a page that arrived while the delete was pending", async () => {
    const { flushDeletes } = await import("./pendingDeletes");
    const older = message("older", 1, { subject: "Older", messageId: "<older@x>" });
    let releasePage: () => void = () => {};
    const pageGate = new Promise<void>((r) => (releasePage = r));
    let pageRequests = 0;
    call.get = (async (url: string) => {
      if (url.includes("cursor=c1")) {
        if (++pageRequests === 1) await pageGate;
        return { status: "success", body: { next_cursor: null, headers: [structuredClone(older)] } };
      }
      if (url.startsWith("/api/mails/headers/")) {
        return { status: "success", body: { next_cursor: "c1", headers: structuredClone(list) } };
      }
      return { status: "success", body: [] };
    }) as typeof call.get;

    const mount = await mountMails();
    try {
      expect(mount.rows().length).toBe(2);
      await openKebabAction(mount, "Delete");
      await mount.act(async () => {
        releasePage();
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(mount.rows().length).toBe(2);
      const undo = await mount.waitFor(() => document.querySelector(".feedback-toast-action"));
      await mount.act(async () => (undo as HTMLElement).click());
      await mount.waitFor(() => (mount.rows().length === 3 ? true : null));
      expect(mount.rows().map((r) => r.querySelector(".mailcard-subject")?.textContent)).toEqual([
        "Re: Budget",
        "Lunch",
        "Older"
      ]);
      expect(pageRequests).toBe(2);
      flushDeletes();
      expect(deleted).toEqual([]);
    } finally {
      await mount.teardown();
    }
  });

  it("measures an incomplete list against the account count it was loaded with", async () => {
    const { queryClient } = await import("client");
    const { accountsQueryUrl } = await import("client/Box/components/Accounts");
    const { missingFromList } = await import("./listPages");
    call.get = (async (url: string) => {
      if (url.startsWith("/api/mails/headers/")) {
        queryClient.setQueryData(accountsQueryUrl, {
          received: [{ key: "maple@example.com", doc_count: 50, unread_doc_count: 1, saved_doc_count: 0 }],
          sent: [],
          spam: []
        });
        const cursor = new URL(url, "http://x").searchParams.get("cursor");
        return {
          status: "success",
          body: { next_cursor: `${cursor ?? "c"}1`, headers: cursor ? [] : structuredClone(list) }
        };
      }
      return { status: "success", body: [] };
    }) as typeof call.get;

    const mount = await mountMails();
    try {
      expect(missingFromList("/api/mails/headers/maple@example.com", 51, 3)).toBe(1);
    } finally {
      await mount.teardown();
    }
  });

  it("marks every unread message of the conversation read on open", async () => {
    list[2] = { ...list[2], read: false };
    const mount = await mountMails();
    try {
      await mount.act(async () => {
        (mount.rows()[0].querySelector(".header") as HTMLElement).click();
      });
      expect(
        (posted as { mail_id: string; read?: boolean }[])
          .filter((body) => body.read)
          .map((body) => body.mail_id)
          .sort()
      ).toEqual(["m1", "m3"]);
    } finally {
      list[2] = { ...list[2], read: true };
      await mount.teardown();
    }
  });

  it("unsaves every saved message of a saved conversation", async () => {
    list[0] = { ...list[0], saved: true };
    list[2] = { ...list[2], saved: true };
    const mount = await mountMails();
    try {
      await openKebabAction(mount, "Unsave");
      expect(
        (posted as { mail_id: string; save?: boolean }[])
          .map((body) => [body.mail_id, body.save])
          .sort()
      ).toEqual([
        ["m1", false],
        ["m3", false]
      ]);
    } finally {
      list[0] = { ...list[0], saved: false };
      list[2] = { ...list[2], saved: false };
      await mount.teardown();
    }
  });

  describe("a refused write", () => {
    const REFUSAL = "Invalid request. You may not manipulate other users' email";
    const refuse = () => {
      call.post = (async (_url: string, body: unknown) => {
        posted.push(body);
        return { status: "failed", message: REFUSAL };
      }) as typeof call.post;
      globalThis.fetch = (async (url: string) => {
        deleted.push(url);
        return new Response(JSON.stringify({ status: "failed", message: REFUSAL }));
      }) as unknown as typeof fetch;
    };
    const errorToast = () =>
      document.querySelector(".feedback-toast.error span")?.textContent ?? null;

    it("puts an opened conversation back to unread and says why", async () => {
      const { trackMarkRead } = await import("./pendingReads");
      refuse();
      const mount = await mountMails();
      try {
        await mount.act(async () => {
          (mount.rows()[0].querySelector(".header") as HTMLElement).click();
        });
        expect(await mount.waitFor(errorToast)).toBe(REFUSAL);
        await mount.waitFor(() =>
          mount.rows()[0].classList.contains("unread") ? true : null
        );
      } finally {
        trackMarkRead("m3", Promise.resolve({ status: "success" }));
        await mount.teardown();
      }
    });

    it("takes the star back off and says why", async () => {
      refuse();
      const mount = await mountMails();
      try {
        await openKebabAction(mount, "Save");
        expect(await mount.waitFor(errorToast)).toBe(REFUSAL);
        await mount.waitFor(() =>
          mount.rows()[0].classList.contains("star") ? null : true
        );
        expect(
          mount.rows()[0].querySelector('[aria-label="Unsave"]')
        ).toBeNull();
      } finally {
        await mount.teardown();
      }
    });

    it("brings a deleted conversation back once the delete is refused", async () => {
      const { flushDeletes } = await import("./pendingDeletes");
      refuse();
      const mount = await mountMails();
      try {
        await openKebabAction(mount, "Delete");
        expect(mount.rows().length).toBe(1);
        await mount.act(async () => flushDeletes());
        expect(await mount.waitFor(errorToast)).toBe(REFUSAL);
        await mount.waitFor(() => (mount.rows().length === 2 ? true : null));
      } finally {
        await mount.teardown();
      }
    });

    it("shows no error when the write lands", async () => {
      const mount = await mountMails();
      try {
        await openKebabAction(mount, "Save");
        await mount.act(async () => {
          await new Promise((r) => setTimeout(r, 20));
        });
        expect(errorToast()).toBeNull();
        expect(mount.rows()[0].classList.contains("star")).toBe(true);
      } finally {
        await mount.teardown();
      }
    });
  });

  it("lists search matches one by one", async () => {
    const mount = await mountMails(Category.Search, "budget");
    try {
      expect(mount.rows().length).toBe(2);
      expect(mount.container.querySelector(".thread-count-badge")).toBeNull();
    } finally {
      await mount.teardown();
    }
  });
});
