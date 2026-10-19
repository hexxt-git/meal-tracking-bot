import { config } from "../config.ts";
import { userDb } from "../db/index.ts";
import { TEXT_STEPS } from "../domain/onboarding.ts";
import { looksLikeKey } from "../services/openrouter.ts";
import { telegram } from "../telegram/api.ts";
import type { Message, Update } from "../telegram/types.ts";
import { runCallback } from "./callbacks.ts";
import { runCommand } from "./commands.ts";
import { createCtx, Ctx } from "./context.ts";
import { logMeal } from "./meals.ts";
import { answerText, saveKey } from "./onboarding.ts";
import { KEY_PROMPT } from "./views.ts";

export async function handleUpdate(update: Update) {
  const chat = update.message?.chat ?? update.callback_query?.message?.chat ?? update.my_chat_member?.chat;
  if (!chat) return;
  if (chat.type !== "private") return void await telegram.leave(chat.id);

  const from = update.message?.from ?? update.callback_query?.from;
  if (!from) return;

  const db = userDb(from.id);
  const admission = await db.users.admit({
    updateId: update.update_id,
    chatId: chat.id,
    firstName: from.first_name ?? null,
    maxPerHour: config.limits.messagesPerHour,
  });
  if (admission.status === "duplicate") return;

  const cb = update.callback_query;
  if (admission.status === "rate_limited") {
    if (cb) return void await telegram.answerCallback(cb.id, "Slow down a little 🙂");
    return void await telegram.send(chat.id, "You're sending messages too fast. Please try again in a bit.");
  }

  const ctx = createCtx(admission.user, db);
  try {
    if (cb) await runCallback(ctx, cb);
    else if (update.message) await routeMessage(ctx, update.message);
  } catch (e) {
    console.error(e);
    if (cb) await telegram.answerCallback(cb.id).catch(() => {});
    await ctx.reply("⚠️ Something went wrong. Please try again.").catch(() => {});
  }
}

function routeMessage(ctx: Ctx, msg: Message) {
  const step = ctx.user.onboardingStep;
  if (msg.text?.startsWith("/")) return runCommand(ctx, msg);
  if (msg.text && looksLikeKey(msg.text)) return saveKey(ctx, msg.text.trim(), msg.message_id);
  if (msg.text && step === "key") return ctx.reply(KEY_PROMPT);
  if (msg.text && TEXT_STEPS.includes(step)) return answerText(ctx, msg.text);
  return logMeal(ctx, msg);
}
