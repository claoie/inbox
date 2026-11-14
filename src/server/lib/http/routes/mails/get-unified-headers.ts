import {
  getAccounts,
  getUnifiedMailHeaders,
  getUnifiedMailHeadersDelta,
  toMailHeaderData
} from "server";
import { jsonList } from "../../respond";
import { Route } from "../route";
import type { HeadersDeltaGetResponse, HeadersGetResponse } from "./get-headers";

// The "All accounts" list (design doc §8, Phase 2 item 10): received mail
// across every alias, unread-then-recent, as conversations on the client.
// The address set comes from the accounts payload's `received` keys — the
// same set the sidebar lists — so the view is exactly the union of the
// per-account All Mails views: spam, sent, and saved stay per-account.
//
// Paging matches the per-account list: the list query returns the same
// Pagination-default window (from 0, size 10,000) and the client slices
// pages from it, so no `from`/`size` query params are read here either.
export const getUnifiedHeadersRoute = new Route<
  HeadersGetResponse | HeadersDeltaGetResponse
>(
  "GET",
  "/unified",
  async (req) => {
    const user = req.session.user!;

    const { received } = await getAccounts(user);
    const addresses = received.map((a) => a.key);

    const { since } = req.query;
    if (since !== undefined) {
      // Validate at the boundary: a malformed cursor must not silently fall
      // back to a full fetch (the client expects the delta shape) nor reach
      // the SQL layer (`updated > 'garbage'` would throw).
      if (typeof since !== "string" || Number.isNaN(Date.parse(since))) {
        return {
          status: "failed",
          message: "Invalid `since` parameter: expected an ISO timestamp."
        };
      }
      const delta = await getUnifiedMailHeadersDelta(user, addresses, since);
      return { status: "success", body: delta };
    }

    return jsonList(await getUnifiedMailHeaders(user, addresses, {}), toMailHeaderData);
  }
);
