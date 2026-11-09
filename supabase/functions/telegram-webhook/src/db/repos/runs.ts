import { and, eq, sql } from "drizzle-orm";
import type { Run } from "../client.ts";
import { users } from "../schema.ts";
import type { ActiveRun } from "../../domain/question.ts";

const holds = (tgId: number, runId: string) =>
  and(eq(users.tgId, tgId), sql`${users.agentRun}->>'id' = ${runId}`);

/** The user's single assistant run slot. Row locks make taking it over and the holder's writes mutually exclusive. */
export function runsRepo(run: Run, tgId: number) {
  return {
    /** `decide` gets the current holder and returns the run to store, or null to leave the slot alone. */
    claim: (decide: (current: ActiveRun | null) => ActiveRun | null) =>
      run(async (tx) => {
        const [row] = await tx
          .select({ current: users.agentRun })
          .from(users)
          .where(eq(users.tgId, tgId))
          .for("update");
        const next = decide(row?.current ?? null);
        if (next)
          await tx
            .update(users)
            .set({ agentRun: next })
            .where(eq(users.tgId, tgId));
        return next;
      }),

    holds: (runId: string) =>
      run(
        async (tx) =>
          (
            await tx
              .select({ tgId: users.tgId })
              .from(users)
              .where(holds(tgId, runId))
          ).length > 0,
      ),

    /** Marks the run as replying so it can't be taken over; false if it already was. */
    commit: (runId: string) =>
      run(
        async (tx) =>
          (
            await tx
              .update(users)
              .set({
                agentRun: sql`jsonb_set(${users.agentRun}, '{committedAt}', to_jsonb(now()))`,
              })
              .where(holds(tgId, runId))
              .returning({ tgId: users.tgId })
          ).length > 0,
      ),

    release: (runId: string) =>
      run(
        async (tx) =>
          void (await tx
            .update(users)
            .set({ agentRun: null })
            .where(holds(tgId, runId))),
      ),
  };
}

/**
 * A runner whose transactions first share-lock the user row and throw `Superseded` unless `runId` holds the slot,
 * so a run that was taken over can't write after the takeover undid its changes.
 */
export function guardedRunner(
  run: Run,
  tgId: number,
  runId: string,
  onSuperseded: () => void,
): Run {
  return (fn) =>
    run(async (tx) => {
      const rows = await tx
        .select({ tgId: users.tgId })
        .from(users)
        .where(holds(tgId, runId))
        .for("share");
      if (!rows.length) {
        onSuperseded();
        throw new Superseded();
      }
      return await fn(tx);
    });
}

export class Superseded extends Error {
  constructor() {
    super("A newer message took over this run");
  }
}
