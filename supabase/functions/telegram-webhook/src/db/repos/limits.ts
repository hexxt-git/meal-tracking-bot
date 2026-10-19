import { sql } from "drizzle-orm";
import type { Run } from "../client.ts";

export function limitsRepo(run: Run) {
  return {
    /** Counts a hit in a fixed window; true if still within `max`. */
    hit: (bucket: string, max: number, window: string) =>
      run(async (tx) => {
        const [row] = await tx.execute<{ ok: boolean }>(sql`select app.rate_limit_hit(${bucket}, ${max}, ${window}::interval) as ok`);
        return row.ok;
      }),
  };
}
