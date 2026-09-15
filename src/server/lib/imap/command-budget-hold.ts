import { AsyncLocalStorage } from "node:async_hooks";
import { acquireCommandBudget, releaseCommandBudget } from "./command-budget";

interface Hold {
  held: boolean;
}

/**
 * Bound in `handler.ts` around a budgeted command's full processing, so
 * `withYieldedCommandBudget` below knows whether THIS command currently
 * holds a command-budget slot.
 */
const holdStore = new AsyncLocalStorage<Hold>();

export const runInCommandBudgetContext = <T>(held: boolean, fn: () => T): T =>
  holdStore.run({ held }, fn);

/**
 * Wraps a lazily-started async generator (body-budget / stream-mutex both
 * defer their own `acquire()` to the generator's first `.next()`) so that,
 * for the ENTIRE window this generator is being waited on or driven, the
 * calling command's command-budget slot — if it holds one — is given up
 * and reacquired once the generator completes, throws, or is abandoned
 * early (`.return()`, which `finally` catches the same as the other two).
 *
 * Without this, a command-budget slot acquired in `handler.ts` before
 * dispatch stays held for however long the command then queues behind a
 * DIFFERENT resource's own limit (body-budget's fetch-concurrency cap,
 * stream-mutex's per-key dedupe) plus however long the resulting stream
 * then takes to drain to a possibly-slow peer (up to `SOCKET_TIMEOUT_MS`).
 * That nests two independent budgets instead of partitioning them: a burst
 * of exactly the commands this budget exists to bound (concurrent
 * `UID FETCH ... BODY[]`) can saturate it entirely with commands that are
 * themselves just queued elsewhere, not doing command-budget-relevant work,
 * starving every other command server-wide behind them.
 */
export const withYieldedCommandBudget = async function* <T>(
  makeStream: () => AsyncIterable<T>
): AsyncGenerator<T, void, unknown> {
  const ctx = holdStore.getStore();
  const wasHeld = ctx?.held ?? false;
  if (wasHeld) {
    releaseCommandBudget();
    ctx!.held = false;
  }
  try {
    yield* makeStream();
  } finally {
    if (wasHeld) {
      await acquireCommandBudget();
      ctx!.held = true;
    }
  }
};
