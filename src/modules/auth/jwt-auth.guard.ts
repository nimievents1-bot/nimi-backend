import { type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";

import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator";

/**
 * Default app-level auth guard. Skips routes annotated with @Public().
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  override canActivate(ctx: ExecutionContext): ReturnType<AuthGuard["canActivate"]> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(ctx);
  }
}
