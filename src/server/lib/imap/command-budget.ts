import { createFifoSemaphore } from "./fifo-semaphore";
import { parseConcurrencyValue } from "./concurrency-env";
import { bodyBudgetCapacity } from "./body-budget";

// A streaming `UID FETCH ... BODY[]` holds its command-budget slot for the
// WHOLE socket write (see `handler.ts`'s use of `withBodyBudgetStream` via
// the FETCH path), which is also gated by `body-budget.ts`'s own, separate
// concurrency cap. Sizing this capacity only slightly above that cap would
// mean every concurrent body stream at body-budget's own limit pins nearly
// all of THIS budget too, starving every other command server-wide behind
// them. Deriving the default from `bodyBudgetCapacity()` plus a margin keeps
// that headroom even if an operator raises `IMAP_BODY_FETCH_CONCURRENCY`
// without separately retuning this one.
const CONCURRENT_BODY_STREAM_MARGIN = 5;
const DEFAULT_CONCURRENCY = bodyBudgetCapacity() + CONCURRENT_BODY_STREAM_MARGIN;

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
