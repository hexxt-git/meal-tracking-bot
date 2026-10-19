import postgres from "postgres";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

// Transaction-mode pooler: no prepared statements.
const client = postgres(config.databaseUrl, { prepare: false, max: 3 });

// Not exported: this connection bypasses RLS. All access goes through `userRunner`.
const db = drizzle(client, { schema });

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** A runner whose transactions execute as `bot_user` scoped to one Telegram user, so RLS applies to every query. */
export function userRunner(tgId: number): Run {
  return (fn) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tg_id', ${String(tgId)}, true)`);
      await tx.execute(sql`set local role bot_user`);
      return await fn(tx);
    });
}

/** Runs a trivial real query so Supabase sees database activity (free projects pause when idle). */
export async function ping(): Promise<void> {
  await db.execute(sql`select count(*) from app.users`);
}
