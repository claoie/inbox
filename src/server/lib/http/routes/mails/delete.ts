import { isUuid } from "common";
import { getMailBody, deleteMail, refuseReadOnly } from "server";
import { Route } from "../route";

export type MailDeleteResponse = undefined;

export const deleteMailRoute = new Route<MailDeleteResponse>(
  "DELETE",
  "/:id",
  async (req) => {
    const user = req.session.user!;

    const guard = refuseReadOnly(user, "Deleting mail");
    if (!guard.ok) return { status: "failed", message: guard.message };

    const mailId = req.params.id;

    if (!isUuid(mailId)) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    const data = await getMailBody(user.id, mailId);

    if (!data) {
      return {
        status: "failed",
        message: "Invalid request. You may not manipulate other users' email"
      };
    }

    // Deliberately not gated on the return value. A DB fault now throws, so
    // `false` here means only that the row disappeared between the check above
    // and the delete — a concurrent delete that reached the same end state the
    // caller asked for. Reporting that as a failure would be a lie in the
    // other direction.
    await deleteMail(user.id, mailId);
    return { status: "success" };
  }
);
