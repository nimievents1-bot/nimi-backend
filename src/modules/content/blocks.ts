import { z } from "zod";

/**
 * ContentBlock payload schemas — one per block `type`.
 *
 * Add a new block here, register it in `BlockPayload`, and the
 * controller will validate any matching write request without code changes.
 *
 * Keep these schemas conservative: tight string limits, optional fields
 * explicit, no free-form JSON. Anything stored in the DB rendered by the
 * web app must be safe by construction.
 */

export const HeroBlock = z.object({
  type: z.literal("hero"),
  imageUrl: z.string().url().nullable(),
  alt: z.string().min(1).max(160),
  eyebrow: z.string().max(80).optional().nullable(),
  headline: z.string().min(1).max(140),
  subheadline: z.string().max(220).optional().nullable(),
  primaryCta: z
    .object({ label: z.string().min(1).max(40), href: z.string().min(1).max(200) })
    .optional()
    .nullable(),
});
export type HeroBlock = z.infer<typeof HeroBlock>;

export const RichTextBlock = z.object({
  type: z.literal("richtext"),
  /** Sanitised HTML — server-side sanitised before persist. Max ~16KB. */
  html: z.string().min(1).max(16_000),
});
export type RichTextBlock = z.infer<typeof RichTextBlock>;

export const SectionIntroBlock = z.object({
  type: z.literal("section-intro"),
  eyebrow: z.string().max(80).optional().nullable(),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(2_000),
  imageUrl: z.string().url().optional().nullable(),
});
export type SectionIntroBlock = z.infer<typeof SectionIntroBlock>;

export const PackageTierBlock = z.object({
  type: z.literal("package-tier"),
  name: z.string().min(1).max(40),
  position: z.number().int().min(1).max(3),
  description: z.string().min(1).max(400),
  includes: z.array(z.string().min(1).max(120)).max(20),
  priceFrom: z.string().max(60).optional().nullable(),
  ctaLabel: z.string().max(40).default("Enquire"),
});
export type PackageTierBlock = z.infer<typeof PackageTierBlock>;

export const FaqBlock = z.object({
  type: z.literal("faq"),
  items: z
    .array(
      z.object({
        question: z.string().min(1).max(200),
        answer: z.string().min(1).max(2_000),
      }),
    )
    .min(1)
    .max(50),
});
export type FaqBlock = z.infer<typeof FaqBlock>;

export const GalleryBlock = z.object({
  type: z.literal("gallery"),
  images: z
    .array(
      z.object({
        url: z.string().url(),
        alt: z.string().min(1).max(160),
        caption: z.string().max(200).optional().nullable(),
      }),
    )
    .max(40),
});
export type GalleryBlock = z.infer<typeof GalleryBlock>;

export const TestimonialBlock = z.object({
  type: z.literal("testimonial"),
  quote: z.string().min(1).max(800),
  author: z.string().min(1).max(120),
  role: z.string().max(120).optional().nullable(),
  imageUrl: z.string().url().optional().nullable(),
});
export type TestimonialBlock = z.infer<typeof TestimonialBlock>;

export const FooterBlock = z.object({
  type: z.literal("footer"),
  about: z.string().max(400),
  phone: z.string().max(40),
  email: z.string().email(),
  social: z
    .array(z.object({ label: z.string().max(40), href: z.string().url() }))
    .max(10)
    .optional()
    .nullable(),
});
export type FooterBlock = z.infer<typeof FooterBlock>;

export const BlockPayload = z.discriminatedUnion("type", [
  HeroBlock,
  RichTextBlock,
  SectionIntroBlock,
  PackageTierBlock,
  FaqBlock,
  GalleryBlock,
  TestimonialBlock,
  FooterBlock,
]);
export type BlockPayload = z.infer<typeof BlockPayload>;

/** Sentinel list of allowed `page` slugs. Tight by design — adding a new
 *  page is a code change, not a runtime decision. */
export const ALLOWED_PAGES = [
  "home",
  "catering",
  "events",
  "gifting",
  "cravings",
  "about",
  "faq",
  "contact",
  "privacy",
  "terms",
  "cookies",
  "site",
] as const;
export type AllowedPage = (typeof ALLOWED_PAGES)[number];
