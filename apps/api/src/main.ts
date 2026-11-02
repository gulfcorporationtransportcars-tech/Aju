import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureApp } from "./bootstrap";
import { env } from "./config/env";

async function main() {
  const config = env(); // fail fast on bad configuration
  const app = configureApp(await NestFactory.create(AppModule));
  (app.getHttpAdapter().getInstance() as { set: (k: string, v: unknown) => void }).set("trust proxy", 1); // behind nginx
  await app.listen(config.PORT);
  Logger.log(`LUXORA Hub API listening on :${config.PORT}/api/v1`, "Bootstrap");
}

main();
