import { Module } from "@nestjs/common";
import { SalesModule } from "../sales/sales.module";
import { FinanceController } from "./finance.controller";
import { PaymentsService } from "./payments.service";
import { ReportsController } from "./reports.controller";
import { VatController } from "./vat.controller";

@Module({
  imports: [SalesModule],
  providers: [PaymentsService],
  controllers: [FinanceController, VatController, ReportsController],
  exports: [PaymentsService],
})
export class FinanceModule {}
