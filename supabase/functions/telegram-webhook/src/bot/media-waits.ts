import { systemDb, userDb } from "../db/index.ts";
import { retryMediaWait } from "./assistant.ts";
import { createCtx } from "./context.ts";

/** Retries every request waiting for Telegram to deliver its media. Triggered by the photo-waits pg_cron job. */
export async function retryMediaWaits() {
  const tgIds = await systemDb().mediaWaits.pending();
  await Promise.all(
    tgIds.map(async (tgId) => {
      const db = userDb(tgId);
      const user = await db.users.get();
      if (user) await retryMediaWait(createCtx(user, db));
    }),
  );
}
