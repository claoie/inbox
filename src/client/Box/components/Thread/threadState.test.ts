import { describe, it, expect } from "bun:test";
import { QueryClient } from "react-query";
import { MailHeaderData } from "common";
import { call } from "client";
import { fetchList, fetchNextListPage, snapshotListPaging } from "../Mails/listPages";
import {
  FOLD_THRESHOLD,
  initialExpanded,
  markReadInCaches,
  restoreCaches,
  snapshotCaches,
  threadItems,
  updateMailInCaches
} from "./threadState";

const mail = (id: string, read = true) =>
  new MailHeaderData({ id, read, subject: "s", date: "2026-01-01T00:00:00Z" });

describe("initialExpanded", () => {
  it("opens the opened message, the newest and the unread ones", () => {
    const thread = [mail("a"), mail("b", false), mail("c"), mail("d")];
    expect([...initialExpanded(thread, "a")].sort()).toEqual(["a", "b", "d"]);
  });

  it("is empty for an empty thread", () => {
    expect(initialExpanded([], "a").size).toBe(0);
  });
});

describe("threadItems", () => {
  it("shows a short conversation message by message", () => {
    const thread = [mail("a"), mail("b"), mail("c")];
    expect(threadItems(thread, new Set(["c"])).map((i) => i.kind)).toEqual([
      "message",
      "message",
      "message"
    ]);
  });

  it("folds a long run of collapsed middle messages into one row", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const thread = ids.map((id) => mail(id));
    const items = threadItems(thread, new Set(["f"]));
    expect(items.map((i) => (i.kind === "fold" ? `fold:${i.ids.join("")}` : i.mail.id))).toEqual([
      "a",
      "fold:bcde",
      "f"
    ]);
    expect(FOLD_THRESHOLD).toBeLessThanOrEqual(4);
  });

  it("never folds an open message", () => {
    const thread = ["a", "b", "c", "d", "e", "f"].map((id) => mail(id));
    const items = threadItems(thread, new Set(["c", "f"]));
    expect(items.every((i) => i.kind === "message")).toBe(true);
  });
});

describe("cache helpers", () => {
  const seed = () => {
    const qc = new QueryClient();
    qc.setQueryData("/api/mails/headers/me@x.com", [mail("a", false), mail("b")]);
    qc.setQueryData("/api/mails/thread/a", [mail("a", false)]);
    qc.setQueryData("/api/mails/accounts", { received: [], sent: [], spam: [] });
    qc.setQueryData("/other", [mail("a", false)]);
    return qc;
  };

  it("marks a mail read in lists and threads, not elsewhere", () => {
    const qc = seed();
    markReadInCaches(qc, ["a"]);
    expect(qc.getQueryData<MailHeaderData[]>("/api/mails/headers/me@x.com")?.[0].read).toBe(true);
    expect(qc.getQueryData<MailHeaderData[]>("/api/mails/thread/a")?.[0].read).toBe(true);
    expect(qc.getQueryData<MailHeaderData[]>("/other")?.[0].read).toBe(false);
  });

  it("removes a mail everywhere and Undo puts it back", () => {
    const qc = seed();
    const snapshot = snapshotCaches(qc);
    updateMailInCaches(qc, "a", () => null);
    expect(qc.getQueryData<MailHeaderData[]>("/api/mails/headers/me@x.com")?.map((m) => m.id)).toEqual(["b"]);
    expect(qc.getQueryData<MailHeaderData[]>("/api/mails/thread/a")).toEqual([]);
    restoreCaches(qc, snapshot);
    expect(qc.getQueryData<MailHeaderData[]>("/api/mails/headers/me@x.com")?.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("puts each list's paging position back with its rows", async () => {
    const url = "/api/mails/headers/paging@x.com";
    const originalGet = call.get;
    call.get = (async (path: string) => ({
      status: "success",
      body: path.includes("cursor=c1")
        ? { next_cursor: "c2", headers: [mail("b")] }
        : { next_cursor: "c1", headers: [mail("a")] }
    })) as typeof call.get;
    try {
      const qc = new QueryClient();
      qc.setQueryData(url, await fetchList(url));
      const before = snapshotListPaging(url);
      const snapshot = snapshotCaches(qc);
      await fetchNextListPage(url);
      expect(snapshotListPaging(url)).not.toEqual(before);
      restoreCaches(qc, snapshot);
      expect(snapshotListPaging(url)).toEqual(before);
    } finally {
      call.get = originalGet;
    }
  });
});
