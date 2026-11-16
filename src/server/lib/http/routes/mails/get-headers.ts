import { MailHeaderDataType } from "common";
import {
  getMailHeaders,
  getMailHeaderPage,
  getMailHeadersDelta,
  toMailHeaderData,
  addressToUsername,
  GetMailsOptions
} from "server";
import { jsonList } from "../../respond";
import { Route } from "../route";
import { encodeListCursor, ListPageResponse, parseListPageParams } from "./list-page";

// Full-list response (no `?since=`, no `?limit=`). Unchanged shape — old clients keep working.
export type HeadersGetResponse = MailHeaderDataType[];

export type HeadersPageGetResponse = ListPageResponse<MailHeaderDataType>;

export interface HeadersDeltaGetResponse {
  as_of: string;
  headers: MailHeaderDataType[];
  expunged_ids: string[];
}

export const getHeadersRoute = new Route<
  HeadersGetResponse | HeadersDeltaGetResponse | HeadersPageGetResponse
>(
  "GET",
  "/headers/:account",
  async (req) => {
    const user = req.session.user!;

    const { username } = user;
    const usernameInAccount = addressToUsername(req.params.account);
    const valid = ["admin", usernameInAccount].includes(username);

    if (!valid) {
      return {
        status: "failed",
        message: "Invalid request. You may not look at other users' emails."
      };
    }

    const options: GetMailsOptions = {
      sent: !!req.query.sent,
      saved: !!req.query.saved,
      spam: !!req.query.spam
    };

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
      const delta = await getMailHeadersDelta(
        user,
        req.params.account,
        options,
        since
      );
      return { status: "success", body: delta };
    }

    const pageParams = parseListPageParams(req.query);
    if ("error" in pageParams) return { status: "failed", message: pageParams.error };
    if (pageParams.paged) {
      const { batches, next } = await getMailHeaderPage(
        user,
        req.params.account,
        options,
        pageParams.limit,
        pageParams.after
      );
      return jsonList(batches, toMailHeaderData, {
        listKey: "headers",
        fields: { next_cursor: encodeListCursor(next) }
      });
    }

    return jsonList(await getMailHeaders(user, req.params.account, options), toMailHeaderData);
  }
);
