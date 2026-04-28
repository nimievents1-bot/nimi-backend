import { SetMetadata } from "@nestjs/common";

/**
 * `@Public()` — opt a route out of the global JwtAuthGuard.
 * Used on /auth/login, /auth/register, /auth/forgot-password, etc.
 */
export const IS_PUBLIC_KEY = "isPublic";
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
