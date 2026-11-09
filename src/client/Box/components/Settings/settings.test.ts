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

const mountSettings = async (density: "comfortable" | "compact") => {
  const { createElement, act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("react-query");
  const { Context, IsOnlineProvider } = await import("client");
  const Settings = (await import("./index")).default;

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const densityCalls: string[] = [];
  const contextValue = {
    density,
    setDensity: (value: string) => {
      densityCalls.push(value);
    }
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
      expect(headings).toEqual(["Appearance", "Spam allowlist"]);
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
