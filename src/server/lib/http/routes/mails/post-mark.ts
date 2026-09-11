import { isUuid } from "common";
import {
  push,
  getMailBody,
  markRead,
  markSaved,
  refuseReadOnly
} from "server";
import { Route } from "../route";
import { logger } from "../../../logger";

export type MarkMailPostResponse = undefined;

export interface MarkMailPostBody {
  mail_id: string;
  read?: boolean;
  save?: boolean;
}

export const postMarkMailRoute = new Route<MarkMailPostResponse>(
  "POST",
  "/mark",
  async (req) => {
    const user = req.session.user!;

    const guard = refuseReadOnly(user, "Marking mail");
    if (!guard.ok) return { status: "failed", message: guard.message };

    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "failed", message: "Invalid request body." };
    }

    const { mail_id, read, save } = body as Record<string, unknown>;

    if (!isUuid(mail_id)) {
      return { status: "failed", message: "mail_id must be a valid id" };
    }

    const mail = await getMailBody(user.id, mail_id);

    if (!mail) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    // A DB fault now propagates to the route boundary (500), so a `false` here
    // means the row genuinely stopped matching between the check above and the
    // write — report it rather than answering success for a write that never
    // landed, or, for `read`, decrementing the badge for a mail that stayed
    // unread.
    if (read === true) {
      if (!(await markRead(user.id, mail_id))) {
        return { status: "failed", message: "Failed to mark the mail read" };
      }
      push
        .decrementBadgeCount([user])
        .catch((error) =>
          logger.error("Failed to decrement badge count", {}, error)
        );
    }

    if (typeof save === "boolean") {
      if (!(await markSaved(user.id, mail_id, save))) {
        return { status: "failed", message: "Failed to update the saved flag" };
      }
    }

    return { status: "success" };
  }
);
