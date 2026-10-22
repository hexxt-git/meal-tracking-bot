import { esc, telegram } from "../telegram/api.ts";
import { answerQuestion, continuePastBudget, retry } from "./assistant.ts";
import { countryAction } from "./screens/country.ts";
import type { CallbackQuery } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import {
  accountAction,
  helpView,
  keyAction,
  menuView,
  profileView,
  setReminders,
  settingsTimezone,
  settingsView,
  setUnits,
} from "./screens/account.ts";
import { editGoal, goalsView, recalcGoals, saveGoal } from "./screens/goals.ts";
import { dayView, deleteMeal, exportCsv, historyView, importHelpView, mealView, undo, weekView } from "./screens/journal.ts";
import { onboardingAction, startProfile, stepView } from "./screens/onboarding.ts";
import type { Reply } from "./ui.ts";

type Handler = (ctx: Ctx, args: string[]) => Promise<Reply> | Reply;

const int = (s: string | undefined) => Math.max(0, Number.parseInt(s ?? "0", 10) || 0);

// Callback data is `<kind>:<arg>:<arg>…`, kept under Telegram's 64-byte limit.
const HANDLERS: Record<string, Handler> = {
  menu: () => ({ view: menuView() }),
  help: () => ({ view: helpView() }),
  day: async (ctx, [n]) => ({ view: await dayView(ctx, int(n)) }),
  /** From a meal reply: today's totals as a new message, leaving the reply as it is. */
  today: async (ctx) => ({ send: await dayView(ctx, 0) }),
  week: async (ctx) => ({ view: await weekView(ctx) }),
  hist: async (ctx, [page]) => ({ view: await historyView(ctx, int(page)) }),
  meal: async (ctx, [id, origin]) => ({ view: await mealView(ctx, id, origin) }),
  del: (ctx, [id, origin]) => deleteMeal(ctx, id, origin),
  undo: (ctx, [batchId, origin]) => undo(ctx, batchId, origin),
  csv: exportCsv,
  imp: () => ({ view: importHelpView() }),

  goals: (ctx) => ({ view: goalsView(ctx) }),
  ge: editGoal,
  gs: saveGoal,
  grc: recalcGoals,

  prof: async (ctx, [action]) => ({ view: action === "edit" ? await startProfile(ctx) : profileView(ctx) }),
  ob: onboardingAction,

  set: async (ctx) => ({ view: await settingsView(ctx) }),
  units: setUnits,
  rem: setReminders,
  key: keyAction,
  acct: accountAction,
  tz: (ctx, [mode, ...rest]) => {
    if (mode === "s") return settingsTimezone(ctx, rest);
    if (ctx.user.onboardingStep !== "timezone") return { toast: "That step was already answered" };
    return rest[0] === "p" ? { view: stepView(ctx, int(rest[1])) } : onboardingAction(ctx, ["timezone", rest[0]]);
  },
  ct: countryAction,

  ask: answerQuestion,
  retry,
  budget: continuePastBudget,

  /** Only points the assistant at the meal; what to change is up to the user's next message and the assistant. */
  async fix(ctx, [id]) {
    const meal = await ctx.db.meals.byId(id);
    if (!meal) return { toast: "This meal no longer exists" };
    ctx.user = await ctx.db.users.update({ fixMealId: meal.id });
    return { send: { text: `What should change about <b>${esc(meal.description)}</b>?`, keyboard: [] } };
  },
};

export async function runCallback(ctx: Ctx, cb: CallbackQuery) {
  const [kind, ...args] = (cb.data ?? "").split(":");
  const reply = await HANDLERS[kind]?.(ctx, args) ?? {};
  if (reply.view && cb.message) await telegram.edit(ctx.user.chatId, cb.message.message_id, reply.view.text, reply.view.keyboard);
  if (reply.send) await ctx.send(reply.send);
  await telegram.answerCallback(cb.id, reply.toast);
  await reply.after?.();
}
