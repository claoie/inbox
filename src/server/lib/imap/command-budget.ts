import { logger } from "server";

const DEFAULT_CONCURRENCY = 4;

const parseConcurrency = (): number => {
  const raw = process.env.IMAP_COMMAND_CONCURRENCY;
  if (!raw) return DEFAULT_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(
      "[command-budget] IMAP_COMMAND_CONCURRENCY invalid, falling back to default",
      { raw, default: DEFAULT_CONCURRENCY }
    );
    return DEFAULT_CONCURRENCY;
  }
  return parsed;
};

const CAPACITY = parseConcurrency();

let inFlight = 0;
const waitQueue: Array<() => void> = [];

/**
 * Acquire a slot in the global command budget. Resolves immediately when
 * a slot is free; otherwise queues FIFO and resolves once one frees up.
 * Returns the number of milliseconds spent waiting, for diagnostics.
 */
export const acquireCommandBudget = async (): Promise<number> => {
  if (inFlight < CAPACITY) {
    inFlight++;
    return 0;
  }
  const start = performance.now();
  await new Promise<void>((resolve) => {
    waitQueue.push(() => {
      inFlight++;
      resolve();
    });
  });
  return performance.now() - start;
};

export const releaseCommandBudget = (): void => {
  inFlight--;
  const next = waitQueue.shift();
  if (next) next();
};

/** Exposed for tests. */
export const _resetCommandBudget = (): void => {
  inFlight = 0;
  waitQueue.length = 0;
};

export const commandBudgetCapacity = (): number => CAPACITY;

export const commandBudgetInFlight = (): number => inFlight;
