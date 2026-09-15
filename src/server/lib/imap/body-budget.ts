import { AsyncLocalStorage } from "node:async_hooks";
import { createFifoSemaphore } from "./fifo-semaphore";
import { parseConcurrencyValue } from "./concurrency-env";

const DEFAULT_CONCURRENCY = 3;

const CAPACITY = parseConcurrencyValue(
  process.env.IMAP_BODY_FETCH_CONCURRENCY,
  "IMAP_BODY_FETCH_CONCURRENCY",
  DEFAULT_CONCURRENCY,
  "body-budget"
);

const semaphore = createFifoSemaphore(CAPACITY);

/**
 * Per-request wait accumulator. Bound at the top of the IMAP command
 * handler via `runInBodyBudgetContext(fn)`; every `withBodyBudget` call
 * that runs INSIDE `fn` (even across `await` boundaries and nested
 * async work) adds its measured wait to the SAME `{ ms }` object.
 * The handler reads the total from `getBodyBudgetWaitMs()` at the end.
 *
 * Load-bearing: without AsyncLocalStorage the wait latency would sit on
 * a module-scoped variable that concurrent handlers overwrite (handler
 * A yields inside `await withBodyBudget`, handler B on a different
 * socket acquires and writes its OWN wait time to the shared cell,
 * then A resumes and reads B's value). AsyncLocalStorage keeps each
 * request's ledger separate.
 */
const waitStore = new AsyncLocalStorage<{ ms: number }>();

export const runInBodyBudgetContext = <T>(fn: () => T): T =>
  waitStore.run({ ms: 0 }, fn);

export const getBodyBudgetWaitMs = (): number => waitStore.getStore()?.ms ?? 0;

const acquire = async (): Promise<void> => {
  const waitedMs = await semaphore.acquire();
  const ledger = waitStore.getStore();
  if (ledger) ledger.ms += waitedMs;
};

export const withBodyBudget = async <T>(fn: () => Promise<T>): Promise<T> => {
  await acquire();
  try {
    return await fn();
  } finally {
    semaphore.release();
  }
};

/**
 * Hold a budget slot for the whole lifetime of a stream.
 *
 * The streaming BODY[] path is the LARGEST fetch shape, so it must be inside
 * the same bound as the materializing paths — otherwise K concurrent sockets
 * each stream a distinct large body with no cap and the budget covers only the
 * cheaper shapes. `withBodyBudget` cannot express this: it releases when its
 * promise settles, which for a generator is before the consumer has read a
 * single chunk.
 *
 * The slot is released in `finally`, which a generator runs on completion, on
 * throw, AND when the consumer abandons it early (`for await` breaking on a
 * dead socket calls `.return()`), so an aborted FETCH cannot leak a slot.
 */
export const withBodyBudgetStream = async function* <T>(
  makeStream: () => AsyncIterable<T>
): AsyncGenerator<T, void, unknown> {
  await acquire();
  try {
    yield* makeStream();
  } finally {
    semaphore.release();
  }
};

/** Exposed for tests. */
export const _resetBodyBudget = (): void => semaphore.reset();

export const bodyBudgetCapacity = (): number => CAPACITY;
