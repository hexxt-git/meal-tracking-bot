import { resetTelegram } from "./support/env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { answerQuestion, respond } from "../src/bot/assistant.ts";
import type { User } from "../src/db/index.ts";
import type { Message } from "../src/telegram/types.ts";
import type { View } from "../src/bot/ui.ts";
import { buttons, fakeCtx, user, weight } from "./support/fakes.ts";
import { fakeModel } from "./support/model.ts";

const customUser = (patch: Partial<User> = {}) =>
  user({
    aiSettings: {
      custom: {
        enabled: true,
        baseUrl: "https://fake.example/v1",
        model: "fake-model",
        images: false,
      },
    } as never,
    ...patch,
  });

function setup(
  patch: Partial<User> = {},
  weights = [] as ReturnType<typeof weight>[],
) {
  resetTelegram();
  const f = fakeCtx({ user: customUser(patch), weights });
  f.state.providerSecret = { token: "tok", headers: {} };
  return f;
}

let nextId = 100;
const message = (text: string): Message =>
  ({
    message_id: nextId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: "private" },
    from: { id: 1 },
    text,
  }) as Message;

const texts = (sent: unknown[]) =>
  sent.map((v) => (typeof v === "string" ? v : (v as View).text));

Deno.test(
  "the first weigh-in in lb switches the display units and sets the profile weight",
  async () => {
    fakeModel([
      [
        { name: "log_weight", args: { weight: 154.3, unit: "lb" } },
        { name: "reply", args: { text: "Logged." } },
      ],
    ]);
    const { ctx, state } = setup();
    await respond(ctx, message("154.3 lbs"));
    assertEquals(ctx.user.units, "imperial");
    assertEquals(ctx.user.weightKg, 69.989);
    assertEquals(state.weights.length, 1);
    const [reply] = state.replies;
    assertStringIncludes(reply.text, "Logged weight 154.3 lb.");
  },
);

Deno.test(
  "later weigh-ins keep the chosen units but still update the profile weight",
  async () => {
    fakeModel([
      [
        { name: "log_weight", args: { weight: 154, unit: "lb" } },
        { name: "reply", args: { text: "Logged." } },
      ],
    ]);
    const { ctx, sent } = setup({ units: "metric", weightKg: 72 }, [
      weight({ weighedAt: new Date(Date.now() - 86_400_000), weightKg: 72 }),
    ]);
    await respond(ctx, message("154 lb"));
    assertEquals(ctx.user.units, "metric");
    assertEquals(ctx.user.weightKg, 69.853);
    assertStringIncludes(texts(sent).at(-1)!, "69.9 kg (154.0 lb)");
  },
);

Deno.test(
  "backdating a weigh-in doesn't overwrite the profile with an older value",
  async () => {
    fakeModel([
      [
        {
          name: "log_weight",
          args: {
            weight: 80,
            unit: "kg",
            weighed_at: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          },
        },
        { name: "reply", args: { text: "Logged." } },
      ],
    ]);
    const { ctx } = setup({ weightKg: 70 }, [
      weight({ weighedAt: new Date(Date.now() - 3_600_000), weightKg: 70 }),
    ]);
    await respond(ctx, message("I was 80kg on monday"));
    assertEquals(ctx.user.weightKg, 70);
  },
);

Deno.test(
  "a used-up budget offers Continue without calling the model",
  async () => {
    const seen = fakeModel([]);
    const { ctx, state, sent } = setup();
    state.usage.costUsd = 0.25;
    await respond(ctx, message("70kg"));
    assertEquals(seen.length, 0);
    assertStringIncludes(texts(sent)[0], "budget of $0.20 is used up");
    assert(ctx.user.retryRun, "the request is kept for Continue");
  },
);

Deno.test("the daily request limit stops before the model", async () => {
  const seen = fakeModel([]);
  const { ctx, state, sent } = setup();
  state.withinLimits = false;
  await respond(ctx, message("70kg"));
  assertEquals(seen.length, 0);
  assertStringIncludes(texts(sent)[0], "daily limit");
});

Deno.test(
  "a question is saved, and a typed answer resumes the same message",
  async () => {
    const seen = fakeModel([
      [
        {
          name: "ask_user",
          args: { question: "kg or lb?", options: ["kg", "lb"] },
        },
      ],
      [
        { name: "log_weight", args: { weight: 70, unit: "kg" } },
        { name: "reply", args: { text: "Logged." } },
      ],
    ]);
    const { ctx, state } = setup();
    await respond(ctx, message("70"));
    assertEquals(ctx.user.pendingQuestion?.question, "kg or lb?");
    assertEquals(state.weights.length, 0);
    await respond(ctx, message("kg"));
    assertEquals(ctx.user.pendingQuestion, null);
    assertEquals(
      state.weights.map((w) => w.weightKg),
      [70],
    );
    assert(JSON.stringify(seen[1].body.messages).includes("A: kg"));
  },
);

Deno.test(
  "an empty message gets the logging hint without a model call",
  async () => {
    const seen = fakeModel([]);
    const { ctx, sent } = setup();
    await respond(ctx, message(""));
    assertEquals(seen.length, 0);
    assertStringIncludes(String(sent[0]), "Send a photo");
  },
);

Deno.test("a transient failure with nothing saved offers Retry", async () => {
  fakeModel([
    { status: 503, body: "{}" },
    { status: 503, body: "{}" },
  ]);
  const { ctx, sent } = setup();
  await respond(ctx, message("70kg"));
  const last = sent.at(-1) as View;
  assert(buttons(last)[0][0].startsWith("retry:"));
});

const meal = (name: string, kcal: number) => ({
  name: "log_meal",
  args: {
    description: name,
    items: [
      {
        name,
        portion: "1 serving",
        kcal,
        protein_g: 10,
        carbs_g: 10,
        fat_g: 5,
      },
    ],
  },
});

const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise((r) => setTimeout(r, 10));
};

Deno.test(
  "a message sent before the reply takes over the running request, so nothing is logged twice",
  async () => {
    const seen = fakeModel([
      [meal("Chicken", 300)],
      "hang",
      [
        meal("Chicken", 300),
        meal("Rice", 200),
        { name: "reply", args: { text: "Logged both." } },
      ],
    ]);
    const { ctx, state, sent } = setup();
    const first = respond(ctx, message("chicken"));
    await until(() => seen.length === 2);
    assertEquals(state.meals.length, 1, "the first run logged chicken");
    await Promise.all([first, respond(ctx, message("and rice"))]);

    assertEquals(state.meals.map((m) => m.description).sort(), [
      "Chicken",
      "Rice",
    ]);
    assertEquals(sent.length, 1, "only the newer run replies");
    assertStringIncludes(texts(sent)[0], "Logged both.");
    const userTurn = JSON.stringify(seen[2].body.messages);
    assertStringIncludes(userTurn, "chicken");
    assertStringIncludes(userTurn, "and rice");
    assertStringIncludes(userTurn, "2 messages in a row");
    assertEquals(state.user.agentRun, null, "the slot is released");
  },
);

Deno.test(
  "a message sent while a reply is going out waits for it instead of undoing it",
  async () => {
    fakeModel([
      [meal("Chicken", 300), { name: "reply", args: { text: "Chicken." } }],
      [meal("Rice", 200), { name: "reply", args: { text: "Rice." } }],
    ]);
    const { ctx, state, sent } = setup();
    const commit = ctx.db.runs.commit;
    let second: Promise<unknown> | undefined;
    ctx.db.runs.commit = async (id) => {
      const ok = await commit(id);
      second ??= respond(ctx, message("rice"));
      return ok;
    };
    await respond(ctx, message("chicken"));
    await second;
    assertEquals(state.meals.map((m) => m.description).sort(), [
      "Chicken",
      "Rice",
    ]);
    assertEquals(texts(sent).length, 2);
  },
);

Deno.test("a tapped answer is added to the stored question", async () => {
  fakeModel([
    [
      {
        name: "ask_user",
        args: { question: "kg or lb?", options: ["kg", "lb"] },
      },
    ],
    [
      { name: "log_weight", args: { weight: 70, unit: "kg" } },
      { name: "reply", args: { text: "Logged." } },
    ],
  ]);
  const { ctx, state } = setup();
  await respond(ctx, message("70"));
  const q = ctx.user.pendingQuestion!;
  const asked = state.replies.find((r) => r.text.startsWith("Asked:"))!;
  const reply = answerQuestion(ctx, [q.id, "1"], {
    id: "cb",
    from: { id: 1 },
    message: { message_id: asked.id, chat: { id: 1, type: "private" } },
  });
  await reply.after?.();
  assertStringIncludes(asked.text, "-> User answered: lb");
});
