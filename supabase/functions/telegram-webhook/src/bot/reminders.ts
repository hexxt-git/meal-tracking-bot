import { systemDb } from "../db/index.ts";
import { REMINDER_HOURS, reminderText } from "../domain/reminders.ts";
import { telegram } from "../telegram/api.ts";

/** Sends every reminder that is due. Triggered by the `reminders` pg_cron job every 15 minutes. */
export async function sendReminders(): Promise<number> {
  const db = systemDb();
  const due = await db.reminders.claimDue(REMINDER_HOURS);
  let sent = 0;
  for (const r of due) {
    try {
      await telegram.send(r.chatId, reminderText(r.hours));
      sent++;
    } catch (e) {
      if (e instanceof Error && e.message.includes("Forbidden")) await db.reminders.disable(r.tgId);
      else console.error("reminder", r.tgId, e);
    }
  }
  return sent;
}
