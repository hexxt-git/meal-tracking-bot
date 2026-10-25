import { sql } from "drizzle-orm";
import type { ProviderSecret } from "../../domain/ai-settings.ts";
import type { Run } from "../client.ts";

/** OpenRouter keys and custom provider secrets live in Supabase Vault and are reachable only through the caller-scoped definer functions. */
export function keysRepo(run: Run) {
  return {
    set: (key: string) =>
      run(
        async (tx) =>
          void (await tx.execute(sql`select app.set_openrouter_key(${key})`)),
      ),
    get: () =>
      run(async (tx) => {
        const [row] = await tx.execute<{ key: string | null }>(
          sql`select app.get_openrouter_key() as key`,
        );
        return row.key;
      }),
    delete: () =>
      run(
        async (tx) =>
          void (await tx.execute(sql`select app.delete_openrouter_key()`)),
      ),
    /** Token and extra headers of the custom provider, stored as one JSON secret. */
    getProvider: () =>
      run(async (tx) => {
        const [row] = await tx.execute<{ secret: string | null }>(
          sql`select app.get_provider_secret() as secret`,
        );
        return row.secret ? (JSON.parse(row.secret) as ProviderSecret) : null;
      }),
    setProvider: (secret: ProviderSecret) =>
      run(
        async (tx) =>
          void (await tx.execute(
            sql`select app.set_provider_secret(${JSON.stringify(secret)})`,
          )),
      ),
    deleteProvider: () =>
      run(
        async (tx) =>
          void (await tx.execute(sql`select app.delete_provider_secret()`)),
      ),
  };
}
