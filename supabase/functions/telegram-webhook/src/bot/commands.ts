import { telegram } from "../telegram/api.ts";
import type { Message } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import { accountAction, helpView, menuView, profileView, settingsTimezone, settingsView } from "./screens/account.ts";
import { goalsView } from "./screens/goals.ts";
import { dayView, exportCsv, historyView, weekView } from "./screens/journal.ts";
import { keyPromptView, saveKey, stepView, welcomeView } from "./screens/onboarding.ts";
import { LOG_HINT, REPLY_KEYBOARD, REPLY_KEYS, Reply, View } from "./ui.ts";

type Command = (ctx: Ctx, args: string, msg: Message) => Promise<unknown> | unknown;

const show = (ctx: Ctx, view: View | Promise<View>) => Promise.resolve(view).then(ctx.send);

/** Sends a callback-style reply as a new message (commands have no message to edit). */
async function showReply(ctx: Ctx, reply: Promise<Reply>) {
  const r = await reply;
  const view = r.view ?? r.send;
  if (view) return ctx.send(view);
  if (r.toast) return ctx.send(r.toast);
}

const COMMANDS: Record<string, Command> = {
  start: (ctx) => {
    if (ctx.user.onboardingStep === "key") return ctx.send(welcomeView());
    if (ctx.user.onboardingStep !== "done") return ctx.send(stepView(ctx));
    return telegram.sendWithReplyKeyboard(ctx.user.chatId, `Welcome back. ${LOG_HINT}`, REPLY_KEYBOARD);
  },
  menu: (ctx) => show(ctx, menuView()),
  help: (ctx) => show(ctx, helpView()),
  today: (ctx) => show(ctx, dayView(ctx, 0)),
  week: (ctx) => show(ctx, weekView(ctx)),
  history: (ctx) => show(ctx, historyView(ctx, 0)),
  goals: (ctx) => show(ctx, goalsView(ctx)),
  profile: (ctx) => show(ctx, profileView(ctx)),
  settings: (ctx) => show(ctx, settingsView(ctx)),
  timezone: (ctx) => showReply(ctx, settingsTimezone(ctx, ["p", "-1"])),
  export: (ctx) => showReply(ctx, exportCsv(ctx)),
  setkey: (ctx, args, msg) => (args ? saveKey(ctx, args, msg.message_id) : ctx.send(keyPromptView())),
  deleteaccount: (ctx) => showReply(ctx, accountAction(ctx, [])),
};

export function runCommand(ctx: Ctx, msg: Message) {
  const [head, ...rest] = msg.text!.trim().split(/\s+/);
  const name = head.slice(1).split("@")[0].toLowerCase();
  return (COMMANDS[name] ?? COMMANDS.menu)(ctx, rest.join(" "), msg);
}

/** Taps on the persistent bottom keyboard arrive as plain text. */
export function runReplyKey(ctx: Ctx, text: string): Promise<unknown> | null {
  if (text === REPLY_KEYS.today) return show(ctx, dayView(ctx, 0));
  if (text === REPLY_KEYS.history) return show(ctx, historyView(ctx, 0));
  if (text === REPLY_KEYS.menu) return show(ctx, menuView());
  return null;
}
