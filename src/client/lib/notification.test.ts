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

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

const { Notifier } = await import("./notification");
const { call } = await import("./call");

type Globals = Record<string, unknown>;
let saved: { window: Globals; navigator: Globals; delete: typeof call.delete };
let deletes: string[];
let unsubscribed: number;

// happy-dom has no push notifications; give it the three globals the
// Notifier checks for, with a granted permission and one live subscription.
const installPush = () => {
  Object.assign(window, {
    Notification: { permission: "granted" },
    PushManager: function PushManager() {}
  });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: async () => ({
        pushManager: {
          getSubscription: async () => ({
            unsubscribe: async () => {
              unsubscribed++;
              return true;
            }
          })
        }
      })
    }
  });
};

beforeEach(() => {
  saved = {
    window: {
      Notification: (window as unknown as Globals).Notification,
      PushManager: (window as unknown as Globals).PushManager
    },
    navigator: {
      serviceWorker: Object.getOwnPropertyDescriptor(navigator, "serviceWorker")
    },
    delete: call.delete
  };
  deletes = [];
  unsubscribed = 0;
  window.localStorage.clear();
  call.delete = (async (path: string) => {
    deletes.push(path);
    return { status: "success" };
  }) as typeof call.delete;
});

afterEach(() => {
  call.delete = saved.delete;
  for (const [key, value] of Object.entries(saved.window)) {
    if (value === undefined) delete (window as unknown as Globals)[key];
    else (window as unknown as Globals)[key] = value;
  }
  const descriptor = saved.navigator.serviceWorker as
    | PropertyDescriptor
    | undefined;
  if (descriptor) Object.defineProperty(navigator, "serviceWorker", descriptor);
  else delete (navigator as unknown as Globals).serviceWorker;
});

describe("Notifier.permission", () => {
  it("is unsupported without push notifications", () => {
    expect(new Notifier().permission).toBe("unsupported");
  });

  it("is the browser's permission when push is available", () => {
    installPush();
    expect(new Notifier().permission).toBe("granted");
  });
});

describe("Notifier.unsubscribe", () => {
  it("drops the server's subscription and the browser's own", async () => {
    installPush();
    window.localStorage.setItem("push_subscription_id", JSON.stringify("sub-1"));
    await new Notifier().unsubscribe();
    expect(deletes).toEqual(["/api/push/subscribe/sub-1"]);
    expect(window.localStorage.getItem("push_subscription_id")).toBeNull();
    expect(unsubscribed).toBe(1);
  });

  it("skips the server when nothing was subscribed", async () => {
    installPush();
    await new Notifier().unsubscribe();
    expect(deletes).toEqual([]);
    expect(unsubscribed).toBe(1);
  });

  it("still drops the server's subscription where push is unavailable", async () => {
    window.localStorage.setItem("push_subscription_id", JSON.stringify("sub-2"));
    await new Notifier().unsubscribe();
    expect(deletes).toEqual(["/api/push/subscribe/sub-2"]);
    expect(window.localStorage.getItem("push_subscription_id")).toBeNull();
  });
});
