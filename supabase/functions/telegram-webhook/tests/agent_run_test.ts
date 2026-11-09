import { setExternalFetch } from "./support/env.ts";
import { fakeModel } from "./support/model.ts";
import { assert, assertEquals } from "@std/assert";
import { AgentInput, runAgent } from "../src/agent/index.ts";
import type { ChatProvider } from "../src/services/llm.ts";
import { testConnection } from "../src/services/llm.ts";
import { fakeDb, weight } from "./support/fakes.ts";

const provider: ChatProvider = {
  kind: "custom",
  connection: {
    baseUrl: "https://fake.example/v1",
    token: "tok",
    auth: "header",
    authHeader: "api-key",
    headers: { "X-Org": "acme" },
  },
  model: "fake-model",
  images: false,
  reasoningParam: "reasoning_effort",
};

function input(patch: Partial<AgentInput> = {}) {
  const { db, state } = fakeDb();
  const base: AgentInput = {
    provider,
    research: null,
    maxResearch: 0,
    effort: "low",
    replyDetail: "short",
    unsupported: [],
    user: {
      utcOffsetMinutes: 60,
      country: null,
      units: "metric",
      targetKcal: null,
      targetProteinG: null,
      targetCarbsG: null,
      targetFatG: null,
    },
    store: db.meals,
    weights: db.weights,
    recentWeights: [],
    text: "70kg",
    media: [],
    photoIds: [],
    photoRefs: [],
    sentAt: new Date(),
    messageId: 5,
    recentMeals: [],
    fixMeal: null,
    answers: [],
    history: [],
    ...patch,
  };
  return { input: base, state };
}

Deno.test(
  "a weigh-in message logs the weight and replies in one turn",
  async () => {
    const seen = fakeModel([
      [
        { name: "log_weight", args: { weight: 70, unit: "kg" } },
        { name: "reply", args: { text: "Logged." } },
      ],
    ]);
    const { input: i, state } = input();
    const r = await runAgent(i);
    assertEquals(r.error, null);
    assertEquals(r.turns, 1);
    assertEquals(r.reply, "Logged.");
    assertEquals(
      r.weightChanges.map((c) => c.kind),
      ["created"],
    );
    assertEquals(state.weights[0].weightKg, 70);
    assertEquals(state.weights[0].batchId, r.batchId);

    const req = seen[0];
    assertEquals(req.url, "https://fake.example/v1/chat/completions");
    assertEquals(req.headers.get("api-key"), "tok");
    assertEquals(req.headers.get("x-org"), "acme");
    assertEquals(req.headers.get("authorization"), null);
    assertEquals(req.body.reasoning_effort, "low");
    assertEquals(req.body.model, "fake-model");
    const tools = (req.body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    for (const t of [
      "log_weight",
      "read_weights",
      "update_weight",
      "delete_weight",
      "log_meal",
      "ask_user",
    ])
      assert(tools.includes(t), t);
    assert(!tools.includes("research_food"));
    assert(!tools.includes("view_image"));
  },
);

Deno.test(
  "a failed tool call is fed back and the model gets another turn",
  async () => {
    const seen = fakeModel([
      [
        { name: "log_weight", args: { weight: 7, unit: "kg" } },
        { name: "reply", args: { text: "Logged 7 kg." } },
      ],
      [
        { name: "log_weight", args: { weight: 70, unit: "kg" } },
        { name: "reply", args: { text: "Logged 70 kg." } },
      ],
    ]);
    const { input: i, state } = input();
    const r = await runAgent(i);
    assertEquals(r.turns, 2);
    assertEquals(r.reply, "Logged 70 kg.");
    assertEquals(
      state.weights.map((w) => w.weightKg),
      [70],
    );
    const toolMsgs = (
      seen[1].body.messages as { role: string; content: unknown }[]
    ).filter((m) => m.role === "tool");
    assert(JSON.stringify(toolMsgs).includes("between 20 and 400"));
  },
);

Deno.test("a question ends the run before anything is logged", async () => {
  fakeModel([
    [
      {
        name: "ask_user",
        args: { question: "kg or lb?", options: ["kg", "lb"] },
      },
    ],
  ]);
  const { input: i, state } = input({ text: "70" });
  const r = await runAgent(i);
  assertEquals(r.question, { question: "kg or lb?", options: ["kg", "lb"] });
  assertEquals(state.weights.length, 0);
});

Deno.test(
  "after the last question round, ask_user is no longer offered",
  async () => {
    const seen = fakeModel([
      [{ name: "reply", args: { text: "Assumed kg." } }],
    ]);
    const { input: i } = input({
      answers: [
        { question: "a", answer: "b" },
        { question: "c", answer: "d" },
      ],
    });
    await runAgent(i);
    const tools = (seen[0].body.tools as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    assert(!tools.includes("ask_user"));
    assert(
      String(JSON.stringify(seen[0].body.messages)).includes(
        "No more questions",
      ),
    );
  },
);

Deno.test(
  "a transient provider error is retried once, a permanent one is reported",
  async () => {
    fakeModel([
      { status: 502, body: '{"error":{"message":"upstream"}}' },
      [{ name: "reply", args: { text: "ok" } }],
    ]);
    const ok = await runAgent(input().input);
    assertEquals(ok.error, null);
    assertEquals(ok.reply, "ok");

    fakeModel([{ status: 401, body: '{"error":{"message":"bad key"}}' }]);
    const bad = await runAgent(input().input);
    assertEquals(bad.error?.status, 401);
    assertEquals(bad.error?.transient, false);
    assertEquals(bad.weightChanges, []);
  },
);

Deno.test(
  "the run stops after the turn limit even if the model never replies",
  async () => {
    fakeModel(
      Array.from({ length: 10 }, () => [
        { name: "read_weights", args: { limit: 1 } },
      ]),
    );
    const r = await runAgent(input().input);
    assertEquals(r.turns, 6);
    assertEquals(r.reply, "");
  },
);

Deno.test(
  "recent weigh-ins reach the prompt so corrections need no read",
  async () => {
    const seen = fakeModel([[{ name: "reply", args: { text: "ok" } }]]);
    const w = weight({ weighedAt: new Date(), weightKg: 70.4 });
    await runAgent(input({ recentWeights: [w] }).input);
    const system = JSON.stringify(seen[0].body.messages);
    assert(system.includes(w.id));
    assert(system.includes("70.4"));
  },
);

Deno.test(
  "connection test reports HTTP errors and the model's reply",
  async () => {
    setExternalFetch(() =>
      Promise.resolve(
        Response.json({ choices: [{ message: { content: " OK " } }] }),
      ),
    );
    assertEquals(
      await testConnection(
        provider.kind === "custom" ? provider.connection : (null as never),
        "m",
      ),
      {
        ok: true,
        reply: "OK",
      },
    );
    setExternalFetch(() =>
      Promise.resolve(
        Response.json({ error: { message: "nope" } }, { status: 404 }),
      ),
    );
    assertEquals(
      await testConnection(
        provider.kind === "custom" ? provider.connection : (null as never),
        "m",
      ),
      { ok: false, error: "HTTP 404: nope" },
    );
    setExternalFetch(() => Promise.reject(new TypeError("dns failure")));
    const down = await testConnection(
      provider.kind === "custom" ? provider.connection : (null as never),
      "m",
    );
    assertEquals(down, { ok: false, error: "dns failure" });
    setExternalFetch(null);
  },
);

Deno.test(
  "a reply sent alongside a failed tool call is not shown if no new reply follows",
  async () => {
    fakeModel(
      Array.from({ length: 6 }, () => [
        { name: "log_weight", args: { weight: 7, unit: "kg" } },
        { name: "reply", args: { text: "Logged 7 kg." } },
      ]),
    );
    const { input: i, state } = input();
    const r = await runAgent(i);
    assertEquals(state.weights.length, 0);
    assertEquals(r.reply, "");
  },
);

Deno.test(
  "this message's photos stay in every request of the run",
  async () => {
    const seen = fakeModel([
      [{ name: "read_meals", args: { days_back: 0 } }],
      [{ name: "reply", args: { text: "Done." } }],
    ]);
    const { input: i } = input({
      provider: { ...provider, images: true },
      text: "dinner",
      media: [{ kind: "image", mime: "image/jpeg", data: new Uint8Array([1]) }],
      photoIds: ["file1"],
      photoRefs: ["p1"],
    });
    const r = await runAgent(i);
    assertEquals(r.turns, 2);
    for (const req of seen)
      assert(JSON.stringify(req.body.messages).includes("image_url"));
  },
);
