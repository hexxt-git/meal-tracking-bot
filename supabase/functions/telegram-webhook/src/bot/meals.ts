import { config } from "../config.ts";
import type { Meal } from "../db/index.ts";
import { itemTotals, sumTotals } from "../domain/meal.ts";
import { dayStart, isoOffset, localTime, parseEatenAt } from "../domain/time.ts";
import { analyzeMeal, Decision, Media, OpenRouterError } from "../services/openrouter.ts";
import { esc, telegram } from "../telegram/api.ts";
import type { FileRef, Message } from "../telegram/types.ts";
import type { Ctx } from "./context.ts";
import { clock, mealBody } from "./format.ts";
import { welcomeView } from "./screens/onboarding.ts";
import { btn, LOG_HINT, num } from "./ui.ts";

type Input = { text: string; photoIds: string[]; imageMime: string; audio: FileRef | null };

export async function logMeal(ctx: Ctx, msg: Message) {
  const input = await collectInput(ctx, msg);
  if (!input) return;
  if (!input.text && !input.photoIds.length && !input.audio) return ctx.send(LOG_HINT);

  const apiKey = await ctx.db.keys.get();
  if (!apiKey) return ctx.send(welcomeView());

  if (!(await ctx.db.limits.hit("ai", config.limits.analysesPerDay, "1 day"))) {
    return ctx.send(`You've reached the daily limit of ${config.limits.analysesPerDay} analyses. It resets at midnight UTC.`);
  }
  await telegram.typing(ctx.user.chatId);

  const recent = await recentMeals(ctx);
  let decision: Decision;
  try {
    decision = await analyzeMeal({
      apiKey,
      text: input.text,
      media: await downloadMedia(input),
      localNow: localTime(new Date(), ctx.user.utcOffsetMinutes),
      offset: isoOffset(ctx.user.utcOffsetMinutes),
      recent: recent.map((m) => ({
        id: m.id,
        eaten_at_local: localTime(m.eatenAt, ctx.user.utcOffsetMinutes),
        description: m.description,
        items: m.items,
      })),
      fixMealId: ctx.user.fixMealId,
    });
  } catch (e) {
    if (e instanceof OpenRouterError) return ctx.send(openRouterMessage(e));
    throw e;
  }
  if (ctx.user.fixMealId) ctx.user = await ctx.db.users.update({ fixMealId: null });

  if (decision.action === "not_meal" || !decision.items.length) {
    return ctx.send(`${esc(decision.reply || "That doesn't look like a meal.")}\n\n${LOG_HINT}`);
  }

  const target = decision.action === "edit" ? recent.find((m) => m.id === decision.target_meal_id) : undefined;
  return target ? applyEdit(ctx, target, decision, input) : applyCreate(ctx, decision, input, msg.message_id);
}

/** Albums arrive as one update per photo; the first update to claim the group handles all of it, the rest return null. */
async function collectInput(ctx: Ctx, msg: Message): Promise<Input | null> {
  const imageDoc = msg.document?.mime_type?.startsWith("image/") ? msg.document : undefined;
  const photoId = msg.photo?.at(-1)?.file_id ?? imageDoc?.file_id;
  const base: Input = {
    text: msg.text ?? msg.caption ?? "",
    photoIds: photoId ? [photoId] : [],
    imageMime: imageDoc?.mime_type ?? "image/jpeg",
    audio: msg.voice ?? msg.audio ?? null,
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

async function downloadMedia(input: Input): Promise<Media[]> {
  const images = await Promise.all(input.photoIds.map(async (id) => ({ kind: "image" as const, mime: input.imageMime, data: await telegram.download(id) })));
  if (!input.audio) return images;
  return [...images, { kind: "audio", format: audioFormat(input.audio.mime_type), data: await telegram.download(input.audio.file_id) }];
}

async function recentMeals(ctx: Ctx): Promise<Meal[]> {
  const recent = await ctx.db.meals.latest(config.recentMealsForContext);
  const fixId = ctx.user.fixMealId;
  if (!fixId || recent.some((m) => m.id === fixId)) return recent;
  const fixMeal = await ctx.db.meals.byId(fixId);
  return fixMeal ? [...recent, fixMeal] : recent;
}

async function applyCreate(ctx: Ctx, decision: Decision, input: Input, messageId: number) {
  const { meal, revisionId } = await ctx.db.meals.create({
    eatenAt: parseEatenAt(decision.eaten_at) ?? new Date(),
    description: decision.description,
    userNote: input.text || null,
    items: decision.items,
    ...itemTotals(decision.items),
    photoFileIds: input.photoIds,
    sourceMessageId: messageId,
  });
  return ctx.send({
    text: `<b>${esc(meal.description)}</b>  ·  ${clock(meal.eatenAt, ctx.user)}\n\n${mealBody(meal)}${note(decision)}\n\n${await todayLine(ctx)}`,
    keyboard: mealActions(meal.id, revisionId),
  });
}

async function applyEdit(ctx: Ctx, target: Meal, decision: Decision, input: Input) {
  const result = await ctx.db.meals.update(target.id, {
    description: decision.description,
    items: decision.items,
    ...itemTotals(decision.items),
    eatenAt: parseEatenAt(decision.eaten_at) ?? target.eatenAt,
    photoFileIds: [...target.photoFileIds, ...input.photoIds],
    userNote: [target.userNote, input.text].filter(Boolean).join("\n") || null,
  });
  if (!result) return ctx.send("That meal no longer exists.");
  const { meal, before, revisionId } = result;
  return ctx.send({
    text: `Updated <b>${esc(meal.description)}</b>  ·  ${clock(meal.eatenAt, ctx.user)}\n\n${mealBody(meal)}\nWas ${num(before.kcal)} kcal.${note(decision)}\n\n${await todayLine(ctx)}`,
    keyboard: mealActions(meal.id, revisionId),
  });
}

const mealActions = (mealId: string, revisionId: string) => [[btn("Undo", `undo:${revisionId}`), btn("Fix", `fix:${mealId}`), btn("Today", "day:0")]];

const note = (d: Decision) => (d.reply ? `\n<i>${esc(d.reply)}</i>` : "");

async function todayLine(ctx: Ctx) {
  const t = sumTotals(await ctx.db.meals.since(dayStart(ctx.user.utcOffsetMinutes)));
  const goal = ctx.user.targetKcal ? ` / ${num(ctx.user.targetKcal)}` : "";
  return `Today  ${num(t.kcal)}${goal} kcal`;
}

function audioFormat(mime?: string) {
  if (!mime || mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("wav")) return "wav";
  return "ogg";
}

function openRouterMessage(e: OpenRouterError) {
  if (e.status === 401) return "OpenRouter rejected your API key. Paste a new one into the chat, or replace it in Menu → Settings.";
  if (e.status === 402) return "Your OpenRouter account is out of credits. Top up at https://openrouter.ai/credits and try again.";
  if (e.status === 429) return "OpenRouter is rate limiting your key. Try again in a minute.";
  return `OpenRouter error: ${esc(e.message)}. Please try again.`;
}
