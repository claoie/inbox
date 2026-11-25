import { useCallback } from "react";
import { QueryClient, useQueryClient } from "react-query";
import { useFeedback } from "client";
import { accountsQueryUrl } from "client/Box/components/Accounts";

/**
 * The server's answer to a write. A refusal comes back as HTTP 200 with a
 * failed status, so only `status` says whether the write landed.
 */
export interface WriteOutcome {
  status: string;
  message?: string;
}

export const REFUSED_FALLBACK = "That change wasn't saved.";

/** The first refusal's message among `outcomes`, or null when every write landed. */
export const refusalMessage = (outcomes: WriteOutcome[]) => {
  const refused = outcomes.find((o) => o.status !== "success");
  return refused ? refused.message || REFUSED_FALLBACK : null;
};

const isMailDataKey = (key: unknown) =>
  typeof key === "string" &&
  (key.startsWith("/api/mails/") || key === accountsQueryUrl);

/** Puts every mail list, conversation and count back to what the server holds. */
export const refetchMailData = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({
    predicate: ({ queryKey }) => isMailDataKey(queryKey)
  });

/**
 * Watches writes whose effect is already on screen. When any is refused,
 * refetches so the screen shows what the server holds, and tells the user
 * why — once per batch. Resolves to whether every write landed.
 */
export const useRefusedWrites = () => {
  const queryClient = useQueryClient();
  const { showToast } = useFeedback();
  return useCallback(
    (requests: Promise<WriteOutcome>[]) =>
      Promise.all(requests).then((outcomes) => {
        const message = refusalMessage(outcomes);
        if (message === null) return true;
        refetchMailData(queryClient);
        showToast({ message, tone: "error" });
        return false;
      }),
    [queryClient, showToast]
  );
};
