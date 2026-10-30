import { resetTelegram, telegramCalls } from "./support/env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { mealBody, mealButtonLabel } from "../src/bot/format.ts";
import {
  menuView,
  profileView,
  setUnits,
  settingsTimezone,
} from "../src/bot/screens/account.ts";
import { countryAction, countryPicker } from "../src/bot/screens/country.ts";
import {
  deleteMeal,
  historyView,
  importCsv,
  isCsvFile,
  mealView,
} from "../src/bot/screens/journal.ts";
import { onboardingAction, stepView } from "../src/bot/screens/onboarding.ts";
import { tzPicker } from "../src/bot/screens/timezone.ts";
import { bar, rows, table, truncate } from "../src/bot/ui.ts";
import {
  COUNTRIES,
  COUNTRY_LETTERS,
  countriesByLetter,
  countryName,
  isCountry,
} from "../src/domain/countries.ts";
import { TZ_OFFSETS } from "../src/domain/time.ts";
import { buttons, fakeCtx, meal, plain, user } from "./support/fakes.ts";

const HOUR = 3_600_000;

// --- UI helpers ---

Deno.test("bars clamp at full and handle a zero target", () => {
  assertEquals(bar(0, 100), "░".repeat(10));
  assertEquals(bar(50, 100), "█".repeat(5) + "░".repeat(5));
  assertEquals(bar(500, 100), "█".repeat(10));
  assertEquals(bar(10, 0), "░".repeat(10));
  assertEquals(bar(-5, 100), "░".repeat(10));
});

Deno.test("tables pad columns, escape HTML and trim trailing space", () => {
  assertEquals(
    table(
      [
        ["a", "1", ""],
        ["<b>", "100", "x"],
      ],
      ["l", "r", "l"],
    ),
    "<pre>a      1\n&lt;b&gt;  100  x</pre>",
  );
});

Deno.test("truncate and rows", () => {
  assertEquals(truncate("abcdef", 4), "abc…");
  assertEquals(truncate("abcd", 4), "abcd");
  assertEquals(rows([1, 2, 3, 4, 5] as never[], 2).length, 3);
  assertEquals(rows([], 2), []);
});

Deno.test(
  "meal text escapes names and notes from the model and the user",
  () => {
    const m = meal({
      eatenAt: new Date(),
      description: "<script>",
      userNote: "a & b <i>",
      items: [
        {
          name: "Fish & <chips>",
          portion: "1 <plate>",
          kcal: 700,
          protein_g: 1,
          carbs_g: 1,
          fat_g: 1,
        },
      ],
    });
    const html = mealBody(m);
    assertStringIncludes(html, "Fish &amp; &lt;chips&gt;, 1 &lt;plate&gt;");
    assertStringIncludes(html, "a &amp; b &lt;i&gt;");
    assert(!html.includes("<script>"));
    assertStringIncludes(
      mealButtonLabel({ ...m, description: "x".repeat(40) }, user()),
      "…",
    );
  },
);

// --- Journal screens ---

Deno.test("history pages and meal origin round-trip", async () => {
  const meals = Array.from({ length: 9 }, (_, i) =>
    meal({ eatenAt: new Date(Date.now() - i * HOUR), description: `m${i}` }),
  );
  const { ctx } = fakeCtx({ meals });
  const first = await historyView(ctx, 0);
  assertEquals(buttons(first).length, 8 + 2);
  assertEquals(buttons(first)[0], [`meal:${meals[0].id}:h0`]);
  assertEquals(buttons(first).at(-2), ["hist:1"]);
  const second = await historyView(ctx, 1);
  assertEquals(buttons(second).at(-2), ["hist:0"]);

  const v = await mealView(ctx, meals[0].id, "h1");
  assertEquals(buttons(v), [[`del:${meals[0].id}:h1`, "hist:1"]]);
  const fromDay = await mealView(ctx, meals[0].id, "d3");
  assertEquals(buttons(fromDay)[0][1], "day:3");
  assertStringIncludes(
    plain(await mealView(ctx, "nope", "d0")),
    "no longer exists",
  );
});

Deno.test("empty history", async () => {
  const { ctx } = fakeCtx();
  const v = await historyView(ctx, 0);
  assertStringIncludes(plain(v), "No meals logged yet.");
  assertEquals(buttons(v), [["menu"]]);
});

Deno.test("deleting a meal twice says so", async () => {
  const m = meal({ eatenAt: new Date() });
  const { ctx, state } = fakeCtx({ meals: [m] });
  const r = await deleteMeal(ctx, m.id, "d0");
  assertStringIncludes(plain(r.view!), "Deleted Meal.");
  assertEquals(state.meals.length, 0);
  assertEquals((await deleteMeal(ctx, m.id, "d0")).toast, "Already deleted");
});

Deno.test("csv files are recognized by type or name", () => {
  assert(isCsvFile({ file_id: "1", mime_type: "text/csv" }));
  assert(isCsvFile({ file_id: "1", file_name: "MEALS.CSV" }));
  assert(isCsvFile({ file_id: "1", mime_type: "text/comma-separated-values" }));
  assert(!isCsvFile({ file_id: "1", file_name: "meals.csv.exe" }));
  assert(!isCsvFile({ file_id: "1", mime_type: "application/pdf" }));
});

Deno.test("oversized imports are refused before downloading", async () => {
  resetTelegram();
  const { ctx, sent } = fakeCtx();
  await importCsv(ctx, { file_id: "f", file_size: 2_000_001 });
  assertStringIncludes(plain(sent[0]), "too large");
  assertEquals(telegramCalls.length, 0);
});

// --- Settings and onboarding ---

Deno.test(
  "switching units re-renders settings; forged units are ignored",
  async () => {
    const { ctx } = fakeCtx();
    await setUnits(ctx, ["imperial"]);
    assertEquals(ctx.user.units, "imperial");
    await setUnits(ctx, ["furlongs"]);
    assertEquals(ctx.user.units, "imperial");
  },
);

Deno.test(
  "profile shows imperial values and dashes for missing answers",
  () => {
    const { ctx } = fakeCtx({
      user: user({
        units: "imperial",
        heightCm: 180,
        weightKg: 80,
        objective: "lose",
        paceKgPerWeek: 0.5,
      }),
    });
    const out = plain(profileView(ctx));
    assertStringIncludes(out, `5'11"`);
    assertStringIncludes(out, "176 lb");
    assertStringIncludes(out, "Lose 1.1 lb/wk");
    assertStringIncludes(out, "Sex       –");
  },
);

Deno.test("settings timezone: forged offsets are ignored", async () => {
  const { ctx, state } = fakeCtx();
  assertEquals(await settingsTimezone(ctx, ["61"]), {});
  assertEquals(await settingsTimezone(ctx, [""]), {});
  assertEquals(state.updates, []);
  const r = await settingsTimezone(ctx, ["-570"]);
  assertEquals(r.toast, "Timezone saved");
  assertEquals(ctx.user.utcOffsetMinutes, -570);
});

Deno.test("onboarding ignores taps on steps already answered", async () => {
  const { ctx } = fakeCtx({ user: user({ onboardingStep: "age" }) });
  assertEquals(
    (await onboardingAction(ctx, ["sex", "male"])).toast,
    "That step was already answered",
  );
  await onboardingAction(ctx, ["age", "ok", "30.5"]);
  assertEquals(ctx.user.age, 31);
  assertEquals(ctx.user.onboardingStep, "height");
  assertEquals(await onboardingAction(ctx, ["height", "zz", "1"]), {});
});

Deno.test("onboarding steppers clamp forged values in their buttons", () => {
  const { ctx } = fakeCtx({ user: user({ onboardingStep: "age" }) });
  const v = stepView(ctx, 500);
  assertStringIncludes(plain(v), "100 years");
  assert(buttons(v)[0].every((d) => Number(d.split(":")[3]) <= 100));
});

Deno.test(
  "onboarding finishes with goals once the last step is answered",
  async () => {
    resetTelegram();
    const { ctx } = fakeCtx({
      user: user({
        onboardingStep: "country",
        sex: "male",
        age: 30,
        heightCm: 180,
        weightKg: 80,
        activity: "moderate",
        objective: "maintain",
        paceKgPerWeek: 0,
      }),
    });
    const r = await onboardingAction(ctx, ["country", "DZ"]);
    assertEquals(ctx.user.onboardingStep, "done");
    assertEquals(ctx.user.country, "DZ");
    assertEquals(ctx.user.targetKcal, 2760);
    assertStringIncludes(plain(r.view!), "Setup complete");
    assertEquals(
      telegramCalls.map((c) => c.method),
      ["sendMessage"],
    );
  },
);

Deno.test(
  "onboarding back from timezone skips pace when maintaining",
  async () => {
    const { ctx } = fakeCtx({
      user: user({ onboardingStep: "timezone", objective: "maintain" }),
    });
    await onboardingAction(ctx, ["back"]);
    assertEquals(ctx.user.onboardingStep, "objective");
    const first = fakeCtx({ user: user({ onboardingStep: "units" }) });
    assertEquals(await onboardingAction(first.ctx, ["back"]), {});
  },
);

// --- Pickers ---

Deno.test(
  "country picker lists each country once and pages within a letter",
  () => {
    const names = Object.values(COUNTRIES);
    assertEquals(new Set(names).size, names.length);
    for (const l of COUNTRY_LETTERS) {
      const shown = countryPicker("s", { letter: l, page: 0 }).flat();
      assert(shown.length > 1, l);
    }
    const s = countriesByLetter("S").length;
    const lastPage = countryPicker("s", { letter: "S", page: 99 });
    const nav = lastPage.at(-1)!.map((b) => b.text);
    assert(nav.includes("‹ Prev") && !nav.includes("More ›"), `S has ${s}`);
    assertEquals(
      countryPicker("o", { letter: "1", page: 0 }).flat().length,
      COUNTRY_LETTERS.length,
    );
    assertEquals(countryName("UK"), "United Kingdom");
    assertEquals(isCountry("UK"), false);
    assertEquals(countryName("toString"), null);
    assertEquals(countryName(null), null);
  },
);

Deno.test("country picks from settings are validated", async () => {
  const { ctx, state } = fakeCtx();
  assertEquals(await countryAction(ctx, ["s", "c", "XX"]), {});
  assertEquals(await countryAction(ctx, ["s", "c", "toString"]), {});
  assertEquals(state.updates, []);
  assertEquals(
    (await countryAction(ctx, ["s", "c", "FR"])).toast,
    "Country saved",
  );
  assertEquals(ctx.user.country, "FR");
  assertEquals(
    (await countryAction(ctx, ["o", "c", "FR"])).toast,
    "That step was already answered",
  );
});

Deno.test(
  "timezone picker covers every offset exactly once and marks clashes",
  () => {
    const now = new Date(Date.UTC(2026, 9, 30, 10, 0));
    const all: string[] = [];
    for (let p = 0; p < 10; p++) {
      const kb = tzPicker("s", p, 0, now);
      for (const b of kb.flat()) {
        const data = (b as { callback_data: string }).callback_data;
        if (!data.includes(":p:")) all.push(data);
      }
    }
    assertEquals(new Set(all).size, TZ_OFFSETS.length);
    const labels = tzPicker("s", 0, 0, now)
      .flat()
      .map((b) => b.text);
    // UTC-10 and UTC+14 show the same clock time, so both carry their offset.
    assert(labels.some((l) => l.includes("UTC-10:00")));
    const clamped = tzPicker("s", -5, 0, now);
    assertEquals(
      clamped.at(-1)!.map((b) => b.text),
      ["Later ›"],
    );
  },
);

Deno.test("menu has every main screen", () => {
  const data = buttons(menuView()).flat();
  for (const d of [
    "day:0",
    "week",
    "hist:0",
    "wt:0",
    "goals",
    "prof",
    "set",
    "help",
    "csv",
    "imp",
  ])
    assert(data.includes(d), d);
});
