import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service";

import { type UpdateProfileDto } from "./profile.controller";

/**
 * Returns true if (day, month) describes a real calendar day, using a
 * leap-friendly 29-Feb (we accept it because we only store day+month
 * and don't have a year to disambiguate). Anything else — 31 Apr,
 * 30 Feb, 32 of anything — returns false.
 */
function isValidDayMonth(day: number, month: number): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  // Construct a Date in a leap year so 29 Feb is valid; if Date
  // normalises the day (e.g. 31 Apr → 1 May), the day-of-month won't
  // match what we asked for.
  const probe = new Date(Date.UTC(2024, month - 1, day));
  return probe.getUTCDate() === day && probe.getUTCMonth() === month - 1;
}

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
        birthDay: true,
        birthMonth: true,
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
    const data: Record<string, string | number | null> = {};

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

    // Birthday is day+month only (no year, no PII age-bracket). We
    // accept three shapes from the client to give the UI flexibility:
    //   - both day + month present  → set/replace
    //   - both day + month null     → clear
    //   - one defined, the other not → reject (preserves the invariant
    //     that the two columns are always in lockstep)
    const hasDay = dto.birthDay !== undefined;
    const hasMonth = dto.birthMonth !== undefined;
    if (hasDay !== hasMonth) {
      throw new BadRequestException(
        "Please provide both the day and the month of your birthday (or clear both to remove it).",
      );
    }
    if (hasDay && hasMonth) {
      const day = dto.birthDay;
      const month = dto.birthMonth;
      if (day === null && month === null) {
        data.birthDay = null;
        data.birthMonth = null;
      } else if (typeof day === "number" && typeof month === "number") {
        if (!isValidDayMonth(day, month)) {
          throw new BadRequestException(
            "That isn't a valid calendar date — please check the day for that month.",
          );
        }
        data.birthDay = day;
        data.birthMonth = month;
      } else {
        // Mixed null + number is an inconsistent payload.
        throw new BadRequestException(
          "Please provide both the day and the month of your birthday (or clear both to remove it).",
        );
      }
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
