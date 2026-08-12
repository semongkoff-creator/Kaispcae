import { PrismaClient } from '@prisma/client';
import { workDayOf } from '@kaispace/shared';

export type VibeCounterField = 'emoteCount' | 'waveCount' | 'chatCount' | 'furnitureCount';

// Bagian B.5's Vibe inputs — counts only, never event CONTENT (see
// DailyVibeCounter's doc comment in schema.prisma for why zone-chat text is
// deliberately never persisted here). One row per user per WIB calendar day
// (workDayOf, the same date bucketing AttendanceRecord already uses),
// upserted so the first event of the day creates the row. A switch instead
// of a dynamic `{ [field]: ... }` key — Prisma's generated update input
// shape can't be indexed by a runtime string safely.
export async function incrementDailyVibeCounter(
  prisma: PrismaClient,
  userId: string,
  field: VibeCounterField,
  at: Date = new Date(),
): Promise<void> {
  const date = workDayOf(at, 'Asia/Jakarta');
  const where = { userId_date: { userId, date } };
  switch (field) {
    case 'emoteCount':
      await prisma.dailyVibeCounter.upsert({ where, create: { userId, date, emoteCount: 1 }, update: { emoteCount: { increment: 1 } } });
      break;
    case 'waveCount':
      await prisma.dailyVibeCounter.upsert({ where, create: { userId, date, waveCount: 1 }, update: { waveCount: { increment: 1 } } });
      break;
    case 'chatCount':
      await prisma.dailyVibeCounter.upsert({ where, create: { userId, date, chatCount: 1 }, update: { chatCount: { increment: 1 } } });
      break;
    case 'furnitureCount':
      await prisma.dailyVibeCounter.upsert({ where, create: { userId, date, furnitureCount: 1 }, update: { furnitureCount: { increment: 1 } } });
      break;
  }
}
