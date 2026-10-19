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

async function recordRevision(tx: Tx, mealId: string, before: Meal | null) {
  const [rev] = await tx
    .insert(mealRevisions)
    .values({ mealId, before: before && toSnapshot(before) })
    .returning({ id: mealRevisions.id });
  return rev.id;
}

export function mealsRepo(run: Run) {
  return {
    byId: (id: string) => run(async (tx) => (await tx.select().from(meals).where(eq(meals.id, id)))[0] ?? null),

    /** Most recently logged first (not eaten), so "it" means the meal the user just sent. */
    recentlyLogged: (limit: number) => run((tx) => tx.select().from(meals).orderBy(desc(meals.loggedAt)).limit(limit)),

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

    /** Inserts the meal and an undo record for it. */
    create: (meal: NewMeal) =>
      run(async (tx) => {
        const [row] = await tx.insert(meals).values(meal).returning();
        return { meal: row, revisionId: await recordRevision(tx, row.id, null) };
      }),

    /** Updates the meal, keeping its prior state for undo. */
    update: (id: string, patch: Partial<NewMeal>) =>
      run(async (tx) => {
        const [before] = await tx.select().from(meals).where(eq(meals.id, id)).for("update");
        if (!before) return null;
        const revisionId = await recordRevision(tx, id, before);
        const [meal] = await tx.update(meals).set(patch).where(eq(meals.id, id)).returning();
        return { meal, before, revisionId };
      }),

    /** Deletes the meal, keeping it for undo. Returns the revision id, or null if it was already gone. */
    delete: (id: string) =>
      run(async (tx) => {
        const [before] = await tx.delete(meals).where(eq(meals.id, id)).returning();
        return before ? await recordRevision(tx, id, before) : null;
      }),

    /** Reverts one create/update/delete. Null if it was already undone. */
    undo: (revisionId: string) =>
      run(async (tx) => {
        const [rev] = await tx
          .update(mealRevisions)
          .set({ undoneAt: new Date() })
          .where(and(eq(mealRevisions.id, revisionId), isNull(mealRevisions.undoneAt)))
          .returning();
        if (!rev) return null;
        if (!rev.before) {
          const [gone] = await tx.delete(meals).where(eq(meals.id, rev.mealId)).returning({ description: meals.description });
          return { mealId: rev.mealId, description: gone?.description ?? "meal", restored: false };
        }
        const { id: _id, tgId: _tg, createdAt: _c, updatedAt: _u, ...restorable } = fromSnapshot(rev.before);
        await tx
          .insert(meals)
          .values({ id: rev.mealId, ...restorable })
          .onConflictDoUpdate({ target: meals.id, set: restorable });
        return { mealId: rev.mealId, description: restorable.description, restored: true };
      }),
  };
}
