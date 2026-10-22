import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { TSchema, Type } from "typebox";
import type { Meal, UserDb } from "../db/index.ts";
import { isEditable, itemTotals, MealItem, READ_WINDOW_DAYS, sanitizeItems } from "../domain/meal.ts";
import { dayStart, localStamp, parseEatenAt } from "../domain/time.ts";

export type MealStore = Pick<UserDb["meals"], "byId" | "since" | "create" | "update" | "delete">;

export type Change = { kind: "created" | "updated" | "deleted"; meal: Meal; before?: Meal };

/** Web lookup used by `research_food`; returns a short answer and what it cost. */
export type ResearchFn = (query: string) => Promise<{ answer: string; sources: string[]; costUsd: number }>;

/** Photos the user sent earlier, by the short ids the assistant sees. */
export type PhotoLibrary = {
  /** Ids by Telegram file id; files without one are left out. */
  idsFor: (fileIds: string[]) => Promise<Map<string, string>>;
  load: (photoId: string) => Promise<ImageContent | null>;
};

export type RunOptions = {
  store: MealStore;
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
  readonly batchId = crypto.randomUUID();
  readonly changes = new Map<string, Change>();
  question: { question: string; options: string[] } | null = null;
  replyText: string | null = null;
  researches = 0;
  researchCostUsd = 0;
  imageViews = 0;
  private readonly photoIds = new Map<string, string>();

  constructor(readonly o: RunOptions) {
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

  /** Meals as the model sees them: local times, an editable flag and the ids of their photos. */
  async views(meals: Meal[]) {
    const unknown = meals.flatMap((m) => m.photoFileIds).filter((f) => !this.photoIds.has(f));
    if (unknown.length && this.o.library) {
      for (const [fileId, id] of await this.o.library.idsFor([...new Set(unknown)])) this.photoIds.set(fileId, id);
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
  portion: Type.String({ description: 'Amount eaten, e.g. "150 g", "1 cup", "2 slices"' }),
  kcal: Type.Number(),
  protein_g: Type.Number(),
  carbs_g: Type.Number(),
  fat_g: Type.Number(),
});

const EatenAt = Type.String({
  description: "When it was eaten, ISO 8601 with the user's UTC offset. Omit when the user gives no time.",
});

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }], details: undefined });

function eatenAt(s: string | undefined, run: RunState): Date | undefined {
  if (s === undefined) return undefined;
  const d = parseEatenAt(s, run.o.sentAt.getTime(), READ_WINDOW_DAYS);
  if (!d) throw new Error(`eaten_at must be ISO 8601, not in the future and at most ${READ_WINDOW_DAYS} days back`);
  return d;
}

async function editableMeal(run: RunState, id: string): Promise<Meal> {
  const meal = UUID.test(id) ? await run.o.store.byId(id) : null;
  if (!meal) throw new Error(`No meal with id ${id}`);
  if (!isEditable(meal.loggedAt, Date.now())) throw new Error("This meal was logged more than 24 hours ago and is read-only");
  return meal;
}

const cleanItems = (items: MealItem[]) => sanitizeItems(items.map((i) => ({ ...i, name: i.name.trim(), portion: i.portion.trim() })));

export function mealTools(run: RunState, canAsk: boolean): AgentTool[] {
  const tools: AgentTool[] = [
    tool({
      name: "reply",
      label: "Reply",
      description: "Sends your final reply and ends the run. Call it in the same turn as your last change.",
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
      parameters: Type.Object({ days_back: Type.Integer({ minimum: 0, maximum: READ_WINDOW_DAYS - 1 }) }),
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
        description: Type.String({ description: 'Short title for the whole meal, e.g. "Chicken shawarma plate"' }),
        eaten_at: Type.Optional(EatenAt),
        items: Type.Array(Item, { minItems: 1 }),
      }),
      execute: async (_id, p) => {
        const items = cleanItems(p.items);
        const { meal } = await run.o.store.create({
          eatenAt: eatenAt(p.eaten_at, run) ?? run.o.sentAt,
          loggedAt: run.o.sentAt,
          description: p.description.trim() || "Meal",
          userNote: run.o.userText,
          items,
          ...itemTotals(items),
          photoFileIds: run.o.fileIds,
          sourceMessageId: run.o.messageId,
        }, run.batchId);
        run.record("created", meal);
        return ok(await run.view(meal));
      },
    }),
    tool({
      name: "update_meal",
      label: "Update meal",
      description: "Changes an editable meal. Pass only the fields that change; items replaces the whole item list.",
      parameters: Type.Object({
        meal_id: Type.String(),
        description: Type.Optional(Type.String()),
        eaten_at: Type.Optional(EatenAt),
        items: Type.Optional(Type.Array(Item, { minItems: 1 })),
      }),
      execute: async (_id, p) => {
        const meal = await editableMeal(run, p.meal_id);
        const items = p.items && cleanItems(p.items);
        const result = await run.o.store.update(meal.id, {
          ...(p.description?.trim() ? { description: p.description.trim() } : {}),
          ...(p.eaten_at !== undefined ? { eatenAt: eatenAt(p.eaten_at, run) } : {}),
          ...(items ? { items, ...itemTotals(items) } : {}),
          ...(run.o.fileIds.length ? { photoFileIds: [...new Set([...meal.photoFileIds, ...run.o.fileIds])] } : {}),
          ...(run.o.userText ? { userNote: [meal.userNote, run.o.userText].filter(Boolean).join("\n") } : {}),
        }, run.batchId);
        if (!result) throw new Error(`No meal with id ${p.meal_id}`);
        run.record("updated", result.meal, result.before);
        return ok(await run.view(result.meal));
      },
    }),
    tool({
      name: "delete_meal",
      label: "Delete meal",
      description: "Deletes an editable meal, e.g. one the user didn't actually eat or a duplicate.",
      parameters: Type.Object({ meal_id: Type.String() }),
      execute: async (_id, p) => {
        const meal = await editableMeal(run, p.meal_id);
        const result = await run.o.store.delete(meal.id, run.batchId);
        if (!result) throw new Error(`No meal with id ${p.meal_id}`);
        run.record("deleted", result.meal, result.meal);
        return ok({ deleted: meal.id });
      },
    }),
  ];
  if (run.o.photos?.length || run.o.library) {
    const maxViews = run.o.maxImageViews ?? 3;
    tools.push(tool({
      name: "view_image",
      label: "View image",
      description: `Shows one photo the user sent, by its id: this message's photos (only attached to your first request) or ` +
        `earlier ones from the conversation and meals. Costs money; at most ${maxViews} per message.`,
      parameters: Type.Object({ image_id: Type.String() }),
      execute: async (_id, p) => {
        if (run.imageViews >= maxViews) throw new Error("No more image views for this message");
        const id = p.image_id.trim();
        const image = run.o.photos?.find((x) => x.id === id)?.image ?? await run.o.library?.load(id);
        if (!image) throw new Error(`No photo with id ${id}`);
        run.imageViews++;
        return { content: [{ type: "text" as const, text: `Photo ${id}:` }, image], details: undefined };
      },
    }));
  }
  if (run.o.research) {
    const research = run.o.research;
    tools.push(tool({
      name: "research_food",
      label: "Research food",
      description: `Looks up nutrition facts on the web for one product, dish or menu item. Costs money; at most ${run.o.maxResearch ?? 0} per message.`,
      parameters: Type.Object({
        query: Type.String({ description: 'Brand, product and variant, e.g. "Mahboul potato chips salted 100 g bag"' }),
      }),
      execute: async (_id, p) => {
        if (run.researches >= (run.o.maxResearch ?? 0) || run.o.overBudget?.()) throw new Error("No research left for this message; estimate instead");
        const r = await research(p.query);
        run.researches++;
        run.researchCostUsd += r.costUsd;
        return ok({ answer: r.answer, sources: r.sources.slice(0, 3) });
      },
    }));
  }
  if (!canAsk) return tools;
  return [...tools, tool({
    name: "ask_user",
    label: "Ask user",
    description: "Shows the user a multiple-choice question as buttons and ends this turn. Only when strictly necessary.",
    parameters: Type.Object({
      question: Type.String(),
      options: Type.Array(Type.String({ maxLength: 30 }), { minItems: 2, maxItems: 4 }),
    }),
    execute: (_id, p) => {
      if (run.changes.size) throw new Error("Ask before logging or changing meals, not after");
      run.question = { question: p.question.trim(), options: p.options.map((o) => o.trim()).filter(Boolean).slice(0, 4) };
      return Promise.resolve({ ...ok({ asked: true }), terminate: true });
    },
  })];
}
