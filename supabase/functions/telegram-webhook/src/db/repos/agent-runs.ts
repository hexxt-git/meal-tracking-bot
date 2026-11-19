import { eq } from "drizzle-orm";
import type { Run } from "../client.ts";
import { agentRuns, RunEnd, RunStart } from "../schema.ts";

/** Debug record of each assistant run; failures here are logged and never break the run. */
export function agentRunsRepo(run: Run) {
  const quiet = (p: Promise<unknown>) =>
    p.then(
      () => {},
      (e) => console.error("agent_runs", e),
    );
  return {
    start: (row: RunStart) =>
      quiet(
        run((tx) => tx.insert(agentRuns).values(row).onConflictDoNothing()),
      ),
    finish: (id: string, end: RunEnd) =>
      quiet(
        run((tx) =>
          tx
            .update(agentRuns)
            .set({ ...end, finishedAt: new Date() })
            .where(eq(agentRuns.id, id)),
        ),
      ),
  };
}
