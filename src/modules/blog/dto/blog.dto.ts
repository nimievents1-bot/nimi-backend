import { Type } from "class-transformer";
import {
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export enum BlogPostStatusDto {
  DRAFT = "DRAFT",
  SCHEDULED = "SCHEDULED",
  PUBLISHED = "PUBLISHED",
}

export class CreateBlogPostDto {
  @IsString() @MinLength(2) @MaxLength(80)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, {
    message: "Slug must be lowercase letters, numbers and hyphens.",
  })
  slug!: string;

  @IsString() @MinLength(2) @MaxLength(200)
  title!: string;

  @IsString() @MinLength(20) @MaxLength(400)
  excerpt!: string;

  @IsString() @MinLength(20) @MaxLength(200_000)
  body!: string;

  @IsString() @MinLength(2) @MaxLength(120)
  authorName!: string;

  @IsOptional() @IsString() @MaxLength(80)
  category?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(1024)
  coverUrl?: string;

  @IsOptional() @IsString() @MaxLength(160)
  coverAlt?: string;

  @IsOptional() @IsString() @MaxLength(120)
  seoTitle?: string;

  @IsOptional() @IsString() @MaxLength(280)
  seoDescription?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  ogImageUrl?: string;
}

export class UpdateBlogPostDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200)
  title?: string;

  @IsOptional() @IsString() @MinLength(20) @MaxLength(400)
  excerpt?: string;

  @IsOptional() @IsString() @MinLength(20) @MaxLength(200_000)
  body?: string;

  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  authorName?: string;

  @IsOptional() @IsString() @MaxLength(80)
  category?: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString() @MaxLength(1024)
  coverUrl?: string;

  @IsOptional() @IsString() @MaxLength(160)
  coverAlt?: string;

  @IsOptional() @IsString() @MaxLength(120)
  seoTitle?: string;

  @IsOptional() @IsString() @MaxLength(280)
  seoDescription?: string;

  @IsOptional() @IsString() @MaxLength(1024)
  ogImageUrl?: string;
}

export class PublishBlogPostDto {
  @IsOptional() @Type(() => Date) @IsDate()
  scheduledFor?: Date;
}

export class ListPostsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50)
  limit?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0)
  offset?: number;

  @IsOptional() @IsEnum(BlogPostStatusDto)
  status?: BlogPostStatusDto;

  @IsOptional() @IsString() @Length(1, 80)
  category?: string;

  @IsOptional() @IsString() @MaxLength(120)
  q?: string;
}
