import { and, eq } from "drizzle-orm";
import type { Run } from "../client.ts";
import { mediaGroupItems } from "../schema.ts";

export function albumsRepo(run: Run) {
  return {
    add: (item: { mediaGroupId: string; messageId: number; fileId: string; caption: string | null }) =>
      run(async (tx) => void await tx.insert(mediaGroupItems).values(item).onConflictDoNothing()),

    /** Atomically takes every unclaimed item of the album; only the first caller gets rows. */
    claim: (mediaGroupId: string) =>
      run((tx) =>
        tx
          .update(mediaGroupItems)
          .set({ claimed: true })
          .where(and(eq(mediaGroupItems.mediaGroupId, mediaGroupId), eq(mediaGroupItems.claimed, false)))
          .returning({ fileId: mediaGroupItems.fileId, caption: mediaGroupItems.caption })
      ),
  };
}
