import { computeTargets } from "../domain/nutrition.ts";
import {
  completeProfile,
  nextStep,
  parseChoice,
  parseTextAnswer,
  PROFILE_START,
  ProfilePatch,
  Step,
  stepAfterKey,
} from "../domain/onboarding.ts";
import { isValidKey, looksLikeKey } from "../services/openrouter.ts";
import { telegram } from "../telegram/api.ts";
import type { Ctx } from "./context.ts";
import { fmtTargets, LOG_HINT, stepQuestion } from "./views.ts";

export function askStep(ctx: Ctx) {
  const q = stepQuestion(ctx.user);
  return q ? ctx.reply(q.text, q.keyboard) : undefined;
}

export async function startProfile(ctx: Ctx) {
  ctx.user = await ctx.db.users.update({ onboardingStep: PROFILE_START });
  return askStep(ctx);
}

export async function saveKey(ctx: Ctx, key: string, messageId: number) {
  await telegram.deleteMessage(ctx.user.chatId, messageId);
  if (!looksLikeKey(key) || !(await isValidKey(key))) {
    return ctx.reply("❌ OpenRouter rejected that key (I deleted your message). Double-check it and paste it again.");
  }
  await ctx.db.keys.set(key);
  const wasOnboarding = ctx.user.onboardingStep === "key";
  ctx.user = await ctx.db.users.update({ onboardingStep: stepAfterKey(ctx.user.onboardingStep, ctx.user.targetKcal != null) });
  await ctx.reply("🔑 Key saved and your message deleted.");
  if (wasOnboarding && ctx.user.onboardingStep === PROFILE_START) {
    await ctx.reply("Now a few quick questions so I can set your daily calorie and macro targets.");
    return askStep(ctx);
  }
}

async function advance(ctx: Ctx, patch: ProfilePatch) {
  ctx.user = await ctx.db.users.update({ ...patch, onboardingStep: nextStep(ctx.user.onboardingStep, patch) });
  return ctx.user.onboardingStep === "done" ? finish(ctx) : askStep(ctx);
}

export function answerText(ctx: Ctx, text: string) {
  const result = parseTextAnswer(ctx.user.onboardingStep, text, ctx.user.units);
  return "error" in result ? ctx.reply(result.error) : advance(ctx, result.patch);
}

/** Returns the label to show for the chosen button, or null if the button is stale. */
export async function answerChoice(ctx: Ctx, step: Step, value: string): Promise<string | null> {
  if (ctx.user.onboardingStep !== step) return null;
  const answer = parseChoice(step, value, ctx.user);
  if (!answer) return null;
  await advance(ctx, answer.patch);
  return answer.label;
}

export async function skip(ctx: Ctx) {
  ctx.user = await ctx.db.users.update({ onboardingStep: "done" });
  return ctx.reply(`No problem. Run /profile whenever you want targets. ${LOG_HINT}`);
}

async function finish(ctx: Ctx) {
  const profile = completeProfile(ctx.user);
  if (!profile) return ctx.reply(`✅ All set. Your profile is incomplete, so there are no targets yet (run /profile any time).\n\n${LOG_HINT}`);
  const t = computeTargets(profile);
  ctx.user = await ctx.db.users.update({ targetKcal: t.kcal, targetProteinG: t.protein_g, targetCarbsG: t.carbs_g, targetFatG: t.fat_g });
  return ctx.reply(`✅ <b>Your daily targets</b>\n${fmtTargets(ctx.user)}\n\nOverride with <code>/goals 2200 160 220 70</code> (kcal P C F).\n\n${LOG_HINT}`);
}
