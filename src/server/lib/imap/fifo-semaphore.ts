/**
 * A bounded-concurrency FIFO gate: up to `capacity` acquires proceed
 * immediately, further acquires queue and are woken in arrival order as
 * slots free up. Shared by `body-budget.ts` and `command-budget.ts`, which
 * differ only in what they gate and how they report wait time.
 */
export interface FifoSemaphore {
  /** Resolves once a slot is held. Resolves to the number of ms spent waiting (0 if a slot was free). */
  acquire(): Promise<number>;
  release(): void;
  readonly capacity: number;
  inFlight(): number;
  reset(): void;
}

export const createFifoSemaphore = (capacity: number): FifoSemaphore => {
  let inFlight = 0;
  const waitQueue: Array<() => void> = [];

  const acquire = async (): Promise<number> => {
    if (inFlight < capacity) {
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

  const release = (): void => {
    inFlight--;
    const next = waitQueue.shift();
    if (next) next();
  };

  return {
    acquire,
    release,
    capacity,
    inFlight: () => inFlight,
    reset: () => {
      inFlight = 0;
      waitQueue.length = 0;
    },
  };
};
