import "./support/env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { progressTable } from "../src/bot/format.ts";
import { dayView, undo, weekView } from "../src/bot/screens/journal.ts";
import { dayStart, weekStartDaysAgo } from "../src/domain/time.ts";
import {
  buttons,
  fakeCtx,
  goals,
  meal,
  plain,
  user,
  weight,
} from "./support/fakes.ts";

const HOUR = 3_600_000;
const totals = (
  kcal: number,
  proteinG: number,
  carbsG: number,
  fatG: number,
) => ({ kcal, proteinG, carbsG, fatG });

Deno.test("left line subtracts eaten from each target", () => {
  const out = plain(progressTable(totals(1620, 86, 210, 80), user(goals)));
  assertStringIncludes(
    out,
    "Left: 680 kcal  ·  P 46 g  ·  C 40 g  ·  F over 10 g",
  );
});

Deno.test("left line at exactly the target and over on calories", () => {
  const out = plain(progressTable(totals(2400, 132, 250, 70), user(goals)));
  assertStringIncludes(
    out,
    "Left: over 100 kcal  ·  P 0 g  ·  C 0 g  ·  F 0 g",
  );
});

Deno.test("left values round like the table so they add up on screen", () => {
  const out = plain(progressTable(totals(0, 86.4, 0, 0), user(goals)));
  assertStringIncludes(out, "P 46 g");
  const half = plain(progressTable(totals(0, 85.5, 0, 0), user(goals)));
  assertStringIncludes(half, "P 46 g");
});

Deno.test(
  "no left line without goals; macros without a target are skipped",
  () => {
    assert(
      !plain(progressTable(totals(500, 1, 1, 1), user())).includes("Left"),
    );
    const out = plain(
      progressTable(totals(500, 10, 10, 10), user({ targetKcal: 2000 })),
    );
    assertStringIncludes(out, "Left: 1,500 kcal");
    assert(!out.includes("P "), out);
  },
);

Deno.test("day view shows the left line and day navigation", async () => {
  const { ctx } = fakeCtx({
    user: user(goals),
    meals: [
      meal({ eatenAt: new Date(dayStart(0).getTime() + HOUR), kcal: 300 }),
    ],
  });
  const today = await dayView(ctx, 0);
  assertStringIncludes(plain(today), "Left: 2,000 kcal");
  assertEquals(buttons(today).at(-2), ["day:1"]);
  const yesterday = await dayView(ctx, 1);
  assertStringIncludes(plain(yesterday), "No meals logged.");
  assertEquals(buttons(yesterday).at(-2), ["day:2", "day:0"]);
});

Deno.test("current week runs from Sunday to today", async () => {
  const back = weekStartDaysAgo(0, 0);
  const sunday = dayStart(0, back);
  const { ctx } = fakeCtx({
    meals: [
      meal({ eatenAt: new Date(sunday.getTime() + HOUR), kcal: 1000 }),
      meal({ eatenAt: new Date(sunday.getTime() - HOUR), kcal: 9999 }),
    ],
  });
  const v = await weekView(ctx, 0);
  const rows = plain(v)
    .split("\n")
    .filter((l) => /^\w{3} \d/.test(l));
  assertEquals(rows.length, back + 1);
  assert(rows[0].startsWith("Sun"), rows[0]);
  assertStringIncludes(rows[0], "1,000");
  assert(!plain(v).includes("9,999"));
  assertStringIncludes(plain(v), "This week");
  assertStringIncludes(plain(v), "Average 1,000 kcal over 1 logged day");
  assertEquals(buttons(v)[0], ["week:1"]);
});

Deno.test("past weeks list all seven days and can step forward", async () => {
  const sunday = dayStart(0, weekStartDaysAgo(0, 1));
  const saturday = new Date(sunday.getTime() + 6 * 24 * HOUR + 23 * HOUR);
  const { ctx } = fakeCtx({
    meals: [
      meal({ eatenAt: saturday, kcal: 800 }),
      meal({ eatenAt: new Date(saturday.getTime() + 2 * HOUR), kcal: 5555 }),
    ],
  });
  const v = await weekView(ctx, 1);
  const rows = plain(v)
    .split("\n")
    .filter((l) => /^\w{3} \d/.test(l));
  assertEquals(
    rows.map((r) => r.slice(0, 3)),
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  );
  assertStringIncludes(rows[6], "800");
  assert(!plain(v).includes("5,555"));
  assertStringIncludes(plain(v), "Last week");
  assertEquals(buttons(v)[0], ["week:2", "week:0"]);
  assertStringIncludes(
    plain(await weekView(ctx, 5)),
    "Nothing logged this week.",
  );
});

Deno.test("week days follow the user's timezone", async () => {
  // A meal just after local midnight on Sunday at UTC+14 is Saturday in UTC.
  const off = 14 * 60;
  const sunday = dayStart(off, weekStartDaysAgo(off, 1));
  const { ctx } = fakeCtx({
    user: user({ utcOffsetMinutes: off }),
    meals: [meal({ eatenAt: new Date(sunday.getTime() + 60_000), kcal: 444 })],
  });
  const rows = plain(await weekView(ctx, 1))
    .split("\n")
    .filter((l) => /^\w{3} \d/.test(l));
  assert(rows[0].startsWith("Sun") && rows[0].includes("444"), rows[0]);
});

Deno.test(
  "undo from a reply removes the run's weigh-ins and resyncs the profile",
  async () => {
    const batch = crypto.randomUUID();
    const { ctx, state } = fakeCtx({
      user: user({ weightKg: 71 }),
      weights: [
        weight({ weighedAt: new Date(Date.now() - 48 * HOUR), weightKg: 72 }),
        weight({ weighedAt: new Date(), weightKg: 71, batchId: batch }),
      ],
    });
    const r = await undo(ctx, batch, undefined);
    assertStringIncludes(plain(r.view!), "Removed the weigh-in of 71.0 kg.");
    assertEquals(buttons(r.view!), [["wt:0"]]);
    assertEquals(state.weights.length, 1);
    assertEquals(ctx.user.weightKg, 72);
    assertEquals((await undo(ctx, batch, undefined)).toast, "Already undone");
  },
);
