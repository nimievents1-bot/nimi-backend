import { Type } from "class-transformer";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * Public list query — bounded so anyone can hit the endpoint without
 * pulling thousands of rows. Defaults are tuned for the homepage card grid.
 */
export class ListTestimonialsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1000)
  offset?: number;
}

/** Admin list — wider bounds; can also filter by publish state. */
export class AdminListTestimonialsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  offset?: number;

  @IsOptional() @Type(() => Boolean) @IsBoolean()
  isPublished?: boolean;

  @IsOptional() @IsString() @MaxLength(120)
  q?: string;
}

export class CreateTestimonialDto {
  @IsString() @MinLength(2) @MaxLength(120)
  authorName!: string;

  @IsOptional() @IsString() @MaxLength(120)
  role?: string;

  @IsString() @MinLength(20) @MaxLength(1000)
  body!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5)
  rating?: number;

  @IsOptional() @IsString() @MaxLength(40)
  eventType?: string;

  @IsOptional() @IsBoolean()
  isPublished?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  displayOrder?: number;
}

export class UpdateTestimonialDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  authorName?: string;

  @IsOptional() @IsString() @MaxLength(120)
  role?: string;

  @IsOptional() @IsString() @MinLength(20) @MaxLength(1000)
  body?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5)
  rating?: number;

  @IsOptional() @IsString() @MaxLength(40)
  eventType?: string;

  @IsOptional() @IsBoolean()
  isPublished?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  displayOrder?: number;
}
