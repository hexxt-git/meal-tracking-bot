import { eq, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { aiUsage } from "../schema.ts";

const utcDay = () => new Date().toISOString().slice(0, 10);

export function usageRepo(run: Run) {
  return {
    /** Billed USD so far today (UTC), and whether the user chose to go past the daily budget. */
    today: () =>
      run(async (tx) => {
        const [row] = await tx.select({ costUsd: aiUsage.costUsd, bypassed: aiUsage.budgetBypassed }).from(aiUsage)
          .where(eq(aiUsage.day, utcDay()));
        return row ?? { costUsd: 0, bypassed: false };
      }),

    bypassBudget: () =>
      run((tx) =>
        tx.insert(aiUsage).values({ day: utcDay(), budgetBypassed: true }).onConflictDoUpdate({
          target: [aiUsage.tgId, aiUsage.day],
          set: { budgetBypassed: true },
        })
      ),

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
