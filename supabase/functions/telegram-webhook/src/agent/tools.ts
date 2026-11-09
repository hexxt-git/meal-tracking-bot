import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { TSchema, Type } from "typebox";
import type { Meal, Note, UserDb, Weight } from "../db/index.ts";
import {
  isEditable,
  itemTotals,
  MealItem,
  READ_WINDOW_DAYS,
  sanitizeItems,
} from "../domain/meal.ts";
import { dayStart, localStamp, parseEatenAt } from "../domain/time.ts";
import {
  isPlausibleKg,
  MAX_WEIGHT_KG,
  MIN_WEIGHT_KG,
  toKg,
  WeightUnit,
} from "../domain/weight.ts";

export type MealStore = Pick<
  UserDb["meals"],
  "byId" | "since" | "create" | "update" | "delete"
>;

export type WeightStore = Pick<
  UserDb["weights"],
  "byId" | "recent" | "create" | "update" | "delete"
>;

export type NoteStore = Pick<
  UserDb["notes"],
  "byId" | "list" | "create" | "update" | "delete"
>;

export type NoteChange = {
  kind: "created" | "updated" | "deleted";
  text: string;
};

/** Notes kept per user; past this, the assistant must merge or delete before saving more. */
export const MAX_NOTES = 40;
export const MAX_NOTE_CHARS = 300;

export type WeightChange = {
  kind: "created" | "updated" | "deleted";
  weight: Weight;
  before?: Weight;
};

export type Change = {
  kind: "created" | "updated" | "deleted";
  meal: Meal;
  before?: Meal;
};

/** Web lookup used by `research_food`; returns a short answer and what it cost. */
export type ResearchFn = (
  query: string,
) => Promise<{ answer: string; sources: string[]; costUsd: number }>;

/** Photos the user sent earlier, by the short ids the assistant sees. */
export type PhotoLibrary = {
  /** Ids by Telegram file id; files without one are left out. */
  idsFor: (fileIds: string[]) => Promise<Map<string, string>>;
  load: (photoId: string) => Promise<ImageContent | null>;
};

export type RunOptions = {
  batchId?: string;
  store: MealStore;
  weights: WeightStore;
  /** Absent in contexts without memory; the note tools are then left out. */
  notes?: NoteStore;
  offsetMin: number;
  sentAt: Date;
  userText: string | null;
  /** Telegram file ids of this message's photos, saved on the meals it logs. */
  fileIds: string[];
  messageId: number;
  /** This message's photos with their ids, in the same order as `fileIds`. */
  photos?: { id: string; image: ImageContent }[];
  library?: PhotoLibrary;
  maxImageViews?: number;
  /** Null when research is unavailable (not configured, or today's budget is nearly used). */
  research?: ResearchFn | null;
  maxResearch?: number;
  /** True once the run has spent its cost cap. */
  overBudget?: () => boolean;
};

/** Everything the tools act on during one assistant run. */
export class RunState {
  readonly batchId: string;
  readonly changes = new Map<string, Change>();
  readonly weightChanges = new Map<string, WeightChange>();
  readonly noteChanges: NoteChange[] = [];
  question: { question: string; options: string[] } | null = null;
  replyText: string | null = null;
  researches = 0;
  researchCostUsd = 0;
  imageViews = 0;
  private readonly photoIds = new Map<string, string>();

  constructor(readonly o: RunOptions) {
    this.batchId = o.batchId ?? crypto.randomUUID();
    o.photos?.forEach((p, i) => {
      if (o.fileIds[i]) this.photoIds.set(o.fileIds[i], p.id);
    });
  }

  /** Folds successive changes to one meal into its net effect for this run. */
  record(kind: Change["kind"], meal: Meal, before?: Meal) {
    const prev = this.changes.get(meal.id);
    if (!prev) return this.changes.set(meal.id, { kind, meal, before });
    if (prev.kind === "created") {
      if (kind === "deleted") return this.changes.delete(meal.id);
      return this.changes.set(meal.id, { kind: "created", meal });
    }
    this.changes.set(meal.id, { kind, meal, before: prev.before });
  }

  recordWeight(kind: WeightChange["kind"], weight: Weight, before?: Weight) {
    const prev = this.weightChanges.get(weight.id);
    if (!prev)
      return this.weightChanges.set(weight.id, { kind, weight, before });
    if (prev.kind === "created") {
      if (kind === "deleted") return this.weightChanges.delete(weight.id);
      return this.weightChanges.set(weight.id, { kind: "created", weight });
    }
    this.weightChanges.set(weight.id, { kind, weight, before: prev.before });
  }

  weightView(w: Weight) {
    return {
      id: w.id,
      weighed_at: localStamp(w.weighedAt, this.o.offsetMin),
      weight_kg: w.weightKg,
      entered_in: w.unit,
    };
  }

  /** Meals as the model sees them: local times, an editable flag and the ids of their photos. */
  async views(meals: Meal[]) {
    const unknown = meals
      .flatMap((m) => m.photoFileIds)
      .filter((f) => !this.photoIds.has(f));
    if (unknown.length && this.o.library) {
      for (const [fileId, id] of await this.o.library.idsFor([
        ...new Set(unknown),
      ]))
        this.photoIds.set(fileId, id);
    }
    return meals.map((m) => {
      const photos = m.photoFileIds.flatMap((f) => this.photoIds.get(f) ?? []);
      return {
        id: m.id,
        eaten_at: localStamp(m.eatenAt, this.o.offsetMin),
        logged_at: localStamp(m.loggedAt, this.o.offsetMin),
        editable: isEditable(m.loggedAt, Date.now()),
        description: m.description,
        kcal: m.kcal,
        protein_g: m.proteinG,
        carbs_g: m.carbsG,
        fat_g: m.fatG,
        items: m.items,
        ...(photos.length ? { photos } : {}),
      };
    });
  }

  async view(m: Meal) {
    return (await this.views([m]))[0];
  }
}

/** Infers each tool's parameter type for `execute` while letting tools of different shapes share one list. */
const tool = <T extends TSchema>(t: AgentTool<T>) => t as unknown as AgentTool;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Item = Type.Object({
  name: Type.String(),
  portion: Type.String({
    description: 'Amount eaten, e.g. "150 g", "1 cup", "2 slices"',
  }),
  kcal: Type.Number(),
  protein_g: Type.Number(),
  carbs_g: Type.Number(),
  fat_g: Type.Number(),
});

const EatenAt = Type.String({
  description:
    "When it was eaten, ISO 8601 with the user's UTC offset. Omit when the user gives no time.",
});

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
  details: undefined,
});

function eatenAt(
  s: string | undefined,
  run: RunState,
  field = "eaten_at",
): Date | undefined {
  if (s === undefined) return undefined;
  const d = parseEatenAt(s, run.o.sentAt.getTime(), READ_WINDOW_DAYS);
  if (!d)
    throw new Error(
      `${field} must be ISO 8601, not in the future and at most ${READ_WINDOW_DAYS} days back`,
    );
  return d;
}

const Unit = Type.Union([Type.Literal("kg"), Type.Literal("lb")]);

const WeighedAt = Type.String({
  description:
    "When they weighed themselves, ISO 8601 with the user's UTC offset. Omit when the user gives no time.",
});

function weightKg(value: number, unit: WeightUnit): number {
  const kg = toKg(value, unit);
  if (!isPlausibleKg(kg))
    throw new Error(
      `Weight must be between ${MIN_WEIGHT_KG} and ${MAX_WEIGHT_KG} kg; check the number and the unit`,
    );
  return kg;
}

async function existingWeight(run: RunState, id: string): Promise<Weight> {
  const w = UUID.test(id) ? await run.o.weights.byId(id) : null;
  if (!w) throw new Error(`No weigh-in with id ${id}`);
  return w;
}

function weightTools(run: RunState): AgentTool[] {
  return [
    tool({
      name: "read_weights",
      label: "Read weights",
      description: "The user's most recent weigh-ins, newest first.",
      parameters: Type.Object({
        limit: Type.Integer({ minimum: 1, maximum: 60 }),
      }),
      execute: async (_id, p) => {
        const rows = await run.o.weights.recent(
          Math.min(60, Math.max(1, p.limit)),
        );
        return ok(rows.map((w) => run.weightView(w)));
      },
    }),
    tool({
      name: "log_weight",
      label: "Log weight",
      description:
        "Records a body weight reading, in the unit the user gave or the scale shows.",
      parameters: Type.Object({
        weight: Type.Number(),
        unit: Unit,
        weighed_at: Type.Optional(WeighedAt),
      }),
      execute: async (_id, p) => {
        const weight = await run.o.weights.create({
          weighedAt: eatenAt(p.weighed_at, run, "weighed_at") ?? run.o.sentAt,
          weightKg: weightKg(p.weight, p.unit),
          unit: p.unit,
          batchId: run.batchId,
          sourceMessageId: run.o.messageId,
        });
        run.recordWeight("created", weight);
        return ok(run.weightView(weight));
      },
    }),
    tool({
      name: "update_weight",
      label: "Update weight",
      description:
        "Corrects a weigh-in. Pass weight and unit together to change the value.",
      parameters: Type.Object({
        weight_id: Type.String(),
        weight: Type.Optional(Type.Number()),
        unit: Type.Optional(Unit),
        weighed_at: Type.Optional(WeighedAt),
      }),
      execute: async (_id, p) => {
        const before = await existingWeight(run, p.weight_id);
        const unit = p.unit ?? before.unit;
        const result = await run.o.weights.update(before.id, {
          ...(p.weight !== undefined
            ? { weightKg: weightKg(p.weight, unit), unit }
            : {}),
          ...(p.weighed_at !== undefined
            ? { weighedAt: eatenAt(p.weighed_at, run, "weighed_at") }
            : {}),
        });
        if (!result) throw new Error(`No weigh-in with id ${p.weight_id}`);
        run.recordWeight("updated", result, before);
        return ok(run.weightView(result));
      },
    }),
    tool({
      name: "delete_weight",
      label: "Delete weight",
      description: "Deletes a weigh-in, e.g. a wrong reading or a duplicate.",
      parameters: Type.Object({ weight_id: Type.String() }),
      execute: async (_id, p) => {
        const w = await existingWeight(run, p.weight_id);
        const gone = await run.o.weights.delete(w.id);
        if (!gone) throw new Error(`No weigh-in with id ${p.weight_id}`);
        run.recordWeight("deleted", gone, gone);
        return ok({ deleted: w.id });
      },
    }),
  ];
}

function noteTools(run: RunState, notes: NoteStore): AgentTool[] {
  const NoteText = Type.String({ minLength: 1, maxLength: MAX_NOTE_CHARS });
  const clean = (s: string) => {
    const t = s.trim().replace(/\s+/g, " ");
    if (!t) throw new Error("A note needs some text");
    if (t.length > MAX_NOTE_CHARS)
      throw new Error(`Notes are at most ${MAX_NOTE_CHARS} characters`);
    return t;
  };
  const existing = async (id: string) => {
    const n = UUID.test(id) ? await notes.byId(id) : null;
    if (!n) throw new Error(`No note with id ${id}`);
    return n;
  };
  return [
    tool({
      name: "save_note",
      label: "Save note",
      description:
        "Remembers a lasting fact about the user for all future messages, e.g. their own product's nutrition, a usual portion or a preference. Not for one-off meals.",
      parameters: Type.Object({ text: NoteText }),
      execute: async (_id, p) => {
        const text = clean(p.text);
        if ((await notes.list()).length >= MAX_NOTES)
          throw new Error(
            `The user already has ${MAX_NOTES} notes. Make room by merging duplicates or deleting outdated ones (never overwrite an unrelated note); if none can go, tell the user their memory is full`,
          );
        const n = await notes.create(text);
        run.noteChanges.push({ kind: "created", text });
        return ok({ id: n.id, text });
      },
    }),
    tool({
      name: "update_note",
      label: "Update note",
      description:
        "Replaces a note's text, e.g. when the user corrects a remembered fact. Write the complete new text.",
      parameters: Type.Object({ note_id: Type.String(), text: NoteText }),
      execute: async (_id, p) => {
        const before = await existing(p.note_id.trim());
        const text = clean(p.text);
        const n = await notes.update(before.id, text);
        if (!n) throw new Error(`No note with id ${p.note_id}`);
        run.noteChanges.push({ kind: "updated", text });
        return ok({ id: n.id, text });
      },
    }),
    tool({
      name: "delete_note",
      label: "Delete note",
      description:
        "Forgets a note that is wrong or no longer true, or that the user asks you to forget.",
      parameters: Type.Object({ note_id: Type.String() }),
      execute: async (_id, p) => {
        const n = await existing(p.note_id.trim());
        await notes.delete(n.id);
        run.noteChanges.push({ kind: "deleted", text: n.text });
        return ok({ deleted: n.id });
      },
    }),
  ];
}

/** As the assistant sees notes in its prompt. */
export const noteView = (n: Note) => ({ id: n.id, text: n.text });

async function editableMeal(run: RunState, id: string): Promise<Meal> {
  const meal = UUID.test(id) ? await run.o.store.byId(id) : null;
  if (!meal) throw new Error(`No meal with id ${id}`);
  if (!isEditable(meal.loggedAt, Date.now()))
    throw new Error(
      "This meal was logged more than 24 hours ago and is read-only",
    );
  return meal;
}

const cleanItems = (items: MealItem[]) =>
  sanitizeItems(
    items.map((i) => ({
      ...i,
      name: i.name.trim(),
      portion: i.portion.trim(),
    })),
  );

export function mealTools(run: RunState, canAsk: boolean): AgentTool[] {
  const tools: AgentTool[] = [
    tool({
      name: "reply",
      label: "Reply",
      description:
        "Sends your final reply and ends the run. Call it in the same turn as your last change.",
      parameters: Type.Object({ text: Type.String() }),
      execute: (_id, p) => {
        run.replyText = p.text.trim();
        return Promise.resolve({ ...ok({ sent: true }), terminate: true });
      },
    }),
    tool({
      name: "read_meals",
      label: "Read meals",
      description: `Meals eaten from the start of the local day \`days_back\` days ago until now (0 = today, max ${READ_WINDOW_DAYS - 1}).`,
      parameters: Type.Object({
        days_back: Type.Integer({ minimum: 0, maximum: READ_WINDOW_DAYS - 1 }),
      }),
      execute: async (_id, p) => {
        const days = Math.min(READ_WINDOW_DAYS - 1, Math.max(0, p.days_back));
        const meals = await run.o.store.since(dayStart(run.o.offsetMin, days));
        return ok(await run.views(meals));
      },
    }),
    tool({
      name: "log_meal",
      label: "Log meal",
      description: "Records a new meal.",
      parameters: Type.Object({
        description: Type.String({
          description:
            'Short title for the whole meal, e.g. "Chicken shawarma plate"',
        }),
        eaten_at: Type.Optional(EatenAt),
        items: Type.Array(Item, { minItems: 1 }),
      }),
      execute: async (_id, p) => {
        const items = cleanItems(p.items);
        const { meal } = await run.o.store.create(
          {
            eatenAt: eatenAt(p.eaten_at, run) ?? run.o.sentAt,
            loggedAt: run.o.sentAt,
            description: p.description.trim() || "Meal",
            userNote: run.o.userText,
            items,
            ...itemTotals(items),
            photoFileIds: run.o.fileIds,
            sourceMessageId: run.o.messageId,
          },
          run.batchId,
        );
        run.record("created", meal);
        return ok(await run.view(meal));
      },
    }),
    tool({
      name: "update_meal",
      label: "Update meal",
      description:
        "Changes an editable meal. Pass only the fields that change; items replaces the whole item list.",
      parameters: Type.Object({
        meal_id: Type.String(),
        description: Type.Optional(Type.String()),
        eaten_at: Type.Optional(EatenAt),
        items: Type.Optional(Type.Array(Item, { minItems: 1 })),
      }),
      execute: async (_id, p) => {
        const meal = await editableMeal(run, p.meal_id);
        const items = p.items && cleanItems(p.items);
        const result = await run.o.store.update(
          meal.id,
          {
            ...(p.description?.trim()
              ? { description: p.description.trim() }
              : {}),
            ...(p.eaten_at !== undefined
              ? { eatenAt: eatenAt(p.eaten_at, run) }
              : {}),
            ...(items ? { items, ...itemTotals(items) } : {}),
            ...(run.o.fileIds.length
              ? {
                  photoFileIds: [
                    ...new Set([...meal.photoFileIds, ...run.o.fileIds]),
                  ],
                }
              : {}),
            ...(run.o.userText
              ? {
                  userNote: [meal.userNote, run.o.userText]
                    .filter(Boolean)
                    .join("\n"),
                }
              : {}),
          },
          run.batchId,
        );
        if (!result) throw new Error(`No meal with id ${p.meal_id}`);
        run.record("updated", result.meal, result.before);
        return ok(await run.view(result.meal));
      },
    }),
    tool({
      name: "delete_meal",
      label: "Delete meal",
      description:
        "Deletes an editable meal, e.g. one the user didn't actually eat or a duplicate.",
      parameters: Type.Object({ meal_id: Type.String() }),
      execute: async (_id, p) => {
        const meal = await editableMeal(run, p.meal_id);
        const result = await run.o.store.delete(meal.id, run.batchId);
        if (!result) throw new Error(`No meal with id ${p.meal_id}`);
        run.record("deleted", result.meal, result.meal);
        return ok({ deleted: meal.id });
      },
    }),
    ...weightTools(run),
    ...(run.o.notes ? noteTools(run, run.o.notes) : []),
  ];
  if (run.o.photos?.length || run.o.library) {
    const maxViews = run.o.maxImageViews ?? 3;
    tools.push(
      tool({
        name: "view_image",
        label: "View image",
        description:
          `Shows an earlier photo from the conversation or meals by its id (this message's photos are already attached). ` +
          `Costs money; at most ${maxViews} per message.`,
        parameters: Type.Object({ image_id: Type.String() }),
        execute: async (_id, p) => {
          if (run.imageViews >= maxViews)
            throw new Error("No more image views for this message");
          const id = p.image_id.trim();
          const image =
            run.o.photos?.find((x) => x.id === id)?.image ??
            (await run.o.library?.load(id));
          if (!image) throw new Error(`No photo with id ${id}`);
          run.imageViews++;
          return {
            content: [{ type: "text" as const, text: `Photo ${id}:` }, image],
            details: undefined,
          };
        },
      }),
    );
  }
  if (run.o.research) {
    const research = run.o.research;
    tools.push(
      tool({
        name: "research_food",
        label: "Research food",
        description: `Looks up nutrition facts on the web for one product, dish or menu item. Costs money; at most ${run.o.maxResearch ?? 0} per message.`,
        parameters: Type.Object({
          query: Type.String({
            description:
              'Brand, product and variant, e.g. "Mahboul potato chips salted 100 g bag"',
          }),
        }),
        execute: async (_id, p) => {
          if (
            run.researches >= (run.o.maxResearch ?? 0) ||
            run.o.overBudget?.()
          )
            throw new Error(
              "No research left for this message; estimate instead",
            );
          const r = await research(p.query);
          run.researches++;
          run.researchCostUsd += r.costUsd;
          return ok({
            answer: r.answer,
            sources: r.sources.slice(0, 3),
            ...(r.sources.length
              ? {}
              : {
                  warning:
                    "No web sources came back, so this may be from memory and wrong. Trust the photo and label over it.",
                }),
          });
        },
      }),
    );
  }
  if (!canAsk) return tools;
  return [
    ...tools,
    tool({
      name: "ask_user",
      label: "Ask user",
      description:
        "Shows the user a multiple-choice question as buttons and ends this turn. Only when strictly necessary.",
      parameters: Type.Object({
        question: Type.String(),
        options: Type.Array(Type.String({ maxLength: 30 }), {
          minItems: 2,
          maxItems: 4,
        }),
      }),
      execute: (_id, p) => {
        if (run.changes.size || run.weightChanges.size)
          throw new Error("Ask before logging or changing anything, not after");
        const options = [
          ...new Set(p.options.map((o) => o.trim()).filter(Boolean)),
        ].slice(0, 4);
        if (options.length < 2)
          throw new Error("Give 2 to 4 different, non-empty options");
        run.question = { question: p.question.trim(), options };
        return Promise.resolve({ ...ok({ asked: true }), terminate: true });
      },
    }),
  ];
}
