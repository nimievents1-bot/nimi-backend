import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";

import { getEnv } from "../../config/env";

import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtStrategy } from "./jwt.strategy";
import { MfaController } from "./mfa.controller";
import { MfaService } from "./mfa.service";
import { PasswordService } from "./password.service";
import { RefreshService } from "./refresh.service";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt", session: false }),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: getEnv().JWT_SECRET,
        signOptions: {
          algorithm: "HS256",
          expiresIn: getEnv().JWT_ACCESS_TTL,
          issuer: "nimi",
        },
      }),
    }),
  ],
  controllers: [AuthController, MfaController],
  providers: [AuthService, PasswordService, RefreshService, JwtStrategy, MfaService],
  exports: [AuthService, MfaService],
})
export class AuthModule {}
