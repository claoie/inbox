import { createFifoSemaphore } from "./fifo-semaphore";
import { parseConcurrencyValue } from "./concurrency-env";

// A streaming `UID FETCH ... BODY[]` used to hold its command-budget slot
// for the whole body-budget/stream-mutex wait AND the socket write, which
// meant this capacity had to be sized relative to `body-budget.ts`'s own
// cap to avoid starving every other command behind a burst of body
// fetches. `command-budget-hold.ts`'s `withYieldedCommandBudget` now gives
// up this slot for that entire window instead, so the two budgets
// partition rather than nest and this default is independent of
// `IMAP_BODY_FETCH_CONCURRENCY`.
const DEFAULT_CONCURRENCY = 8;

const CAPACITY = parseConcurrencyValue(
  process.env.IMAP_COMMAND_CONCURRENCY,
  "IMAP_COMMAND_CONCURRENCY",
  DEFAULT_CONCURRENCY,
  "command-budget"
);

const semaphore = createFifoSemaphore(CAPACITY);

/**
 * Acquire a slot in the global command budget. Resolves immediately when
 * a slot is free; otherwise queues FIFO and resolves once one frees up.
 * Returns the number of milliseconds spent waiting, for diagnostics.
 */
export const acquireCommandBudget = (): Promise<number> => semaphore.acquire();

export const releaseCommandBudget = (): void => semaphore.release();

/** Exposed for tests. */
export const _resetCommandBudget = (): void => semaphore.reset();

export const commandBudgetCapacity = (): number => CAPACITY;

export const commandBudgetInFlight = (): number => semaphore.inFlight();
