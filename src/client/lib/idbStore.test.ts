import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  idbGetAllQueries,
  idbPutQuery,
  idbDeleteQuery,
  idbClearQueries,
} from "./idbStore";

const closeCachedConnection = async () => {
  const transaction = spyOn(IDBDatabase.prototype, "transaction");
  await idbGetAllQueries();
  const connection = transaction.mock.contexts[0] as IDBDatabase;
  transaction.mockRestore();
  connection.close();
};

beforeEach(async () => {
  await idbClearQueries();
});

describe("idbStore", () => {
  it("round-trips an entry", async () => {
    await idbPutQuery({
      key: "k1",
      payload: { a: 1 },
      userId: "u1",
      lastFetchedAt: 123,
    });
    const all = await idbGetAllQueries();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({
      key: "k1",
      payload: { a: 1 },
      userId: "u1",
      lastFetchedAt: 123,
    });
  });

  it("upserts by key (no duplicate rows)", async () => {
    await idbPutQuery({ key: "k1", payload: { a: 1 }, userId: "u1", lastFetchedAt: 1 });
    await idbPutQuery({ key: "k1", payload: { a: 2 }, userId: "u1", lastFetchedAt: 2 });
    const all = await idbGetAllQueries();
    expect(all).toHaveLength(1);
    expect((all[0].payload as { a: number }).a).toBe(2);
  });

  it("deletes by key", async () => {
    await idbPutQuery({ key: "k1", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbPutQuery({ key: "k2", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbDeleteQuery("k1");
    const all = await idbGetAllQueries();
    expect(all.map((e) => e.key)).toEqual(["k2"]);
  });

  it("clears all entries", async () => {
    await idbPutQuery({ key: "k1", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbPutQuery({ key: "k2", payload: {}, userId: "u1", lastFetchedAt: 1 });
    await idbClearQueries();
    expect(await idbGetAllQueries()).toHaveLength(0);
  });

  describe("after the browser closes the connection", () => {
    const entry = { key: "k1", payload: {}, userId: "u1", lastFetchedAt: 1 };

    it("reopens to write", async () => {
      await closeCachedConnection();
      await idbPutQuery(entry);
      expect((await idbGetAllQueries()).map((e) => e.key)).toEqual(["k1"]);
    });

    it("reopens to read", async () => {
      await idbPutQuery(entry);
      await closeCachedConnection();
      expect((await idbGetAllQueries()).map((e) => e.key)).toEqual(["k1"]);
    });

    it("reopens to delete", async () => {
      await idbPutQuery(entry);
      await closeCachedConnection();
      await idbDeleteQuery("k1");
      expect(await idbGetAllQueries()).toHaveLength(0);
    });

    it("reopens to clear", async () => {
      await idbPutQuery(entry);
      await closeCachedConnection();
      await idbClearQueries();
      expect(await idbGetAllQueries()).toHaveLength(0);
    });

    it("fails soft when the reopened connection refuses too", async () => {
      const transaction = spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
        throw new DOMException("The database connection is closing.", "InvalidStateError");
      });
      try {
        await idbPutQuery(entry);
        await idbDeleteQuery("k1");
        await idbClearQueries();
        expect(await idbGetAllQueries()).toEqual([]);
        expect(transaction).toHaveBeenCalledTimes(8);
      } finally {
        transaction.mockRestore();
      }
    });
  });
});
