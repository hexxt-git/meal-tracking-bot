import { isNotNull } from "drizzle-orm";
import type { Run } from "../client.ts";
import { users } from "../schema.ts";

/** Cross-user: runs without RLS through the system runner. */
export function mediaWaitsRepo(run: Run) {
  return {
    /** Users with a request waiting for Telegram to deliver its media. */
    pending: () =>
      run(async (tx) =>
        (
          await tx
            .select({ tgId: users.tgId })
            .from(users)
            .where(isNotNull(users.mediaWait))
        ).map((r) => r.tgId),
      ),
  };
}
