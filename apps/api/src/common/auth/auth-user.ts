import { UserType } from "@luxora/db";

/** The signed-in user attached to every authenticated request. */
export interface AuthUser {
  id: string;
  type: UserType;
  email: string;
  fullName: string;
  roleKey: string | null;
  permissions: string[];
  customerId: string | null; // B2B portal users
  adClientId: string | null; // ad client portal users
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
