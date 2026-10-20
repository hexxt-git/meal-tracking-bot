import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { chatMessages } from "../schema.ts";

export function messagesRepo(run: Run) {
  return {
    get: (messageId: number) =>
      run(async (tx) => (await tx.select().from(chatMessages).where(eq(chatMessages.messageId, messageId)))[0] ?? null),

    /** Stores (or, after an edit, replaces) the text the user sent. */
    remember: (messageId: number, text: string, sentAt: Date, attachments: string[] = []) =>
      run((tx) =>
        tx.insert(chatMessages).values({ messageId, text, sentAt, attachments }).onConflictDoUpdate({
          target: [chatMessages.tgId, chatMessages.messageId],
          set: { text },
        })
      ),

    rememberReply: (messageId: number, text: string) =>
      run((tx) => tx.insert(chatMessages).values({ messageId, text, sentAt: new Date(), role: "assistant" }).onConflictDoNothing()),

    /** The latest `limit` messages from both sides, oldest first, leaving out `exceptId`. */
    recent: (limit: number, exceptId: number) =>
      run(async (tx) =>
        (await tx.select().from(chatMessages).where(ne(chatMessages.messageId, exceptId)).orderBy(desc(chatMessages.createdAt)).limit(limit))
          .reverse()
      ),

    /** Records that the reply to this message changed meals under `batchId`. */
    addBatch: (messageId: number, batchId: string) =>
      run((tx) =>
        tx.update(chatMessages)
          .set({ batchIds: sql`array_append(${chatMessages.batchIds}, ${batchId}::uuid)` })
          .where(and(eq(chatMessages.messageId, messageId), eq(chatMessages.role, "user")))
      ),
  };
}
