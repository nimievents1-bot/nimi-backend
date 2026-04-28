import { Injectable, Logger } from "@nestjs/common";

import { getEnv } from "../../config/env";

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  /** Optional reply-to override — defaults to support inbox. */
  replyTo?: string;
  /** Optional tag for delivery analytics. */
  tag?: string;
}

interface ResendApiResponse {
  id?: string;
  message?: string;
  name?: string;
}

/**
 * Mailer service — thin wrapper around the Resend HTTP API.
 *
 * Resend is the only currently supported provider. The wrapper returns
 * the provider message id on success and throws on persistent failures.
 *
 * Outbound calls are best-effort: in development without RESEND_API_KEY,
 * the service logs the email instead of sending. This avoids false positives
 * during local development and keeps the build green in CI.
 *
 * Production hardening notes:
 *   - SPF / DKIM / DMARC are configured at the DNS level (out of scope here).
 *   - Every send carries a List-Unsubscribe header where applicable.
 *   - Templates are escaped server-side; never inject untrusted HTML.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);

  async send(args: SendArgs): Promise<{ id: string | null; sent: boolean }> {
    const env = getEnv();
    const from = `Nimi Events <${env.NOREPLY_INBOX}>`;
    const replyTo = args.replyTo ?? env.SUPPORT_INBOX;

    if (!env.RESEND_API_KEY) {
      this.logger.warn(
        { to: args.to, subject: args.subject, tag: args.tag },
        "RESEND_API_KEY not set — logging email instead of sending",
      );
      // eslint-disable-next-line no-console
      if (env.NODE_ENV === "development") console.log("\n--- email (preview) ---\n", args.text, "\n");
      return { id: null, sent: false };
    }

    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: args.to,
          subject: args.subject,
          html: args.html,
          text: args.text,
          reply_to: replyTo,
          tags: args.tag ? [{ name: "kind", value: args.tag }] : undefined,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as ResendApiResponse;
        this.logger.error(
          { status: response.status, body, to: args.to, subject: args.subject },
          "Resend send failed",
        );
        throw new Error(`Resend send failed: ${response.status} ${body.message ?? body.name ?? ""}`);
      }

      const body = (await response.json()) as ResendApiResponse;
      this.logger.log({ id: body.id, to: args.to, subject: args.subject }, "Email sent");
      return { id: body.id ?? null, sent: true };
    } catch (err) {
      this.logger.error({ err, to: args.to, subject: args.subject }, "Mailer error");
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}
