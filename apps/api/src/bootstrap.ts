import { INestApplication } from "@nestjs/common";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { env } from "./config/env";

/** Shared app setup (used by main.ts and the tests). */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix("api/v1");
  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({ origin: env().CORS_ORIGINS.split(",").map((o) => o.trim()), credentials: true });
  app.enableShutdownHooks();
  return app;
}
