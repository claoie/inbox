/**
 * The domain routes: adding a domain, proving it with its DNS record,
 * removing it, and sharing it read-only. The repositories are spied, so the
 * assertions are on what each route asks of them and what it answers.
 */
import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { HttpRequest } from "../../request";
import type { ApiResponse } from "../route";
import * as domainRepo from "../../../postgres/repositories/domains";
import * as userRepo from "../../../postgres/repositories/users";
import { setTxtResolver, type TxtResolver } from "../../../domains";
import { UserModel } from "../../../postgres/models";
import {
  deleteDomainRoute,
  deleteViewerRoute,
  getDomainsRoute,
  postDomainRoute,
  postVerifyDomainRoute,
  postViewerRoute,
  type DomainClaimEntry,
  type DomainEntry,
  type DomainsGetResponse,
} from "./routes";

const spies = {
  listDomainAccess: spyOn(domainRepo, "listDomainAccess"),
  listClaims: spyOn(domainRepo, "listClaims"),
  listDomainViewers: spyOn(domainRepo, "listDomainViewers"),
  findDomain: spyOn(domainRepo, "findDomain"),
  addClaim: spyOn(domainRepo, "addClaim"),
  getClaim: spyOn(domainRepo, "getClaim"),
  promoteClaim: spyOn(domainRepo, "promoteClaim"),
  getDomainAccess: spyOn(domainRepo, "getDomainAccess"),
  deleteClaim: spyOn(domainRepo, "deleteClaim"),
  deleteOwnedDomain: spyOn(domainRepo, "deleteOwnedDomain"),
  grantViewer: spyOn(domainRepo, "grantViewer"),
  revokeRole: spyOn(domainRepo, "revokeRole"),
  findUserByUsername: spyOn(userRepo, "findUserByUsername"),
};

let txtRecords: string[][] | Error = [];
const previousResolver: TxtResolver = setTxtResolver(async () => {
  if (txtRecords instanceof Error) throw txtRecords;
  return txtRecords;
});

const originalDomain = process.env.EMAIL_DOMAIN;
process.env.EMAIL_DOMAIN = "example.com";

afterAll(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
  setTxtResolver(previousResolver);
  if (originalDomain === undefined) delete process.env.EMAIL_DOMAIN;
  else process.env.EMAIL_DOMAIN = originalDomain;
});

const USER = { id: "u-alice", username: "alice", email: "alice@example.org" };

const req = (overrides: Record<string, unknown> = {}) =>
  ({
    method: "POST",
    session: { user: USER },
    params: {},
    query: {},
    body: {},
    ...overrides,
  }) as unknown as HttpRequest;

const access = (overrides: Partial<domainRepo.DomainAccess> = {}): domainRepo.DomainAccess => ({
  domainId: "d-1",
  name: "example.org",
  ownerId: USER.id,
  ownerUsername: "alice",
  role: "owner",
  verifiedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const account = (username: string, columns: Record<string, unknown> = {}) =>
  new UserModel({
    user_id: `u-${username}`,
    username,
    password: "$2b$10$x",
    password_version: 1,
    email: null,
    expiry: null,
    token: null,
    updated: null,
    is_deleted: false,
    imap_uid_validity: null,
    auth_sub: null,
    ...columns,
  });

const CLAIM: domainRepo.DomainClaim = {
  name: "example.org",
  token: "tok",
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  for (const spy of Object.values(spies)) spy.mockReset();
  spies.listDomainViewers.mockResolvedValue([]);
  spies.findDomain.mockResolvedValue(null);
  spies.listClaims.mockResolvedValue([]);
  txtRecords = [];
});

describe("GET /api/domains", () => {
  it("lists owned and viewed domains, viewers to the owner only, and pending claims with their record", async () => {
    spies.listDomainAccess.mockResolvedValue([
      access({ name: "alice.example.com", verifiedAt: null }),
      access({ domainId: "d-2", name: "example.org" }),
      access({ domainId: "d-3", name: "example.net", role: "viewer", ownerId: "u-o", ownerUsername: "owen" }),
    ]);
    spies.listDomainViewers.mockImplementation(async (domainId) =>
      domainId === "d-2" ? [{ userId: "u-bob", username: "bob", role: "viewer" }] : []
    );
    spies.listClaims.mockResolvedValue([{ ...CLAIM, name: "example.info" }]);

    const result = (await getDomainsRoute.callback(req({ method: "GET" }))) as ApiResponse<DomainsGetResponse>;

    expect(result.status).toBe("success");
    const body = result.body!;
    expect(body.zone).toBe("example.com");
    expect(body.domains.map((d) => [d.name, d.role, d.managedByServer, d.viewers])).toEqual([
      ["alice.example.com", "owner", true, []],
      ["example.org", "owner", false, ["bob"]],
      ["example.net", "viewer", false, undefined],
    ]);
    // A viewer is never told who else views the domain.
    expect(spies.listDomainViewers).not.toHaveBeenCalledWith("d-3");
    expect(body.claims).toEqual([
      {
        name: "example.info",
        record: { type: "TXT", host: "_mail-verification.example.info", value: "mail-verification=tok" },
        createdAt: CLAIM.createdAt,
      },
    ]);
  });
});

describe("POST /api/domains", () => {
  it("records a claim on a normalized name and answers the record that proves it", async () => {
    spies.addClaim.mockResolvedValue({ status: "created", claim: CLAIM });

    const result = (await postDomainRoute.callback(
      req({ body: { name: " Example.ORG. " } })
    )) as ApiResponse<DomainClaimEntry>;

    expect(result.status).toBe("success");
    expect(spies.addClaim.mock.calls[0]?.slice(0, 2)).toEqual([USER.id, "example.org"]);
    // A fresh, unguessable token per claim.
    expect(spies.addClaim.mock.calls[0]?.[2]).toMatch(/^[0-9a-f]{48}$/);
    expect(result.body!.record.host).toBe("_mail-verification.example.org");
  });

  it("refuses a name under the served zone, which the server assigns itself", async () => {
    for (const name of ["example.com", "bob.example.com"]) {
      const result = (await postDomainRoute.callback(req({ body: { name } }))) as ApiResponse<unknown>;
      expect(result.status).toBe("failed");
    }
    expect(spies.addClaim).not.toHaveBeenCalled();
  });

  it("refuses what is not a domain name, and a domain the user already owns", async () => {
    expect(((await postDomainRoute.callback(req({ body: { name: "not a domain" } }))) as ApiResponse<unknown>).status).toBe("failed");
    spies.findDomain.mockResolvedValue({ domainId: "d-1", name: "example.org", ownerId: USER.id });
    expect(((await postDomainRoute.callback(req({ body: { name: "example.org" } }))) as ApiResponse<unknown>).status).toBe("failed");
    expect(spies.addClaim).not.toHaveBeenCalled();
  });

  it("accepts a claim on a domain someone else owns: DNS decides at verification", async () => {
    spies.findDomain.mockResolvedValue({ domainId: "d-1", name: "example.org", ownerId: "u-other" });
    spies.addClaim.mockResolvedValue({ status: "created", claim: CLAIM });
    const result = (await postDomainRoute.callback(req({ body: { name: "example.org" } }))) as ApiResponse<unknown>;
    expect(result.status).toBe("success");
  });

  it("refuses past the ceiling", async () => {
    spies.addClaim.mockResolvedValue({ status: "at_limit" });
    const result = (await postDomainRoute.callback(req({ body: { name: "example.org" } }))) as ApiResponse<unknown>;
    expect(result.status).toBe("failed");
  });
});

describe("POST /api/domains/verify", () => {
  it("promotes the claim once its record is published", async () => {
    spies.getClaim.mockResolvedValue(CLAIM);
    txtRecords = [["mail-verification=tok"]];
    spies.promoteClaim.mockResolvedValue({ status: "verified", previousOwnerId: null });
    spies.getDomainAccess.mockResolvedValue(access());

    const result = (await postVerifyDomainRoute.callback(
      req({ body: { name: "example.org" } })
    )) as ApiResponse<DomainEntry>;

    expect(result.status).toBe("success");
    // Promoted on the token that was checked, not on whatever the claim holds later.
    expect(spies.promoteClaim).toHaveBeenCalledWith(USER.id, "example.org", "tok");
    expect(result.body!.role).toBe("owner");
  });

  it("promotes nothing while the record is missing, and says what to publish", async () => {
    spies.getClaim.mockResolvedValue(CLAIM);
    txtRecords = [["mail-verification=other"]];

    const result = (await postVerifyDomainRoute.callback(
      req({ body: { name: "example.org" } })
    )) as ApiResponse<unknown>;

    expect(result.status).toBe("failed");
    expect(result.message).toContain("_mail-verification.example.org");
    expect(spies.promoteClaim).not.toHaveBeenCalled();
  });

  it("promotes nothing when DNS cannot be asked", async () => {
    spies.getClaim.mockResolvedValue(CLAIM);
    txtRecords = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });

    const result = (await postVerifyDomainRoute.callback(
      req({ body: { name: "example.org" } })
    )) as ApiResponse<unknown>;

    expect(result.status).toBe("failed");
    expect(spies.promoteClaim).not.toHaveBeenCalled();
  });

  it("refuses a name the user never claimed", async () => {
    spies.getClaim.mockResolvedValue(null);
    const result = (await postVerifyDomainRoute.callback(req({ body: { name: "example.org" } }))) as ApiResponse<unknown>;
    expect(result.status).toBe("failed");
    expect(spies.promoteClaim).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/domains/:name", () => {
  it("removes a pending claim first", async () => {
    spies.deleteClaim.mockResolvedValue(true);
    const result = (await deleteDomainRoute.callback(
      req({ method: "DELETE", params: { name: "example.org" } })
    )) as ApiResponse<unknown>;
    expect(result.status).toBe("success");
    expect(spies.deleteOwnedDomain).not.toHaveBeenCalled();
  });

  it("removes a domain the user owns, but never one the server assigned", async () => {
    spies.deleteClaim.mockResolvedValue(false);
    spies.deleteOwnedDomain.mockResolvedValue(true);
    const removed = (await deleteDomainRoute.callback(
      req({ method: "DELETE", params: { name: "example.org" } })
    )) as ApiResponse<unknown>;
    expect(removed.status).toBe("success");
    expect(spies.deleteOwnedDomain).toHaveBeenCalledWith(USER.id, "example.org");

    spies.deleteOwnedDomain.mockClear();
    const own = (await deleteDomainRoute.callback(
      req({ method: "DELETE", params: { name: "alice.example.com" } })
    )) as ApiResponse<unknown>;
    expect(own.status).toBe("failed");
    expect(spies.deleteOwnedDomain).not.toHaveBeenCalled();
  });
});

describe("sharing a domain read-only", () => {
  it("grants an existing account the viewer role on a domain the user owns", async () => {
    spies.getDomainAccess.mockResolvedValue(access());
    spies.findUserByUsername.mockResolvedValue(account("bob"));
    spies.grantViewer.mockResolvedValue("granted");

    const result = (await postViewerRoute.callback(
      req({ body: { name: "example.org", username: "bob" } })
    )) as ApiResponse<DomainEntry>;

    expect(result.status).toBe("success");
    expect(spies.getDomainAccess).toHaveBeenCalledWith(USER.id, "example.org");
    expect(spies.grantViewer).toHaveBeenCalledWith("d-1", USER.id, "u-bob");
  });

  it("refuses the share when the domain changed owner before the grant was written", async () => {
    spies.getDomainAccess.mockResolvedValue(access());
    spies.findUserByUsername.mockResolvedValue(account("bob"));
    spies.grantViewer.mockResolvedValue("not_owner");

    const result = (await postViewerRoute.callback(
      req({ body: { name: "example.org", username: "bob" } })
    )) as ApiResponse<unknown>;

    expect(result.status).toBe("failed");
    expect(result.message).toBe("You can only share a domain you own.");
  });

  it("refuses to share a domain the user only views", async () => {
    spies.getDomainAccess.mockResolvedValue(access({ role: "viewer", ownerId: "u-o" }));
    const result = (await postViewerRoute.callback(
      req({ body: { name: "example.org", username: "bob" } })
    )) as ApiResponse<unknown>;
    expect(result.status).toBe("failed");
    expect(spies.grantViewer).not.toHaveBeenCalled();
  });

  it("refuses an account that cannot sign in, or none at all", async () => {
    spies.getDomainAccess.mockResolvedValue(access());
    for (const row of [null, account("bob", { is_deleted: true }), account("bob", { password: null })]) {
      spies.findUserByUsername.mockResolvedValue(row);
      const result = (await postViewerRoute.callback(
        req({ body: { name: "example.org", username: "bob" } })
      )) as ApiResponse<unknown>;
      expect(result.status).toBe("failed");
    }
    expect(spies.grantViewer).not.toHaveBeenCalled();
  });

  it("takes the role away from a domain the user owns", async () => {
    spies.getDomainAccess.mockResolvedValue(access());
    spies.findUserByUsername.mockResolvedValue(account("bob"));
    const result = (await deleteViewerRoute.callback(
      req({ method: "DELETE", params: { name: "example.org", username: "bob" } })
    )) as ApiResponse<unknown>;
    expect(result.status).toBe("success");
    expect(spies.revokeRole).toHaveBeenCalledWith("d-1", "u-bob");
  });

  it("refuses to manage the roles of a domain the user does not own", async () => {
    spies.getDomainAccess.mockResolvedValue(null);
    const result = (await deleteViewerRoute.callback(
      req({ method: "DELETE", params: { name: "example.org", username: "bob" } })
    )) as ApiResponse<unknown>;
    expect(result.status).toBe("failed");
    expect(spies.revokeRole).not.toHaveBeenCalled();
  });
});
