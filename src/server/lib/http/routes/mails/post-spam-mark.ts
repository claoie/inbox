import { isUuid } from "common";
import { markSpam, refuseReadOnly } from "server";
import { getMailById } from "server/lib/postgres/repositories/mails";
import { trainWithEmail } from "server/lib/spam/classifier";
import { Route } from "../route";
import { logger } from "../../../logger";

export type SpamMarkPostResponse = undefined;

export interface SpamMarkPostBody {
  mail_id: string;
  is_spam: boolean;
}

/**
 * Mark or unmark an email as spam.
 *
 * In addition to updating the is_spam flag, this route trains the per-user
 * Naive Bayes classifier with the email content so future similar emails
 * are automatically detected.
 *
 * Authorization is enforced at the repository layer via user_id in WHERE clause.
 */
export const postMarkSpamMailRoute = new Route<SpamMarkPostResponse>(
  "POST",
  "/spam/mark",
  async (req) => {
    const user = req.session.user!;

    const guard = refuseReadOnly(user, "Marking spam");
    if (!guard.ok) return { status: "failed", message: guard.message };

    const body: SpamMarkPostBody = req.body;
    const { mail_id, is_spam } = body;

    if (typeof is_spam !== "boolean") {
      return { status: "failed", message: "is_spam must be a boolean" };
    }

    if (!isUuid(mail_id)) {
      return {
        status: "failed",
        message: "Mail not found or you don't have permission"
      };
    }

    const { found, changed } = await markSpam(user.id, mail_id, is_spam);

    if (!found) {
      return {
        status: "failed",
        message: "Mail not found or you don't have permission"
      };
    }

    // Only train when is_spam actually flipped. Re-marking with the same value
    // (idempotent click / retry / fat-finger toggle) must not re-train — one
    // training sample per user action per mail, not one per HTTP call.
    if (changed) {
      getMailById(user.id, mail_id)
        .then((mail) => {
          if (!mail) return;
          const emailContext = {
            subject: mail.subject ?? undefined,
            text: mail.text ?? undefined,
            html: mail.html ?? undefined,
            fromAddress: Array.isArray(mail.from_address) && mail.from_address.length > 0
              ? (mail.from_address[0] as { address?: string }).address
              : undefined,
          };
          return trainWithEmail(user.id, emailContext, is_spam);
        })
        .catch((error) => {
          logger.warn("[SpamFilter] Classifier training failed for feedback", { mail_id }, error);
        });
    }

    return { status: "success" };
  }
);
