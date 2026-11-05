import { describe, it, expect, afterEach, mock } from "bun:test";
import { registerServiceWorker, unregisterServiceWorker } from "./serviceWorker";

// Minimal mutable view of the browser globals the module touches, so the tests
// can stub them without `any` (eslint forbids it) and restore afterwards.
type MutableGlobals = {
  navigator: { serviceWorker?: unknown };
  caches?: { keys(): Promise<string[]>; delete(key: string): Promise<boolean> };
};
const g = globalThis as unknown as MutableGlobals;

const realNavigator = g.navigator;
const realCaches = g.caches;

afterEach(() => {
  g.navigator = realNavigator;
  if (realCaches === undefined) delete g.caches;
  else g.caches = realCaches;
});

describe("registerServiceWorker", () => {
  it("registers the SW script when the API is available", async () => {
    const register = mock(async () => ({}));
    g.navigator = { serviceWorker: { register } };
    await registerServiceWorker();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][0]).toBe("/service-worker.js");
  });

  it("no-ops when serviceWorker is unavailable", async () => {
    g.navigator = {};
    // Must not throw.
    await registerServiceWorker();
  });

  it("swallows a registration rejection", async () => {
    const register = mock(async () => {
      throw new Error("nope");
    });
    g.navigator = { serviceWorker: { register } };
    await registerServiceWorker();
    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe("unregisterServiceWorker", () => {
  it("unregisters every registration and deletes every cache", async () => {
    const unregisterA = mock(async () => true);
    const unregisterB = mock(async () => true);
    const getRegistrations = mock(async () => [
      { unregister: unregisterA },
      { unregister: unregisterB },
    ]);
    g.navigator = { serviceWorker: { getRegistrations } };

    const del = mock(async () => true);
    g.caches = { keys: mock(async () => ["mail-v1", "old"]), delete: del };

    await unregisterServiceWorker();

    expect(unregisterA).toHaveBeenCalledTimes(1);
    expect(unregisterB).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(2);
    expect(del.mock.calls.map((c) => c[0]).sort()).toEqual(["mail-v1", "old"]);
  });

  it("clears caches even when serviceWorker is unavailable", async () => {
    g.navigator = {};
    const del = mock(async () => true);
    g.caches = { keys: mock(async () => ["mail-v1"]), delete: del };
    await unregisterServiceWorker();
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("no-ops when neither serviceWorker nor caches exist", async () => {
    g.navigator = {};
    delete g.caches;
    // Must not throw.
    await unregisterServiceWorker();
  });
});
