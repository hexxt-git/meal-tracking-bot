import { eq, inArray } from "drizzle-orm";
import type { Run } from "../client.ts";
import { photos } from "../schema.ts";

const newPhotoId = () => crypto.randomUUID().slice(0, 8);

export function photosRepo(run: Run) {
  const idsFor = (fileIds: string[]) =>
    run(async (tx) => {
      if (!fileIds.length) return new Map<string, string>();
      const rows = await tx.select().from(photos).where(inArray(photos.fileId, fileIds));
      return new Map(rows.map((r) => [r.fileId, r.id]));
    });

  return {
    /** Ids by Telegram file id; files without one are left out. */
    idsFor,

    /** Ids for these files in the same order, created for files seen for the first time. */
    register: async (fileIds: string[]) => {
      if (!fileIds.length) return [];
      await run((tx) => tx.insert(photos).values(fileIds.map((fileId) => ({ id: newPhotoId(), fileId }))).onConflictDoNothing());
      const ids = await idsFor(fileIds);
      return fileIds.flatMap((f) => ids.get(f) ?? []);
    },

    fileId: (id: string) =>
      run(async (tx) => (await tx.select({ fileId: photos.fileId }).from(photos).where(eq(photos.id, id)))[0]?.fileId ?? null),
  };
}
