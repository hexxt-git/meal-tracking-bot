import { AgentResult, Change, runAgent } from "../agent/index.ts";
import { config } from "../config.ts";
import type { Meal } from "../db/index.ts";
import { sumTotals } from "../domain/meal.ts";
import { ChatInput, isMeaningfulEdit, isOpen, Job, newQuestionId, PendingQuestion } from "../domain/question.ts";
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
  return run(ctx, { input, answers: [], fixMealId: ctx.user.fixMealId, edit: null });
}

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
  return run(ctx, { input, answers: [], fixMealId: null, edit: { before: stored?.text ?? null, sentAt: sentAt.toISOString() } });
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
  return run(ctx, { input: q.input, answers: [...q.history, { question: q.question, answer }], fixMealId: q.fixMealId, edit: null });
}

/** `retry:<id>`: runs a failed request again. */
export function retry(ctx: Ctx, [id]: string[]): Reply {
  const saved = ctx.user.retryRun;
  if (saved?.id !== id) return { toast: "This request can no longer be retried" };
  return { view: { text: "<i>Trying again…</i>", keyboard: [] }, after: () => run(ctx, saved) };
}

/** `budget:<id>`: lifts the daily budget for the rest of the UTC day and runs the request it stopped. */
export function continuePastBudget(ctx: Ctx, [id]: string[]): Reply {
  const saved = ctx.user.retryRun;
  if (saved?.id !== id) return { toast: "This request has expired. Send it again." };
  return {
    view: { text: `Daily budget lifted until midnight UTC.`, keyboard: [] },
    after: async () => {
      await ctx.db.usage.bypassBudget();
      return run(ctx, saved);
    },
  };
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

async function run(ctx: Ctx, job: Job) {
  const { input } = job;
  const apiKey = await ctx.db.keys.get();
  if (!apiKey) return ctx.send(welcomeView());
  if (!(await ctx.db.limits.hit("ai", config.limits.analysesPerDay, "1 day"))) {
    return ctx.send(`You've reached the daily limit of ${config.limits.analysesPerDay} requests. It resets at midnight UTC.`);
  }
  const usage = await ctx.db.usage.today();
  if (usage.costUsd >= config.budget.dailyUsd && !usage.bypassed) {
    return ctx.send({
      text: `Today's AI budget of ${usd(config.budget.dailyUsd)} is used up (${usd(usage.costUsd)} spent on your OpenRouter key). ` +
        "It resets at midnight UTC.\n\nContinue anyway to lift it for the rest of today.",
      keyboard: [[btn("Continue anyway", `budget:${await saveForRetry(ctx, job)}`)]],
    });
  }
  if (ctx.user.pendingQuestion || ctx.user.fixMealId || ctx.user.retryRun) {
    ctx.user = await ctx.db.users.update({ pendingQuestion: null, fixMealId: null, retryRun: null });
  }

  const typing = setInterval(() => telegram.typing(ctx.user.chatId).catch(() => {}), 4500);
  let result: AgentResult;
  try {
    await telegram.typing(ctx.user.chatId);
    result = await runAgent({
      apiKey,
      user: ctx.user,
      store: ctx.db.meals,
      text: input.text,
      media: await downloadMedia(input),
      photoIds: input.photoIds,
      sentAt: new Date(input.sentAt),
      messageId: input.messageId,
      recentMeals: await ctx.db.meals.loggedSince(new Date(Date.now() - DAY_MS)),
      fixMeal: job.fixMealId ? await ctx.db.meals.byId(job.fixMealId) : null,
      answers: job.answers,
      allowResearch: usage.bypassed || usage.costUsd < config.budget.researchCutoffUsd,
      edit: job.edit ? await editContext(ctx, job.edit, input.messageId) : undefined,
      history: await chatHistory(ctx, input.messageId),
      trace: (line) => console.log(`[agent ${ctx.user.tgId}] ${line}`),
    });
  } catch (e) {
    console.error(`[agent ${ctx.user.tgId}]`, e);
    return ctx.send({ text: "Something went wrong on my side while handling that.", keyboard: retryKeyboard(await saveForRetry(ctx, job)) });
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
      history: job.answers,
      fixMealId: job.fixMealId,
    };
    ctx.user = await ctx.db.users.update({ pendingQuestion: q });
    const sent = await ctx.send({
      text: `${esc(q.question)}\n\n<i>Tap an answer or type your own.</i>`,
      keyboard: rows(q.options.map((o, i) => btn(o, `ask:${q.id}:${i}`)), 2),
    });
    return rememberReply(ctx, sent, `Asked: ${q.question} (options: ${q.options.join(" / ")})`);
  }
  const view = await resultView(ctx, result);
  // With changes saved, a retry could log them twice; the Undo and Fix buttons cover that case instead.
  if (!result.changes.length && (result.timedOut || result.error?.transient)) view.keyboard = retryKeyboard(await saveForRetry(ctx, job));
  const sent = await ctx.send(view);
  return rememberReply(ctx, sent, replySummary(result));
}

async function editContext(ctx: Ctx, edit: NonNullable<Job["edit"]>, messageId: number) {
  const stored = await ctx.db.messages.get(messageId);
  return { before: edit.before, sentAt: new Date(edit.sentAt), meals: await ctx.db.meals.touchedBy(stored?.batchIds ?? []) };
}

/** Keeps the job so a Retry or Continue button can start it again; returns the id the button carries. */
async function saveForRetry(ctx: Ctx, { input, answers, fixMealId, edit }: Job) {
  const id = newQuestionId();
  ctx.user = await ctx.db.users.update({ retryRun: { id, input, answers, fixMealId, edit } });
  return id;
}

const retryKeyboard = (id: string) => [[btn("Retry", `retry:${id}`)]];

const usd = (n: number) => `$${n.toFixed(2)}`;

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
  else if (r.timedOut) parts.push(`That took too long, so I stopped.${r.changes.length ? " The changes above were saved." : ""}`);
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
  if (e.status === 403 && /key limit/i.test(e.message)) {
    return "Your OpenRouter key has reached the spending limit set on it at OpenRouter. Raise the limit at https://openrouter.ai/settings/keys or wait for it to reset.";
  }
  if (e.status === 403) return `OpenRouter refused the request: ${esc(e.message)}`;
  if (e.status === 429) return "OpenRouter is rate limiting your key right now. Try again in a minute.";
  if (e.status === 0) return "The connection to OpenRouter dropped before the answer arrived.";
  if (e.status >= 500) return "OpenRouter or the model provider had a temporary problem.";
  return `OpenRouter returned an error: ${esc(e.message)}`;
}
