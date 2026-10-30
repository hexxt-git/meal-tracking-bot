import { AgentResult, Change, runAgent, WeightChange } from "../agent/index.ts";
import { config } from "../config.ts";
import type { Meal } from "../db/index.ts";
import { sumTotals } from "../domain/meal.ts";
import {
  ChatInput,
  isMeaningfulEdit,
  isOpen,
  Job,
  newQuestionId,
  PendingQuestion,
} from "../domain/question.ts";
import { dayStart, mealTimeLabel } from "../domain/time.ts";
import { fmtWeight, unitFor, unitsFor } from "../domain/weight.ts";
import type { PhotoLibrary } from "../agent/tools.ts";
import { base64, Media, ProviderError } from "../services/llm.ts";
import { resolveProviders } from "./providers.ts";
import { RESEARCH, RESEARCH_CUTOFF_SHARE } from "../domain/ai-settings.ts";
import { esc, telegram } from "../telegram/api.ts";
import type { Message } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import { clock, dayLabel, kcalLeft, mealBody } from "./format.ts";
import { welcomeView } from "./screens/onboarding.ts";
import { btn, LOG_HINT, num, Reply, rows, View } from "./ui.ts";

const DAY_MS = 86_400_000;

/** Hands a user message to the assistant, or treats a typed reply as the answer to its open question. */
export async function respond(ctx: Ctx, msg: Message) {
  const input = await collectInput(ctx, msg);
  if (!input) return;
  if (!input.text && !input.photoIds.length && !input.audio)
    return ctx.send(LOG_HINT);
  const photoRefs = await ctx.db.photos.register(input.photoIds);
  await ctx.db.messages.remember(
    input.messageId,
    input.text,
    new Date(input.sentAt),
    attachments(input, photoRefs),
  );

  const q = ctx.user.pendingQuestion;
  if (
    isOpen(q, Date.now(), config.agent.questionTtlMs) &&
    input.text &&
    !input.photoIds.length &&
    !input.audio
  ) {
    return resume(ctx, q, input.text);
  }
  return run(ctx, {
    input,
    answers: [],
    fixMealId: ctx.user.fixMealId,
    edit: null,
  });
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
  return run(ctx, {
    input,
    answers: [],
    fixMealId: null,
    edit: { before: stored?.text ?? null, sentAt: sentAt.toISOString() },
  });
}

/** `ask:<questionId>:<option>` */
export function answerQuestion(ctx: Ctx, [id, index]: string[]): Reply {
  const q = ctx.user.pendingQuestion;
  const answer = q?.options[Number(index)];
  if (
    !isOpen(q, Date.now(), config.agent.questionTtlMs) ||
    q.id !== id ||
    answer === undefined
  ) {
    return { toast: "That question has expired" };
  }
  return {
    view: { text: `${esc(q.question)}\n\n<b>${esc(answer)}</b>`, keyboard: [] },
    after: () => resume(ctx, q, answer),
  };
}

function resume(ctx: Ctx, q: PendingQuestion, answer: string) {
  return run(ctx, {
    input: q.input,
    answers: [...q.history, { question: q.question, answer }],
    fixMealId: q.fixMealId,
    edit: null,
  });
}

/** `retry:<id>`: runs a failed request again. */
export function retry(ctx: Ctx, [id]: string[]): Reply {
  const saved = ctx.user.retryRun;
  if (saved?.id !== id)
    return { toast: "This request can no longer be retried" };
  return {
    view: { text: "<i>Trying again…</i>", keyboard: [] },
    after: () => run(ctx, saved),
  };
}

/** `budget:<id>`: lifts the daily budget for the rest of the UTC day and runs the request it stopped. */
export function continuePastBudget(ctx: Ctx, [id]: string[]): Reply {
  const saved = ctx.user.retryRun;
  if (saved?.id !== id)
    return { toast: "This request has expired. Send it again." };
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
  const imageDoc = msg.document?.mime_type?.startsWith("image/")
    ? msg.document
    : undefined;
  const photoId = msg.photo?.at(-1)?.file_id ?? imageDoc?.file_id;
  const audio = msg.voice ?? msg.audio;
  const base: ChatInput = {
    text: msg.text ?? msg.caption ?? "",
    photoIds: photoId ? [photoId] : [],
    imageMime: imageDoc?.mime_type ?? "image/jpeg",
    audio: audio
      ? { fileId: audio.file_id, mime: audio.mime_type ?? null }
      : null,
    sentAt: new Date(msg.date * 1000).toISOString(),
    messageId: msg.message_id,
  };
  if (!msg.media_group_id) return base;

  await ctx.db.albums.add({
    mediaGroupId: msg.media_group_id,
    messageId: msg.message_id,
    fileId: photoId ?? "",
    caption: msg.caption ?? null,
  });
  await new Promise((r) => setTimeout(r, config.albumSettleMs));
  const items = await ctx.db.albums.claim(msg.media_group_id);
  if (!items.length) return null;
  return {
    ...base,
    photoIds: items.map((i) => i.fileId).filter(Boolean),
    text: items
      .map((i) => i.caption)
      .filter(Boolean)
      .join("\n"),
  };
}

/** Only what the model can receive: no photos for a text-only model, no voice notes outside OpenRouter. */
async function downloadMedia(
  input: ChatInput,
  can: { images: boolean; audio: boolean },
): Promise<Media[]> {
  const images = await Promise.all(
    (can.images ? input.photoIds : []).map(async (id) => ({
      kind: "image" as const,
      mime: input.imageMime,
      data: await telegram.download(id),
    })),
  );
  if (!input.audio || !can.audio) return images;
  return [
    ...images,
    {
      kind: "audio",
      format: audioFormat(input.audio.mime),
      data: await telegram.download(input.audio.fileId),
    },
  ];
}

async function run(ctx: Ctx, job: Job) {
  const { input } = job;
  const providers = await resolveProviders(ctx);
  if (!providers) return ctx.send(welcomeView());
  const { chat, settings } = providers;
  if (!(await ctx.db.limits.hit("ai", config.limits.analysesPerDay, "1 day"))) {
    return ctx.send(
      `You've reached the daily limit of ${config.limits.analysesPerDay} requests. It resets at midnight UTC.`,
    );
  }
  const usage = await ctx.db.usage.today();
  const budget = usage.bypassed ? null : settings.dailyBudgetUsd;
  if (budget != null && usage.costUsd >= budget) {
    return ctx.send({
      text:
        `Today's AI budget of ${usd(budget)} is used up (${usd(usage.costUsd)} spent). ` +
        "It resets at midnight UTC, and you can change it in Settings → Advanced.\n\nContinue anyway to lift it for the rest of today.",
      keyboard: [
        [btn("Continue anyway", `budget:${await saveForRetry(ctx, job)}`)],
      ],
    });
  }
  if (ctx.user.pendingQuestion || ctx.user.fixMealId || ctx.user.retryRun) {
    ctx.user = await ctx.db.users.update({
      pendingQuestion: null,
      fixMealId: null,
      retryRun: null,
    });
  }

  const typing = setInterval(
    () => telegram.typing(ctx.user.chatId).catch(() => {}),
    4500,
  );
  const recentWeights = await ctx.db.weights.recent(5);
  let result: AgentResult;
  try {
    await telegram.typing(ctx.user.chatId);
    const can = {
      images: chat.kind === "openrouter" || chat.images,
      audio: chat.kind === "openrouter",
    };
    const unsupported = [
      ...(!can.images && input.photoIds.length
        ? [
            input.photoIds.length === 1
              ? "a photo"
              : `${input.photoIds.length} photos`,
          ]
        : []),
      ...(!can.audio && input.audio ? ["a voice note"] : []),
    ];
    const researchAllowed =
      budget == null || usage.costUsd < budget * RESEARCH_CUTOFF_SHARE;
    result = await runAgent({
      provider: chat,
      research: researchAllowed ? providers.research : null,
      maxResearch: RESEARCH[settings.researchDepth].lookups,
      effort: settings.effort,
      replyDetail: settings.replyDetail,
      unsupported,
      user: ctx.user,
      store: ctx.db.meals,
      weights: ctx.db.weights,
      recentWeights,
      text: input.text,
      media: await downloadMedia(input, can),
      photoIds: input.photoIds,
      photoRefs: await ctx.db.photos.register(input.photoIds),
      library: can.images ? photoLibrary(ctx) : undefined,
      sentAt: new Date(input.sentAt),
      messageId: input.messageId,
      recentMeals: await ctx.db.meals.loggedSince(
        new Date(Date.now() - DAY_MS),
      ),
      fixMeal: job.fixMealId ? await ctx.db.meals.byId(job.fixMealId) : null,
      answers: job.answers,
      edit: job.edit
        ? await editContext(ctx, job.edit, input.messageId)
        : undefined,
      history: await chatHistory(ctx, input.messageId),
      trace: (line) => console.log(`[agent ${ctx.user.tgId}] ${line}`),
    });
  } catch (e) {
    console.error(`[agent ${ctx.user.tgId}]`, e);
    return ctx.send({
      text: "Something went wrong on my side while handling that.",
      keyboard: retryKeyboard(await saveForRetry(ctx, job)),
    });
  } finally {
    clearInterval(typing);
  }
  await ctx.db.usage.record(result.costUsd, result.searches);
  const changed = result.changes.length + result.weightChanges.length > 0;
  if (changed) await ctx.db.messages.addBatch(input.messageId, result.batchId);
  if (result.weightChanges.length)
    await syncProfileWeight(ctx, recentWeights.length === 0, result);
  const outcome = result.error
    ? `error ${result.error.status} ${result.error.message.slice(0, 200)}`
    : result.timedOut
      ? "timed out"
      : "ok";
  console.log(
    `[agent ${ctx.user.tgId}] ${outcome}: turns ${result.turns}, research ${result.searches}, cost $${result.costUsd.toFixed(4)}` +
      `${result.hitCostCap ? " (hit cost cap)" : ""}, generations ${result.generationIds.join(",")}`,
  );

  if (result.question && !changed) {
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
      keyboard: rows(
        q.options.map((o, i) => btn(o, `ask:${q.id}:${i}`)),
        2,
      ),
    });
    return rememberReply(
      ctx,
      sent,
      `Asked: ${q.question} (options: ${q.options.join(" / ")})`,
    );
  }
  const view = await resultView(ctx, result, chat.kind === "custom");
  // With changes saved, a retry could log them twice; the Undo and Fix buttons cover that case instead.
  if (!changed && (result.timedOut || result.error?.transient))
    view.keyboard = retryKeyboard(await saveForRetry(ctx, job));
  const sent = await ctx.send(view);
  return rememberReply(ctx, sent, replySummary(result));
}

/** Keeps the profile weight at the latest weigh-in; the very first weigh-in also sets the display units. */
async function syncProfileWeight(ctx: Ctx, first: boolean, r: AgentResult) {
  const [latest] = await ctx.db.weights.recent(1);
  const created = r.weightChanges.find((c) => c.kind === "created");
  ctx.user = await ctx.db.users.update({
    ...(latest ? { weightKg: latest.weightKg } : {}),
    ...(first && created ? { units: unitsFor(created.weight.unit) } : {}),
  });
}

async function editContext(
  ctx: Ctx,
  edit: NonNullable<Job["edit"]>,
  messageId: number,
) {
  const stored = await ctx.db.messages.get(messageId);
  return {
    before: edit.before,
    sentAt: new Date(edit.sentAt),
    meals: await ctx.db.meals.touchedBy(stored?.batchIds ?? []),
  };
}

/** Keeps the job so a Retry or Continue button can start it again; returns the id the button carries. */
async function saveForRetry(
  ctx: Ctx,
  { input, answers, fixMealId, edit }: Job,
) {
  const id = newQuestionId();
  ctx.user = await ctx.db.users.update({
    retryRun: { id, input, answers, fixMealId, edit },
  });
  return id;
}

const retryKeyboard = (id: string) => [[btn("Retry", `retry:${id}`)]];

const usd = (n: number) => `$${n.toFixed(2)}`;

function attachments(input: ChatInput, photoRefs: string[]): string[] {
  return [
    ...photoRefs.map((id) => `photo ${id}`),
    ...(input.audio ? ["voice note"] : []),
  ];
}

function photoLibrary(ctx: Ctx): PhotoLibrary {
  return {
    idsFor: (fileIds) => ctx.db.photos.idsFor(fileIds),
    load: async (id) => {
      const fileId = await ctx.db.photos.fileId(id);
      if (!fileId) return null;
      const data = await telegram.download(fileId);
      return { type: "image", data: base64(data), mimeType: imageMime(data) };
    },
  };
}

/** Photos are JPEG; images sent as files can be PNG or WebP. */
function imageMime(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  return "image/jpeg";
}

async function chatHistory(ctx: Ctx, currentMessageId: number) {
  const rows = await ctx.db.messages.recent(
    config.agent.historyMessages,
    currentMessageId,
  );
  return rows.map((m) => ({
    role: m.role,
    text: m.text,
    attachments: m.attachments,
    at: m.sentAt,
  }));
}

/** What the assistant said and did, as it will read it back in later runs. */
export function replySummary(r: AgentResult): string {
  const weights = r.weightChanges.map((c) =>
    c.kind === "deleted"
      ? `Deleted the ${fmtWeight(c.weight.weightKg, c.weight.unit)} weigh-in.`
      : `${c.kind === "created" ? "Logged" : "Updated"} weight ${fmtWeight(c.weight.weightKg, c.weight.unit)}.`,
  );
  const lines = r.changes.map((c) => {
    const verb =
      c.kind === "created"
        ? "Logged"
        : c.kind === "updated"
          ? "Updated"
          : "Deleted";
    return c.kind === "deleted"
      ? `${verb} "${c.meal.description}".`
      : `${verb} "${c.meal.description}" (${c.meal.kcal} kcal).`;
  });
  lines.push(...weights);
  if (r.error) lines.push(`(OpenRouter error: ${r.error.message})`);
  else if (r.reply) lines.push(r.reply);
  return lines.join(" ");
}

async function rememberReply(ctx: Ctx, sent: unknown, summary: string) {
  const id = (sent as { message_id?: number } | null)?.message_id;
  if (id && summary) await ctx.db.messages.rememberReply(id, summary);
}

export async function resultView(
  ctx: Ctx,
  r: AgentResult,
  custom: boolean,
): Promise<View> {
  const when = (m: Meal) =>
    mealTimeLabel(m.eatenAt, m.loggedAt, ctx.user.utcOffsetMinutes);
  const card = (c: Change) => {
    if (c.kind === "deleted")
      return `Deleted <b>${esc(c.meal.description)}</b>.`;
    const head = `${c.kind === "updated" ? "Updated " : ""}<b>${esc(c.meal.description)}</b>  ·  ${when(c.meal)}`;
    const was = c.before && [
      ...(c.before.eatenAt.getTime() !== c.meal.eatenAt.getTime()
        ? [`Time was ${when(c.before)}.`]
        : []),
      ...(c.before.kcal !== c.meal.kcal
        ? [`Was ${num(c.before.kcal)} kcal.`]
        : []),
    ];
    return `${head}\n\n${mealBody(c.meal)}${was?.length ? `\n${was.join(" ")}` : ""}`;
  };

  const unit = unitFor(ctx.user.units);
  const weightCard = ({ kind, weight: w, before }: WeightChange) => {
    const value = (kg: number, entered: typeof w.unit) =>
      `${fmtWeight(kg, unit)}${entered !== unit ? ` (${fmtWeight(kg, entered)})` : ""}`;
    if (kind === "deleted")
      return `Deleted the weigh-in of <b>${value(w.weightKg, w.unit)}</b>.`;
    const at = `${dayLabel(w.weighedAt, ctx.user)}  ${clock(w.weighedAt, ctx.user)}`;
    const was =
      before && before.weightKg !== w.weightKg
        ? `\nWas ${fmtWeight(before.weightKg, unit)}.`
        : "";
    return `${kind === "created" ? "Weight logged" : "Weight updated"}: <b>${value(w.weightKg, w.unit)}</b>  ·  ${at}${was}`;
  };

  const parts = [...r.changes.map(card), ...r.weightChanges.map(weightCard)];
  if (r.error)
    parts.push(
      custom ? customProviderMessage(r.error) : openRouterMessage(r.error),
    );
  else if (r.timedOut)
    parts.push(
      `That took too long, so I stopped.${r.changes.length ? " The changes above were saved." : ""}`,
    );
  else if (r.reply) parts.push(esc(r.reply));
  if (!parts.length)
    parts.push("I couldn't do anything with that. " + LOG_HINT);

  if (!r.changes.length && !r.weightChanges.length)
    return { text: parts.join("\n\n"), keyboard: [] };
  if (r.changes.length) {
    const today = sumTotals(
      await ctx.db.meals.since(dayStart(ctx.user.utcOffsetMinutes)),
    );
    const target = ctx.user.targetKcal;
    parts.push(
      `Today  ${num(today.kcal)}${target ? ` / ${num(target)}` : ""} kcal${target ? `  ·  ${kcalLeft(today.kcal, target)}` : ""}`,
    );
  }
  const fixable = r.changes.findLast((c) => c.kind !== "deleted");
  const undoable =
    r.changes.length || r.weightChanges.some((c) => c.kind === "created");
  return {
    text: truncateHtml(parts.join("\n\n")),
    keyboard: [
      [
        ...(undoable ? [btn("Undo", `undo:${r.batchId}`)] : []),
        ...(fixable ? [btn("Fix", `fix:${fixable.meal.id}`)] : []),
        ...(r.changes.length ? [btn("Today", "today")] : []),
        ...(r.weightChanges.length ? [btn("Weight", "wt:0")] : []),
      ],
    ],
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

function openRouterMessage(e: ProviderError) {
  if (e.status === 401)
    return "OpenRouter rejected your API key. Paste a new one into the chat, or replace it in Menu → Settings.";
  if (e.status === 402)
    return "Your OpenRouter account is out of credits. Top up at https://openrouter.ai/credits and try again.";
  if (e.status === 403 && /key limit/i.test(e.message)) {
    return "Your OpenRouter key has reached the spending limit set on it at OpenRouter. Raise the limit at https://openrouter.ai/settings/keys or wait for it to reset.";
  }
  if (e.status === 403)
    return `OpenRouter refused the request: ${esc(e.message)}`;
  if (e.status === 429)
    return "OpenRouter is rate limiting your key right now. Try again in a minute.";
  if (e.status === 0)
    return "The connection to OpenRouter dropped before the answer arrived.";
  if (e.status >= 500)
    return "OpenRouter or the model provider had a temporary problem.";
  return `OpenRouter returned an error: ${esc(e.message)}`;
}

function customProviderMessage(e: ProviderError) {
  const fix = "Check it in Settings → Advanced → Custom provider.";
  if (e.status === 401 || e.status === 403)
    return `Your custom provider rejected the credentials (${e.status}: ${esc(e.message)}). ${fix}`;
  if (e.status === 404)
    return `Your custom provider couldn't find that URL or model (${esc(e.message)}). ${fix}`;
  if (e.status === 429)
    return "Your custom provider is rate limiting requests right now. Try again in a minute.";
  if (e.status === 0)
    return `The connection to your custom provider dropped or failed (${esc(e.message)}).`;
  if (e.status >= 500)
    return `Your custom provider had a problem (${e.status}: ${esc(e.message)}).`;
  return `Your custom provider returned an error (${e.status}: ${esc(e.message)}). ${fix}`;
}
