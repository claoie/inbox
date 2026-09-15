import { describe, it, expect, beforeEach } from "bun:test";
import {
  runInCommandBudgetContext,
  withYieldedCommandBudget,
} from "./command-budget-hold";
import {
  acquireCommandBudget,
  releaseCommandBudget,
  commandBudgetInFlight,
  _resetCommandBudget,
} from "./command-budget";

const defer = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function* singleValueStream(value: string) {
  yield value;
}

describe("command-budget-hold", () => {
  beforeEach(() => {
    _resetCommandBudget();
  });

  it("gives up a held slot for the duration of the wrapped generator, and reacquires it on completion", async () => {
    await acquireCommandBudget();
    expect(commandBudgetInFlight()).toBe(1);

    const results: string[] = [];
    await runInCommandBudgetContext(true, async () => {
      const gate = defer<void>();
      const gen = withYieldedCommandBudget(async function* () {
        await gate.promise;
        yield "value";
      });
      const consuming = (async () => {
        for await (const v of gen) results.push(v);
      })();

      // The slot is given up as soon as the generator starts (first `.next()`).
      await new Promise((r) => setImmediate(r));
      expect(commandBudgetInFlight()).toBe(0);

      gate.resolve();
      await consuming;
    });

    expect(results).toEqual(["value"]);
    // Reacquired once the generator completed.
    expect(commandBudgetInFlight()).toBe(1);
    releaseCommandBudget();
  });

  it("is a no-op when the command never held a slot", async () => {
    expect(commandBudgetInFlight()).toBe(0);

    await runInCommandBudgetContext(false, async () => {
      const gen = withYieldedCommandBudget(() => singleValueStream("v"));
      const collected: string[] = [];
      for await (const v of gen) collected.push(v);
      expect(collected).toEqual(["v"]);
    });

    expect(commandBudgetInFlight()).toBe(0);
  });

  it("reacquires the slot even when the wrapped generator throws", async () => {
    await acquireCommandBudget();

    await runInCommandBudgetContext(true, async () => {
      const gen = withYieldedCommandBudget<string>(async function* () {
        throw new Error("boom");
      });
      await expect(
        (async () => {
          for await (const _v of gen) {
            // drain
          }
        })()
      ).rejects.toThrow("boom");
    });

    expect(commandBudgetInFlight()).toBe(1);
    releaseCommandBudget();
  });

  it("reacquires the slot when the consumer abandons the generator early", async () => {
    await acquireCommandBudget();

    await runInCommandBudgetContext(true, async () => {
      const gen = withYieldedCommandBudget(async function* () {
        yield "first";
        yield "second";
      });
      for await (const v of gen) {
        expect(v).toBe("first");
        break; // triggers gen.return() via the for-await protocol
      }
      // give the generator's finally a tick to run after the early break
      await new Promise((r) => setImmediate(r));
    });

    expect(commandBudgetInFlight()).toBe(1);
    releaseCommandBudget();
  });
});
