import "./support/env.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  deleteWeight,
  weightEntryView,
  weightView,
} from "../src/bot/screens/weight.ts";
import { buttons, fakeCtx, plain, user, weight } from "./support/fakes.ts";

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

Deno.test("empty weight screen explains how to log", async () => {
  const { ctx } = fakeCtx();
  const v = await weightView(ctx, 0);
  assertStringIncludes(plain(v), "No weigh-ins yet");
  assertEquals(buttons(v), [["menu"]]);
});

Deno.test(
  "weight screen shows latest and trends in the display unit",
  async () => {
    const { ctx } = fakeCtx({
      weights: [
        weight({ weighedAt: ago(0), weightKg: 70 }),
        weight({ weighedAt: ago(8), weightKg: 70.6 }),
        weight({ weighedAt: ago(31), weightKg: 72 }),
      ],
    });
    const out = plain(await weightView(ctx, 0));
    assertStringIncludes(out, "Latest   70.0 kg");
    assertStringIncludes(out, "7 days   -0.6 kg");
    assertStringIncludes(out, "30 days  -2.0 kg");

    ctx.user = user({ units: "imperial" });
    const lb = plain(await weightView(ctx, 0));
    assertStringIncludes(lb, "154.3 lb");
    assertStringIncludes(lb, "-4.4 lb");
  },
);

Deno.test("trends show a dash when there is no entry that old", async () => {
  const { ctx } = fakeCtx({
    weights: [
      weight({ weighedAt: ago(0), weightKg: 70 }),
      weight({ weighedAt: ago(2), weightKg: 71 }),
    ],
  });
  const out = plain(await weightView(ctx, 0));
  assertStringIncludes(out, "7 days   –");
  assertStringIncludes(out, "30 days  –");
});

Deno.test(
  "latest is right even when the newest entry is older than the trend window",
  async () => {
    const { ctx } = fakeCtx({
      weights: [weight({ weighedAt: ago(200), weightKg: 80 })],
    });
    const out = plain(await weightView(ctx, 0));
    assertStringIncludes(out, "Latest   80.0 kg");
  },
);

Deno.test("weight entries page eight at a time, newest first", async () => {
  const { ctx } = fakeCtx({
    weights: Array.from({ length: 9 }, (_, i) =>
      weight({ weighedAt: ago(i), weightKg: 70 + i }),
    ),
  });
  const first = await weightView(ctx, 0);
  const rows = buttons(first);
  assertEquals(rows.length, 8 + 2);
  assert(rows[0][0].startsWith("wte:") && rows[0][0].endsWith(":0"));
  assertEquals(rows.at(-2), ["wt:1"]);
  assertStringIncludes(first.keyboard[0][0].text, "70.0 kg");
  const second = await weightView(ctx, 1);
  assertEquals(buttons(second).length, 1 + 2);
  assertEquals(buttons(second).at(-2), ["wt:0"]);
  assertStringIncludes(second.keyboard[0][0].text, "78.0 kg");
  // A page past the end still offers a way back.
  assertEquals(buttons(await weightView(ctx, 5)).at(-2), ["wt:4"]);
});

Deno.test("entry view shows the entered unit when it differs", async () => {
  const w = weight({ weighedAt: ago(0), weightKg: 69.99, unit: "lb" });
  const { ctx } = fakeCtx({ weights: [w] });
  const v = await weightEntryView(ctx, w.id, 2);
  assertStringIncludes(plain(v), "70.0 kg  (154.3 lb)");
  assertEquals(buttons(v), [[`wtd:${w.id}:2`, "wt:2"]]);
  const gone = await weightEntryView(ctx, crypto.randomUUID(), 0);
  assertStringIncludes(plain(gone), "no longer exists");
});

Deno.test(
  "deleting a weigh-in updates the profile weight to the new latest",
  async () => {
    const latest = weight({ weighedAt: ago(0), weightKg: 70 });
    const older = weight({ weighedAt: ago(3), weightKg: 71 });
    const { ctx, state } = fakeCtx({
      user: user({ weightKg: 70 }),
      weights: [latest, older],
    });
    const r = await deleteWeight(ctx, latest.id, 0);
    assertEquals(r.toast, "Weigh-in deleted");
    assertEquals(ctx.user.weightKg, 71);
    assertEquals(
      state.weights.map((w) => w.id),
      [older.id],
    );
    assertEquals(
      (await deleteWeight(ctx, latest.id, 0)).toast,
      "Already deleted",
    );
  },
);

Deno.test("deleting the last weigh-in keeps the profile weight", async () => {
  const only = weight({ weighedAt: ago(0), weightKg: 70 });
  const { ctx } = fakeCtx({ user: user({ weightKg: 70 }), weights: [only] });
  await deleteWeight(ctx, only.id, 0);
  assertEquals(ctx.user.weightKg, 70);
});
