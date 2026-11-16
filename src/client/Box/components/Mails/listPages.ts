/**
 * Paged loading for the mail lists (`/headers/:account` and `/unified`).
 *
 * A list's query data stays the flat array of the mails loaded so far. The
 * first request in a session asks for one page; scrolling appends the next
 * page from the server's cursor; a refetch asks again for as many rows as are
 * loaded, so it refreshes the list without shrinking it.
 */

import { MailHeaderData } from "common";
import type { AccountsGetResponse, HeadersPageGetResponse } from "server";
import { Category, call } from "client";
import { queryClient } from "../../../lib/queryClient";
import { withoutPendingDeletes } from "./pendingDeletes";

/** Mails asked for per request. */
export const LIST_PAGE_SIZE = 100;

/** Largest refetch, matching the server's cap on `limit`. */
const MAX_REFETCH = 10_000;

interface ListPageState {
  /** Cursor of the next page; null once the last page is loaded. */
  next: string | null;
  /** A request for the next page is in flight. */
  loadingNext: boolean;
  /** The account count the list was last checked against while incomplete. */
  countBaseline?: number;
}

const states = new Map<string, ListPageState>();

const withParams = (url: string, params: Record<string, string>) =>
  url + (url.includes("?") ? "&" : "?") + new URLSearchParams(params).toString();

const requestPage = async (url: string, limit: number, cursor?: string) => {
  const params: Record<string, string> = { limit: String(limit) };
  if (cursor) params.cursor = cursor;
  const { status, body, message } = await call.get<HeadersPageGetResponse>(
    withParams(url, params)
  );
  if (status !== "success" || !body) throw new Error(message);
  return {
    mails: withoutPendingDeletes(body.headers.map((d) => new MailHeaderData(d))),
    next: body.next_cursor
  };
};

/** True while the server has rows after the loaded ones. */
export const hasNextListPage = (url: string) => !!states.get(url)?.next;

/** True once the list has been fetched and every page of it is loaded. */
export const isListComplete = (url: string) => states.get(url)?.next === null;

/**
 * The query function for a paged list: one page on the first request in this
 * session, otherwise as many rows as are already loaded.
 */
/**
 * The query function for a paged list: one page on the first request in this
 * session, otherwise as many rows as are already loaded. `countInAccounts`
 * reads the account count the list is measured against, taken when the list
 * arrives so mail that lands before the next accounts check still shows up as
 * missing.
 */
export const fetchList = async (
  url: string,
  countInAccounts?: () => number | undefined
): Promise<MailHeaderData[]> => {
  const state = states.get(url);
  const loaded = state
    ? queryClient.getQueryData<MailHeaderData[]>(url)?.length ?? 0
    : 0;
  const limit = Math.min(Math.max(LIST_PAGE_SIZE, loaded), MAX_REFETCH);
  const { mails, next } = await requestPage(url, limit);
  states.set(url, { next, loadingNext: false, countBaseline: countInAccounts?.() });
  return mails;
};

/**
 * Appends the next page to the list's query data. No-op without one or while
 * one loads. A page that arrives after the list was refetched or put back
 * (Undo) is dropped: it continues a position the list no longer ends at.
 */
export const fetchNextListPage = async (url: string): Promise<void> => {
  const state = states.get(url);
  const cursor = state?.next;
  if (!state || !cursor || state.loadingNext) return;
  state.loadingNext = true;
  try {
    const { mails, next } = await requestPage(url, LIST_PAGE_SIZE, cursor);
    if (states.get(url) !== state || state.next !== cursor) return;
    queryClient.setQueryData<MailHeaderData[]>(url, (loaded = []) => {
      const ids = new Set(loaded.map((m) => m.id));
      return [...loaded, ...mails.filter((m) => !ids.has(m.id))];
    });
    state.next = next;
  } finally {
    state.loadingNext = false;
  }
};

/** A list's paging position, to put back together with a snapshot of its data. */
export type ListPaging = { next: string | null; countBaseline?: number } | undefined;

export const snapshotListPaging = (url: string): ListPaging => {
  const state = states.get(url);
  return state && { next: state.next, countBaseline: state.countBaseline };
};

/** Restores `paging` for `url`; a next page still in flight is then dropped. */
export const restoreListPaging = (url: string, paging: ListPaging) => {
  if (paging) states.set(url, { ...paging, loadingNext: false });
};

/**
 * How many mails the account counts say the list is missing. A complete list
 * is compared with the count directly. An incomplete one is missing rows by
 * design, so only growth of the count since the list loaded (or since the
 * last check) counts as new mail.
 */
export const missingFromList = (
  url: string,
  countInAccounts: number,
  countInList: number
): number => {
  const state = states.get(url);
  if (!state || state.next === null) return countInAccounts - countInList;
  const baseline = state.countBaseline ?? countInAccounts;
  state.countBaseline = countInAccounts;
  return countInAccounts - baseline;
};

/**
 * The count the accounts payload gives for a list: received mail across every
 * account for the unified list, saved mail on either side for Saved, and the
 * account's sent or received count otherwise.
 */
export const listCountInAccounts = (
  accounts: AccountsGetResponse,
  account: string,
  category: Category,
  allAccounts: boolean
): number => {
  if (allAccounts) return accounts.received.reduce((acc, e) => acc + e.doc_count, 0);
  if (category === Category.SavedMails) {
    return (
      (accounts.received.find((e) => e.key === account)?.saved_doc_count || 0) +
      (accounts.sent.find((e) => e.key === account)?.saved_doc_count || 0)
    );
  }
  const side = category === Category.SentMails ? "sent" : "received";
  return accounts[side].find((e) => e.key === account)?.doc_count || 0;
};
