import { fmtOffset } from "../domain/time.ts";
import { btn } from "../telegram/api.ts";
import type { Message } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import { askStep, saveKey, startProfile } from "./onboarding.ts";
import { exportCsv, goals, history, today, week } from "./reports.ts";
import { HELP, KEY_PROMPT, LOG_HINT, tzKeyboard } from "./views.ts";

type Command = (ctx: Ctx, args: string, msg: Message) => unknown;

const COMMANDS: Record<string, Command> = {
  start: (ctx) => {
    if (ctx.user.onboardingStep === "key") return ctx.reply(`👋 <b>Welcome to Meal Tracker!</b>\n\n${KEY_PROMPT}`);
    if (ctx.user.onboardingStep !== "done") return askStep(ctx);
    return ctx.reply(`👋 Welcome back! ${LOG_HINT}\n\n${HELP}`);
  },
  help: (ctx) => ctx.reply(HELP),
  setkey: (ctx, args, msg) => (args ? saveKey(ctx, args, msg.message_id) : ctx.reply(KEY_PROMPT)),
  deletekey: async (ctx) => {
    await ctx.db.keys.delete();
    return ctx.reply("🔑 Your OpenRouter key was deleted. Paste a new one any time to keep logging.");
  },
  deleteaccount: (ctx) =>
    ctx.reply("⚠️ Delete your profile, every logged meal and your stored key? This can't be undone.", [
      [btn("Yes, delete everything", "delacct:yes"), btn("Cancel", "delacct:no")],
    ]),
  profile: startProfile,
  timezone: (ctx) => ctx.reply(`🕒 Current timezone: <b>${fmtOffset(ctx.user.utcOffsetMinutes)}</b>. Pick yours:`, tzKeyboard("tz")),
  goals: (ctx, args) => goals(ctx, args),
  today,
  week,
  history,
  export: exportCsv,
};

export function runCommand(ctx: Ctx, msg: Message) {
  const [head, ...rest] = msg.text!.trim().split(/\s+/);
  const name = head.slice(1).split("@")[0].toLowerCase();
  return (COMMANDS[name] ?? COMMANDS.help)(ctx, rest.join(" "), msg);
}
