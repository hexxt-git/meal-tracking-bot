import { eq, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { aiUsage } from "../schema.ts";

const utcDay = () => new Date().toISOString().slice(0, 10);

export function usageRepo(run: Run) {
  return {
    /** Billed USD so far today (UTC). */
    todayCost: () =>
      run(async (tx) => (await tx.select({ cost: aiUsage.costUsd }).from(aiUsage).where(eq(aiUsage.day, utcDay())))[0]?.cost ?? 0),

    record: (costUsd: number, searches: number) =>
      run((tx) =>
        tx.insert(aiUsage).values({ day: utcDay(), costUsd, runs: 1, searches }).onConflictDoUpdate({
          target: [aiUsage.tgId, aiUsage.day],
          set: {
            costUsd: sql`${aiUsage.costUsd} + ${costUsd}`,
            runs: sql`${aiUsage.runs} + 1`,
            searches: sql`${aiUsage.searches} + ${searches}`,
          },
        })
      ),
  };
}
