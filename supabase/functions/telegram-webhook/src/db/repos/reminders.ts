import { eq, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { users } from "../schema.ts";

export type DueReminder = { tgId: number; chatId: number; hours: number };

/** Cross-user: runs without RLS through the system runner. */
export function remindersRepo(run: Run) {
  return {
    /**
     * Picks users whose latest meal (or signup, if none) is at least one threshold old and who haven't had that
     * threshold's reminder yet, and marks them as reminded. Only the highest due threshold is returned per user.
     * The `last_reminder_at is not distinct from` check makes a concurrent run skip rows this one already claimed.
     */
    claimDue: (hours: number[]) =>
      run(async (tx) => {
        const rows = await tx.execute<{ tg_id: string; chat_id: string; hours: number }>(sql`
          with due as (
            select u.tg_id, u.last_reminder_at, l.last_meal_at,
              (select max(h) from unnest(${`{${hours.join(",")}}`}::int[]) h
                where l.last_meal_at + make_interval(hours => h) <= now()) as hours
            from app.users u
            cross join lateral (
              select coalesce(max(m.logged_at), u.created_at) as last_meal_at from app.meals m where m.tg_id = u.tg_id
            ) l
            where u.reminders_enabled and u.onboarding_step = 'done'
          )
          update app.users u set last_reminder_at = now()
          from due d
          where u.tg_id = d.tg_id
            and d.hours is not null
            and (d.last_reminder_at is null or d.last_reminder_at < d.last_meal_at + make_interval(hours => d.hours))
            and u.last_reminder_at is not distinct from d.last_reminder_at
          returning u.tg_id, u.chat_id, d.hours`);
        return rows.map((r): DueReminder => ({ tgId: Number(r.tg_id), chatId: Number(r.chat_id), hours: Number(r.hours) }));
      }),

    /** For users who blocked the bot. */
    disable: (tgId: number) => run((tx) => tx.update(users).set({ remindersEnabled: false }).where(eq(users.tgId, tgId))),
  };
}
