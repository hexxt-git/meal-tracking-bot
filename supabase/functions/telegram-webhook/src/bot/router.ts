import { config } from "../config.ts";
import { userDb } from "../db/index.ts";
import { looksLikeKey } from "../services/openrouter.ts";
import { telegram } from "../telegram/api.ts";
import type { Message, Update } from "../telegram/types.ts";
import { runCallback } from "./callbacks.ts";
import { runCommand, runReplyKey } from "./commands.ts";
import { createCtx, Ctx } from "./context.ts";
import { respond, respondToEdit } from "./assistant.ts";
import { importCsv, isCsvFile } from "./screens/journal.ts";
import { saveKey, stepView, welcomeView } from "./screens/onboarding.ts";

export async function handleUpdate(update: Update) {
  const chat = update.message?.chat ?? update.edited_message?.chat ?? update.callback_query?.message?.chat ??
    update.my_chat_member?.chat;
  if (!chat) return;
  if (chat.type !== "private") return void await telegram.leave(chat.id);

  const from = update.message?.from ?? update.edited_message?.from ?? update.callback_query?.from;
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
    if (cb) return void await telegram.answerCallback(cb.id, "Too many requests. Try again in a bit.");
    return void await telegram.send(chat.id, "You're sending messages too fast. Please try again in a bit.");
  }

  const ctx = createCtx(admission.user, db);
  try {
    if (cb) await runCallback(ctx, cb);
    else if (update.message) await routeMessage(ctx, update.message);
    else if (update.edited_message) await routeEdit(ctx, update.edited_message);
  } catch (e) {
    console.error(e);
    if (cb) await telegram.answerCallback(cb.id, "Something went wrong").catch(() => {});
    else await ctx.send("Something went wrong. Please try again.").catch(() => {});
  }
}

function routeMessage(ctx: Ctx, msg: Message) {
  const text = msg.text?.trim();
  if (text?.startsWith("/")) return runCommand(ctx, msg);
  if (text && looksLikeKey(text)) return saveKey(ctx, text, msg.message_id);
  if (ctx.user.onboardingStep === "key") return ctx.send(welcomeView());
  if (msg.document && isCsvFile(msg.document)) return importCsv(ctx, msg.document);
  const nav = text ? runReplyKey(ctx, text) : null;
  if (nav) return nav;
  // During setup, typed text would be ambiguous, so re-show the current step instead of passing it to the assistant.
  if (text && ctx.user.onboardingStep !== "done") return ctx.send(stepView(ctx));
  return respond(ctx, msg);
}

/** Only edits to messages the assistant could have handled are passed on; commands, keys and setup answers are not. */
function routeEdit(ctx: Ctx, msg: Message) {
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (ctx.user.onboardingStep !== "done" || !text || text.startsWith("/") || looksLikeKey(text)) return;
  return respondToEdit(ctx, msg);
}
