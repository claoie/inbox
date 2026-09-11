import { WithRequired, getRandomId, DateString } from "common";
import { Model } from "../Model";

export interface UserType {
  id?: string;
  email?: string;
  username?: string;
  password?: string;
  token?: string;
  expiry?: DateString;
}

export class User extends Model<User> implements UserType {
  declare id?: string;
  declare email?: string;
  declare username?: string;
  declare password?: string;
  declare token?: string;
  declare expiry?: DateString;

  mask = () => {
    const { id, email, username, token, expiry } = this;
    return new MaskedUser({ id, email, username, token, expiry });
  };

  getSigned = () => {
    const { id, username, email, password } = this;
    if (!id || !username || !password || !email) return undefined;
    return new SignedUser(this.mask() as SignedUser);
  };
}

export type MaskedUserType = Omit<UserType, "password">;

export class MaskedUser extends Model<MaskedUser> implements MaskedUserType {
  declare id?: string;
  declare email?: string;
  declare username?: string;
  declare token?: string;
  declare expiry?: string;
}

export type SignedUserType = WithRequired<
  MaskedUserType,
  "id" | "email" | "username"
>;

export class SignedUser extends Model<SignedUser> implements SignedUserType {
  declare id: string;
  declare email: string;
  declare username: string;
  declare token?: string;
  declare expiry?: string;
  /**
   * Session-scoped read-only role attribution. When true the request was
   * authenticated as a read-only account whose session_id was remapped to
   * the effective (data-owning) user's id, so every read path keys off the
   * same `id` as the owner while every mutating surface refuses the write.
   */
  declare isReadOnly?: boolean;
  /**
   * Original username the caller authenticated as, before any session-scope
   * remap. Distinct from `username` (which after remap names the effective
   * data owner) so audit-log lines and refusal messages can attribute the
   * action to the credential that produced it.
   */
  declare authenticatedAs?: string;

  constructor(init?: Partial<SignedUser>) {
    super(init);
    if (!init?.id) this.id = getRandomId();
    if (!init?.email) this.email = "unknown";
    if (!init?.username) this.username = "unknown";
  }
}
