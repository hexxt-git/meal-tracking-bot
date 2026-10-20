import { systemRunner, userRunner } from "./client.ts";
export { ping } from "./client.ts";
import { albumsRepo } from "./repos/albums.ts";
import { keysRepo } from "./repos/keys.ts";
import { limitsRepo } from "./repos/limits.ts";
import { mealsRepo } from "./repos/meals.ts";
import { messagesRepo } from "./repos/messages.ts";
import { remindersRepo } from "./repos/reminders.ts";
import { usageRepo } from "./repos/usage.ts";
import { usersRepo } from "./repos/users.ts";

export type { Meal, User } from "./schema.ts";

/** Data access for one Telegram user. Every call runs under RLS as that user. */
export function userDb(tgId: number) {
  const run = userRunner(tgId);
  return {
    users: usersRepo(run, tgId),
    meals: mealsRepo(run),
    keys: keysRepo(run),
    limits: limitsRepo(run),
    albums: albumsRepo(run),
    usage: usageRepo(run),
    messages: messagesRepo(run),
  };
}

export type UserDb = ReturnType<typeof userDb>;

/** Data access for scheduled jobs that span users. Bypasses RLS, so it exposes only what those jobs need. */
export function systemDb() {
  return { reminders: remindersRepo(systemRunner) };
}
