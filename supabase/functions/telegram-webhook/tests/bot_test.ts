import { resetTelegram, telegramCalls } from "./support/env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AgentResult } from "../src/agent/index.ts";
import { replySummary, resultView } from "../src/bot/assistant.ts";
import { runCallback } from "../src/bot/callbacks.ts";
import { runCommand } from "../src/bot/commands.ts";
import { advancedAction, providerAction } from "../src/bot/screens/advanced.ts";
import { isGoalField } from "../src/domain/goals.ts";
import { parseChoice } from "../src/domain/onboarding.ts";
import { resolveProviders } from "../src/bot/providers.ts";
import { editGoal, recalcGoals, saveGoal } from "../src/bot/screens/goals.ts";
import { ProviderError } from "../src/services/provider-error.ts";
import { dayStart } from "../src/domain/time.ts";
import {
  buttons,
  fakeCtx,
  goals,
  labels,
  meal,
  plain,
  user,
  weight,
} from "./support/fakes.ts";

const result = (patch: Partial<AgentResult> = {}): AgentResult => ({
  reply: "",
  changes: [],
  weightChanges: [],
  noteChanges: [],
  batchId: "b1",
  question: null,
  error: null,
  timedOut: false,
  costUsd: 0,
  turns: 1,
  searches: 0,
  hitCostCap: false,
  generationIds: [],
  ...patch,
});

const now = new Date();

Deno.test(
  "weigh-in reply shows both units when entered in the other one",
  async () => {
    const { ctx } = fakeCtx();
    const w = weight({ weighedAt: now, weightKg: 69.99, unit: "lb" });
    const v = await resultView(
      ctx,
      result({ weightChanges: [{ kind: "created", weight: w }] }),
      false,
    );
    assertStringIncludes(plain(v), "Weight logged: 70.0 kg (154.3 lb)");
    assert(!plain(v).includes("Today"), "no meal totals for a weigh-in");
    assertEquals(buttons(v), [["undo:b1", "wt:0"]]);
  },
);

Deno.test("weigh-in reply in the display unit shows one value", async () => {
  const { ctx } = fakeCtx({ user: user({ units: "imperial" }) });
  const w = weight({ weighedAt: now, weightKg: 69.99, unit: "lb" });
  const v = await resultView(
    ctx,
    result({ weightChanges: [{ kind: "created", weight: w }] }),
    false,
  );
  assertStringIncludes(plain(v), "Weight logged: 154.3 lb  ·");
  assert(!plain(v).includes("kg"));
});

Deno.test("corrected and deleted weigh-ins can't be undone", async () => {
  const { ctx } = fakeCtx();
  const before = weight({ weighedAt: now, weightKg: 70 });
  const after = { ...before, weightKg: 71 };
  const v = await resultView(
    ctx,
    result({
      weightChanges: [
        { kind: "updated", weight: after, before },
        { kind: "deleted", weight: before, before },
      ],
    }),
    false,
  );
  assertStringIncludes(plain(v), "Weight updated: 71.0 kg");
  assertStringIncludes(plain(v), "Was 70.0 kg.");
  assertStringIncludes(plain(v), "Deleted the weigh-in of 70.0 kg.");
  assertEquals(buttons(v), [["wt:0"]]);
});

Deno.test("meal reply shows today's total with what is left", async () => {
  const m = meal({
    eatenAt: new Date(dayStart(0).getTime() + 60_000),
    kcal: 1620,
  });
  const { ctx } = fakeCtx({ user: user(goals), meals: [m] });
  const v = await resultView(
    ctx,
    result({ changes: [{ kind: "created", meal: m }], reply: "a <b> c" }),
    false,
  );
  assertStringIncludes(plain(v), "Today  1,620 / 2,300 kcal  ·  680 kcal left");
  assertStringIncludes(v.text, "a &lt;b&gt; c");
  assertEquals(buttons(v), [["undo:b1", `fix:${m.id}`, "today"]]);

  ctx.user = user();
  const noGoal = await resultView(
    ctx,
    result({ changes: [{ kind: "created", meal: m }] }),
    false,
  );
  assertStringIncludes(plain(noGoal), "Today  1,620 kcal");
  assert(!plain(noGoal).includes("left"));
});

Deno.test(
  "reply without changes has no buttons and explains errors",
  async () => {
    const { ctx } = fakeCtx();
    assertEquals((await resultView(ctx, result(), false)).keyboard, []);
    assertStringIncludes(
      plain(await resultView(ctx, result(), false)),
      "I couldn't do anything with that.",
    );
    const e = await resultView(
      ctx,
      result({ error: new ProviderError(402, "no credits") }),
      false,
    );
    assertStringIncludes(plain(e), "out of credits");
    const custom = await resultView(
      ctx,
      result({ error: new ProviderError(404, "<model>") }),
      true,
    );
    assertStringIncludes(custom.text, "&lt;model&gt;");
  },
);

Deno.test(
  "reply summary mentions weigh-ins so later runs know about them",
  () => {
    const w = weight({ weighedAt: now, weightKg: 69.99, unit: "lb" });
    assertEquals(
      replySummary(
        result({
          reply: "Down 0.4 lb.",
          weightChanges: [{ kind: "created", weight: w }],
        }),
      ),
      "Logged weight 154.3 lb. Down 0.4 lb.",
    );
  },
);

Deno.test(
  "callbacks edit the pressed message and answer the press",
  async () => {
    resetTelegram();
    const { ctx } = fakeCtx();
    await runCallback(ctx, {
      id: "cb1",
      from: { id: 1 },
      data: "week:abc",
      message: { message_id: 55, chat: { id: 1, type: "private" }, date: 0 },
    } as never);
    assertEquals(
      telegramCalls.map((c) => c.method),
      ["editMessageText", "answerCallbackQuery"],
    );
    assertEquals(telegramCalls[0].body.message_id, 55);
    assertStringIncludes(String(telegramCalls[0].body.text), "This week");
  },
);

Deno.test("unknown callbacks are only acknowledged", async () => {
  resetTelegram();
  const { ctx } = fakeCtx();
  for (const data of ["nope:1", "", ":::"])
    await runCallback(ctx, { id: "cb", from: { id: 1 }, data } as never);
  assertEquals(
    telegramCalls.map((c) => c.method),
    ["answerCallbackQuery", "answerCallbackQuery", "answerCallbackQuery"],
  );
});

Deno.test("any other button ends a waiting settings prompt", async () => {
  resetTelegram();
  const awaiting = { field: "url" as const, at: new Date().toISOString() };
  const { ctx } = fakeCtx({ user: user({ awaitingInput: awaiting }) });
  await runCallback(ctx, { id: "cb", from: { id: 1 }, data: "menu" } as never);
  assertEquals(ctx.user.awaitingInput, null);
});

Deno.test(
  "goal editor clamps forged values and ignores unknown fields",
  async () => {
    const { ctx, state } = fakeCtx({ user: user(goals) });
    assertStringIncludes(
      plain(editGoal(ctx, ["kcal", "99999"]).view!),
      "6,000 kcal",
    );
    assertStringIncludes(plain(editGoal(ctx, ["kcal"]).view!), "2,300 kcal");
    assertStringIncludes(plain(editGoal(ctx, ["fat", "abc"]).view!), "70 g");
    assertEquals(editGoal(ctx, ["sugar", "1"]), {});
    assertEquals(await saveGoal(ctx, ["__proto__", "1"]), {});
    await saveGoal(ctx, ["protein", "-5"]);
    assertEquals(ctx.user.targetProteinG, 20);
    assertEquals(state.updates.length, 1);
    // Steppers never step past the limits.
    const steps = editGoal(ctx, ["kcal", "6000"]).view!;
    assert(buttons(steps)[0].every((d) => Number(d.split(":")[2]) <= 6000));
  },
);

Deno.test("recalculating goals needs a complete profile", async () => {
  const { ctx } = fakeCtx();
  assertEquals((await recalcGoals(ctx)).toast, "Finish your profile first");
  ctx.user = user({
    sex: "male",
    age: 30,
    heightCm: 180,
    weightKg: 80,
    activity: "moderate",
    objective: "maintain",
    paceKgPerWeek: 0,
  });
  assertEquals((await recalcGoals(ctx)).toast, "Recalculated");
  assertEquals(ctx.user.targetKcal, 2760);
});

Deno.test(
  "provider choice: custom when ready, else OpenRouter, else none",
  async () => {
    const { ctx } = fakeCtx();
    // deno-lint-ignore no-explicit-any
    const keys = ctx.db.keys as any;
    assertEquals(await resolveProviders(ctx), null);

    keys.get = () => Promise.resolve("sk-or-key");
    const or = await resolveProviders(ctx);
    assertEquals(or?.chat.kind, "openrouter");
    assertEquals(or?.research?.kind, "openrouter");

    ctx.user = user({ aiSettings: { researchDepth: "off" } });
    assertEquals((await resolveProviders(ctx))?.research, null);

    // Enabled but missing a model: falls back to OpenRouter.
    ctx.user = user({
      aiSettings: {
        custom: { enabled: true, baseUrl: "https://x.ai/v1" },
      } as never,
    });
    assertEquals((await resolveProviders(ctx))?.chat.kind, "openrouter");

    keys.get = () => Promise.resolve(null);
    keys.getProvider = () => Promise.resolve({ token: "t", headers: {} });
    ctx.user = user({
      aiSettings: {
        custom: { enabled: true, baseUrl: "https://x.ai/v1", model: "m" },
      } as never,
    });
    const custom = await resolveProviders(ctx);
    assertEquals(custom?.chat.kind, "custom");
    assertEquals(
      custom?.research,
      null,
      "no research model and no OpenRouter key",
    );
  },
);

Deno.test("menu offers the weight screen", async () => {
  const { ctx } = fakeCtx();
  resetTelegram();
  await runCallback(ctx, {
    id: "cb",
    from: { id: 1 },
    data: "menu",
    message: { message_id: 1 },
  } as never);
  const markup = telegramCalls[0].body.reply_markup as {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  assert(markup.inline_keyboard.flat().some((b) => b.callback_data === "wt:0"));
  assert(
    labels({ text: "", keyboard: markup.inline_keyboard }).includes("Weight"),
  );
});

const FORGED = [
  "toString",
  "constructor",
  "__proto__",
  "hasOwnProperty",
  "__defineGetter__",
];

Deno.test(
  "forged callback names that match Object.prototype are ignored",
  async () => {
    const { ctx } = fakeCtx();
    for (const kind of FORGED) {
      resetTelegram();
      await runCallback(ctx, {
        id: "cb",
        from: { id: 1 },
        data: `${kind}:x`,
      } as never);
      assertEquals(
        telegramCalls.map((c) => c.method),
        ["answerCallbackQuery"],
        kind,
      );
    }
  },
);

Deno.test("forged commands fall back to the menu", async () => {
  const { ctx, sent } = fakeCtx();
  for (const name of FORGED)
    await runCommand(ctx, {
      message_id: 1,
      text: `/${name}`,
      date: 0,
      chat: { id: 1, type: "private" },
    } as never);
  assertEquals(sent.length, FORGED.length);
  assert(sent.every((v) => plain(v) === "Menu"));
});

Deno.test("forged settings and onboarding values are rejected", async () => {
  const { ctx, state } = fakeCtx();
  for (const f of FORGED) {
    assertEquals(parseChoice("activity", f, ctx.user), null);
    assertEquals(isGoalField(f), false);
    assertStringIncludes(
      plain((await advancedAction(ctx, [f, "1"])).view!),
      "Advanced",
    );
    assertEquals(await providerAction(ctx, ["in", f]), {});
  }
  assertEquals(await providerAction(ctx, ["in"]), {});
  assertEquals(state.updates, []);
});
