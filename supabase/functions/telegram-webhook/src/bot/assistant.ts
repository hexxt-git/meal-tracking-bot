import { AgentResult, Change, runAgent } from "../agent/index.ts";
import { config } from "../config.ts";
import type { Meal } from "../db/index.ts";
import { sumTotals } from "../domain/meal.ts";
import { ChatInput, isMeaningfulEdit, isOpen, newQuestionId, PendingQuestion, QuestionAnswer } from "../domain/question.ts";
import { dayStart, mealTimeLabel } from "../domain/time.ts";
import { Media, OpenRouterError } from "../services/openrouter.ts";
import { esc, telegram } from "../telegram/api.ts";
import type { Message } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import { mealBody } from "./format.ts";
import { welcomeView } from "./screens/onboarding.ts";
import { btn, LOG_HINT, num, Reply, rows, View } from "./ui.ts";

const DAY_MS = 86_400_000;

/** Hands a user message to the assistant, or treats a typed reply as the answer to its open question. */
export async function respond(ctx: Ctx, msg: Message) {
  const input = await collectInput(ctx, msg);
  if (!input) return;
  if (!input.text && !input.photoIds.length && !input.audio) return ctx.send(LOG_HINT);
  await ctx.db.messages.remember(input.messageId, input.text, new Date(input.sentAt), attachments(input));

  const q = ctx.user.pendingQuestion;
  if (isOpen(q, Date.now(), config.agent.questionTtlMs) && input.text && !input.photoIds.length && !input.audio) {
    return resume(ctx, q, input.text);
  }
  return run(ctx, input, [], ctx.user.fixMealId);
}

type Edit = { before: string | null; sentAt: Date; meals: Meal[] };

/**
 * Runs the assistant on an edited message with its before and after text and the meals it logged or changed.
 * Photos are only re-sent when the original message led to no meal.
 */
export async function respondToEdit(ctx: Ctx, msg: Message) {
  const after = msg.text ?? msg.caption ?? "";
  const stored = await ctx.db.messages.get(msg.message_id);
  const sentAt = stored?.sentAt ?? new Date(msg.date * 1000);
  await ctx.db.messages.remember(msg.message_id, after, sentAt);
  if (stored && !isMeaningfulEdit(stored.text, after)) return;

  const meals = await ctx.db.meals.touchedBy(stored?.batchIds ?? []);
  const photoId = meals.length ? undefined : msg.photo?.at(-1)?.file_id;
  const input: ChatInput = {
    text: after,
    photoIds: photoId ? [photoId] : [],
    imageMime: "image/jpeg",
    audio: null,
    sentAt: new Date((msg.edit_date ?? msg.date) * 1000).toISOString(),
    messageId: msg.message_id,
  };
  return run(ctx, input, [], null, { before: stored?.text ?? null, sentAt, meals });
}

/** `ask:<questionId>:<option>` */
export function answerQuestion(ctx: Ctx, [id, index]: string[]): Reply {
  const q = ctx.user.pendingQuestion;
  const answer = q?.options[Number(index)];
  if (!isOpen(q, Date.now(), config.agent.questionTtlMs) || q.id !== id || answer === undefined) {
    return { toast: "That question has expired" };
  }
  return {
    view: { text: `${esc(q.question)}\n\n<b>${esc(answer)}</b>`, keyboard: [] },
    after: () => resume(ctx, q, answer),
  };
}

function resume(ctx: Ctx, q: PendingQuestion, answer: string) {
  return run(ctx, q.input, [...q.history, { question: q.question, answer }], q.fixMealId);
}

/** Albums arrive as one update per photo; the first update to claim the group handles all of it, the rest return null. */
async function collectInput(ctx: Ctx, msg: Message): Promise<ChatInput | null> {
  const imageDoc = msg.document?.mime_type?.startsWith("image/") ? msg.document : undefined;
  const photoId = msg.photo?.at(-1)?.file_id ?? imageDoc?.file_id;
  const audio = msg.voice ?? msg.audio;
  const base: ChatInput = {
    text: msg.text ?? msg.caption ?? "",
    photoIds: photoId ? [photoId] : [],
    imageMime: imageDoc?.mime_type ?? "image/jpeg",
    audio: audio ? { fileId: audio.file_id, mime: audio.mime_type ?? null } : null,
    sentAt: new Date(msg.date * 1000).toISOString(),
    messageId: msg.message_id,
  };
  if (!msg.media_group_id) return base;

  await ctx.db.albums.add({ mediaGroupId: msg.media_group_id, messageId: msg.message_id, fileId: photoId ?? "", caption: msg.caption ?? null });
  await new Promise((r) => setTimeout(r, config.albumSettleMs));
  const items = await ctx.db.albums.claim(msg.media_group_id);
  if (!items.length) return null;
  return {
    ...base,
    photoIds: items.map((i) => i.fileId).filter(Boolean),
    text: items.map((i) => i.caption).filter(Boolean).join("\n"),
  };
}

async function downloadMedia(input: ChatInput): Promise<Media[]> {
  const images = await Promise.all(input.photoIds.map(async (id) => ({ kind: "image" as const, mime: input.imageMime, data: await telegram.download(id) })));
  if (!input.audio) return images;
  return [...images, { kind: "audio", format: audioFormat(input.audio.mime), data: await telegram.download(input.audio.fileId) }];
}

async function run(ctx: Ctx, input: ChatInput, answers: QuestionAnswer[], fixMealId: string | null, edit?: Edit) {
  const apiKey = await ctx.db.keys.get();
  if (!apiKey) return ctx.send(welcomeView());
  if (!(await ctx.db.limits.hit("ai", config.limits.analysesPerDay, "1 day"))) {
    return ctx.send(`You've reached the daily limit of ${config.limits.analysesPerDay} requests. It resets at midnight UTC.`);
  }
  const spent = await ctx.db.usage.todayCost();
  if (spent >= config.budget.dailyUsd) {
    return ctx.send(
      `Today's AI budget of $${config.budget.dailyUsd.toFixed(2)} is used up, so I can't analyse more until midnight UTC. Your log is still available from the buttons below.`,
    );
  }
  if (ctx.user.pendingQuestion || ctx.user.fixMealId) ctx.user = await ctx.db.users.update({ pendingQuestion: null, fixMealId: null });

  const typing = setInterval(() => telegram.typing(ctx.user.chatId).catch(() => {}), 4500);
  let result: AgentResult;
  try {
    await telegram.typing(ctx.user.chatId);
    const sentAt = new Date(input.sentAt);
    result = await runAgent({
      apiKey,
      user: ctx.user,
      store: ctx.db.meals,
      text: input.text,
      media: await downloadMedia(input),
      photoIds: input.photoIds,
      sentAt,
      messageId: input.messageId,
      recentMeals: await ctx.db.meals.loggedSince(new Date(Date.now() - DAY_MS)),
      fixMeal: fixMealId ? await ctx.db.meals.byId(fixMealId) : null,
      answers,
      allowResearch: spent < config.budget.researchCutoffUsd,
      edit,
      history: await chatHistory(ctx, input.messageId),
      trace: (line) => console.log(`[agent ${ctx.user.tgId}] ${line}`),
    });
  } finally {
    clearInterval(typing);
  }
  await ctx.db.usage.record(result.costUsd, result.searches);
  if (result.changes.length) await ctx.db.messages.addBatch(input.messageId, result.batchId);
  const outcome = result.error ? `error ${result.error.status} ${result.error.message.slice(0, 200)}` : result.timedOut ? "timed out" : "ok";
  console.log(
    `[agent ${ctx.user.tgId}] ${outcome}: turns ${result.turns}, research ${result.searches}, cost $${result.costUsd.toFixed(4)}` +
      `${result.hitCostCap ? " (hit cost cap)" : ""}, generations ${result.generationIds.join(",")}`,
  );

  if (result.question && !result.changes.length) {
    const q: PendingQuestion = {
      id: newQuestionId(),
      ...result.question,
      askedAt: new Date().toISOString(),
      input,
      history: answers,
      fixMealId,
    };
    ctx.user = await ctx.db.users.update({ pendingQuestion: q });
    const sent = await ctx.send({
      text: `${esc(q.question)}\n\n<i>Tap an answer or type your own.</i>`,
      keyboard: rows(q.options.map((o, i) => btn(o, `ask:${q.id}:${i}`)), 2),
    });
    return rememberReply(ctx, sent, `Asked: ${q.question} (options: ${q.options.join(" / ")})`);
  }
  const sent = await ctx.send(await resultView(ctx, result));
  return rememberReply(ctx, sent, replySummary(result));
}

function attachments(input: ChatInput): string[] {
  return [...input.photoIds.map(() => "photo"), ...(input.audio ? ["voice note"] : [])];
}

async function chatHistory(ctx: Ctx, currentMessageId: number) {
  const rows = await ctx.db.messages.recent(config.agent.historyMessages, currentMessageId);
  return rows.map((m) => ({ role: m.role, text: m.text, attachments: m.attachments, at: m.sentAt }));
}

/** What the assistant said and did, as it will read it back in later runs. */
function replySummary(r: AgentResult): string {
  const lines = r.changes.map((c) => {
    const verb = c.kind === "created" ? "Logged" : c.kind === "updated" ? "Updated" : "Deleted";
    return c.kind === "deleted" ? `${verb} "${c.meal.description}".` : `${verb} "${c.meal.description}" (${c.meal.kcal} kcal).`;
  });
  if (r.error) lines.push(`(OpenRouter error: ${r.error.message})`);
  else if (r.reply) lines.push(r.reply);
  return lines.join(" ");
}

async function rememberReply(ctx: Ctx, sent: unknown, summary: string) {
  const id = (sent as { message_id?: number } | null)?.message_id;
  if (id && summary) await ctx.db.messages.rememberReply(id, summary);
}

async function resultView(ctx: Ctx, r: AgentResult): Promise<View> {
  const when = (m: Meal) => mealTimeLabel(m.eatenAt, m.loggedAt, ctx.user.utcOffsetMinutes);
  const card = (c: Change) => {
    if (c.kind === "deleted") return `Deleted <b>${esc(c.meal.description)}</b>.`;
    const head = `${c.kind === "updated" ? "Updated " : ""}<b>${esc(c.meal.description)}</b>  ·  ${when(c.meal)}`;
    const was = c.before && [
      ...(c.before.eatenAt.getTime() !== c.meal.eatenAt.getTime() ? [`Time was ${when(c.before)}.`] : []),
      ...(c.before.kcal !== c.meal.kcal ? [`Was ${num(c.before.kcal)} kcal.`] : []),
    ];
    return `${head}\n\n${mealBody(c.meal)}${was?.length ? `\n${was.join(" ")}` : ""}`;
  };

  const parts = r.changes.map(card);
  if (r.error) parts.push(openRouterMessage(r.error));
  else if (r.timedOut) parts.push("That took too long, so I stopped. Anything shown above was saved.");
  else if (r.reply) parts.push(esc(r.reply));
  if (!parts.length) parts.push("I couldn't do anything with that. " + LOG_HINT);

  if (!r.changes.length) return { text: parts.join("\n\n"), keyboard: [] };
  const today = sumTotals(await ctx.db.meals.since(dayStart(ctx.user.utcOffsetMinutes)));
  parts.push(`Today  ${num(today.kcal)}${ctx.user.targetKcal ? ` / ${num(ctx.user.targetKcal)}` : ""} kcal`);
  const fixable = r.changes.findLast((c) => c.kind !== "deleted");
  return {
    text: truncateHtml(parts.join("\n\n")),
    keyboard: [[btn("Undo", `undo:${r.batchId}`), ...(fixable ? [btn("Fix", `fix:${fixable.meal.id}`)] : []), btn("Today", "day:0")]],
  };
}

/** Telegram rejects messages over 4096 characters; cut at a block boundary so no tag is left open. */
function truncateHtml(s: string, max = 4000) {
  if (s.length <= max) return s;
  return `${s.slice(0, s.lastIndexOf("\n\n", max))}\n\n…`;
}

function audioFormat(mime: string | null) {
  if (!mime || mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "ogg";
}

function openRouterMessage(e: OpenRouterError) {
  if (e.status === 401) return "OpenRouter rejected your API key. Paste a new one into the chat, or replace it in Menu → Settings.";
  if (e.status === 402) return "Your OpenRouter account is out of credits. Top up at https://openrouter.ai/credits and try again.";
  if (e.status === 403) return `OpenRouter refused the request: ${esc(e.message)}`;
  if (e.status === 429) return "OpenRouter is rate limiting your key. Try again in a minute.";
  return `OpenRouter error: ${esc(e.message)}. Please try again.`;
}
