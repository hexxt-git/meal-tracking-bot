import { and, asc, desc, eq, gte, isNull, lt } from "drizzle-orm";
import type { Run, Tx } from "../client.ts";
import { Meal, mealRevisions, meals, MealSnapshot, NewMeal } from "../schema.ts";

const toSnapshot = (m: Meal): MealSnapshot => JSON.parse(JSON.stringify(m));

const fromSnapshot = (s: MealSnapshot): Meal => ({
  ...s,
  eatenAt: new Date(s.eatenAt),
  // Snapshots taken before logged_at existed fall back to the creation time.
  loggedAt: new Date(s.loggedAt ?? s.createdAt),
  createdAt: new Date(s.createdAt),
  updatedAt: new Date(s.updatedAt),
});

async function recordRevision(tx: Tx, batchId: string, mealId: string, before: Meal | null) {
  await tx.insert(mealRevisions).values({ batchId, mealId, before: before && toSnapshot(before) });
}

export type UndoResult = { mealId: string; description: string; restored: boolean };

export function mealsRepo(run: Run) {
  return {
    byId: (id: string) => run(async (tx) => (await tx.select().from(meals).where(eq(meals.id, id)))[0] ?? null),

    /** Meals sent to the bot at or after `from`, most recent first. */
    loggedSince: (from: Date) => run((tx) => tx.select().from(meals).where(gte(meals.loggedAt, from)).orderBy(desc(meals.loggedAt))),

    since: (from: Date) => run((tx) => tx.select().from(meals).where(gte(meals.eatenAt, from)).orderBy(asc(meals.eatenAt))),

    /** Meals in [from, to), oldest first. */
    between: (from: Date, to: Date) =>
      run((tx) =>
        tx.select().from(meals).where(and(gte(meals.eatenAt, from), lt(meals.eatenAt, to))).orderBy(asc(meals.eatenAt))
      ),

    /** Newest first; fetches one extra row so callers can tell whether another page exists. */
    page: async (page: number, size: number) => {
      const rows = await run((tx) => tx.select().from(meals).orderBy(desc(meals.eatenAt)).limit(size + 1).offset(page * size));
      return { meals: rows.slice(0, size), hasMore: rows.length > size };
    },

    all: () => run((tx) => tx.select().from(meals).orderBy(asc(meals.eatenAt))),

    // Writes record an undo revision under `batchId`; undoing the batch reverts every change in it.

    create: (meal: NewMeal, batchId: string = crypto.randomUUID()) =>
      run(async (tx) => {
        const [row] = await tx.insert(meals).values(meal).returning();
        await recordRevision(tx, batchId, row.id, null);
        return { meal: row, batchId };
      }),

    update: (id: string, patch: Partial<NewMeal>, batchId: string = crypto.randomUUID()) =>
      run(async (tx) => {
        const [before] = await tx.select().from(meals).where(eq(meals.id, id)).for("update");
        if (!before) return null;
        await recordRevision(tx, batchId, id, before);
        const [meal] = await tx.update(meals).set(patch).where(eq(meals.id, id)).returning();
        return { meal, before, batchId };
      }),

    /** Null if the meal was already gone. */
    delete: (id: string, batchId: string = crypto.randomUUID()) =>
      run(async (tx) => {
        const [before] = await tx.delete(meals).where(eq(meals.id, id)).returning();
        if (!before) return null;
        await recordRevision(tx, batchId, id, before);
        return { meal: before, batchId };
      }),

    /**
     * Inserts meals in one transaction, skipping any whose eaten time and title match an existing meal,
     * so importing the same file twice adds nothing.
     */
    importMany: (rows: NewMeal[], batchId: string = crypto.randomUUID()) =>
      run(async (tx) => {
        const key = (m: { eatenAt?: Date; description: string }) => `${m.eatenAt?.getTime()}|${m.description}`;
        const seen = new Set((await tx.select({ eatenAt: meals.eatenAt, description: meals.description }).from(meals)).map(key));
        const fresh = rows.filter((r) => !seen.has(key(r)) && seen.add(key(r)));
        for (let i = 0; i < fresh.length; i += 500) {
          const inserted = await tx.insert(meals).values(fresh.slice(i, i + 500)).returning({ id: meals.id });
          await tx.insert(mealRevisions).values(inserted.map((m) => ({ batchId, mealId: m.id, before: null })));
        }
        return { imported: fresh.length, duplicates: rows.length - fresh.length, batchId };
      }),

    /** Reverts every change in the batch, newest first. Empty if it was already undone. */
    undo: (batchId: string) =>
      run(async (tx) => {
        const revs = await tx
          .update(mealRevisions)
          .set({ undoneAt: new Date() })
          .where(and(eq(mealRevisions.batchId, batchId), isNull(mealRevisions.undoneAt)))
          .returning();
        revs.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const results: UndoResult[] = [];
        for (const rev of revs) {
          if (!rev.before) {
            const [gone] = await tx.delete(meals).where(eq(meals.id, rev.mealId)).returning({ description: meals.description });
            results.push({ mealId: rev.mealId, description: gone?.description ?? "meal", restored: false });
            continue;
          }
          const { id: _id, tgId: _tg, createdAt: _c, updatedAt: _u, ...restorable } = fromSnapshot(rev.before);
          await tx
            .insert(meals)
            .values({ id: rev.mealId, ...restorable })
            .onConflictDoUpdate({ target: meals.id, set: restorable });
          results.push({ mealId: rev.mealId, description: restorable.description, restored: true });
        }
        return results;
      }),
  };
}
