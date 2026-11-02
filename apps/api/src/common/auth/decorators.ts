import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common";
import { AuthUser } from "./auth-user";

export const IS_PUBLIC = "isPublic";
export const REQUIRED_PERMISSIONS = "requiredPermissions";

/** Route needs no login (e.g. storefront catalogue, login itself). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route needs ALL of these permission keys ("module:action"). */
export const RequirePermissions = (...keys: string[]) => SetMetadata(REQUIRED_PERMISSIONS, keys);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
