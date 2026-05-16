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
 */
function classifyError(err: Error): { title: string; detail: string } {
  const name = err.name ?? "";
  const msg = err.message ?? "";

  // Stripe SDK errors all subclass Error and set `name` to one of
  // "StripeInvalidRequestError", "StripeAuthenticationError", etc.
  if (name.startsWith("Stripe")) {
    if (name === "StripeAuthenticationError") {
      return {
        title: "Payment provider misconfigured",
        detail:
          "We couldn't reach our payment provider. The site administrator has been notified.",
      };
    }
    if (name === "StripeInvalidRequestError") {
      return {
        title: "Payment setup error",
        detail:
          "We couldn't set up the payment for this order. Please refresh and try again — if the problem persists, contact support.",
      };
    }
    return {
      title: "Payment provider error",
      detail:
        "Our payment provider returned an error. Please wait a moment and try again.",
    };
  }

  // Prisma client errors all have `code` starting with "P".
  if (name === "PrismaClientKnownRequestError" || name === "PrismaClientValidationError") {
    return {
      title: "Database error",
      detail: "We couldn't save the request. Please try again in a moment.",
    };
  }

  // Network / fetch failures inside the API (e.g. talking to Resend).
  if (name === "FetchError" || /ECONN|ETIMEDOUT|ENOTFOUND/.test(msg)) {
    return {
      title: "Network error",
      detail:
        "An upstream service didn't respond in time. Please try again in a moment.",
    };
  }

  return {
    title: "Internal Server Error",
    detail: "An unexpected error occurred. Please try again.",
  };
}
