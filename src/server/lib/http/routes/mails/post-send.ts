import { MailDataToSend, MailDataToSendType } from "common";
import {
  sendMail,
  MailValidationError,
  MailSendingError,
  refuseReadOnly,
} from "server";
import { Route } from "../route";

export type SendMailPostResponse =
  | { status: "success" }
  | { status: "failed"; message: string };

export type SendMailPostBody = MailDataToSendType;

export const postSendMailRoute = new Route<SendMailPostResponse>(
  "POST",
  "/send",
  async (req) => {
    const user = req.session.user!;

    const guard = refuseReadOnly(user, "Sending mail");
    if (!guard.ok) return { status: "failed", message: guard.message };

    const body: SendMailPostBody = req.body;
    const attachments = req.files?.attachments;

    try {
      await sendMail(user, new MailDataToSend({ ...body }), attachments);
      return { status: "success" };
    } catch (error) {
      if (error instanceof MailValidationError || error instanceof MailSendingError) {
        return { status: "failed", message: error.message };
      }
      throw error;
    }
  }
);
