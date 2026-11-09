import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  MAX_NOTES,
  mealTools,
  RunOptions,
  RunState,
} from "../src/agent/tools.ts";
import { fakeDb, meal } from "./support/fakes.ts";

const HOUR = 3_600_000;
const item = (kcal: number) => ({
  name: " Rice ",
  portion: " 150 g ",
  kcal,
  protein_g: 4,
  carbs_g: 40,
  fat_g: 0.5,
});

function setup(opts: Partial<RunOptions> = {}, canAsk = true) {
  const { db, state } = fakeDb();
  const run = new RunState({
    store: db.meals,
    weights: db.weights,
    offsetMin: 60,
    sentAt: new Date(),
    userText: "rice for lunch",
    fileIds: [],
    messageId: 9,
    ...opts,
  });
  const tools = new Map<string, AgentTool>(
    mealTools(run, canAsk).map((t) => [t.name, t]),
  );
  // deno-lint-ignore no-explicit-any
  const call = (name: string, args: any) =>
    (async () => {
      const t = tools.get(name);
      if (!t) throw new Error(`no tool ${name}`);
      return await t.execute("t", args);
    })();
  const json = async (name: string, args: unknown) =>
    JSON.parse(((await call(name, args)).content[0] as { text: string }).text);
  return { run, state, tools, call, json };
}

Deno.test(
  "log_meal trims items, totals them and keeps the message's note and photos",
  async () => {
    const { state, json } = setup({ fileIds: ["f1"] });
    const view = await json("log_meal", {
      description: "  ",
      items: [item(200.4), { ...item(-50), protein_g: -3 }],
    });
    const [m] = state.meals;
    assertEquals(m.description, "Meal");
    assertEquals(m.items[0].name, "Rice");
    assertEquals(m.items[0].portion, "150 g");
    assertEquals(
      m.items.map((i) => i.kcal),
      [200, 0],
    );
    assertEquals(m.kcal, 200);
    assertEquals(m.proteinG, 4);
    assertEquals(m.userNote, "rice for lunch");
    assertEquals(m.photoFileIds, ["f1"]);
    assertEquals(m.sourceMessageId, 9);
    assertEquals(view.editable, true);
  },
);

Deno.test(
  "log_meal rejects eaten_at in the future or beyond the read window",
  async () => {
    const { state, call } = setup();
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    await assertRejects(() =>
      call("log_meal", {
        description: "x",
        eaten_at: at(2 * HOUR),
        items: [item(1)],
      }),
    );
    await assertRejects(() =>
      call("log_meal", {
        description: "x",
        eaten_at: at(-8 * 24 * HOUR),
        items: [item(1)],
      }),
    );
    await assertRejects(() =>
      call("log_meal", {
        description: "x",
        eaten_at: "yesterday",
        items: [item(1)],
      }),
    );
    assertEquals(state.meals.length, 0);
    await call("log_meal", {
      description: "x",
      eaten_at: at(-6 * 24 * HOUR),
      items: [item(1)],
    });
    assertEquals(state.meals.length, 1);
  },
);

Deno.test("meals logged over 24 hours ago are read-only", async () => {
  const { state, call } = setup();
  const old = meal({ eatenAt: new Date(Date.now() - 25 * HOUR) });
  state.meals.push(old);
  await assertRejects(
    () => call("delete_meal", { meal_id: old.id }),
    Error,
    "read-only",
  );
  await assertRejects(
    () => call("update_meal", { meal_id: old.id, description: "y" }),
    Error,
    "read-only",
  );
  assertEquals(state.meals.length, 1);
});

Deno.test(
  "unknown or malformed meal ids are rejected before touching the store",
  async () => {
    const { call } = setup();
    await assertRejects(
      () => call("delete_meal", { meal_id: "1; drop table" }),
      Error,
      "No meal",
    );
    await assertRejects(
      () => call("update_meal", { meal_id: crypto.randomUUID() }),
      Error,
      "No meal",
    );
  },
);

Deno.test("read_meals clamps days_back into the window", async () => {
  const { state, json } = setup();
  state.meals.push(
    meal({ eatenAt: new Date(Date.now() - 6.5 * 24 * HOUR) }),
    meal({ eatenAt: new Date(Date.now() - 30 * 24 * HOUR) }),
  );
  assertEquals((await json("read_meals", { days_back: 99 })).length, 1);
  assertEquals((await json("read_meals", { days_back: -3 })).length, 0);
});

Deno.test(
  "research is capped per message and by the run's budget",
  async () => {
    let spent = 0;
    let lookups = 0;
    const { run, call, tools } = setup({
      research: () => {
        lookups++;
        return Promise.resolve({
          answer: "100 kcal",
          sources: ["a", "b", "c", "d"],
          costUsd: 0.01,
        });
      },
      maxResearch: 2,
      overBudget: () => spent > 0.015,
    });
    const r = await call("research_food", { query: "chips" });
    assertEquals(
      JSON.parse((r.content[0] as { text: string }).text).sources.length,
      3,
    );
    spent = 0.02;
    await assertRejects(
      () => call("research_food", { query: "more" }),
      Error,
      "No research left",
    );
    spent = 0;
    await call("research_food", { query: "again" });
    await assertRejects(() => call("research_food", { query: "third" }));
    assertEquals(lookups, 2);
    assertEquals(run.researches, 2);
    assert(tools.has("research_food"));
    assert(!setup().tools.has("research_food"));
  },
);

Deno.test(
  "view_image only exists with photos, finds by id and is capped",
  async () => {
    const image = { type: "image" as const, data: "x", mimeType: "image/jpeg" };
    const { call } = setup({
      photos: [{ id: "p1", image }],
      fileIds: ["f1"],
      library: {
        idsFor: () => Promise.resolve(new Map()),
        load: (id) => Promise.resolve(id === "old" ? image : null),
      },
      maxImageViews: 2,
    });
    await call("view_image", { image_id: " p1 " });
    await assertRejects(
      () => call("view_image", { image_id: "missing" }),
      Error,
      "No photo",
    );
    await call("view_image", { image_id: "old" });
    await assertRejects(
      () => call("view_image", { image_id: "p1" }),
      Error,
      "No more",
    );
    assert(!setup().tools.has("view_image"));
  },
);

Deno.test(
  "ask_user trims and dedupes options, ends the turn, and is absent when asking is used up",
  async () => {
    const { run, call } = setup();
    const r = await call("ask_user", {
      question: " How much? ",
      options: [" Half ", "", "All", "Half", "A bit", "Most", "Some"],
    });
    assertEquals(r.terminate, true);
    assertEquals(run.question, {
      question: "How much?",
      options: ["Half", "All", "A bit", "Most"],
    });
    assert(!setup({}, false).tools.has("ask_user"));
  },
);

Deno.test("ask_user refuses fewer than two usable options", async () => {
  const { run, call } = setup();
  await assertRejects(() =>
    call("ask_user", { question: "kg or lb?", options: ["kg", " ", ""] }),
  );
  await assertRejects(() =>
    call("ask_user", { question: "kg or lb?", options: ["kg", "kg "] }),
  );
  assertEquals(run.question, null);
});

Deno.test("reply records the trimmed text and ends the run", async () => {
  const { run, call } = setup();
  const r = await call("reply", { text: "  Logged.  " });
  assertEquals(r.terminate, true);
  assertEquals(run.replyText, "Logged.");
});

Deno.test(
  "update_meal merges photos and notes, and a time-only change keeps the items",
  async () => {
    const { state, call, run } = setup({
      fileIds: ["f2", "f1"],
      userText: "it was at noon",
    });
    const m = meal({
      eatenAt: new Date(Date.now() - HOUR),
      photoFileIds: ["f1"],
      userNote: "rice",
      items: [item(200)],
      kcal: 200,
    });
    state.meals.push(m);
    // The fake store has no update; give it one that mirrors the repo.
    // deno-lint-ignore no-explicit-any
    (run.o.store as any).update = (id: string, patch: object) => {
      const i = state.meals.findIndex((x) => x.id === id);
      const before = state.meals[i];
      state.meals[i] = { ...before, ...patch };
      return Promise.resolve({
        meal: state.meals[i],
        before,
        batchId: run.batchId,
      });
    };
    const noon = new Date(Date.now() - 30 * 60_000).toISOString();
    await call("update_meal", {
      meal_id: m.id,
      eaten_at: noon,
      description: "  ",
    });
    const after = state.meals[0];
    assertEquals(after.description, "Meal");
    assertEquals(after.kcal, 200);
    assertEquals(after.photoFileIds, ["f1", "f2"]);
    assertEquals(after.userNote, "rice\nit was at noon");
    assertEquals(after.eatenAt.toISOString(), noon);
    assertEquals([...run.changes.values()][0].before?.eatenAt, m.eatenAt);
  },
);

Deno.test("research without sources comes back with a warning", async () => {
  let sources: string[] = [];
  const { call } = setup({
    research: () =>
      Promise.resolve({ answer: "100 kcal", sources, costUsd: 0 }),
    maxResearch: 2,
  });
  const result = async (q: string) =>
    JSON.parse(
      (
        (await call("research_food", { query: q })).content[0] as {
          text: string;
        }
      ).text,
    );
  assertStringIncludes((await result("a")).warning, "No web sources");
  sources = ["https://example.com"];
  assertEquals((await result("b")).warning, undefined);
});

Deno.test("note tools save, update, delete and cap notes", async () => {
  const { db, state } = fakeDb();
  const run = new RunState({
    store: db.meals,
    weights: db.weights,
    notes: db.notes,
    offsetMin: 0,
    sentAt: new Date(),
    userText: null,
    fileIds: [],
    messageId: 1,
  });
  const tools = new Map(mealTools(run, false).map((t) => [t.name, t]));
  const call = (name: string, args: unknown) =>
    tools.get(name)!.execute("c", args as never);

  await call("save_note", { text: "  Gainer:   40 g protein " });
  assertEquals(state.notes[0].text, "Gainer: 40 g protein");
  const id = state.notes[0].id;
  await call("update_note", { note_id: id, text: "Gainer: 42 g protein" });
  assertEquals(state.notes[0].text, "Gainer: 42 g protein");
  await assertRejects(() => call("update_note", { note_id: "x", text: "y" }));
  await call("delete_note", { note_id: id });
  assertEquals(state.notes.length, 0);
  assertEquals(
    run.noteChanges.map((c) => c.kind),
    ["created", "updated", "deleted"],
  );

  for (let i = 0; i < MAX_NOTES; i++)
    await call("save_note", { text: `n${i}` });
  await assertRejects(
    () => call("save_note", { text: "one more" }),
    Error,
    "memory is full",
  );
});
