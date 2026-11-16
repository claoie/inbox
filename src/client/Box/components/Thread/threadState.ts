import { QueryClient } from "react-query";
import { MailHeaderData } from "common";
import { accountsQueryUrl } from "client/Box/components/Accounts";
import { restoreListPaging, snapshotListPaging } from "../Mails/listPages";

export const threadQueryUrl = (mailId: string) => `/api/mails/thread/${mailId}`;

/** Whether a react-query key belongs to a mail list (a folder or search). */
const isListKey = (key: unknown) =>
  typeof key === "string" &&
  (key.startsWith("/api/mails/headers/") || key.startsWith("/api/mails/search/"));

const isThreadKey = (key: unknown) =>
  typeof key === "string" && key.startsWith("/api/mails/thread/");

/**
 * The messages shown open when a conversation is first displayed: the one
 * that was opened, the newest, and any still unread — the ones a reader came
 * for. Everything else starts as a one-line summary.
 */
export const initialExpanded = (
  thread: MailHeaderData[],
  openedId: string
): Set<string> => {
  const ids = new Set<string>();
  if (!thread.length) return ids;
  ids.add(openedId);
  ids.add(thread[thread.length - 1].id);
  thread.forEach((m) => {
    if (!m.read) ids.add(m.id);
  });
  return ids;
};

/** A run of collapsed messages long enough to fold into "N more". */
export const FOLD_THRESHOLD = 3;

export type ThreadItem =
  | { kind: "message"; mail: MailHeaderData }
  | { kind: "fold"; ids: string[] };

/**
 * The page's rows: open and collapsed messages in order, with a run of
 * `FOLD_THRESHOLD` or more collapsed messages between the first and the last
 * shown as one "N more messages" row instead.
 */
export const threadItems = (
  thread: MailHeaderData[],
  expanded: Set<string>
): ThreadItem[] => {
  const items: ThreadItem[] = [];
  let run: MailHeaderData[] = [];
  const flush = () => {
    if (run.length >= FOLD_THRESHOLD) {
      items.push({ kind: "fold", ids: run.map((m) => m.id) });
    } else {
      run.forEach((mail) => items.push({ kind: "message", mail }));
    }
    run = [];
  };
  thread.forEach((mail, i) => {
    const isEdge = i === 0 || i === thread.length - 1;
    if (!expanded.has(mail.id) && !isEdge) {
      run.push(mail);
      return;
    }
    flush();
    items.push({ kind: "message", mail });
  });
  flush();
  return items;
};

/** Marks `ids` read in every cached thread and list. */
export const markReadInCaches = (queryClient: QueryClient, ids: string[]) => {
  if (!ids.length) return;
  const wanted = new Set(ids);
  queryClient
    .getQueryCache()
    .findAll()
    .forEach(({ queryKey }) => {
      if (!isListKey(queryKey) && !isThreadKey(queryKey)) return;
      queryClient.setQueryData<MailHeaderData[] | undefined>(queryKey, (data) =>
        Array.isArray(data)
          ? data.map((m) =>
              wanted.has(m.id) && !m.read
                ? new MailHeaderData({ ...m, read: true })
                : m
            )
          : data
      );
    });
  queryClient.invalidateQueries(accountsQueryUrl);
};

/** Applies `update` to `id` in every cached thread and list it appears in. */
export const updateMailInCaches = (
  queryClient: QueryClient,
  id: string,
  update: (mail: MailHeaderData) => MailHeaderData | null
) => {
  queryClient
    .getQueryCache()
    .findAll()
    .forEach(({ queryKey }) => {
      if (!isListKey(queryKey) && !isThreadKey(queryKey)) return;
      queryClient.setQueryData<MailHeaderData[] | undefined>(queryKey, (data) =>
        Array.isArray(data)
          ? data.flatMap((m) => {
              if (m.id !== id) return [m];
              const next = update(m);
              return next ? [next] : [];
            })
          : data
      );
    });
};

/** Every cached list and thread, with each list's paging position, for Undo to put back. */
export const snapshotCaches = (queryClient: QueryClient) =>
  queryClient
    .getQueryCache()
    .findAll()
    .filter(
      ({ queryKey }) =>
        isListKey(queryKey) ||
        isThreadKey(queryKey) ||
        queryKey === accountsQueryUrl
    )
    .map(
      ({ queryKey }) =>
        [
          queryKey,
          queryClient.getQueryData(queryKey),
          typeof queryKey === "string" ? snapshotListPaging(queryKey) : undefined
        ] as const
    );

export const restoreCaches = (
  queryClient: QueryClient,
  snapshot: ReturnType<typeof snapshotCaches>
) =>
  snapshot.forEach(([key, data, paging]) => {
    queryClient.setQueryData(key, data);
    if (typeof key === "string") restoreListPaging(key, paging);
  });

/** Refetch lists, threads and counts after a change the server owns. */
export const refreshMailQueries = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({
    predicate: ({ queryKey }) =>
      isListKey(queryKey) ||
      isThreadKey(queryKey) ||
      queryKey === accountsQueryUrl
  });
