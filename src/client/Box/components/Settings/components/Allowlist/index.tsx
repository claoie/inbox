import { useState, KeyboardEventHandler } from "react";
import { useMutation, useQuery } from "react-query";

import {
  AllowlistGetResponse,
  AllowlistAddResponse,
  AllowlistAddBody,
  AllowlistDeleteResponse
} from "server";
import { call, queryClient, useIsOnline } from "client";
import {
  ALLOWLIST_PATTERN_MAX_BYTES,
  exceedsAllowlistPatternBytes,
  isValidAllowlistPattern
} from "./pattern";

import "./index.scss";

const queryUrl = "/api/mails/spam-allowlist";

const Allowlist = () => {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // The allowlist stays viewable from cache while offline, but its add/remove
  // mutations are disabled — they'd silently fail against an unreachable server.
  const { isOnline } = useIsOnline();
  const offlineTitle = isOnline
    ? undefined
    : "You're offline — reconnect to change the allowlist";

  const query = useQuery<AllowlistGetResponse>(
    queryUrl,
    async () => {
      const { status, body, message } = await call.get<AllowlistGetResponse>(
        queryUrl
      );
      if (status === "success") return body as AllowlistGetResponse;
      throw new Error(message);
    },
    { retry: false, refetchOnWindowFocus: false, refetchInterval: false }
  );

  const addMutation = useMutation(
    (pattern: string) =>
      call.post<AllowlistAddResponse, AllowlistAddBody>(queryUrl, { pattern }),
    {
      // The POST returns the created entry, so write it straight into the cache
      // instead of triggering a second GET.
      onSuccess: (res) => {
        if (res.status !== "success" || !res.body) {
          setError(res.message || "Failed to add entry.");
          return;
        }
        const entry = res.body;
        queryClient.setQueryData<AllowlistGetResponse>(queryUrl, (old) => [
          entry,
          ...(old || [])
        ]);
        setInput("");
        setError(null);
      }
    }
  );

  const deleteMutation = useMutation(
    (pattern: string) =>
      call.delete<AllowlistDeleteResponse>(
        `${queryUrl}/${encodeURIComponent(pattern)}`
      ),
    {
      onSuccess: (res, pattern) => {
        if (res.status !== "success") {
          setError(res.message || "Failed to remove entry.");
          return;
        }
        queryClient.setQueryData<AllowlistGetResponse>(queryUrl, (old) =>
          (old || []).filter((e) => e.pattern !== pattern)
        );
        setConfirmingId(null);
        setError(null);
      }
    }
  );

  const handleAdd = () => {
    // Guard the shared handler, not just the button — the input's Enter key
    // (onInputKeyDown) routes here too and would otherwise fire the POST offline.
    if (!isOnline) return;
    const pattern = input.trim();
    if (exceedsAllowlistPatternBytes(pattern)) {
      setError(`Pattern must be ${ALLOWLIST_PATTERN_MAX_BYTES} bytes or fewer.`);
      return;
    }
    if (!isValidAllowlistPattern(pattern)) {
      setError(
        "Enter an email (user@example.com) or domain wildcard (*@example.com)."
      );
      return;
    }
    setError(null);
    addMutation.mutate(pattern);
  };

  const onInputKeyDown: KeyboardEventHandler<HTMLInputElement> = (e) => {
    if (e.key === "Enter") handleAdd();
  };

  const renderBody = () => {
    if (query.isLoading) {
      return <div className="allowlist-status">Loading…</div>;
    }
    if (query.error) {
      return <div className="allowlist-status">Failed to load allowlist.</div>;
    }
    const entries = query.data || [];
    if (!entries.length) {
      return (
        <div className="allowlist-status">
          No allowlist entries yet. Add a trusted sender above.
        </div>
      );
    }
    return (
      <ul className="allowlist-entries">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className="pattern">{entry.pattern}</span>
            {confirmingId === entry.id ? (
              <span className="confirm">
                <button
                  className="text-button danger"
                  onClick={() => deleteMutation.mutate(entry.pattern)}
                  disabled={deleteMutation.isLoading || !isOnline}
                  title={offlineTitle}
                >
                  Remove
                </button>
                <button
                  className="text-button"
                  onClick={() => setConfirmingId(null)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="icon-button"
                aria-label={`Remove ${entry.pattern}`}
                title={offlineTitle || "Remove"}
                disabled={!isOnline}
                onClick={() => {
                  setError(null);
                  setConfirmingId(entry.id);
                }}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className="allowlist">
      <p className="allowlist-hint">
        Senders matching these patterns skip spam filtering when the message
        also proves it came from them. A forged sender address is still
        filtered normally.
      </p>

      <div className="allowlist-add">
        <input
          type="text"
          value={input}
          maxLength={ALLOWLIST_PATTERN_MAX_BYTES}
          placeholder="user@example.com or *@example.com"
          aria-label="Allowlist pattern"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <button
          className="text-button"
          onClick={handleAdd}
          disabled={addMutation.isLoading || !input.trim() || !isOnline}
          title={offlineTitle}
        >
          Add
        </button>
      </div>

      {error ? (
        <div className="allowlist-error" role="alert">
          {error}
        </div>
      ) : null}

      {renderBody()}
    </div>
  );
};

export default Allowlist;
