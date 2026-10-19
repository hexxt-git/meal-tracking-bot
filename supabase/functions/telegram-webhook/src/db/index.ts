import { userRunner } from "./client.ts";
import { albumsRepo } from "./repos/albums.ts";
import { keysRepo } from "./repos/keys.ts";
import { limitsRepo } from "./repos/limits.ts";
import { mealsRepo } from "./repos/meals.ts";
import { usersRepo } from "./repos/users.ts";

export type { Meal, User } from "./schema.ts";
export type { Admission } from "./repos/users.ts";

/** Data access for one Telegram user. Every call runs under RLS as that user. */
export function userDb(tgId: number) {
  const run = userRunner(tgId);
  return {
    users: usersRepo(run, tgId),
    meals: mealsRepo(run),
    keys: keysRepo(run),
    limits: limitsRepo(run),
    albums: albumsRepo(run),
  };
}

export type UserDb = ReturnType<typeof userDb>;
