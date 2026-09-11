import { addAllowlistEntry, refuseReadOnly } from "server";
import { Route } from "../route";
import { AllowlistEntryResponse } from "./get-allowlist";

export interface AllowlistAddBody {
  pattern: string;
}

export type AllowlistAddResponse = AllowlistEntryResponse | null;

/**
 * Add an entry to the user's spam allowlist.
 * Pattern can be exact email (user@example.com) or domain wildcard (*@example.com).
 */
export const postSpamAllowlistRoute = new Route<AllowlistAddResponse>(
  "POST",
  "/spam-allowlist",
  async (req) => {
    const user = req.session.user!;

    const guard = refuseReadOnly(user, "Adding to the spam allowlist");
    if (!guard.ok) return { status: "failed", message: guard.message };

    const body: AllowlistAddBody = req.body;
    const { pattern } = body;

    if (!pattern || typeof pattern !== "string") {
      return { status: "failed", message: "pattern is required" };
    }

    // Validate pattern format
    const isExactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pattern);
    const isDomainWildcard = /^\*@[^\s@]+\.[^\s@]+$/.test(pattern);

    if (!isExactEmail && !isDomainWildcard) {
      return {
        status: "failed",
        message: "Pattern must be an email address (user@example.com) or domain wildcard (*@example.com)"
      };
    }

    const entry = await addAllowlistEntry(user.id, pattern);
    
    if (!entry) {
      return { status: "failed", message: "Entry already exists" };
    }

    return {
      status: "success",
      body: {
        id: entry.allowlist_id,
        pattern: entry.pattern,
        createdAt: entry.created_at
      }
    };
  }
);
