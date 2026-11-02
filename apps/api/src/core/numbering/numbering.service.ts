import { Global, Injectable, Module } from "@nestjs/common";
import { formatDocNumber } from "@luxora/shared";
import { PrismaService, Tx } from "../../common/prisma/prisma.service";

@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Next document number, e.g. LUX-INV-2026-0001. A single atomic
   * INSERT … ON CONFLICT … UPDATE means two users saving at the same moment can
   * never get the same number. Run inside the document's transaction so a rolled-back
   * save does not use up a number.
   */
  async next(docType: string, tx?: Tx, date: Date = new Date()): Promise<string> {
    const year = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Dubai", year: "numeric" }).format(date));
    const db = tx ?? this.prisma;
    const rows = await db.$queryRaw<{ lastNumber: number; prefix: string; padding: number }[]>`
      INSERT INTO "NumberSequence" ("id", "docType", "year", "prefix", "lastNumber", "padding")
      VALUES (md5(random()::text || clock_timestamp()::text), ${docType}, ${year}, 'LUX', 1, 4)
      ON CONFLICT ("docType", "year")
      DO UPDATE SET "lastNumber" = "NumberSequence"."lastNumber" + 1
      RETURNING "lastNumber", "prefix", "padding"`;
    const { lastNumber, prefix, padding } = rows[0];
    return formatDocNumber(prefix, docType, year, lastNumber, padding);
  }
}

@Global()
@Module({ providers: [NumberingService], exports: [NumberingService] })
export class NumberingModule {}
