import { removeAllowlistEntry, refuseReadOnly } from "server";
import { Route } from "../route";

export type AllowlistDeleteResponse = undefined;

/**
 * Remove an entry from the user's spam allowlist.
 */
export const deleteSpamAllowlistRoute = new Route<AllowlistDeleteResponse>(
  "DELETE",
  "/spam-allowlist/:pattern",
  async (req) => {
    const user = req.session.user!;

    const guard = refuseReadOnly(user, "Removing from the spam allowlist");
    if (!guard.ok) return { status: "failed", message: guard.message };

    const pattern = req.params.pattern;
    const removed = await removeAllowlistEntry(user.id, pattern);

    if (!removed) {
      return { status: "failed", message: "Entry not found" };
    }

    return { status: "success" };
  }
);
