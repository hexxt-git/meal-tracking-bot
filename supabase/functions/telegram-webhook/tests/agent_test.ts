import { assertEquals } from "@std/assert";
import { RunState } from "../src/agent/tools.ts";
import type { Meal } from "../src/db/index.ts";
import { COUNTRY_LETTERS, countriesByLetter, countryName } from "../src/domain/countries.ts";
import { parseCsv, parseMealsCsv, toCsv } from "../src/domain/csv.ts";
import { isEditable } from "../src/domain/meal.ts";
import { nextStep, parseChoice, PROFILE_STEPS } from "../src/domain/onboarding.ts";
import { isMeaningfulEdit } from "../src/domain/question.ts";

const meal = (id: string, kcal: number): Meal => ({
  id, tgId: 1, eatenAt: new Date(0), loggedAt: new Date(0), description: id, userNote: null, items: [], kcal,
  proteinG: 0, carbsG: 0, fatG: 0, photoFileIds: [], sourceMessageId: null, createdAt: new Date(0), updatedAt: new Date(0),
});

Deno.test("run changes fold into their net effect", () => {
  const run = new RunState({} as never, 0, new Date(), null, [], 1);
  run.record("created", meal("a", 100));
  run.record("updated", meal("a", 150), meal("a", 100));
  run.record("updated", meal("b", 300), meal("b", 200));
  run.record("updated", meal("b", 350), meal("b", 300));
  run.record("created", meal("c", 50));
  run.record("deleted", meal("c", 50), meal("c", 50));
  const changes = [...run.changes.values()];
  assertEquals(changes.map((c) => [c.kind, c.meal.id, c.meal.kcal, c.before?.kcal]), [
    ["created", "a", 150, undefined],
    ["updated", "b", 350, 200],
  ]);
});

Deno.test("edit window is 24 hours from logging", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  assertEquals(isEditable(new Date("2026-10-18T12:30:00Z"), now), true);
  assertEquals(isEditable(new Date("2026-10-18T11:30:00Z"), now), false);
});

Deno.test("country step comes last and validates codes", () => {
  assertEquals(PROFILE_STEPS.at(-1), "country");
  assertEquals(nextStep("timezone", "lose"), "country");
  assertEquals(nextStep("country", "lose"), "done");
  const state = { units: "metric", sex: null, age: null, heightCm: null, weightKg: null, activity: null, objective: null, paceKgPerWeek: null } as const;
  assertEquals(parseChoice("country", "DZ", state), { country: "DZ" });
  assertEquals(parseChoice("country", "none", state), { country: null });
  assertEquals(parseChoice("country", "XX", state), null);
  assertEquals(countryName("DZ"), "Algeria");
  assertEquals(countriesByLetter("A").some(([c]) => c === "AX"), true);
  assertEquals(COUNTRY_LETTERS.every((l) => countriesByLetter(l).length > 0), true);
});

Deno.test("csv export round-trips through import", () => {
  const items = [{ name: 'Yogurt, "Greek"', portion: "100 g", kcal: 137, protein_g: 3.2, carbs_g: 17.1, fat_g: 6.2 }];
  const csv = toCsv([
    ["2026-10-19T08:00:00.000Z", "Mon 19 Oct", "09:00", "2026-10-19T09:30:00.000Z", "Breakfast, sweet", 137, 3.2, 17.1, 6.2, JSON.stringify(items), "line 1\nline 2"],
    ["not a date", "", "", "", "Bad", 1, 1, 1, 1, "[]", ""],
  ]);
  const r = parseMealsCsv(csv);
  if (!r.ok) throw new Error(r.error);
  assertEquals(r.invalidRows, 1);
  assertEquals(r.meals.length, 1);
  const m = r.meals[0];
  assertEquals(m.eatenAt.toISOString(), "2026-10-19T08:00:00.000Z");
  assertEquals(m.loggedAt.toISOString(), "2026-10-19T09:30:00.000Z");
  assertEquals(m.description, "Breakfast, sweet");
  assertEquals(m.items, items);
  assertEquals(m.userNote, "line 1\nline 2");
});

Deno.test("csv import accepts older exports and rejects other files", () => {
  const old = 'eaten_at_utc,eaten_local_date,eaten_local_time,description,kcal,protein_g,carbs_g,fat_g,items,note\r\n"2026-10-01T12:00:00Z","","","Lunch","500","30","50","20","not json",""\r\n';
  const r = parseMealsCsv(old);
  assertEquals(r.ok && [r.meals[0].loggedAt.toISOString(), r.meals[0].items.length], ["2026-10-01T12:00:00.000Z", 0]);
  const bad = parseMealsCsv("name,calories\napple,95");
  assertEquals(bad.ok, false);
  assertEquals(parseCsv('a,"b ""c""",d\n'), [["a", 'b "c"', "d"]]);
});

Deno.test("only edits that change words count", () => {
  assertEquals(isMeaningfulEdit("2 eggs and toast", "2 Eggs, and toast!"), false);
  assertEquals(isMeaningfulEdit("2 eggs and toast", "3 eggs and toast"), true);
  assertEquals(isMeaningfulEdit("café au lait", "cafe au lait"), true);
});
