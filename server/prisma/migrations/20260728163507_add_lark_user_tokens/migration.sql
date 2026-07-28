-- AlterTable
ALTER TABLE "User" ADD COLUMN     "larkRefreshExpiresAt" TIMESTAMP(3),
ADD COLUMN     "larkRefreshToken" TEXT,
ADD COLUMN     "larkTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "larkUserAccessToken" TEXT;

