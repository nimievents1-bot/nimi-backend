import { Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

import { type UpdateProfileDto } from "./profile.controller";

/**
 * Profile read/write for the customer's own record. Auth-sensitive
 * operations (email change, password change, MFA enrolment) stay in
 * `AuthService`; this service only handles the fields a customer can
 * freely edit on `/account/profile`.
 *
 * Empty-string convention: when the client sends `addressLine1: ""`,
 * we treat it as "the customer wants this cleared" and write `null`
 * to the DB. Sending `undefined` (i.e. omitting the key) means
 * "don't touch this field" — that's the difference between a true
 * delete and a partial patch.
 */
@Injectable()
export class ProfileService {
  constructor(private readonly db: PrismaService) {}

  async getForUser(userId: string) {
    const row = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        addressCity: true,
        addressPostcode: true,
        addressCountry: true,
        emailVerifiedAt: true,
        role: true,
        createdAt: true,
      },
    });
    if (!row) throw new NotFoundException();
    return {
      ...row,
      emailVerifiedAt: row.emailVerifiedAt ? row.emailVerifiedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async update(userId: string, dto: UpdateProfileDto) {
    // Build the patch from defined keys only. Empty-string clears
    // (writes null); omitted keys leave the column alone. This makes
    // the endpoint forgiving for partial patches from the client.
    const data: Record<string, string | null> = {};

    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (trimmed.length === 0) {
        // Name is required — refuse the clear by silently keeping the
        // existing value. We could throw, but a cleared-name screen
        // is a worse UX than just ignoring an empty submission.
      } else {
        data.name = trimmed;
      }
    }
    if (dto.phone !== undefined) data.phone = dto.phone.trim() || null;
    if (dto.addressLine1 !== undefined) data.addressLine1 = dto.addressLine1.trim() || null;
    if (dto.addressLine2 !== undefined) data.addressLine2 = dto.addressLine2.trim() || null;
    if (dto.addressCity !== undefined) data.addressCity = dto.addressCity.trim() || null;
    if (dto.addressPostcode !== undefined) {
      const v = dto.addressPostcode.trim();
      data.addressPostcode = v ? v.toUpperCase() : null;
    }
    if (dto.addressCountry !== undefined) {
      const v = dto.addressCountry.trim();
      data.addressCountry = v ? v.toUpperCase() : null;
    }

    if (Object.keys(data).length === 0) {
      // Nothing to do — return the current state so the client doesn't
      // have to re-fetch after a no-op submission.
      return this.getForUser(userId);
    }

    await this.db.user.update({ where: { id: userId }, data });
    return this.getForUser(userId);
  }
}
