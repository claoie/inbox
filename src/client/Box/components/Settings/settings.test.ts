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
import { call } from "client";

beforeAll(() => {
  GlobalRegistrator.register();
  // React 18 only lets `act` flush work when this flag is set.
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

let originalGet: typeof call.get;

beforeEach(() => {
  originalGet = call.get;
  call.get = (async () => ({
    status: "success",
    body: [{ id: "entry-1", pattern: "*@example.com" }]
  })) as typeof call.get;
});

afterEach(() => {
  call.get = originalGet;
});

const mountSettings = async (
  density: "comfortable" | "compact",
  compose: { signature?: string; includeOriginal?: boolean; defaultFrom?: string } = {}
) => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { Context, IsOnlineProvider } = await import("client");
  const Settings = (await import("./index")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const densityCalls: string[] = [];
  const composeCalls: [string, unknown][] = [];
  const contextValue = {
    density,
    setDensity: (value: string) => {
      densityCalls.push(value);
    },
    domainName: "example.com",
    signature: compose.signature ?? "",
    setSignature: (value: string) => composeCalls.push(["signature", value]),
    includeOriginal: compose.includeOriginal ?? true,
    setIncludeOriginal: (value: boolean) =>
      composeCalls.push(["includeOriginal", value]),
    defaultFrom: compose.defaultFrom ?? "",
    setDefaultFrom: (value: string) => composeCalls.push(["defaultFrom", value])
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
            createElement(Settings)
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
  await flush();

  const densityButton = (label: string) =>
    Array.from(
      container.querySelectorAll<HTMLButtonElement>(".segmented button")
    ).find((b) => b.textContent === label) as HTMLButtonElement;

  return {
    container,
    densityCalls,
    composeCalls,
    act,
    flush,
    densityButton,
    click: async (el: HTMLElement) => {
      await act(async () => {
        el.click();
      });
      await flush();
    },
    teardown: async () => {
      await act(async () => root.unmount());
      container.remove();
      queryClient.clear();
    }
  };
};

describe("Settings page", () => {
  it("marks the current density and switches it", async () => {
    const { densityButton, densityCalls, click, teardown } =
      await mountSettings("comfortable");
    try {
      expect(densityButton("Comfortable").getAttribute("aria-pressed")).toBe(
        "true"
      );
      expect(densityButton("Compact").getAttribute("aria-pressed")).toBe(
        "false"
      );
      await click(densityButton("Compact"));
      expect(densityCalls).toEqual(["compact"]);
    } finally {
      await teardown();
    }
  });

  it("lists the spam allowlist inline, not in a dialog", async () => {
    const { container, teardown } = await mountSettings("compact");
    try {
      const headings = Array.from(container.querySelectorAll("h3")).map(
        (h) => h.textContent
      );
      expect(headings).toEqual(["Appearance", "Compose", "Spam allowlist"]);
      expect(
        container.querySelector(".allowlist .allowlist-entries .pattern")
          ?.textContent
      ).toBe("*@example.com");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await teardown();
    }
  });
});

describe("Settings › Compose", () => {
  // Drive a control the way a user does: focus, set the value through the
  // native setter, then fire the event React listens for. The key event
  // covers React's change-event polyfill, which only notices a changed
  // text value on keyup of the focused element (see search.test.ts).
  const setValue = (
    el: HTMLTextAreaElement | HTMLSelectElement,
    value: string,
    event: "input" | "change"
  ) => {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(event, { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  };

  it("shows the saved compose settings and changes each one", async () => {
    const mount = await mountSettings("comfortable", {
      signature: "Maple",
      includeOriginal: true,
      defaultFrom: "old@example.com"
    });
    try {
      const { container, composeCalls, act } = mount;
      const select = container.querySelector(
        "#settings-default-from"
      ) as HTMLSelectElement;
      const textarea = container.querySelector(
        "#settings-signature"
      ) as HTMLTextAreaElement;
      const checkbox = container.querySelector(
        "#settings-include-original"
      ) as HTMLInputElement;

      expect(select.value).toBe("old@example.com");
      expect(
        Array.from(select.options).map((o) => o.value)
      ).toEqual(["", "old@example.com"]);
      expect(textarea.value).toBe("Maple");
      expect(checkbox.checked).toBe(true);

      await act(async () => setValue(select, "", "change"));
      await act(async () => setValue(textarea, "Maple\nExample Co", "input"));
      await act(async () => checkbox.click());
      expect(composeCalls).toEqual([
        ["defaultFrom", ""],
        ["signature", "Maple\nExample Co"],
        ["includeOriginal", false]
      ]);
    } finally {
      await mount.teardown();
    }
  });
});
