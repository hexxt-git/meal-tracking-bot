import { assertEquals } from "@std/assert";
import { computeTargets, parseHeight, parseWeight } from "../src/domain/nutrition.ts";

Deno.test("targets for a moderately active man maintaining", () => {
  // BMR = 800 + 1125 - 150 + 5 = 1780; TDEE = 2759
  assertEquals(
    computeTargets({ sex: "male", age: 30, height_cm: 180, weight_kg: 80, activity: "moderate", objective: "maintain", pace_kg_per_week: 0 }),
    { kcal: 2760, protein_g: 144, carbs_g: 373, fat_g: 77 },
  );
});

Deno.test("cutting applies deficit and higher protein", () => {
  const t = computeTargets({ sex: "female", age: 28, height_cm: 165, weight_kg: 60, activity: "light", objective: "lose", pace_kg_per_week: 0.5 });
  // BMR = 600 + 1031.25 - 140 - 161 = 1330.25; TDEE = 1829.1; -550 = 1279.1
  assertEquals(t.kcal, 1280);
  assertEquals(t.protein_g, 120);
});

Deno.test("calorie floor", () => {
  const t = computeTargets({ sex: "female", age: 60, height_cm: 150, weight_kg: 45, activity: "sedentary", objective: "lose", pace_kg_per_week: 1 });
  assertEquals(t.kcal, 1200);
});

Deno.test("height parsing", () => {
  assertEquals(parseHeight("180", "metric"), 180);
  assertEquals(parseHeight("1.75", "metric"), 175);
  assertEquals(parseHeight("5'10", "imperial"), 177.8);
  assertEquals(parseHeight("5'10\"", "metric"), 177.8);
  assertEquals(parseHeight("70", "imperial"), 177.8);
  assertEquals(parseHeight("tall", "metric"), null);
});

Deno.test("weight parsing", () => {
  assertEquals(parseWeight("72", "metric"), 72);
  assertEquals(parseWeight("72,5kg", "imperial"), 72.5);
  assertEquals(parseWeight("160", "imperial"), 72.6);
  assertEquals(parseWeight("160 lbs", "metric"), 72.6);
});
