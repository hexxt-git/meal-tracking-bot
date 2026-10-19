import type { AgentTool } from "@earendil-works/pi-agent-core";
import { TSchema, Type } from "typebox";
import type { Meal, UserDb } from "../db/index.ts";
import { isEditable, itemTotals, MealItem, READ_WINDOW_DAYS, sanitizeItems } from "../domain/meal.ts";
import { dayStart, localStamp, parseEatenAt } from "../domain/time.ts";

export type MealStore = Pick<UserDb["meals"], "byId" | "since" | "create" | "update" | "delete">;

export type Change = { kind: "created" | "updated" | "deleted"; meal: Meal; before?: Meal };

/** Everything the tools act on during one assistant run. */
export class RunState {
  readonly batchId = crypto.randomUUID();
  readonly changes = new Map<string, Change>();
  question: { question: string; options: string[] } | null = null;

  constructor(
    readonly store: MealStore,
    readonly offsetMin: number,
    readonly sentAt: Date,
    readonly userText: string | null,
    readonly photoIds: string[],
    readonly messageId: number,
  ) {}

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

  /** A meal as the model sees it: local times and an editable flag. */
  view(m: Meal) {
    return {
      id: m.id,
      eaten_at: localStamp(m.eatenAt, this.offsetMin),
      logged_at: localStamp(m.loggedAt, this.offsetMin),
      editable: isEditable(m.loggedAt, Date.now()),
      description: m.description,
      kcal: m.kcal,
      protein_g: m.proteinG,
      carbs_g: m.carbsG,
      fat_g: m.fatG,
      items: m.items,
    };
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
  const d = parseEatenAt(s, run.sentAt.getTime(), READ_WINDOW_DAYS);
  if (!d) throw new Error(`eaten_at must be ISO 8601, not in the future and at most ${READ_WINDOW_DAYS} days back`);
  return d;
}

async function editableMeal(run: RunState, id: string): Promise<Meal> {
  const meal = UUID.test(id) ? await run.store.byId(id) : null;
  if (!meal) throw new Error(`No meal with id ${id}`);
  if (!isEditable(meal.loggedAt, Date.now())) throw new Error("This meal was logged more than 24 hours ago and is read-only");
  return meal;
}

const cleanItems = (items: MealItem[]) => sanitizeItems(items.map((i) => ({ ...i, name: i.name.trim(), portion: i.portion.trim() })));

export function mealTools(run: RunState, canAsk: boolean): AgentTool[] {
  const tools: AgentTool[] = [
    tool({
      name: "read_meals",
      label: "Read meals",
      description: `Meals eaten from the start of the local day \`days_back\` days ago until now (0 = today, max ${READ_WINDOW_DAYS - 1}).`,
      parameters: Type.Object({ days_back: Type.Integer({ minimum: 0, maximum: READ_WINDOW_DAYS - 1 }) }),
      execute: async (_id, p) => {
        const days = Math.min(READ_WINDOW_DAYS - 1, Math.max(0, p.days_back));
        const meals = await run.store.since(dayStart(run.offsetMin, days));
        return ok(meals.map((m) => run.view(m)));
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
        const { meal } = await run.store.create({
          eatenAt: eatenAt(p.eaten_at, run) ?? run.sentAt,
          loggedAt: run.sentAt,
          description: p.description.trim() || "Meal",
          userNote: run.userText,
          items,
          ...itemTotals(items),
          photoFileIds: run.photoIds,
          sourceMessageId: run.messageId,
        }, run.batchId);
        run.record("created", meal);
        return ok(run.view(meal));
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
        const result = await run.store.update(meal.id, {
          ...(p.description?.trim() ? { description: p.description.trim() } : {}),
          ...(p.eaten_at !== undefined ? { eatenAt: eatenAt(p.eaten_at, run) } : {}),
          ...(items ? { items, ...itemTotals(items) } : {}),
          ...(run.photoIds.length ? { photoFileIds: [...meal.photoFileIds, ...run.photoIds] } : {}),
          ...(run.userText ? { userNote: [meal.userNote, run.userText].filter(Boolean).join("\n") } : {}),
        }, run.batchId);
        if (!result) throw new Error(`No meal with id ${p.meal_id}`);
        run.record("updated", result.meal, result.before);
        return ok(run.view(result.meal));
      },
    }),
    tool({
      name: "delete_meal",
      label: "Delete meal",
      description: "Deletes an editable meal, e.g. one the user didn't actually eat or a duplicate.",
      parameters: Type.Object({ meal_id: Type.String() }),
      execute: async (_id, p) => {
        const meal = await editableMeal(run, p.meal_id);
        const result = await run.store.delete(meal.id, run.batchId);
        if (!result) throw new Error(`No meal with id ${p.meal_id}`);
        run.record("deleted", result.meal, result.meal);
        return ok({ deleted: meal.id });
      },
    }),
  ];
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
