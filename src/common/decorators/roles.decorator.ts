import { SetMetadata } from "@nestjs/common";
import { type Role } from "@prisma/client";

/**
 * `@Roles("OWNER", "EDITOR")` — restrict a route to admin roles.
 * Enforced by RolesGuard.
 */
export const ROLES_KEY = "roles";
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
