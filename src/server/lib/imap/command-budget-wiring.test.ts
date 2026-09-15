/**
 * Proves the global command budget is actually wired into `handleRequest`,
 * not just correct in isolation (`command-budget.test.ts` covers the
 * semaphore itself in a vacuum). Saturates the budget externally, dispatches
 * a real command through the handler, and checks the handler's own
 * acquire/release shows up as observable queueing + a post-completion
 * slot count — so gutting `BUDGETED_COMMAND_TYPES` or dropping the
 * `releaseCommandBudget()` call in `handler.ts` fails these, not just a
 * mutation run against the semaphore in isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "events";
import "../push";
import { ImapRequestHandler } from "./handler";
import {
  acquireCommandBudget,
  releaseCommandBudget,
  commandBudgetCapacity,
  commandBudgetInFlight,
  _resetCommandBudget,
} from "./command-budget";

function makeMockSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    writes: string[];
    writable: boolean;
    destroyed: boolean;
    write: (data: string) => boolean;
    setTimeout: () => void;
    destroy: () => void;
    end: () => void;
  };
  socket.writes = [];
  socket.writable = true;
  socket.destroyed = false;
  socket.write = (data: string) => {
    socket.writes.push(data);
    return true;
  };
  socket.setTimeout = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.end = () => {
    socket.destroyed = true;
    socket.emit("close");
  };
  return socket;
}

const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const nextTick = () => new Promise<void>((r) => setImmediate(r));

describe("command budget wiring through handleRequest", () => {
  beforeEach(() => {
    _resetCommandBudget();
  });

  // A failed assertion mid-test would otherwise skip the manual release
  // loop below it and leave the process-global singleton saturated for
  // every later test file in the same process.
  afterEach(() => {
    _resetCommandBudget();
  });

  it("queues a real SELECT dispatched through the handler when the budget is saturated, and releases its slot on completion", async () => {
    const CAP = commandBudgetCapacity();

    // Saturate every slot externally, standing in for other sessions'
    // in-flight budgeted commands.
    for (let i = 0; i < CAP; i++) {
      await acquireCommandBudget();
    }
    expect(commandBudgetInFlight()).toBe(CAP);

    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);
    socket.emit("data", Buffer.from("t1 SELECT INBOX\r\n"));

    // Fully saturated: the handler's own acquire must queue, not run.
    await nextTick();
    expect(socket.writes.some((w) => /^t1 (OK|NO|BAD)/.test(w))).toBe(false);
    expect(commandBudgetInFlight()).toBe(CAP);

    // Free exactly one externally-held slot — the queued SELECT should be
    // the one woken (FIFO), complete, and release its own slot back.
    releaseCommandBudget();

    await waitFor(() => socket.writes.some((w) => /^t1 (OK|NO|BAD)/.test(w)), 2000);
    expect(socket.writes.some((w) => /^t1 (OK|NO|BAD)/.test(w))).toBe(true);

    // Back to CAP - 1: the (CAP - 1) still-held external slots, and the
    // handler's own acquired-then-released slot is gone — proving
    // `releaseCommandBudget()` actually ran in `handler.ts`'s finally.
    expect(commandBudgetInFlight()).toBe(CAP - 1);

    for (let i = 0; i < CAP - 1; i++) releaseCommandBudget();
  });

  it("does not gate a cheap/protocol command (NOOP) behind a fully saturated budget", async () => {
    const CAP = commandBudgetCapacity();
    for (let i = 0; i < CAP; i++) {
      await acquireCommandBudget();
    }

    const handler = new ImapRequestHandler();
    const socket = makeMockSocket();
    handler.setSocket(socket as never);
    socket.emit("data", Buffer.from("t2 NOOP\r\n"));

    await waitFor(() => socket.writes.some((w) => w.includes("t2 OK NOOP completed")), 1000);
    expect(socket.writes.some((w) => w.includes("t2 OK NOOP completed"))).toBe(true);
    // The budget itself never moved — NOOP isn't in BUDGETED_COMMAND_TYPES.
    expect(commandBudgetInFlight()).toBe(CAP);

    for (let i = 0; i < CAP; i++) releaseCommandBudget();
  });
});
