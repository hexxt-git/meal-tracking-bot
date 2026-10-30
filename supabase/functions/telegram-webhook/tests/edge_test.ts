import { assert, assertEquals } from "@std/assert";
import { systemPrompt, PromptContext } from "../src/agent/prompt.ts";
import {
  aiSettings,
  isAwaiting,
  INPUT_TTL_MS,
  parseBaseUrl,
  parseHeaders,
  parseModelId,
} from "../src/domain/ai-settings.ts";
import { parseCsv, parseMealsCsv, toCsv } from "../src/domain/csv.ts";
import { clampGoal } from "../src/domain/goals.ts";
import { itemTotals, sanitizeItems, sumTotals } from "../src/domain/meal.ts";
import { computeTargets } from "../src/domain/nutrition.ts";
import {
  clampStep,
  completeProfile,
  nextStep,
  paceOptions,
  parseChoice,
  prevStep,
  ProfileState,
  stepper,
} from "../src/domain/onboarding.ts";
import { isMeaningfulEdit, isOpen } from "../src/domain/question.ts";
import { reminderText } from "../src/domain/reminders.ts";
import {
  dayStart,
  mealTimeLabel,
  parseEatenAt,
  tzPageOf,
} from "../src/domain/time.ts";
import { parseProviderError } from "../src/services/provider-error.ts";
import { looksLikeKey } from "../src/services/openrouter.ts";

const profile: ProfileState = {
  units: "metric",
  sex: null,
  age: null,
  heightCm: null,
  weightKg: null,
  activity: null,
  objective: null,
  paceKgPerWeek: null,
};

// --- CSV ---

Deno.test(
  "csv parser: BOM, CR-only and CRLF line ends, quoted newlines, blank lines",
  () => {
    assertEquals(parseCsv('﻿a,b\r1,2\r\n\n3,"x\r\ny"\n'), [
      ["a", "b"],
      ["1", "2"],
      ["3", "x\r\ny"],
    ]);
    assertEquals(parseCsv('"",""\n'), []);
    assertEquals(parseCsv('a,""\n'), [["a", ""]]);
    assertEquals(parseCsv("a,b"), [["a", "b"]]);
    assertEquals(parseCsv(""), []);
  },
);

const row = (patch: Record<number, unknown> = {}) => {
  const r: unknown[] = [
    "2026-10-19T08:00:00.000Z",
    "",
    "",
    "",
    "Lunch",
    500,
    30,
    50,
    20,
    "[]",
    "",
  ];
  for (const [i, v] of Object.entries(patch)) r[Number(i)] = v;
  return r;
};
const imported = (...rows: unknown[][]) => {
  const r = parseMealsCsv(toCsv(rows));
  if (!r.ok) throw new Error(r.error);
  return r;
};

Deno.test(
  "csv import rejects rows with missing, negative, huge or non-numeric macros",
  () => {
    for (const bad of ["", " ", "-1", "100000", "abc", "Infinity", "NaN"]) {
      assertEquals(
        imported(row({ 5: bad })).invalidRows,
        1,
        `kcal ${JSON.stringify(bad)}`,
      );
      assertEquals(
        imported(row({ 8: bad })).invalidRows,
        1,
        `fat ${JSON.stringify(bad)}`,
      );
    }
    assertEquals(imported(row({ 5: "0", 6: "0.0" })).meals.length, 1);
    assertEquals(imported(row({ 5: "499.6" })).meals[0].kcal, 500);
  },
);

Deno.test(
  "csv import rejects bad or far-future dates and empty titles, and trims long text",
  () => {
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
    assertEquals(imported(row({ 0: future })).invalidRows, 1);
    assertEquals(imported(row({ 3: "garbage" })).invalidRows, 1);
    assertEquals(imported(row({ 4: "   " })).invalidRows, 1);
    const long = imported(row({ 4: "x".repeat(300), 10: "n".repeat(3000) }))
      .meals[0];
    assertEquals(long.description.length, 200);
    assertEquals(long.userNote?.length, 2000);
  },
);

Deno.test("csv import keeps only well-formed items and clamps them", () => {
  const items = [
    {
      name: "ok",
      portion: "1",
      kcal: 10.6,
      protein_g: -1,
      carbs_g: 1,
      fat_g: 1,
    },
    { name: "no portion", kcal: 1, protein_g: 1, carbs_g: 1, fat_g: 1 },
    {
      name: "nan",
      portion: "1",
      kcal: null,
      protein_g: 1,
      carbs_g: 1,
      fat_g: 1,
    },
    null,
    "string",
  ];
  const m = imported(row({ 9: JSON.stringify(items) })).meals[0];
  assertEquals(m.items, [
    { name: "ok", portion: "1", kcal: 11, protein_g: 0, carbs_g: 1, fat_g: 1 },
  ]);
  assertEquals(imported(row({ 9: '{"name":"x"}' })).meals[0].items, []);
});

Deno.test(
  "csv import header is case and space insensitive, and the row limit holds",
  () => {
    const csv =
      " Eaten_At_UTC ,DESCRIPTION,kcal,protein_g,carbs_g,fat_g\n2026-10-01T12:00:00Z,Lunch,1,1,1,1";
    const r = parseMealsCsv(csv);
    assertEquals(r.ok && r.meals.length, 1);
    assertEquals(parseMealsCsv("").ok, false);
    const many = parseMealsCsv(
      toCsv(Array.from({ length: 5001 }, () => row())),
    );
    assertEquals(many.ok, false);
    assertEquals(
      parseMealsCsv(toCsv(Array.from({ length: 5000 }, () => row()))).ok,
      true,
    );
  },
);

// --- Settings input ---

Deno.test("base URLs: private hosts are refused in every spelling", () => {
  for (const bad of [
    "https://localhost./v1",
    "https://foo.localhost/v1",
    "https://printer.local./v1",
    "https://metadata.google.internal./",
    "https://LOCALHOST/v1",
    "https://127.1/v1",
    "https://0x7f000001/",
    "https://2130706433/",
    "https://0/",
    "https://172.16.0.1/",
    "https://172.31.255.255/",
    "https://100.64.0.1/",
    "https://169.254.169.254/latest",
    "https://[::ffff:127.0.0.1]/",
    "ftp://api.example.com",
    "",
  ])
    assert("error" in parseBaseUrl(bad), bad);
  for (const ok of [
    "https://172.32.0.1/v1",
    "https://100.128.0.1/",
    "https://api.example.com",
  ])
    assert("url" in parseBaseUrl(ok), ok);
  assertEquals(
    parseBaseUrl("  https://API.Example.com/v1//chat/completions/ "),
    {
      url: "https://api.example.com/v1/",
    },
  );
});

Deno.test(
  "headers: values may contain colons; limits and reserved names hold",
  () => {
    assertEquals(parseHeaders("X-Time: 12:30\n\n  "), {
      headers: { "X-Time": "12:30" },
    });
    assertEquals(parseHeaders(""), { headers: {} });
    assert("error" in parseHeaders(": value"));
    assert("error" in parseHeaders("X-Empty:"));
    assert("error" in parseHeaders("Content-Length: 5"));
    assert("error" in parseHeaders("Bad Name: 1"));
    assert("error" in parseHeaders(`X-Long: ${"a".repeat(2001)}`));
    assert(
      "error" in
        parseHeaders(
          Array.from({ length: 11 }, (_, i) => `X-${i}: 1`).join("\n"),
        ),
    );
  },
);

Deno.test("model ids are one word up to 200 characters", () => {
  assertEquals(parseModelId("  openai/gpt-x  "), "openai/gpt-x");
  assertEquals(parseModelId("a".repeat(200))?.length, 200);
  assertEquals(parseModelId("a".repeat(201)), null);
  assertEquals(parseModelId("two words"), null);
  assertEquals(parseModelId("   "), null);
});

Deno.test("settings prompts and questions expire", () => {
  const at = new Date(0).toISOString();
  assertEquals(isAwaiting({ field: "url", at }, INPUT_TTL_MS - 1), true);
  assertEquals(isAwaiting({ field: "url", at }, INPUT_TTL_MS), false);
  assertEquals(isAwaiting(null, 0), false);
  const q = { askedAt: at } as never;
  assertEquals(isOpen(q, 999, 1000), true);
  assertEquals(isOpen(q, 1000, 1000), false);
  assertEquals(isOpen(null, 0, 1000), false);
});

Deno.test("stored settings: unknown nested values don't drop defaults", () => {
  const s = aiSettings({ custom: null, dailyBudgetUsd: null });
  assertEquals(s.custom.auth, "bearer");
  assertEquals(s.dailyBudgetUsd, null);
});

Deno.test("OpenRouter key detection", () => {
  assert(looksLikeKey(" sk-or-v1-" + "a".repeat(40) + " "));
  assert(!looksLikeKey("sk-or-short"));
  assert(!looksLikeKey("my key is sk-or-v1-" + "a".repeat(40)));
});

// --- Onboarding and goals ---

Deno.test(
  "steppers snap to their own step size, so integer fields stay integers",
  () => {
    const age = stepper("age", profile);
    assertEquals(clampStep(age, 30.5), 31);
    assertEquals(clampStep(age, 30.4), 30);
    assertEquals(clampStep(age, -5), 13);
    assertEquals(clampStep(age, Infinity), age.initial);
    assertEquals(clampStep(stepper("height", profile), 170.6), 171);
    assertEquals(clampStep(stepper("weight", profile), 70.3), 70.5);
    assertEquals(
      clampStep(stepper("weight", { ...profile, units: "imperial" }), 154.5),
      155,
    );
  },
);

Deno.test("imperial height stepper round-trips feet and inches", () => {
  const h = stepper("height", {
    ...profile,
    units: "imperial",
    heightCm: 152.4,
  });
  assertEquals(h.initial, 60);
  assertEquals(h.format(60), `5'0"`);
  assertEquals(h.format(71), `5'11"`);
});

Deno.test(
  "pace choices depend on the objective and stale values are refused",
  () => {
    assertEquals(
      paceOptions("metric", "gain").map((p) => p.kg),
      [0.25, 0.5],
    );
    assertEquals(paceOptions("imperial", "lose")[0].label, "0.6 lb/wk");
    assertEquals(
      parseChoice("pace", "1", { ...profile, objective: "gain" }),
      null,
    );
    assertEquals(
      parseChoice("pace", "", { ...profile, objective: "lose" }),
      null,
    );
    assertEquals(parseChoice("timezone", "", profile), null);
    assertEquals(parseChoice("timezone", "abc", profile), null);
    assertEquals(parseChoice("age", "30", profile), null);
    assertEquals(parseChoice("units", "Metric", profile), null);
  },
);

Deno.test("step order edges", () => {
  assertEquals(prevStep("objective", "maintain"), "activity");
  assertEquals(prevStep("pace", "lose"), "objective");
  assertEquals(prevStep("done", null), null);
  assertEquals(prevStep("key", null), null);
  assertEquals(nextStep("pace", "lose"), "timezone");
});

Deno.test(
  "a complete profile needs every answer, but a zero pace counts",
  () => {
    const full: ProfileState = {
      units: "metric",
      sex: "female",
      age: 30,
      heightCm: 165,
      weightKg: 60,
      activity: "light",
      objective: "maintain",
      paceKgPerWeek: 0,
    };
    assert(completeProfile(full));
    for (const k of [
      "sex",
      "age",
      "heightCm",
      "weightKg",
      "activity",
      "objective",
      "paceKgPerWeek",
    ] as const)
      assertEquals(completeProfile({ ...full, [k]: null }), null, k);
  },
);

Deno.test(
  "targets: gaining adds the surplus, the male floor holds, carbs never go negative",
  () => {
    const base = {
      sex: "male" as const,
      age: 30,
      height_cm: 180,
      weight_kg: 80,
      activity: "moderate" as const,
      pace_kg_per_week: 0.5,
    };
    const maintain = computeTargets({ ...base, objective: "maintain" });
    const gain = computeTargets({ ...base, objective: "gain" });
    assertEquals(gain.kcal - maintain.kcal, 550);
    const tiny = computeTargets({
      ...base,
      age: 90,
      height_cm: 120,
      weight_kg: 200,
      activity: "sedentary",
      objective: "lose",
      pace_kg_per_week: 1,
    });
    assert(tiny.kcal >= 1500);
    assert(tiny.carbs_g >= 0);
    assertEquals(tiny.protein_g, 400);
  },
);

Deno.test("goal clamps at both ends", () => {
  assertEquals(clampGoal("carbs", -1), 0);
  assertEquals(clampGoal("carbs", 0), 0);
  assertEquals(clampGoal("kcal", 6001), 6000);
  assertEquals(clampGoal("protein", Infinity), 120);
});

// --- Meals and time ---

Deno.test("totals round to one decimal without drifting", () => {
  const items = Array.from({ length: 10 }, () => ({
    name: "x",
    portion: "1",
    kcal: 1,
    protein_g: 0.1,
    carbs_g: 0.2,
    fat_g: 0.3,
  }));
  assertEquals(itemTotals(items), {
    kcal: 10,
    proteinG: 1,
    carbsG: 2,
    fatG: 3,
  });
  assertEquals(itemTotals([]), { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  assertEquals(sumTotals([]), { kcal: 0, proteinG: 0, carbsG: 0, fatG: 0 });
  assertEquals(
    sanitizeItems([
      {
        name: "x",
        portion: "1",
        kcal: -0.4,
        protein_g: -0,
        carbs_g: 1,
        fat_g: 1,
      },
    ])[0].kcal,
    0,
  );
});

Deno.test("eaten_at window edges", () => {
  const now = Date.UTC(2026, 9, 19, 12);
  const iso = (ms: number) => new Date(ms).toISOString();
  assert(parseEatenAt(iso(now + 3_600_000), now));
  assertEquals(parseEatenAt(iso(now + 3_600_001), now), null);
  assert(parseEatenAt(iso(now - 7 * 86_400_000), now));
  assertEquals(parseEatenAt(iso(now - 7 * 86_400_000 - 1), now), null);
  assertEquals(parseEatenAt("", now), null);
  assertEquals(parseEatenAt(undefined, now), null);
});

Deno.test(
  "day start for negative and fractional offsets across midnight",
  () => {
    // 03:00 UTC is 23:30 the day before at UTC-03:30.
    const now = Date.UTC(2026, 9, 20, 3);
    assertEquals(
      dayStart(-210, 0, now).toISOString(),
      "2026-10-19T03:30:00.000Z",
    );
    assertEquals(
      dayStart(345, 0, now).toISOString(),
      "2026-10-19T18:15:00.000Z",
    );
  },
);

Deno.test("meal time label threshold is 15 minutes", () => {
  const logged = new Date("2026-10-19T12:15:00Z");
  assertEquals(
    mealTimeLabel(new Date("2026-10-19T12:00:01Z"), logged, 0),
    "12:00",
  );
  assertEquals(
    mealTimeLabel(new Date("2026-10-19T12:00:00Z"), logged, 0),
    "12:00, logged 12:15",
  );
});

Deno.test(
  "timezone page of an unknown offset falls back to the first page",
  () => {
    assertEquals(tzPageOf(7), 0);
  },
);

Deno.test(
  "edits: case and spacing are ignored, punctuation and unicode letters count",
  () => {
    assertEquals(isMeaningfulEdit("", ""), false);
    assertEquals(isMeaningfulEdit("2 eggs", "2  eggs\n"), false);
    assertEquals(isMeaningfulEdit("2 eggs", "20 eggs"), true);
    assertEquals(isMeaningfulEdit("خبز", "خبز!"), true);
  },
);

Deno.test("reminder text for unknown hours", () => {
  assertEquals(reminderText(7), "No meal logged in 7 hours.");
  assert(reminderText(48).includes("last reminder"));
});

Deno.test(
  "provider errors: status, non-JSON bodies, JSON without message",
  () => {
    const e = parseProviderError("503 Service Unavailable");
    assertEquals([e.status, e.transient], [503, true]);
    assertEquals(parseProviderError("400: not json").message, "not json");
    assertEquals(
      parseProviderError('400: {"error":"x"}').message,
      '{"error":"x"}',
    );
    assertEquals(parseProviderError("socket hang up").status, 0);
    assertEquals(parseProviderError("408: timeout").transient, true);
    assertEquals(parseProviderError("409: conflict").transient, true);
    assertEquals(parseProviderError("404: nope").transient, false);
    assertEquals(parseProviderError("1234: x").status, 0);
  },
);

// --- Prompt ---

const ctx = (patch: Partial<PromptContext> = {}): PromptContext => ({
  now: "Mon 2026-10-19 20:00",
  nowIso: "2026-10-19T20:00:00+01:00",
  offset: "+01:00",
  country: null,
  units: "metric",
  targets: null,
  recentMeals: [],
  recentWeights: [],
  fixMeal: null,
  answers: [],
  canAsk: true,
  canResearch: true,
  photoIds: [],
  replyDetail: "normal",
  unsupported: [],
  history: [],
  ...patch,
});

Deno.test("prompt switches research and asking sections", () => {
  assert(systemPrompt(ctx()).includes("RESEARCH (required)"));
  assert(
    systemPrompt(ctx({ canResearch: false })).includes(
      "Web research is unavailable",
    ),
  );
  assert(systemPrompt(ctx()).includes("Call ask_user only when"));
  assert(
    systemPrompt(ctx({ canAsk: false })).includes(
      "No more questions for this message",
    ),
  );
  assert(
    systemPrompt(ctx({ country: "Algeria" })).includes("as sold in Algeria"),
  );
  assert(!systemPrompt(ctx()).includes("as sold in"));
});

Deno.test("prompt includes optional context only when present", () => {
  const empty = systemPrompt(ctx());
  for (const s of [
    "EDITED MESSAGE",
    'tapped "Fix"',
    "You already asked",
    "can't receive",
    "attached to your first request",
  ])
    assert(!empty.includes(s), s);
  assert(empty.includes("LATEST WEIGH-INS (most recent first): (none)"));
  assert(empty.includes("RECENT CONVERSATION") && empty.includes("(none)"));

  const full = systemPrompt(
    ctx({
      fixMeal: { id: "m1" },
      answers: [{ question: "How much?", answer: "Half" }],
      unsupported: ["a voice note"],
      photoIds: ["p1", "p2"],
      recentWeights: [{ id: "w1", weight_kg: 70 }],
      edit: {
        before: null,
        after: "3 eggs",
        sentAt: "Mon 2026-10-19 08:00",
        meals: [],
      },
      targets: "2000 kcal",
    }),
  );
  assert(full.includes('tapped "Fix"') && full.includes('"m1"'));
  assert(full.includes("- Q: How much?\n  A: Half"));
  assert(
    full.includes("a voice note, which the configured model can't receive"),
  );
  assert(full.includes("ids p1, p2"));
  assert(full.includes('"weight_kg":70'));
  assert(full.includes("(original text not available)"));
  assert(full.includes("Daily targets: 2000 kcal."));
});

Deno.test("prompt history lines are flattened and capped", () => {
  const p = systemPrompt(
    ctx({
      history: [
        {
          who: "User",
          at: "t",
          text: `a\n\nb ${"x".repeat(700)}`,
          attachments: ["photo p1", "voice note"],
        },
      ],
    }),
  );
  const line = p.split("\n").find((l) => l.startsWith("[t] User:"))!;
  assert(line.startsWith("[t] User: a b x"));
  assert(line.endsWith(" [photo p1, voice note]"));
  assert(line.length < 650);
});
