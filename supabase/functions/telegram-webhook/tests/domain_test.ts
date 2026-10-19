import { assertEquals } from "@std/assert";
import { itemTotals } from "../src/domain/meal.ts";
import { clampStep, nextStep, parseChoice, prevStep, ProfileState, stepAfterKey, stepper } from "../src/domain/onboarding.ts";
import { clampGoal } from "../src/domain/goals.ts";
import {
  dayStart,
  groupByLocalDay,
  isoOffset,
  localDayLabel,
  localIso,
  localStamp,
  localTime,
  mealTimeLabel,
  parseEatenAt,
  TZ_OFFSETS,
  TZ_PAGES,
  tzPage,
  tzPageOf,
} from "../src/domain/time.ts";

const state: ProfileState = {
  units: "metric", sex: null, age: null, heightCm: null, weightKg: null, activity: null, objective: null, paceKgPerWeek: null,
};

Deno.test("onboarding skips pace when maintaining, both ways", () => {
  assertEquals(nextStep("objective", "maintain"), "timezone");
  assertEquals(nextStep("objective", "lose"), "pace");
  assertEquals(nextStep("timezone", null), "country");
  assertEquals(nextStep("country", null), "done");
  assertEquals(prevStep("timezone", "maintain"), "objective");
  assertEquals(prevStep("timezone", "lose"), "pace");
  assertEquals(prevStep("units", null), null);
});

Deno.test("key step leads into the profile only on first setup", () => {
  assertEquals(stepAfterKey("key", false), "units");
  assertEquals(stepAfterKey("key", true), "done");
  assertEquals(stepAfterKey("age", false), "age");
});

Deno.test("button answers are validated against the step", () => {
  assertEquals(parseChoice("sex", "male", state), { sex: "male" });
  assertEquals(parseChoice("sex", "robot", state), null);
  assertEquals(parseChoice("pace", "0.5", { ...state, objective: "lose" }), { paceKgPerWeek: 0.5 });
  assertEquals(parseChoice("pace", "0.75", { ...state, objective: "gain" }), null);
  assertEquals(parseChoice("timezone", "60", state), { utcOffsetMinutes: 60 });
  assertEquals(parseChoice("timezone", "61", state), null);
  assertEquals(parseChoice("objective", "maintain", state), { objective: "maintain", paceKgPerWeek: 0 });
});

Deno.test("steppers convert display units and clamp forged values", () => {
  const h = stepper("height", { ...state, units: "imperial" });
  assertEquals(h.initial, 67);
  assertEquals(h.format(70), `5'10"`);
  assertEquals(h.toPatch(70), { heightCm: 177.8 });
  assertEquals(clampStep(h, 999), 90);
  const w = stepper("weight", { ...state, weightKg: 81.3 });
  assertEquals(w.initial, 81.3);
  assertEquals(clampStep(w, 72.26), 72.5);
  assertEquals(clampStep(w, NaN), 81.3);
  assertEquals(stepper("weight", { ...state, units: "imperial", weightKg: 72.6 }).initial, 160);
});

Deno.test("goal values are clamped", () => {
  assertEquals(clampGoal("kcal", 50), 1000);
  assertEquals(clampGoal("protein", 162.4), 162);
  assertEquals(clampGoal("fat", NaN), 70);
});

Deno.test("timezone pages cover every offset once", () => {
  const all = Array.from({ length: TZ_PAGES }, (_, p) => tzPage(p)).flat();
  assertEquals(all, TZ_OFFSETS);
  assertEquals(tzPage(tzPageOf(60)).includes(60), true);
});

Deno.test("local day boundaries", () => {
  const now = Date.UTC(2026, 9, 19, 23, 30); // 00:30 next day at UTC+1
  assertEquals(dayStart(60, 0, now).toISOString(), "2026-10-19T23:00:00.000Z");
  assertEquals(dayStart(0, 0, now).toISOString(), "2026-10-19T00:00:00.000Z");
  assertEquals(dayStart(-300, 1, now).toISOString(), "2026-10-18T05:00:00.000Z");
  assertEquals(isoOffset(-570), "-09:30");
  assertEquals(localTime(new Date(now), 60), "2026-10-20 00:30");
  assertEquals(localDayLabel(new Date(now), 60), "Tue 20 Oct");
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

Deno.test("time context given to the model", () => {
  const d = new Date("2026-10-19T12:42:30Z");
  assertEquals(localIso(d, 60), "2026-10-19T13:42:30+01:00");
  assertEquals(localIso(d, -570), "2026-10-19T03:12:30-09:30");
  assertEquals(localStamp(d, 60), "Mon 2026-10-19 13:42");
  assertEquals(localStamp(d, 720), "Tue 2026-10-20 00:42");
});

Deno.test("meal time label shows logged time only when it differs", () => {
  const logged = new Date("2026-10-19T12:42:00Z");
  assertEquals(mealTimeLabel(new Date("2026-10-19T12:40:00Z"), logged, 60), "13:40");
  assertEquals(mealTimeLabel(new Date("2026-10-19T09:00:00Z"), logged, 60), "10:00, logged 13:42");
  assertEquals(mealTimeLabel(new Date("2026-10-18T19:00:00Z"), logged, 60), "Sun 18 Oct 20:00, logged Mon 19 Oct 13:42");
});

Deno.test("eaten_at in the user's offset resolves to the right instant", () => {
  const sent = Date.parse("2026-10-19T12:42:00Z");
  assertEquals(parseEatenAt("2026-10-19T10:00:00+01:00", sent)?.toISOString(), "2026-10-19T09:00:00.000Z");
  assertEquals(parseEatenAt("2026-10-19T15:00:00+01:00", sent), null);
});
