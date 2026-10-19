import { eq, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { chatMessages } from "../schema.ts";

export function messagesRepo(run: Run) {
  return {
    get: (messageId: number) =>
      run(async (tx) => (await tx.select().from(chatMessages).where(eq(chatMessages.messageId, messageId)))[0] ?? null),

    /** Stores (or, after an edit, replaces) the text the user sent. */
    remember: (messageId: number, text: string, sentAt: Date) =>
      run((tx) =>
        tx.insert(chatMessages).values({ messageId, text, sentAt }).onConflictDoUpdate({
          target: [chatMessages.tgId, chatMessages.messageId],
          set: { text },
        })
      ),

    /** Records that the reply to this message changed meals under `batchId`. */
    addBatch: (messageId: number, batchId: string) =>
      run((tx) =>
        tx.update(chatMessages)
          .set({ batchIds: sql`array_append(${chatMessages.batchIds}, ${batchId}::uuid)` })
          .where(eq(chatMessages.messageId, messageId))
      ),
  };
}
