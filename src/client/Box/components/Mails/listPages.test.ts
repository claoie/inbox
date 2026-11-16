import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { MailHeaderData } from "common";
import { call } from "client";
import { queryClient } from "../../../lib/queryClient";
import { AccountsGetResponse } from "server";
import { Category } from "client";
import {
  LIST_PAGE_SIZE,
  fetchList,
  fetchNextListPage,
  hasNextListPage,
  isListComplete,
  listCountInAccounts,
  missingFromList,
  restoreListPaging,
  snapshotListPaging
} from "./listPages";

const mail = (id: string) => new MailHeaderData({ id, read: false });

let requests: string[];
type Page = { next_cursor: string | null; headers: MailHeaderData[] };
let pages: Record<string, Page | Promise<Page>>;
let originalGet: typeof call.get;

beforeEach(() => {
  requests = [];
  pages = {};
  queryClient.clear();
  originalGet = call.get;
  call.get = (async (url: string) => {
    requests.push(url);
    const page = await pages[url];
    return page
      ? { status: "success", body: page }
      : { status: "failed", message: `no stub for ${url}` };
  }) as typeof call.get;
});

afterEach(() => {
  call.get = originalGet;
});

// Each test uses its own list URL: the module keeps per-URL paging state.
let urlCount = 0;
const freshUrl = () => `/api/mails/headers/u${++urlCount}@x.com`;

describe("paged mail lists", () => {
  it("asks for one page first and remembers whether more follow", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a"), mail("b")] };
    const mails = await fetchList(url);
    expect(mails.map((m) => m.id)).toEqual(["a", "b"]);
    expect(requests).toEqual([`${url}?limit=${LIST_PAGE_SIZE}`]);
    expect(hasNextListPage(url)).toBe(true);
    expect(isListComplete(url)).toBe(false);
  });

  it("appends the next page from the cursor, skipping ids already loaded", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a"), mail("b")] };
    queryClient.setQueryData(url, await fetchList(url));
    pages[`${url}?limit=${LIST_PAGE_SIZE}&cursor=c1`] = { next_cursor: null, headers: [mail("b"), mail("c")] };
    await fetchNextListPage(url);
    expect(queryClient.getQueryData<MailHeaderData[]>(url)?.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(hasNextListPage(url)).toBe(false);
    expect(isListComplete(url)).toBe(true);
  });

  it("refetches as many rows as are loaded, so a refetch does not shrink the list", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a")] };
    await fetchList(url);
    const loaded = Array.from({ length: 250 }, (_, i) => mail(`m${i}`));
    queryClient.setQueryData(url, loaded);
    pages[`${url}?limit=250`] = { next_cursor: "c2", headers: loaded };
    await fetchList(url);
    expect(requests.at(-1)).toBe(`${url}?limit=250`);
  });

  it("starts from one page in a new session even when a persisted list is larger", async () => {
    const url = freshUrl();
    queryClient.setQueryData(url, Array.from({ length: 5000 }, (_, i) => mail(`m${i}`)));
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a")] };
    await fetchList(url);
    expect(requests).toEqual([`${url}?limit=${LIST_PAGE_SIZE}`]);
  });

  it("keeps the folder's own query parameters", async () => {
    const url = `${freshUrl()}?sent=1`;
    pages[`${url}&limit=${LIST_PAGE_SIZE}`] = { next_cursor: null, headers: [] };
    await fetchList(url);
    expect(requests).toEqual([`${url}&limit=${LIST_PAGE_SIZE}`]);
  });

  it("does nothing for a next page when the list is complete", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: null, headers: [mail("a")] };
    await fetchList(url);
    await fetchNextListPage(url);
    expect(requests).toHaveLength(1);
  });

  it("throws on a failed page so the query reports the error", async () => {
    await expect(fetchList(freshUrl())).rejects.toThrow();
  });
});

describe("missingFromList", () => {
  it("compares a complete list with the account count", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: null, headers: [mail("a")] };
    await fetchList(url);
    expect(missingFromList(url, 3, 1)).toBe(2);
  });

  it("compares a never-fetched list with the account count", () => {
    expect(missingFromList(freshUrl(), 3, 1)).toBe(2);
  });

  it("counts only growth since the last check for an incomplete list", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a")] };
    await fetchList(url);
    expect(missingFromList(url, 900, 100)).toBe(0);
    expect(missingFromList(url, 900, 100)).toBe(0);
    expect(missingFromList(url, 902, 100)).toBe(2);
    expect(missingFromList(url, 902, 100)).toBe(0);
  });
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

describe("a list replaced while a page loads", () => {
  it("drops a next page that arrives after the list was refetched", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a")] };
    queryClient.setQueryData(url, await fetchList(url));
    const slow = deferred<Page>();
    pages[`${url}?limit=${LIST_PAGE_SIZE}&cursor=c1`] = slow.promise;
    const loading = fetchNextListPage(url);
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c9", headers: [mail("z")] };
    queryClient.setQueryData(url, await fetchList(url));
    slow.resolve({ next_cursor: "c2", headers: [mail("b")] });
    await loading;
    expect(queryClient.getQueryData<MailHeaderData[]>(url)?.map((m) => m.id)).toEqual(["z"]);
    expect(hasNextListPage(url)).toBe(true);
  });

  it("puts the paging position back with an Undo snapshot, so the next page follows the restored rows", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a")] };
    queryClient.setQueryData(url, await fetchList(url));
    const listBefore = queryClient.getQueryData<MailHeaderData[]>(url);
    const pagingBefore = snapshotListPaging(url);
    pages[`${url}?limit=${LIST_PAGE_SIZE}&cursor=c1`] = { next_cursor: "c2", headers: [mail("b")] };
    await fetchNextListPage(url);
    queryClient.setQueryData(url, listBefore);
    restoreListPaging(url, pagingBefore);
    requests.length = 0;
    await fetchNextListPage(url);
    expect(requests).toEqual([`${url}?limit=${LIST_PAGE_SIZE}&cursor=c1`]);
    expect(queryClient.getQueryData<MailHeaderData[]>(url)?.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("drops a next page still in flight when Undo puts the list back", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a")] };
    queryClient.setQueryData(url, await fetchList(url));
    const pagingBefore = snapshotListPaging(url);
    const slow = deferred<Page>();
    pages[`${url}?limit=${LIST_PAGE_SIZE}&cursor=c1`] = slow.promise;
    const loading = fetchNextListPage(url);
    restoreListPaging(url, pagingBefore);
    slow.resolve({ next_cursor: "c2", headers: [mail("b")] });
    await loading;
    expect(queryClient.getQueryData<MailHeaderData[]>(url)?.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("the count a list is measured against", () => {
  it("takes the count when the list arrives, so mail that lands before the next check is missing", async () => {
    const url = freshUrl();
    pages[`${url}?limit=${LIST_PAGE_SIZE}`] = { next_cursor: "c1", headers: [mail("a")] };
    await fetchList(url, () => 900);
    expect(missingFromList(url, 901, 100)).toBe(1);
  });

  const accounts = {
    received: [
      { key: "a@x.com", doc_count: 10, saved_doc_count: 2 },
      { key: "b@x.com", doc_count: 5, saved_doc_count: 0 }
    ],
    sent: [{ key: "a@x.com", doc_count: 7, saved_doc_count: 1 }]
  } as unknown as AccountsGetResponse;

  it("reads each list's count from the accounts payload", () => {
    expect(listCountInAccounts(accounts, "a@x.com", Category.AllMails, true)).toBe(15);
    expect(listCountInAccounts(accounts, "a@x.com", Category.AllMails, false)).toBe(10);
    expect(listCountInAccounts(accounts, "a@x.com", Category.SentMails, false)).toBe(7);
    expect(listCountInAccounts(accounts, "a@x.com", Category.SavedMails, false)).toBe(3);
    expect(listCountInAccounts(accounts, "c@x.com", Category.AllMails, false)).toBe(0);
  });
});
