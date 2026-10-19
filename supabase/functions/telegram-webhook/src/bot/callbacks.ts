import type { Step } from "../domain/onboarding.ts";
import { fmtOffset, TZ_OFFSETS } from "../domain/time.ts";
import { btn, esc, telegram } from "../telegram/api.ts";
import type { CallbackQuery } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import { answerChoice, skip } from "./onboarding.ts";

type Handler = (ctx: Ctx, cb: CallbackQuery, args: string[]) => Promise<string | void>;

const original = (cb: CallbackQuery) => esc(cb.message?.text ?? "");
const editSource = (ctx: Ctx, cb: CallbackQuery, html: string) => telegram.edit(ctx.user.chatId, cb.message!.message_id, html);

// Each handler returns an optional toast text for answerCallbackQuery.
const HANDLERS: Record<string, Handler> = {
  async ob(ctx, cb, [step, value]) {
    if (step === "skip") {
      await editSource(ctx, cb, `${original(cb)}\n<b>→ Skipped</b>`);
      await skip(ctx);
      return;
    }
    const label = await answerChoice(ctx, step as Step, value);
    if (!label) return "That question was already answered.";
    await editSource(ctx, cb, `${original(cb)}\n<b>→ ${esc(label)}</b>`);
  },

  async tz(ctx, cb, [value]) {
    const offset = Number(value);
    if (!TZ_OFFSETS.includes(offset)) return;
    ctx.user = await ctx.db.users.update({ utcOffsetMinutes: offset });
    await editSource(ctx, cb, `🕒 Timezone set to <b>${fmtOffset(offset)}</b>.`);
  },

  async undo(ctx, cb, [revisionId]) {
    if (!(await ctx.db.meals.undo(revisionId))) return "Already undone.";
    await editSource(ctx, cb, `${original(cb)}\n\n<i>↩️ Undone</i>`);
    return "Undone";
  },

  async fix(ctx, _cb, [mealId]) {
    const meal = await ctx.db.meals.byId(mealId);
    if (!meal) return "That meal no longer exists.";
    ctx.user = await ctx.db.users.update({ fixMealId: meal.id });
    await ctx.reply(`✏️ What should change about <b>${esc(meal.description)}</b>? Send text, a photo or a voice note.`);
  },

  async del(ctx, _cb, [mealId]) {
    const revisionId = await ctx.db.meals.delete(mealId);
    if (!revisionId) return "Already gone.";
    await ctx.reply("🗑 Meal deleted.", [[btn("↩️ Undo", `undo:${revisionId}`)]]);
    return "Deleted";
  },

  async delacct(ctx, cb, [answer]) {
    if (answer !== "yes") return void await editSource(ctx, cb, "Cancelled. Nothing was deleted.");
    await ctx.db.users.deleteAccount();
    await editSource(ctx, cb, "🗑 Your account, meals and key were deleted. Send /start to begin again.");
  },
};

export async function runCallback(ctx: Ctx, cb: CallbackQuery) {
  const [kind, ...args] = (cb.data ?? "").split(":");
  const toast = await HANDLERS[kind]?.(ctx, cb, args);
  await telegram.answerCallback(cb.id, toast || undefined);
}
