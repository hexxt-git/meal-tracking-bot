import { eq, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { processedUpdates, User, UserPatch, users } from "../schema.ts";

export type Admission = { status: "duplicate" } | { status: "rate_limited"; user: User } | { status: "ok"; user: User };

export function usersRepo(run: Run, tgId: number) {
  return {
    /** Dedupes the Telegram update, counts it against the hourly limit and upserts the user, in one transaction. */
    admit(input: { updateId: number; chatId: number; firstName: string | null; maxPerHour: number }): Promise<Admission> {
      return run(async (tx) => {
        const fresh = await tx.insert(processedUpdates).values({ updateId: input.updateId }).onConflictDoNothing().returning();
        if (!fresh.length) return { status: "duplicate" as const };

        const [{ ok }] = await tx.execute<{ ok: boolean }>(
          sql`select app.rate_limit_hit('messages', ${input.maxPerHour}, '1 hour') as ok`,
        );
        const [user] = await tx
          .insert(users)
          .values({ tgId, chatId: input.chatId, firstName: input.firstName })
          .onConflictDoUpdate({ target: users.tgId, set: { chatId: input.chatId, firstName: input.firstName } })
          .returning();
        return { status: ok ? "ok" as const : "rate_limited" as const, user };
      });
    },

    update(patch: UserPatch): Promise<User> {
      return run(async (tx) => {
        const [user] = await tx.update(users).set(patch).where(eq(users.tgId, tgId)).returning();
        return user;
      });
    },

    /** Removes the profile, meals, Vault key and bookkeeping rows. */
    deleteAccount(): Promise<void> {
      return run(async (tx) => {
        await tx.execute(sql`select app.delete_account()`);
      });
    },
  };
}
