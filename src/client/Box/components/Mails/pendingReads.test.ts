import { describe, it, expect } from "bun:test";
import { MailHeaderData } from "common";
import {
  isReadRefused,
  pendingReadCount,
  trackMarkRead,
  withPendingReads
} from "./pendingReads";

const unread = (id: string) => new MailHeaderData({ id, read: false });
const tick = () => new Promise((r) => setTimeout(r, 5));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("withPendingReads", () => {
  it("keeps a mail read when the list was fetched while its mark was in flight", async () => {
    const mark = deferred<{ status: string }>();
    trackMarkRead("a", mark.promise);
    const mails = await withPendingReads(async () => [unread("a"), unread("b")]);
    expect(mails.map((m) => [m.id, m.read])).toEqual([
      ["a", true],
      ["b", false]
    ]);
    mark.resolve({ status: "success" });
    await tick();
    expect(pendingReadCount()).toBe(0);
  });

  it("keeps a mail read when the mark succeeded while the list was in flight", async () => {
    const list = deferred<MailHeaderData[]>();
    const fetched = withPendingReads(() => list.promise);
    trackMarkRead("a", Promise.resolve({ status: "success" }));
    await tick();
    expect(pendingReadCount()).toBe(1);
    list.resolve([unread("a")]);
    expect((await fetched).map((m) => m.read)).toEqual([true]);
    expect(pendingReadCount()).toBe(0);
  });

  it("trusts a list fetched after the mark succeeded", async () => {
    trackMarkRead("a", Promise.resolve({ status: "success" }));
    await tick();
    const mails = await withPendingReads(async () => [unread("a")]);
    expect(mails.map((m) => m.read)).toEqual([false]);
  });

  it("trusts a list started after the mark succeeded even while an older list is in flight", async () => {
    const older = deferred<MailHeaderData[]>();
    const olderFetch = withPendingReads(() => older.promise);
    trackMarkRead("a", Promise.resolve({ status: "success" }));
    await tick();
    const newer = await withPendingReads(async () => [unread("a")]);
    expect(newer.map((m) => m.read)).toEqual([false]);
    older.resolve([unread("a")]);
    expect((await olderFetch).map((m) => m.read)).toEqual([true]);
  });

  it("trusts the server again once the mark fails", async () => {
    trackMarkRead("a", Promise.resolve({ status: "error" }));
    await tick();
    const mails = await withPendingReads(async () => [unread("a")]);
    expect(mails.map((m) => m.read)).toEqual([false]);
    expect(pendingReadCount()).toBe(0);
  });
});

describe("isReadRefused", () => {
  it("holds a refused mark until a later mark of the same mail lands", async () => {
    trackMarkRead("r", Promise.resolve({ status: "failed" }));
    await tick();
    expect(isReadRefused("r")).toBe(true);
    const mails = await withPendingReads(async () => [unread("r")]);
    expect(mails.map((m) => m.read)).toEqual([false]);
    trackMarkRead("r", Promise.resolve({ status: "success" }));
    await tick();
    expect(isReadRefused("r")).toBe(false);
  });
});
