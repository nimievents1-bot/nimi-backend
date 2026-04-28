import { Type } from "class-transformer";
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export enum ContactStatusDto {
  NEW = "NEW",
  CONTACTED = "CONTACTED",
  CLOSED = "CLOSED",
  SPAM = "SPAM",
}

export enum ContactKindDto {
  GENERAL = "GENERAL",
  CATERING = "CATERING",
  EVENTS = "EVENTS",
  GIFTING = "GIFTING",
  CRAVINGS = "CRAVINGS",
  PRESS = "PRESS",
}

export class ListEnquiriesQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;

  @IsOptional() @IsEnum(ContactStatusDto)
  status?: ContactStatusDto;

  @IsOptional() @IsEnum(ContactKindDto)
  kind?: ContactKindDto;

  @IsOptional() @IsString() @MaxLength(120)
  q?: string;
}

export class UpdateEnquiryDto {
  @IsOptional() @IsEnum(ContactStatusDto)
  status?: ContactStatusDto;

  @IsOptional() @IsString() @MaxLength(8000)
  internalNotes?: string;

  /**
   * Tags as a string array — used in future filtering. Capped to keep
   * the payload small.
   */
  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];
}

export class ReplyEnquiryDto {
  @IsString() @MaxLength(140)
  subject!: string;

  @IsString() @MaxLength(8000)
  body!: string;
}
