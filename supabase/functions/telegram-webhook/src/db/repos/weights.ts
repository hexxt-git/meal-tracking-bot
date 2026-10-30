import { desc, eq, gte } from "drizzle-orm";
import type { Run } from "../client.ts";
import { bodyWeights, NewWeight, Weight } from "../schema.ts";

export function weightsRepo(run: Run) {
  return {
    byId: (id: string): Promise<Weight | null> =>
      run(
        async (tx) =>
          (
            await tx.select().from(bodyWeights).where(eq(bodyWeights.id, id))
          )[0] ?? null,
      ),

    /** Newest first. */
    recent: (limit: number) =>
      run((tx) =>
        tx
          .select()
          .from(bodyWeights)
          .orderBy(desc(bodyWeights.weighedAt))
          .limit(limit),
      ),

    /** Weigh-ins at or after `from`, newest first. */
    since: (from: Date) =>
      run((tx) =>
        tx
          .select()
          .from(bodyWeights)
          .where(gte(bodyWeights.weighedAt, from))
          .orderBy(desc(bodyWeights.weighedAt)),
      ),

    /** Newest first; fetches one extra row so callers can tell whether another page exists. */
    page: async (page: number, size: number) => {
      const rows = await run((tx) =>
        tx
          .select()
          .from(bodyWeights)
          .orderBy(desc(bodyWeights.weighedAt))
          .limit(size + 1)
          .offset(page * size),
      );
      return { weights: rows.slice(0, size), hasMore: rows.length > size };
    },

    create: (w: NewWeight) =>
      run(
        async (tx) => (await tx.insert(bodyWeights).values(w).returning())[0],
      ),

    /** Null if the entry is gone. */
    update: (id: string, patch: Partial<NewWeight>): Promise<Weight | null> =>
      run(
        async (tx) =>
          (
            await tx
              .update(bodyWeights)
              .set(patch)
              .where(eq(bodyWeights.id, id))
              .returning()
          )[0] ?? null,
      ),

    /** Null if the entry was already gone. */
    delete: (id: string): Promise<Weight | null> =>
      run(
        async (tx) =>
          (
            await tx
              .delete(bodyWeights)
              .where(eq(bodyWeights.id, id))
              .returning()
          )[0] ?? null,
      ),

    /** Removes the weigh-ins an assistant run logged. */
    undo: (batchId: string) =>
      run((tx) =>
        tx
          .delete(bodyWeights)
          .where(eq(bodyWeights.batchId, batchId))
          .returning(),
      ),
  };
}
