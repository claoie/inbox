import { describe, it, expect, beforeEach } from "bun:test";

import {
  acquireCommandBudget,
  releaseCommandBudget,
  commandBudgetCapacity,
  commandBudgetInFlight,
  _resetCommandBudget,
} from "./command-budget";

const CAP = commandBudgetCapacity();

const defer = <T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
} => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const nextTick = () => new Promise<void>((r) => setImmediate(r));

const withCommandBudget = async <T>(fn: () => Promise<T>): Promise<T> => {
  await acquireCommandBudget();
  try {
    return await fn();
  } finally {
    releaseCommandBudget();
  }
};

describe("command-budget semaphore", () => {
  beforeEach(() => {
    _resetCommandBudget();
  });

  it("runs up to CAP callers concurrently", async () => {
    const gates = Array.from({ length: CAP }, () => defer<string>());
    const running: string[] = [];
    const wrapped = gates.map((g, i) =>
      withCommandBudget(async () => {
        running.push(`start-${i}`);
        return await g.promise;
      })
    );

    await nextTick();
    expect(running).toHaveLength(CAP);
    expect(commandBudgetInFlight()).toBe(CAP);

    gates.forEach((g, i) => g.resolve(`done-${i}`));
    const results = await Promise.all(wrapped);
    expect(results).toEqual(gates.map((_, i) => `done-${i}`));
    expect(commandBudgetInFlight()).toBe(0);
  });

  it("queues an extra caller until a slot frees", async () => {
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) => withCommandBudget(() => g.promise));

    let extraStarted = false;
    const extra = withCommandBudget(async () => {
      extraStarted = true;
      return "extra-done";
    });

    await nextTick();
    expect(extraStarted).toBe(false);

    holding[0].resolve();
    await holding[0].promise;
    await nextTick();
    expect(extraStarted).toBe(true);

    holding.slice(1).forEach((g) => g.resolve());
    await Promise.all(holdingRuns);
    await extra;
  });

  it("wakes multiple queued callers in FIFO order", async () => {
    const holding = Array.from({ length: CAP }, () => defer<void>());
    const holdingRuns = holding.map((g) => withCommandBudget(() => g.promise));

    const completed: string[] = [];
    const waiters = ["A", "B", "C"] as const;
    const waiterRuns: Promise<unknown>[] = [];
    for (const name of waiters) {
      waiterRuns.push(
        withCommandBudget(async () => {
          completed.push(name);
        })
      );
      await nextTick();
    }

    for (const g of holding) {
      g.resolve();
      await nextTick();
    }
    await Promise.all(holdingRuns);
    await Promise.all(waiterRuns);
    expect(completed).toEqual(["A", "B", "C"]);
  });

  it("releases on throw so subsequent callers still run", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CAP }, (_, i) =>
        withCommandBudget<never>(async () => {
          throw new Error(`boom-${i}`);
        })
      )
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    let ranAfter = false;
    await withCommandBudget(async () => {
      ranAfter = true;
    });
    expect(ranAfter).toBe(true);
  });

  it("acquiring below capacity resolves with zero wait", async () => {
    const waited = await acquireCommandBudget();
    expect(waited).toBe(0);
    releaseCommandBudget();
  });

  it("a queued acquire reports non-zero wait once woken", async () => {
    for (let i = 0; i < CAP; i++) {
      const waited = await acquireCommandBudget();
      expect(waited).toBe(0);
    }

    const waitPromise = acquireCommandBudget();
    await nextTick();
    // Release one slot after a short delay so the queued acquire measures
    // non-trivial wait time.
    setTimeout(() => releaseCommandBudget(), 20);
    const waited = await waitPromise;
    expect(waited).toBeGreaterThan(0);

    // Drain remaining slots (CAP - 1 held from the initial fill, plus the
    // one the queued acquire above just took).
    for (let i = 0; i < CAP; i++) releaseCommandBudget();
  });
});
