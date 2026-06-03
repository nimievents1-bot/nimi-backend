import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { type FastifyReply, type FastifyRequest } from "fastify";

/**
 * Global exception filter — converts every error into a sanitised
 * RFC 7807 problem-details JSON response and logs the failure with
 * the request id so it can be correlated with downstream logs.
 *
 * Internal stack traces never leak to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FastifyRequest>();
    const res = ctx.getResponse<FastifyReply>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let title = "Internal Server Error";
    let detail = "An unexpected error occurred. Please try again.";
    let extras: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      title = exception.message || HttpStatus[status] || "Error";

      const response = exception.getResponse();
      if (typeof response === "string") {
        detail = response;
      } else if (typeof response === "object" && response !== null) {
        const obj = response as Record<string, unknown>;
        const possibleMessage = obj.message ?? obj.error;
        detail = Array.isArray(possibleMessage)
          ? possibleMessage.join("; ")
          : typeof possibleMessage === "string"
          ? possibleMessage
          : detail;
        if (Array.isArray(obj.message)) {
          extras = { errors: obj.message };
        }
      }
    } else if (exception instanceof Error) {
      // Anything not an HttpException is a programming bug or an
      // unwrapped 3rd-party library error (Stripe SDK, Prisma, fetch).
      // Log the full error AND surface the type/message in the
      // response detail so the operator can correlate without server
      // log access. We never include the stack trace in the response.
      this.logger.error(
        {
          err: exception,
          errName: exception.name,
          errMessage: exception.message,
          requestId: req.id,
          url: req.url,
          method: req.method,
        },
        `Unhandled ${exception.name}: ${exception.message}`,
      );
      // The classifier below picks a tighter title for the common
      // libraries so the client error message is human-readable.
      const tagged = classifyError(exception);
      title = tagged.title;
      detail = tagged.detail;

      // Diagnostic surface: include the error name + the first 200
      // characters of the message in the response under `_debug`.
      // This is NEVER displayed in the customer UI (the form only
      // renders `detail`) — it's there for the operator to inspect
      // in DevTools or curl. We deliberately:
      //
      //   - Keep the body's `detail` field generic (no internal
      //     details leaked to the user-visible message).
      //   - Truncate the upstream message so a Prisma message
      //     containing the full SQL can't bloat the response.
      //   - Strip newlines so the JSON stays single-line / safe.
      //   - Only attach for paths under `/v1/admin/`. Public
      //     endpoints get nothing extra — the customer never sees
      //     internal error names regardless.
      const isAdminPath = typeof req.url === "string" && /\/admin\//.test(req.url);
      if (isAdminPath) {
        const safeMessage = exception.message
          ? exception.message.replace(/[\r\n]+/g, " ").slice(0, 200)
          : "";
        extras = {
          ...(extras ?? {}),
          _debug: {
            name: exception.name,
            message: safeMessage,
          },
        };
      }
    }

    const requestId = req.id ?? "unknown";

    // Append the requestId to the detail so the user can quote it back
    // to support. The original detail message stays leading so the
    // user-facing copy reads naturally; the ref is parenthetical.
    const detailWithRef = `${detail} (ref: ${requestId})`;

    void res
      .status(status)
      .header("Content-Type", "application/problem+json")
      .send({
        type: "about:blank",
        title,
        status,
        detail: detailWithRef,
        instance: req.url,
        requestId,
        ...(extras ?? {}),
      });
  }
}

/**
 * Best-effort classifier for unwrapped library exceptions. Keeps the
 * client-facing detail short and actionable; the full error is in the
 * logs for the operator. Never echoes raw library messages verbatim
 * because they often contain internal IDs the customer doesn't need
 * to see.
 *
 * Coverage notes:
 *   - Stripe SDK errors: prefix-matched on `name` so every subclass
 *     (Invalid, Authentication, Card, RateLimit, Permission, etc.)
 *     gets a Stripe-shaped response.
 *   - Prisma errors: we recognise all five client error classes that
 *     Prisma 5 throws. The previous version only matched two, which
 *     left "schema drift" / "engine panic" / "init failed" cases
 *     falling through to a useless generic message.
 *   - Network errors: matches FetchError as well as the bare Node
 *     error codes (ECONN, ETIMEDOUT, ENOTFOUND, ECONNRESET).
 *   - Programmer errors: TypeError / ReferenceError / RangeError are
 *     surfaced with a clearer title so the operator immediately knows
 *     it's a code bug rather than a downstream service hiccup.
 */
function classifyError(err: Error): { title: string; detail: string } {
  const name = err.name ?? "";
  const msg = err.message ?? "";

  // Stripe SDK errors. Two detection paths because the Stripe Node
  // SDK (v17+) stopped setting `.name = "StripeInvalidRequestError"`
  // and now puts the discriminator on `.type` instead while leaving
  // `.name` as the bare string "Error". We accept either fingerprint
  // so future SDK churn doesn't silently re-break classification.
  //
  // We read `.type` defensively: it exists on Stripe errors but not
  // on Error in general, so the access is typed as `unknown` and
  // narrowed via `typeof` before being treated as a string. This is
  // also why the cast goes through a `{ type?: unknown }` shape —
  // a direct cast to `{ type: string }` would (correctly) be flagged
  // by TS as overlapping insufficiently with `Error`.
  const maybeType = (err as { type?: unknown }).type;
  const stripeType = typeof maybeType === "string" ? maybeType : undefined;
  const isStripeShaped =
    name.startsWith("Stripe") ||
    (stripeType !== undefined && stripeType.startsWith("Stripe"));
  if (isStripeShaped) {
    const effectiveName = name.startsWith("Stripe") ? name : stripeType ?? name;
    if (effectiveName === "StripeAuthenticationError") {
      return {
        title: "Payment provider misconfigured",
        detail:
          "We couldn't reach our payment provider. The site administrator has been notified.",
      };
    }
    if (effectiveName === "StripeInvalidRequestError") {
      // The single most common StripeInvalidRequestError for us is
      // "No such product/price/customer" — the stored ID points at
      // a resource that no longer exists in the current Stripe
      // account / mode. Surface a hint so the operator immediately
      // sees the cause rather than the generic message.
      const hint = /No such (product|price|customer)/i.exec(msg);
      const tailoredDetail = hint
        ? `Stripe doesn't recognise that ${hint[1]} — it was either deleted, or the API key was switched between live and test mode. Reset the Stripe IDs on this record and try again.`
        : "We couldn't set up the payment for this order. Please refresh and try again — if the problem persists, contact support.";
      return {
        title: "Payment setup error",
        detail: tailoredDetail,
      };
    }
    return {
      title: "Payment provider error",
      detail:
        "Our payment provider returned an error. Please wait a moment and try again.",
    };
  }

  // All five Prisma 5 client error classes. Catching the variants
  // matters: an outdated client (schema column missing locally) throws
  // PrismaClientValidationError; a missing DB column throws
  // PrismaClientKnownRequestError (P2022); a broken DB connection
  // throws PrismaClientInitializationError; a Rust panic in the query
  // engine throws PrismaClientRustPanicError; everything else throws
  // PrismaClientUnknownRequestError.
  if (
    name === "PrismaClientKnownRequestError" ||
    name === "PrismaClientValidationError" ||
    name === "PrismaClientInitializationError" ||
    name === "PrismaClientUnknownRequestError" ||
    name === "PrismaClientRustPanicError"
  ) {
    // Prisma includes the SQLSTATE-style code (P2022, etc.) on the
    // known-error class. Surfacing it in the operator-facing detail
    // keeps customer responses generic but still gives the operator
    // a one-liner to grep without needing log access. We're careful
    // to truncate the upstream message because Prisma's message can
    // contain table / column names which leak the schema; only
    // surface the code, not the body.
    const codeMatch = /\bP\d{4}\b/.exec(msg);
    const codeHint = codeMatch ? ` (${codeMatch[0]})` : "";
    return {
      title: "Database error",
      detail: `We couldn't save the request. Please try again in a moment${codeHint}.`,
    };
  }

  // Network / fetch failures inside the API (e.g. talking to Resend
  // or Stripe). Match FetchError plus bare Node connect/dns codes —
  // ECONNRESET is the new EAGAIN, hit it once a day on busy infra.
  if (name === "FetchError" || /ECONN|ETIMEDOUT|ENOTFOUND|ECONNRESET/.test(msg)) {
    return {
      title: "Network error",
      detail:
        "An upstream service didn't respond in time. Please try again in a moment.",
    };
  }

  // Programmer errors. These are bugs, not transient failures —
  // give the operator a different title so dashboards/alerts can
  // separate "production bug" from "downstream outage" without
  // string-matching the body.
  if (name === "TypeError" || name === "ReferenceError" || name === "RangeError") {
    return {
      title: "Application error",
      detail:
        "Something went wrong on our side. The team has been notified — please try again or use a different field.",
    };
  }

  return {
    title: "Internal Server Error",
    detail: "An unexpected error occurred. Please try again.",
  };
}
