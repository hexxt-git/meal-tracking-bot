import { ACTIVITY, computeTargets } from "../../domain/nutrition.ts";
import {
  clampStep,
  completeProfile,
  nextStep,
  NumericStep,
  paceOptions,
  parseChoice,
  prevStep,
  PROFILE_START,
  PROFILE_STEPS,
  ProfilePatch,
  Step,
  stepAfterKey,
  stepper,
} from "../../domain/onboarding.ts";
import { isValidKey, looksLikeKey } from "../../services/openrouter.ts";
import { telegram } from "../../telegram/api.ts";
import type { Button } from "../../telegram/types.ts";
import type { Ctx } from "../context.ts";
import { goalsTable } from "./goals.ts";
import { TZ_QUESTION, tzPicker } from "./timezone.ts";
import { btn, link, LOG_HINT, REPLY_KEYBOARD, Reply, View } from "../ui.ts";

export const KEYS_URL = "https://openrouter.ai/keys";

export const welcomeView = (): View => ({
  text: `<b>Meal Tracker</b>

Log what you eat with a photo, a short description or a voice note. Calories and macros are estimated for you and tracked against your daily goals.

To start, paste an OpenRouter API key into this chat. It is only used for your own requests, stored encrypted, and your message is deleted right away.`,
  keyboard: [[link("Get a key at openrouter.ai", KEYS_URL)]],
});

export const keyPromptView = (back?: string): View => ({
  text: "Paste your OpenRouter API key into this chat. Your message is deleted right after it's saved.",
  keyboard: [[link("Get a key at openrouter.ai", KEYS_URL)], ...(back ? [[btn("‹ Back", back)]] : [])],
});

const isNumeric = (s: Step): s is NumericStep => s === "age" || s === "height" || s === "weight";

const QUESTIONS: Partial<Record<Step, string>> = {
  units: "Which units do you use?",
  sex: "What's your sex? It's used in the metabolic rate formula.",
  age: "How old are you?",
  height: "How tall are you?",
  weight: "What do you weigh right now?",
  activity: "How active are you on a typical week?",
  objective: "What's your goal?",
  pace: "How fast?",
  timezone: TZ_QUESTION,
};

/** Renders the current onboarding step. `value` is the stepper position for numeric steps, or the picker page for timezone. */
export function stepView(ctx: Ctx, value?: number, prefix = ""): View {
  const u = ctx.user;
  const step = u.onboardingStep;
  const header = `${prefix}<b>Setup</b>  ·  step ${PROFILE_STEPS.indexOf(step) + 1} of ${PROFILE_STEPS.length}\n\n${QUESTIONS[step] ?? ""}`;
  const prev = prevStep(step, u.objective);
  const footer: Button[] = [...(prev ? [btn("‹ Back", "ob:back")] : []), btn("Skip setup", "ob:skip")];
  const choose = (options: [string, string][]) => options.map(([label, v]) => btn(label, `ob:${step}:${v}`));

  if (isNumeric(step)) {
    const spec = stepper(step, u);
    const v = clampStep(spec, value ?? spec.initial);
    return {
      text: `${header}\n\n<pre>   ${spec.format(v)}   </pre>`,
      keyboard: [
        spec.deltas.map((d) => btn(d > 0 ? `+${d}` : `−${-d}`, `ob:${step}:v:${clampStep(spec, v + d)}`)),
        [...footer.slice(0, -1), btn("Next ›", `ob:${step}:ok:${v}`)],
        [footer.at(-1)!],
      ],
    };
  }

  const options: Record<string, Button[][]> = {
    units: [choose([["Metric  ·  kg, cm", "metric"], ["Imperial  ·  lb, ft", "imperial"]])],
    sex: [choose([["Male", "male"], ["Female", "female"]])],
    activity: Object.entries(ACTIVITY).map(([k, a]) => choose([[a.label, k]])),
    objective: [choose([["Lose weight", "lose"], ["Maintain", "maintain"], ["Gain weight", "gain"]])],
    pace: [paceOptions(u.units, u.objective).map((p) => btn(p.label, `ob:pace:${p.kg}`))],
    timezone: tzPicker("o", value ?? null, u.utcOffsetMinutes),
  };
  return { text: header, keyboard: [...(options[step] ?? []), footer] };
}

export async function saveKey(ctx: Ctx, key: string, messageId: number) {
  await telegram.deleteMessage(ctx.user.chatId, messageId);
  if (!looksLikeKey(key) || !(await isValidKey(key))) {
    return ctx.send({ text: "OpenRouter didn't accept that key. Your message was deleted. Check the key and paste it again.", keyboard: [[link("Open openrouter.ai/keys", KEYS_URL)]] });
  }
  await ctx.db.keys.set(key);
  const firstSetup = ctx.user.onboardingStep === "key";
  ctx.user = await ctx.db.users.update({ onboardingStep: stepAfterKey(ctx.user.onboardingStep, ctx.user.targetKcal != null) });
  if (firstSetup && ctx.user.onboardingStep === PROFILE_START) {
    return ctx.send(stepView(ctx, undefined, "Key saved and your message deleted.\n\nNext, a few questions to set your daily goals.\n\n"));
  }
  return ctx.send("Key saved and your message deleted.");
}

export async function startProfile(ctx: Ctx): Promise<View> {
  ctx.user = await ctx.db.users.update({ onboardingStep: PROFILE_START });
  return stepView(ctx);
}

async function advance(ctx: Ctx, patch: ProfilePatch): Promise<Reply> {
  const objective = patch.objective ?? ctx.user.objective;
  ctx.user = await ctx.db.users.update({ ...patch, onboardingStep: nextStep(ctx.user.onboardingStep, objective) });
  return ctx.user.onboardingStep === "done" ? finish(ctx) : { view: stepView(ctx) };
}

/** Handles `ob:*` callbacks. */
export async function onboardingAction(ctx: Ctx, args: string[]): Promise<Reply> {
  const [step, a, b] = args;
  if (step === "skip") {
    ctx.user = await ctx.db.users.update({ onboardingStep: "done" });
    await sendReplyKeyboard(ctx);
    return { view: { text: "Setup skipped. You can finish it any time from Menu → Profile.", keyboard: [[btn("Today", "day:0"), btn("Menu", "menu")]] } };
  }
  if (step === "back") {
    const prev = prevStep(ctx.user.onboardingStep, ctx.user.objective);
    if (!prev) return {};
    ctx.user = await ctx.db.users.update({ onboardingStep: prev });
    return { view: stepView(ctx) };
  }
  if (step !== ctx.user.onboardingStep) return { toast: "That step was already answered" };

  if (isNumeric(step)) {
    const spec = stepper(step, ctx.user);
    const v = clampStep(spec, Number(b));
    if (a === "v") return { view: stepView(ctx, v) };
    if (a === "ok") return advance(ctx, spec.toPatch(v));
    return {};
  }
  const patch = parseChoice(step as Step, a, ctx.user);
  return patch ? advance(ctx, patch) : {};
}

async function finish(ctx: Ctx): Promise<Reply> {
  const profile = completeProfile(ctx.user);
  if (profile) {
    const t = computeTargets(profile);
    ctx.user = await ctx.db.users.update({ targetKcal: t.kcal, targetProteinG: t.protein_g, targetCarbsG: t.carbs_g, targetFatG: t.fat_g });
  }
  await sendReplyKeyboard(ctx);
  if (!profile) {
    return { view: { text: "Setup saved, but some answers are missing, so no goals were set.", keyboard: [[btn("Profile", "prof"), btn("Today", "day:0")]] } };
  }
  return {
    view: {
      text: `<b>Setup complete</b>\n\nYour daily goals:\n${goalsTable(ctx.user)}You can adjust them any time in Menu → Goals.\n\n${LOG_HINT}`,
      keyboard: [[btn("Today", "day:0"), btn("Goals", "goals")]],
    },
  };
}

function sendReplyKeyboard(ctx: Ctx) {
  return telegram.sendWithReplyKeyboard(ctx.user.chatId, "Use the buttons below to open Today, History or the Menu.", REPLY_KEYBOARD);
}
