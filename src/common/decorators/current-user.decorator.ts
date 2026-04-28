import { type ExecutionContext, createParamDecorator } from "@nestjs/common";
import { type FastifyRequest } from "fastify";

import { type AuthenticatedUser } from "../../modules/auth/types";

/**
 * `@CurrentUser()` — inject the authenticated user from the request.
 * The user is populated by JwtAuthGuard; this decorator just hands it back.
 *
 * If the route is decorated with @Public() and no user is on the request,
 * this returns undefined — handle that case in the controller.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    return req.user;
  },
);
