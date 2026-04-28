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
      // Anything not an HttpException is a programming bug; log it and return a 500.
      this.logger.error(
        { err: exception, requestId: req.id, url: req.url, method: req.method },
        exception.message,
      );
    }

    const requestId = req.id ?? "unknown";

    void res.status(status).header("Content-Type", "application/problem+json").send({
      type: "about:blank",
      title,
      status,
      detail,
      instance: req.url,
      requestId,
      ...(extras ?? {}),
    });
  }
}
