-- AlterTable
ALTER TABLE "outboxEvents" ALTER COLUMN "publishedAt" DROP NOT NULL,
ALTER COLUMN "publishedAt" DROP DEFAULT;
