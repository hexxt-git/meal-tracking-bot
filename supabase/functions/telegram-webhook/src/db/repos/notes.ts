import { asc, eq, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { Note, userNotes } from "../schema.ts";

export function notesRepo(run: Run) {
  return {
    /** Oldest first. */
    list: () =>
      run((tx) =>
        tx.select().from(userNotes).orderBy(asc(userNotes.createdAt)),
      ),

    byId: (id: string): Promise<Note | null> =>
      run(
        async (tx) =>
          (await tx.select().from(userNotes).where(eq(userNotes.id, id)))[0] ??
          null,
      ),

    create: (text: string) =>
      run(
        async (tx) =>
          (await tx.insert(userNotes).values({ text }).returning())[0],
      ),

    /** Null if the note is gone. */
    update: (id: string, text: string): Promise<Note | null> =>
      run(
        async (tx) =>
          (
            await tx
              .update(userNotes)
              .set({ text, updatedAt: sql`now()` })
              .where(eq(userNotes.id, id))
              .returning()
          )[0] ?? null,
      ),

    /** The deleted note, or null if it was already gone. */
    delete: (id: string): Promise<Note | null> =>
      run(
        async (tx) =>
          (
            await tx.delete(userNotes).where(eq(userNotes.id, id)).returning()
          )[0] ?? null,
      ),
  };
}
