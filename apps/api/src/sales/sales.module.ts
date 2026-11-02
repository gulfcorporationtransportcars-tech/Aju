import { Module } from "@nestjs/common";
import { InventoryModule } from "../trading/inventory/inventory.module";
import { CrmController } from "./crm.controller";
import { PricingService } from "./pricing.service";
import { SalesController } from "./sales.controller";
import { SalesService } from "./sales.service";

@Module({
  imports: [InventoryModule],
  providers: [PricingService, SalesService],
  controllers: [CrmController, SalesController],
  exports: [SalesService, PricingService],
})
export class SalesModule {}
