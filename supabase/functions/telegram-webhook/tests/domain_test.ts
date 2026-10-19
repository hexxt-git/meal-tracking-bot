import { assertEquals } from "@std/assert";
import { itemTotals } from "../src/domain/meal.ts";
import { nextStep, parseChoice, parseTextAnswer, ProfileState, stepAfterKey } from "../src/domain/onboarding.ts";
import { dayStart, groupByLocalDay, isoOffset, localTime, parseEatenAt } from "../src/domain/time.ts";

const state: ProfileState = {
  units: "metric", sex: null, age: null, heightCm: null, weightKg: null, activity: null, objective: null, paceKgPerWeek: null,
};

Deno.test("onboarding skips pace when maintaining", () => {
  assertEquals(nextStep("objective", { objective: "maintain" }), "timezone");
  assertEquals(nextStep("objective", { objective: "lose" }), "pace");
  assertEquals(nextStep("timezone", {}), "done");
});

Deno.test("key step leads into the profile only on first setup", () => {
  assertEquals(stepAfterKey("key", false), "units");
  assertEquals(stepAfterKey("key", true), "done");
  assertEquals(stepAfterKey("age", false), "age");
});

Deno.test("button answers are validated against the step", () => {
  assertEquals(parseChoice("sex", "male", state)?.patch, { sex: "male" });
  assertEquals(parseChoice("sex", "robot", state), null);
  assertEquals(parseChoice("pace", "0.5", { ...state, objective: "lose" })?.patch, { paceKgPerWeek: 0.5 });
  assertEquals(parseChoice("pace", "0.75", { ...state, objective: "gain" }), null);
  assertEquals(parseChoice("timezone", "60", state)?.label, "UTC+01:00");
  assertEquals(parseChoice("timezone", "61", state), null);
  assertEquals(parseChoice("objective", "maintain", state)?.patch, { objective: "maintain", paceKgPerWeek: 0 });
});

Deno.test("text answers", () => {
  assertEquals(parseTextAnswer("age", "29", "metric"), { patch: { age: 29 } });
  assertEquals("error" in parseTextAnswer("age", "abc", "metric"), true);
  assertEquals(parseTextAnswer("weight", "170", "imperial"), { patch: { weightKg: 77.1 } });
});

Deno.test("local day boundaries", () => {
  const now = Date.UTC(2026, 9, 19, 23, 30); // 00:30 next day at UTC+1
  assertEquals(dayStart(60, 0, now).toISOString(), "2026-10-19T23:00:00.000Z");
  assertEquals(dayStart(0, 0, now).toISOString(), "2026-10-19T00:00:00.000Z");
  assertEquals(dayStart(-300, 1, now).toISOString(), "2026-10-18T05:00:00.000Z");
  assertEquals(isoOffset(-570), "-09:30");
  assertEquals(localTime(new Date(now), 60), "2026-10-20 00:30");
});

Deno.test("eaten_at sanity window", () => {
  const now = Date.UTC(2026, 9, 19, 12);
  assertEquals(parseEatenAt("2026-10-18T19:00:00+01:00", now)?.toISOString(), "2026-10-18T18:00:00.000Z");
  assertEquals(parseEatenAt("2026-10-21T19:00:00Z", now), null);
  assertEquals(parseEatenAt("garbage", now), null);
  assertEquals(parseEatenAt(null, now), null);
});

Deno.test("grouping and totals", () => {
  const rows = [
    { eatenAt: new Date("2026-10-19T22:30:00Z"), kcal: 100 },
    { eatenAt: new Date("2026-10-19T23:30:00Z"), kcal: 200 },
  ];
  assertEquals([...groupByLocalDay(rows, 60).keys()], ["2026-10-19", "2026-10-20"]);
  assertEquals(
    itemTotals([
      { name: "a", portion: "1", kcal: 100, protein_g: 1.25, carbs_g: 2, fat_g: 3 },
      { name: "b", portion: "1", kcal: 50, protein_g: 1.3, carbs_g: 0, fat_g: 0.04 },
    ]),
    { kcal: 150, proteinG: 2.6, carbsG: 2, fatG: 3 },
  );
});
