-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "amountCredited" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SalesOrderLine" ADD COLUMN     "reservedPicks" JSONB;

