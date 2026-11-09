import { assertEquals, assertRejects } from "@std/assert";
import { mealTools, RunState, WeightStore } from "../src/agent/tools.ts";
import type { Weight } from "../src/db/index.ts";
import { dayStart, weekStartDaysAgo } from "../src/domain/time.ts";
import {
  fmtWeight,
  fmtWeightDelta,
  isPlausibleKg,
  toKg,
  weightChange,
} from "../src/domain/weight.ts";

const DAY = 86_400_000;
// Fri 2026-10-30 12:00 UTC
const NOW = Date.UTC(2026, 9, 30, 12);

Deno.test("weights convert between kg and lb", () => {
  assertEquals(toKg(70, "kg"), 70);
  assertEquals(toKg(154.3, "lb"), 69.989);
  assertEquals(fmtWeight(70, "kg"), "70.0 kg");
  assertEquals(fmtWeight(69.99, "lb"), "154.3 lb");
  // Readings to a tenth round-trip through kg and back without drifting a tenth.
  for (let lb = 90; lb <= 400; lb += 0.1) {
    const v = Math.round(lb * 10) / 10;
    assertEquals(fmtWeight(toKg(v, "lb"), "lb"), `${v.toFixed(1)} lb`);
  }
  for (let kg = 40; kg <= 200; kg += 0.1) {
    const v = Math.round(kg * 10) / 10;
    assertEquals(fmtWeight(toKg(v, "kg"), "kg"), `${v.toFixed(1)} kg`);
  }
  assertEquals(fmtWeightDelta(-0.6, "kg"), "-0.6 kg");
  assertEquals(fmtWeightDelta(0.5, "lb"), "+1.1 lb");
  assertEquals(fmtWeightDelta(0.01, "kg"), "±0.0 kg");
  assertEquals(isPlausibleKg(19.9), false);
  assertEquals(isPlausibleKg(400), true);
  assertEquals(isPlausibleKg(NaN), false);
});

Deno.test(
  "weight change compares to the latest weigh-in at least N days old",
  () => {
    const at = (daysAgo: number, kg: number) => ({
      weighedAt: new Date(NOW - daysAgo * DAY),
      weightKg: kg,
    });
    const entries = [
      at(0, 70),
      at(3, 70.4),
      at(7, 70.6),
      at(9, 71),
      at(31, 72),
    ];
    assertEquals(weightChange(entries, 7, 0, NOW)?.toFixed(1), "-0.6");
    assertEquals(weightChange(entries, 30, 0, NOW)?.toFixed(1), "-2.0");
    assertEquals(weightChange(entries.slice(0, 2), 7, 0, NOW), null);
    assertEquals(weightChange([], 7, 0, NOW), null);
  },
);

Deno.test("weeks start on Sunday in the user's timezone", () => {
  assertEquals(weekStartDaysAgo(0, 0, NOW), 5);
  assertEquals(weekStartDaysAgo(0, 2, NOW), 19);
  // Sun 2026-11-01 00:30 local at UTC+1 is still Saturday in UTC.
  const sundayLocal = Date.UTC(2026, 9, 31, 23, 30);
  assertEquals(weekStartDaysAgo(60, 0, sundayLocal), 0);
  assertEquals(weekStartDaysAgo(0, 0, sundayLocal), 6);
  assertEquals(
    new Date(dayStart(0, weekStartDaysAgo(0, 0, NOW), NOW)).getUTCDay(),
    0,
  );
});

function fakeWeights() {
  const rows = new Map<string, Weight>();
  const store: WeightStore = {
    byId: (id) => Promise.resolve(rows.get(id) ?? null),
    recent: (n) =>
      Promise.resolve(
        [...rows.values()]
          .sort((a, b) => b.weighedAt.getTime() - a.weighedAt.getTime())
          .slice(0, n),
      ),
    create: (w) => {
      const row: Weight = {
        id: crypto.randomUUID(),
        tgId: 1,
        weighedAt: w.weighedAt ?? new Date(),
        weightKg: w.weightKg,
        unit: w.unit ?? "kg",
        batchId: w.batchId ?? null,
        sourceMessageId: w.sourceMessageId ?? null,
        createdAt: new Date(),
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    update: (id, patch) => {
      const row = rows.get(id);
      if (!row) return Promise.resolve(null);
      const next = { ...row, ...patch } as Weight;
      rows.set(id, next);
      return Promise.resolve(next);
    },
    delete: (id) => {
      const row = rows.get(id) ?? null;
      rows.delete(id);
      return Promise.resolve(row);
    },
  };
  return { rows, store };
}

function setup() {
  const weights = fakeWeights();
  const run = new RunState({
    store: {} as never,
    weights: weights.store,
    offsetMin: 60,
    sentAt: new Date(),
    userText: "154.3 lbs",
    fileIds: [],
    messageId: 7,
  });
  const tools = new Map(mealTools(run, true).map((t) => [t.name, t]));
  // deno-lint-ignore no-explicit-any
  const call = (name: string, args: any) =>
    (async () => await tools.get(name)!.execute("t", args))();
  return { ...weights, run, call };
}

Deno.test(
  "log_weight stores kg with the entered unit and the run's batch",
  async () => {
    const { rows, run, call } = setup();
    await call("log_weight", { weight: 154.3, unit: "lb" });
    const [w] = rows.values();
    assertEquals(w.weightKg, 69.989);
    assertEquals(w.unit, "lb");
    assertEquals(w.batchId, run.batchId);
    assertEquals(w.sourceMessageId, 7);
    assertEquals([...run.weightChanges.values()][0].kind, "created");
  },
);

Deno.test("log_weight rejects implausible values and bad times", async () => {
  const { rows, call } = setup();
  await assertRejects(() => call("log_weight", { weight: 7, unit: "kg" }));
  await assertRejects(() => call("log_weight", { weight: 900, unit: "lb" }));
  await assertRejects(() =>
    call("log_weight", {
      weight: 70,
      unit: "kg",
      weighed_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    }),
  );
  assertEquals(rows.size, 0);
});

Deno.test("weight changes in one run fold into their net effect", async () => {
  const { rows, run, call } = setup();
  await call("log_weight", { weight: 70, unit: "kg" });
  const id = [...rows.keys()][0];
  await call("update_weight", { weight_id: id, weight: 71 });
  assertEquals(
    [...run.weightChanges.values()].map((c) => c.kind),
    ["created"],
  );
  assertEquals(rows.get(id)!.weightKg, 71);
  await call("delete_weight", { weight_id: id });
  assertEquals(run.weightChanges.size, 0);
  await assertRejects(() => call("delete_weight", { weight_id: id }));
  await assertRejects(() => call("delete_weight", { weight_id: "nope" }));
});

Deno.test(
  "update_weight keeps the stored unit when only the number changes",
  async () => {
    const { rows, call } = setup();
    await call("log_weight", { weight: 154, unit: "lb" });
    const id = [...rows.keys()][0];
    await call("update_weight", { weight_id: id, weight: 155 });
    assertEquals(rows.get(id)!.unit, "lb");
    assertEquals(rows.get(id)!.weightKg, toKg(155, "lb"));
  },
);

Deno.test("ask_user is refused after a weigh-in was logged", async () => {
  const { call } = setup();
  await call("log_weight", { weight: 70, unit: "kg" });
  await assertRejects(() =>
    call("ask_user", { question: "kg or lb?", options: ["kg", "lb"] }),
  );
});

Deno.test("weights keep a typed second decimal only in their own unit", () => {
  assertEquals(fmtWeight(62.65, "kg", "kg"), "62.65 kg");
  assertEquals(fmtWeight(70, "kg", "kg"), "70.0 kg");
  assertEquals(fmtWeight(62.7, "kg", "kg"), "62.7 kg");
  assertEquals(fmtWeight(70, "lb", "kg"), "154.3 lb");
});
