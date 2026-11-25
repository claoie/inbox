import {
  addClaim,
  deleteClaim,
  deleteOwnedDomain,
  findDomain,
  getClaim,
  getDomainAccess,
  grantViewer,
  listClaims,
  listDomainAccess,
  listDomainViewers,
  promoteClaim,
  revokeRole,
  type DomainAccess,
  type DomainClaim,
} from "../../../postgres/repositories/domains";
import { findUserByUsername } from "../../../postgres/repositories/users";
import { DOMAIN_COUNT_MAX, DOMAIN_VIEWER_COUNT_MAX, type DomainRole } from "../../../postgres/models";
import {
  checkVerificationRecord,
  isInServedZone,
  newVerificationToken,
  normalizeDomainName,
  servedZone,
  verificationRecord,
} from "../../../domains";
import { logger } from "../../../logger";
import { Route } from "../route";

/** A domain as its owner or a viewer sees it in Settings. */
export interface DomainEntry {
  name: string;
  role: DomainRole;
  /** The owner's username. */
  owner: string;
  /** True for an account's own name under the served zone, which the server assigns. */
  managedByServer: boolean;
  /** When its DNS record was proved; null for a domain the server assigned. */
  verifiedAt: string | null;
  /** The people with the viewer role on it; listed to its owner only. */
  viewers?: string[];
}

/** A domain someone added and has not proved yet, with the record that proves it. */
export interface DomainClaimEntry {
  name: string;
  record: { type: "TXT"; host: string; value: string };
  createdAt: string;
}

export interface DomainsGetResponse {
  /** The served zone: every account receives mail at `<username>.<zone>`. */
  zone: string;
  domains: DomainEntry[];
  claims: DomainClaimEntry[];
}

const toClaimEntry = (claim: DomainClaim): DomainClaimEntry => ({
  name: claim.name,
  record: verificationRecord(claim.name, claim.token),
  createdAt: claim.createdAt,
});

const toDomainEntry = async (access: DomainAccess): Promise<DomainEntry> => ({
  name: access.name,
  role: access.role,
  owner: access.ownerUsername,
  managedByServer: isInServedZone(access.name),
  verifiedAt: access.verifiedAt,
  ...(access.role === "owner"
    ? { viewers: (await listDomainViewers(access.domainId)).map((viewer) => viewer.username) }
    : {}),
});

const bodyOf = (body: unknown): Record<string, unknown> =>
  body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

export const getDomainsRoute = new Route<DomainsGetResponse>("GET", "/", async (req) => {
  const user = req.session.user!;
  const [access, claims] = await Promise.all([listDomainAccess(user.id), listClaims(user.id)]);
  return {
    status: "success",
    body: {
      zone: servedZone(),
      domains: await Promise.all(access.map(toDomainEntry)),
      claims: claims.map(toClaimEntry),
    },
  };
});

/**
 * Adds a domain the user wants to receive and send mail for. Nothing changes
 * until the DNS record the response names is published and verified: the
 * claim is the user's own, and a claim nobody can prove blocks no one.
 */
export const postDomainRoute = new Route<DomainClaimEntry>("POST", "/", async (req) => {
  const user = req.session.user!;
  const name = normalizeDomainName(bodyOf(req.body).name);
  if (!name) return { status: "failed", message: "Enter a domain name, such as example.com." };
  if (isInServedZone(name)) {
    return {
      status: "failed",
      message: `${name} is part of ${servedZone()}, which this server assigns to accounts itself.`,
    };
  }
  const existing = await findDomain(name);
  if (existing?.ownerId === user.id) {
    return { status: "failed", message: `You already own ${name}.` };
  }
  const result = await addClaim(user.id, name, newVerificationToken());
  if (result.status === "at_limit") {
    return {
      status: "failed",
      message: `You can have at most ${DOMAIN_COUNT_MAX} domains, counting the ones not verified yet.`,
    };
  }
  return { status: "success", body: toClaimEntry(result.claim) };
});

/**
 * Checks a claim's DNS record and, when it is published, makes the user the
 * domain's owner. A domain someone else owned moves to the user: whoever
 * controls the domain's DNS decides who receives its mail.
 */
export const postVerifyDomainRoute = new Route<DomainEntry>("POST", "/verify", async (req) => {
  const user = req.session.user!;
  const name = normalizeDomainName(bodyOf(req.body).name);
  const claim = name ? await getClaim(user.id, name) : null;
  if (!name || !claim) return { status: "failed", message: "Add the domain first." };

  const check = await checkVerificationRecord(name, claim.token);
  if (check === "unavailable") {
    return { status: "failed", message: "DNS could not be reached. Try again in a minute." };
  }
  if (check === "missing") {
    const { host, value } = verificationRecord(name, claim.token);
    return {
      status: "failed",
      message: `No TXT record ${host} with the value ${value} was found yet. DNS changes can take a while to show up.`,
    };
  }

  const promoted = await promoteClaim(user.id, name, claim.token);
  if (promoted.status === "missing") {
    return { status: "failed", message: "This domain's verification changed. Reload and try again." };
  }
  if (promoted.previousOwnerId) {
    logger.info("A verified domain moved to a new owner", {
      domain: name,
      previousOwnerId: promoted.previousOwnerId,
      ownerId: user.id,
    });
  }
  const access = await getDomainAccess(user.id, name);
  if (!access) return { status: "failed", message: "This domain could not be read back." };
  return { status: "success", body: await toDomainEntry(access) };
});

/**
 * Removes a domain the user added: a claim not verified yet, or a domain they
 * own. Its mail stays with them; new mail to it is no longer received. An
 * account's own name under the served zone cannot be removed.
 */
export const deleteDomainRoute = new Route<undefined>("DELETE", "/:name", async (req) => {
  const user = req.session.user!;
  const name = normalizeDomainName(req.params.name);
  if (!name) return { status: "failed", message: "Not a domain name." };
  if (await deleteClaim(user.id, name)) return { status: "success" };
  if (isInServedZone(name)) {
    return { status: "failed", message: `${name} is assigned by this server and cannot be removed.` };
  }
  if (await deleteOwnedDomain(user.id, name)) return { status: "success" };
  return { status: "failed", message: `You don't own ${name}.` };
});

/** The domain `name` when the user owns it, for the role-management routes. */
const ownedDomain = async (userId: string, rawName: unknown) => {
  const name = normalizeDomainName(rawName);
  const access = name ? await getDomainAccess(userId, name) : null;
  return access?.role === "owner" ? access : null;
};

/**
 * Gives a person the viewer role on a domain the user owns: they read its
 * mail, read-only, and never send as it. Anyone who reads a domain reads the
 * sign-up and password-reset mail sent to it too, which is why such
 * addresses are refused by those flows from then on.
 */
export const postViewerRoute = new Route<DomainEntry>("POST", "/viewers", async (req) => {
  const user = req.session.user!;
  const body = bodyOf(req.body);
  const domain = await ownedDomain(user.id, body.name);
  if (!domain) return { status: "failed", message: "You can only share a domain you own." };
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const viewer = username ? await findUserByUsername(username) : null;
  if (!viewer || viewer.is_deleted || (viewer.password === null && viewer.auth_sub === null)) {
    return { status: "failed", message: `There is no account named ${username || "that"}.` };
  }
  if (viewer.user_id === user.id) {
    return { status: "failed", message: "You already own this domain." };
  }
  const result = await grantViewer(domain.domainId, user.id, viewer.user_id);
  if (result === "not_owner") {
    return { status: "failed", message: "You can only share a domain you own." };
  }
  if (result === "at_limit") {
    return {
      status: "failed",
      message: `A domain can have at most ${DOMAIN_VIEWER_COUNT_MAX} viewers.`,
    };
  }
  logger.info("Granted the viewer role on a domain", {
    domain: domain.name,
    viewer: viewer.username,
    grantedBy: user.username,
  });
  return { status: "success", body: await toDomainEntry(domain) };
});

/**
 * Takes the viewer role away. Their web requests stop reading the domain at
 * once, and an IMAP session scoped to it ends at its next command.
 */
export const deleteViewerRoute = new Route<DomainEntry>(
  "DELETE",
  "/viewers/:name/:username",
  async (req) => {
    const user = req.session.user!;
    const domain = await ownedDomain(user.id, req.params.name);
    if (!domain) return { status: "failed", message: "You can only manage a domain you own." };
    const viewer = await findUserByUsername(req.params.username);
    if (viewer) {
      await revokeRole(domain.domainId, viewer.user_id);
      logger.info("Revoked the viewer role on a domain", {
        domain: domain.name,
        viewer: viewer.username,
        revokedBy: user.username,
      });
    }
    return { status: "success", body: await toDomainEntry(domain) };
  }
);
