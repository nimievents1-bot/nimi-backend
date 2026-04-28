import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { type Role } from "@prisma/client";
import { type FastifyRequest } from "fastify";

import { ROLES_KEY } from "../../common/decorators/roles.decorator";

import { type AuthenticatedUser } from "./types";

/**
 * RolesGuard — enforces @Roles() metadata on the decorated handler/class.
 * Must run *after* JwtAuthGuard so the user is on the request.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    if (!req.user) throw new UnauthorizedException();
    if (!required.includes(req.user.role)) throw new ForbiddenException();
    return true;
  }
}
