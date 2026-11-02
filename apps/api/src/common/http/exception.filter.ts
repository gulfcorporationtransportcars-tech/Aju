import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { Prisma } from "@luxora/db";
import { InsufficientStockError } from "@luxora/shared";
import type { Response } from "express";

/** Turns database and business-rule errors into clear HTTP responses. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Error");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      return res.status(exception.getStatus()).json(typeof body === "string" ? { statusCode: exception.getStatus(), message: body } : body);
    }

    if (exception instanceof InsufficientStockError) {
      return res.status(HttpStatus.CONFLICT).json({
        statusCode: 409,
        message: exception.message,
        requested: exception.requested,
        available: exception.available,
      });
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2002") {
        return res.status(409).json({ statusCode: 409, message: `Already exists: ${(exception.meta?.target as string[] | undefined)?.join(", ") ?? "duplicate value"}` });
      }
      if (exception.code === "P2025") return res.status(404).json({ statusCode: 404, message: "Record not found" });
      if (exception.code === "P2003") return res.status(400).json({ statusCode: 400, message: "Linked record does not exist" });
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return res.status(500).json({ statusCode: 500, message: "Internal server error" });
  }
}
