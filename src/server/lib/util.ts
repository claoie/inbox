/**
 * Utilities shared across server modules.
 * Placed here to avoid circular imports that occur when importing through the barrel.
 */

export const getDomain = () => process.env.EMAIL_DOMAIN || "mydomain";

export const getUserDomain = (username: string) => {
  const domain = getDomain();
  if (username === "admin") return domain;
  return `${username}.${domain}`;
};

/**
 * The username whose mailbox receives mail for `address`. The inverse of
 * {@link getUserDomain}: `x@<domain>` and `x@admin.<domain>` are admin's, and
 * `x@bob.<domain>` is bob's. Returns the address's own domain for anything
 * outside the served domain, which matches no username.
 */
export const addressToUsername = (address: string) => {
  const domain = getDomain();
  const parsedAddress = address.split("@");
  const domainInAddress = parsedAddress[parsedAddress.length - 1];
  const subDomain = domainInAddress.split(`.${domain}`)[0]?.toLowerCase();
  return subDomain === domain ? "admin" : subDomain;
};

/**
 * Resolves `undefined` if `promise` has not settled within `ms`.
 *
 * For awaits on the shutdown path whose own transport carries no deadline: a
 * hung one holds the stop open until the container's grace period expires and
 * SIGKILL replaces the clean exit.
 */
export const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
