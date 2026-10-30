import type { Ctx } from "../../src/bot/context.ts";
import type { View } from "../../src/bot/ui.ts";
import type { Meal, User, UserDb, Weight } from "../../src/db/index.ts";
import type { NewMeal, NewWeight, UserPatch } from "../../src/db/schema.ts";

export const user = (patch: Partial<User> = {}): User => ({
  tgId: 1,
  chatId: 1,
  firstName: "Test",
  onboardingStep: "done",
  units: "metric",
  sex: null,
  age: null,
  heightCm: null,
  weightKg: null,
  activity: null,
  objective: null,
  paceKgPerWeek: null,
  utcOffsetMinutes: 0,
  country: null,
  targetKcal: null,
  targetProteinG: null,
  targetCarbsG: null,
  targetFatG: null,
  fixMealId: null,
  remindersEnabled: true,
  lastReminderAt: null,
  pendingQuestion: null,
  retryRun: null,
  aiSettings: {},
  awaitingInput: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...patch,
});

export const goals = {
  targetKcal: 2300,
  targetProteinG: 132,
  targetCarbsG: 250,
  targetFatG: 70,
};

export function meal(patch: Partial<Meal> & { eatenAt: Date }): Meal {
  return {
    id: crypto.randomUUID(),
    tgId: 1,
    loggedAt: patch.eatenAt,
    description: "Meal",
    userNote: null,
    items: [],
    kcal: 500,
    proteinG: 30,
    carbsG: 50,
    fatG: 20,
    photoFileIds: [],
    sourceMessageId: null,
    createdAt: patch.eatenAt,
    updatedAt: patch.eatenAt,
    ...patch,
  };
}

export function weight(patch: Partial<Weight> & { weighedAt: Date }): Weight {
  return {
    id: crypto.randomUUID(),
    tgId: 1,
    weightKg: 70,
    unit: "kg",
    batchId: null,
    sourceMessageId: null,
    createdAt: patch.weighedAt,
    ...patch,
  };
}

const newestFirst = <T>(rows: T[], at: (r: T) => Date) =>
  [...rows].sort((a, b) => at(b).getTime() - at(a).getTime());

/** In-memory stand-in for the repos the bot screens use. Unused repos throw so a test notices. */
export function fakeDb(
  init: { user?: User; meals?: Meal[]; weights?: Weight[] } = {},
) {
  const state = {
    user: init.user ?? user(),
    meals: [...(init.meals ?? [])],
    weights: [...(init.weights ?? [])],
    batches: new Map<string, string[]>(),
    updates: [] as UserPatch[],
    withinLimits: true,
    usage: { costUsd: 0, bypassed: false },
    replies: [] as { id: number; text: string }[],
    providerSecret: null as {
      token: string | null;
      headers: Record<string, string>;
    } | null,
  };
  const byEaten = () =>
    [...state.meals].sort((a, b) => a.eatenAt.getTime() - b.eatenAt.getTime());

  const meals = {
    byId: (id: string) =>
      Promise.resolve(state.meals.find((m) => m.id === id) ?? null),
    since: (from: Date) =>
      Promise.resolve(byEaten().filter((m) => m.eatenAt >= from)),
    between: (from: Date, to: Date) =>
      Promise.resolve(
        byEaten().filter((m) => m.eatenAt >= from && m.eatenAt < to),
      ),
    loggedSince: (from: Date) =>
      Promise.resolve(
        newestFirst(
          state.meals.filter((m) => m.loggedAt >= from),
          (m) => m.loggedAt,
        ),
      ),
    all: () => Promise.resolve(byEaten()),
    page: (page: number, size: number) => {
      const rows = byEaten()
        .reverse()
        .slice(page * size, page * size + size + 1);
      return Promise.resolve({
        meals: rows.slice(0, size),
        hasMore: rows.length > size,
      });
    },
    create: (m: NewMeal, batchId: string = crypto.randomUUID()) => {
      const row = meal({ ...m, eatenAt: m.eatenAt ?? new Date() } as Meal);
      state.meals.push(row);
      state.batches.set(batchId, [
        ...(state.batches.get(batchId) ?? []),
        row.id,
      ]);
      return Promise.resolve({ meal: row, batchId });
    },
    delete: (id: string, batchId: string = crypto.randomUUID()) => {
      const row = state.meals.find((m) => m.id === id);
      if (!row) return Promise.resolve(null);
      state.meals = state.meals.filter((m) => m.id !== id);
      return Promise.resolve({ meal: row, batchId });
    },
    /** Only reverts creations, which is all these tests need. */
    undo: (batchId: string) => {
      const ids = state.batches.get(batchId) ?? [];
      state.batches.delete(batchId);
      const gone = state.meals.filter((m) => ids.includes(m.id));
      state.meals = state.meals.filter((m) => !ids.includes(m.id));
      return Promise.resolve(
        gone.map((m) => ({
          mealId: m.id,
          description: m.description,
          restored: false,
        })),
      );
    },
  };

  const weights = {
    byId: (id: string) =>
      Promise.resolve(state.weights.find((w) => w.id === id) ?? null),
    recent: (limit: number) =>
      Promise.resolve(
        newestFirst(state.weights, (w) => w.weighedAt).slice(0, limit),
      ),
    since: (from: Date) =>
      Promise.resolve(
        newestFirst(
          state.weights.filter((w) => w.weighedAt >= from),
          (w) => w.weighedAt,
        ),
      ),
    page: (page: number, size: number) => {
      const rows = newestFirst(state.weights, (w) => w.weighedAt).slice(
        page * size,
        page * size + size + 1,
      );
      return Promise.resolve({
        weights: rows.slice(0, size),
        hasMore: rows.length > size,
      });
    },
    create: (w: NewWeight) => {
      const row = weight({
        ...w,
        weighedAt: w.weighedAt ?? new Date(),
      } as Weight);
      state.weights.push(row);
      return Promise.resolve(row);
    },
    update: (id: string, patch: Partial<NewWeight>) => {
      const i = state.weights.findIndex((w) => w.id === id);
      if (i < 0) return Promise.resolve(null);
      state.weights[i] = { ...state.weights[i], ...patch } as Weight;
      return Promise.resolve(state.weights[i]);
    },
    delete: (id: string) => {
      const row = state.weights.find((w) => w.id === id) ?? null;
      state.weights = state.weights.filter((w) => w.id !== id);
      return Promise.resolve(row);
    },
    undo: (batchId: string) => {
      const gone = state.weights.filter((w) => w.batchId === batchId);
      state.weights = state.weights.filter((w) => w.batchId !== batchId);
      return Promise.resolve(gone);
    },
  };

  const users = {
    update: (patch: UserPatch) => {
      state.updates.push(patch);
      state.user = { ...state.user, ...patch } as User;
      return Promise.resolve(state.user);
    },
  };

  const keys = {
    get: () => Promise.resolve(null),
    getProvider: () => Promise.resolve(state.providerSecret),
  };

  const limits = { hit: () => Promise.resolve(state.withinLimits) };
  const usage = {
    today: () => Promise.resolve({ ...state.usage }),
    record: (costUsd: number) => {
      state.usage.costUsd += costUsd;
      return Promise.resolve();
    },
    bypassBudget: () => {
      state.usage.bypassed = true;
      return Promise.resolve();
    },
  };
  const messages = {
    get: () => Promise.resolve(null),
    remember: () => Promise.resolve(),
    rememberReply: (id: number, text: string) => {
      state.replies.push({ id, text });
      return Promise.resolve();
    },
    recent: () => Promise.resolve([]),
    addBatch: () => Promise.resolve(),
  };
  const photos = {
    register: () => Promise.resolve([]),
    idsFor: () => Promise.resolve(new Map()),
    fileId: () => Promise.resolve(null),
  };

  const unused = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, prop) => () => {
          throw new Error(`fakeDb.${name}.${String(prop)} is not faked`);
        },
      },
    );

  const db = {
    meals,
    weights,
    users,
    keys,
    limits,
    albums: unused("albums"),
    usage,
    messages,
    photos,
  } as unknown as UserDb;

  return { db, state };
}

/** A context over a fake db; `sent` collects what the bot sends as new messages. */
export function fakeCtx(init: Parameters<typeof fakeDb>[0] = {}) {
  const { db, state } = fakeDb(init);
  const sent: (View | string)[] = [];
  const ctx: Ctx = {
    user: state.user,
    db,
    send: (view) => {
      sent.push(view);
      return Promise.resolve({ message_id: 1 });
    },
  };
  return { ctx, state, sent };
}

/** Callback data of every button, row by row. */
export const buttons = (v: View) =>
  v.keyboard.map((row) =>
    row.map((b) => ("callback_data" in b ? b.callback_data : b.text)),
  );

export const labels = (v: View) => v.keyboard.flat().map((b) => b.text);

/** View text without HTML tags and entities, for readable assertions. */
export const plain = (v: View | string) =>
  (typeof v === "string" ? v : v.text)
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
