import { esc, telegram } from "../telegram/api.ts";
import type { CallbackQuery } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import { accountAction, helpView, keyAction, menuView, profileView, settingsTimezone, settingsView, setUnits } from "./screens/account.ts";
import { editGoal, goalsView, recalcGoals, saveGoal } from "./screens/goals.ts";
import { dayView, deleteMeal, exportCsv, historyView, mealView, undo, weekView } from "./screens/journal.ts";
import { onboardingAction, startProfile, stepView } from "./screens/onboarding.ts";
import { btn, Reply } from "./ui.ts";

type Handler = (ctx: Ctx, args: string[]) => Promise<Reply> | Reply;

const int = (s: string | undefined) => Math.max(0, Number.parseInt(s ?? "0", 10) || 0);

// Callback data is `<kind>:<arg>:<arg>…`, kept under Telegram's 64-byte limit.
const HANDLERS: Record<string, Handler> = {
  menu: () => ({ view: menuView() }),
  help: () => ({ view: helpView() }),
  day: async (ctx, [n]) => ({ view: await dayView(ctx, int(n)) }),
  week: async (ctx) => ({ view: await weekView(ctx) }),
  hist: async (ctx, [page]) => ({ view: await historyView(ctx, int(page)) }),
  meal: async (ctx, [id, origin]) => ({ view: await mealView(ctx, id, origin) }),
  del: (ctx, [id, origin]) => deleteMeal(ctx, id, origin),
  undo: (ctx, [revisionId, origin]) => undo(ctx, revisionId, origin),
  csv: exportCsv,

  goals: (ctx) => ({ view: goalsView(ctx) }),
  ge: editGoal,
  gs: saveGoal,
  grc: recalcGoals,

  prof: async (ctx, [action]) => ({ view: action === "edit" ? await startProfile(ctx) : profileView(ctx) }),
  ob: onboardingAction,

  set: async (ctx) => ({ view: await settingsView(ctx) }),
  units: setUnits,
  key: keyAction,
  acct: accountAction,
  tz: (ctx, [mode, ...rest]) => {
    if (mode === "s") return settingsTimezone(ctx, rest);
    if (ctx.user.onboardingStep !== "timezone") return { toast: "That step was already answered" };
    return rest[0] === "p" ? { view: stepView(ctx, int(rest[1])) } : onboardingAction(ctx, ["timezone", rest[0]]);
  },

  async fix(ctx, [id]) {
    if (!id) {
      ctx.user = await ctx.db.users.update({ fixMealId: null });
      return { view: { text: "Correction cancelled.", keyboard: [] } };
    }
    const meal = await ctx.db.meals.byId(id);
    if (!meal) return { toast: "This meal no longer exists" };
    ctx.user = await ctx.db.users.update({ fixMealId: meal.id });
    return {
      send: {
        text: `What should change about <b>${esc(meal.description)}</b>? Reply with text, a photo or a voice note.`,
        keyboard: [[btn("Cancel", "fix")]],
      },
    };
  },
};

export async function runCallback(ctx: Ctx, cb: CallbackQuery) {
  const [kind, ...args] = (cb.data ?? "").split(":");
  const reply = await HANDLERS[kind]?.(ctx, args) ?? {};
  if (reply.view && cb.message) await telegram.edit(ctx.user.chatId, cb.message.message_id, reply.view.text, reply.view.keyboard);
  if (reply.send) await ctx.send(reply.send);
  await telegram.answerCallback(cb.id, reply.toast);
}
