import { sql } from "drizzle-orm";
import type { Run } from "../client.ts";

/** OpenRouter keys live in Supabase Vault and are reachable only through the caller-scoped definer functions. */
export function keysRepo(run: Run) {
  return {
    set: (key: string) => run(async (tx) => void await tx.execute(sql`select app.set_openrouter_key(${key})`)),
    get: () =>
      run(async (tx) => {
        const [row] = await tx.execute<{ key: string | null }>(sql`select app.get_openrouter_key() as key`);
        return row.key;
      }),
    delete: () => run(async (tx) => void await tx.execute(sql`select app.delete_openrouter_key()`)),
  };
}
