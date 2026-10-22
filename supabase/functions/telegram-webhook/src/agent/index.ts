import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { config } from "../config.ts";
import type { Meal } from "../db/index.ts";
import { countryName } from "../domain/countries.ts";
import type { QuestionAnswer } from "../domain/question.ts";
import { isoOffset, localIso, localStamp } from "../domain/time.ts";
import { base64, chatModel, Media, openRouterStream, OpenRouterError, parseProviderError, researchFood } from "../services/openrouter.ts";
import { systemPrompt } from "./prompt.ts";
import { Change, MealStore, mealTools, PhotoLibrary, RunState } from "./tools.ts";

export type { Change } from "./tools.ts";

export type AgentUser = {
  utcOffsetMinutes: number;
  country: string | null;
  units: string;
  targetKcal: number | null;
  targetProteinG: number | null;
  targetCarbsG: number | null;
  targetFatG: number | null;
};

export type AgentInput = {
  apiKey: string;
  user: AgentUser;
  store: MealStore;
  text: string;
  media: Media[];
  /** Telegram file ids of this message's photos. */
  photoIds: string[];
  /** Short ids of those photos, in the same order. */
  photoRefs: string[];
  /** Earlier photos the assistant can open with view_image. */
  library?: PhotoLibrary;
  sentAt: Date;
  messageId: number;
  /** Meals logged in the last day, most recent first. */
  recentMeals: Meal[];
  fixMeal: Meal | null;
  answers: QuestionAnswer[];
  allowResearch: boolean;
  /** Earlier messages, oldest first, not including this one. */
  history: { role: "user" | "assistant"; text: string; attachments: string[]; at: Date }[];
  /** Set when the user edited an earlier message; `text` is then the edited version. */
  edit?: { before: string | null; sentAt: Date; meals: Meal[] };
  /** Receives one line per tool call and result, for logs. */
  trace?: (line: string) => void;
};

export type AgentResult = {
  reply: string;
  changes: Change[];
  batchId: string;
  question: { question: string; options: string[] } | null;
  error: OpenRouterError | null;
  timedOut: boolean;
  /** As billed by OpenRouter, including research. */
  costUsd: number;
  turns: number;
  searches: number;
  hitCostCap: boolean;
  generationIds: string[];
};

const PHOTOS_REMOVED = (ids: string[]) =>
  `[Photo${ids.length === 1 ? "" : "s"} ${ids.join(", ")} ${ids.length === 1 ? "was" : "were"} attached to your first request only. ` +
  `Call view_image with an id to see one again.]`;

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const u = input.user;
  const off = u.utcOffsetMinutes;
  const canAsk = input.answers.length < config.agent.maxQuestions;
  const images: ImageContent[] = input.media.flatMap((m) =>
    m.kind === "image" ? [{ type: "image", data: base64(m.data), mimeType: m.mime }] : []
  );
  const country = countryName(u.country);
  const generationIds: string[] = [];
  let costUsd = 0;
  const research = input.allowResearch
    ? async (query: string) => {
      const r = await researchFood(input.apiKey, query, country);
      costUsd += r.costUsd;
      if (r.generationId) generationIds.push(r.generationId);
      input.trace?.(`research $${r.costUsd.toFixed(4)} ${r.generationId ?? ""}`);
      return r;
    }
    : null;
  const photos = images.flatMap((image, i) => (input.photoRefs[i] ? [{ id: input.photoRefs[i], image }] : []));
  const run = new RunState({
    store: input.store,
    offsetMin: off,
    sentAt: input.sentAt,
    userText: input.text || null,
    fileIds: input.photoIds,
    messageId: input.messageId,
    photos,
    library: input.library,
    maxImageViews: config.agent.maxImageViews,
    research,
    maxResearch: config.agent.maxResearchPerRun,
    overBudget: () => costUsd >= config.agent.maxRunCostUsd,
  });

  const prompt = systemPrompt({
    now: localStamp(input.sentAt, off),
    nowIso: localIso(input.sentAt, off),
    offset: isoOffset(off),
    country,
    units: u.units,
    targets: u.targetKcal
      ? `${u.targetKcal} kcal, protein ${u.targetProteinG} g, carbs ${u.targetCarbsG} g, fat ${u.targetFatG} g`
      : null,
    recentMeals: await run.views(input.recentMeals),
    fixMeal: input.fixMeal && await run.view(input.fixMeal),
    answers: input.answers,
    canAsk,
    canResearch: research != null,
    photoIds: photos.map((p) => p.id),
    history: input.history.map((h) => ({
      who: h.role === "user" ? "User" : "You",
      at: localStamp(h.at, off),
      text: h.text,
      attachments: h.attachments,
    })),
    edit: input.edit && {
      before: input.edit.before,
      after: input.text,
      sentAt: localStamp(input.edit.sentAt, off),
      meals: await run.views(input.edit.meals),
    },
  });

  let turns = 0;
  const agent = new Agent({
    initialState: { systemPrompt: prompt, model: chatModel(), thinkingLevel: config.agent.firstEffort, tools: mealTools(run, canAsk) },
    streamFn: openRouterStream(input.apiKey, input.media.filter((m) => m.kind === "audio"), (usage) => {
      costUsd += usage.costUsd;
      if (usage.generationId) generationIds.push(usage.generationId);
      input.trace?.(`request $${usage.costUsd.toFixed(4)} ${usage.generationId ?? ""}`);
    }),
    // Photos are sent with the first request only; later requests get a note and can call view_image.
    transformContext: (messages) => {
      if (!images.length || !messages.some((m) => m.role === "assistant")) return Promise.resolve(messages);
      return Promise.resolve(messages.map((m) => {
        if (m.role !== "user" || typeof m.content === "string" || !m.content.some((c) => c.type === "image")) return m;
        return { ...m, content: [...m.content.filter((c) => c.type !== "image"), { type: "text" as const, text: PHOTOS_REMOVED(photos.map((p) => p.id)) }] };
      }));
    },
    toolExecution: "sequential",
    finishTurn: ({ message, toolResults }) => {
      turns++;
      if (message.stopReason === "error" || message.stopReason === "aborted") return;
      const failed = toolResults.some((r) => r.isError);
      if (run.question || turns >= config.agent.maxTurns) return { action: "end" };
      if (run.replyText !== null && !failed) return { action: "end" };
    },
  });

  if (input.trace) {
    const trace = input.trace;
    agent.subscribe((e) => {
      if (e.type === "tool_execution_start") trace(`→ ${e.toolName} ${JSON.stringify(e.args).slice(0, 600)}`);
      if (e.type === "tool_execution_end") {
        const text = (e.result.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
        trace(`${e.isError ? "✗" : "←"} ${e.toolName} ${text.slice(0, 300)}`);
      }
    });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, config.agent.timeoutMs);
  try {
    await agent.prompt(input.edit ? `(edited message) ${input.text}` : input.text || "(no text)", images);
    for (let retry = 0; retry < config.agent.transientRetries && !timedOut; retry++) {
      const failed = agent.state.messages.at(-1);
      if (!agent.state.errorMessage || failed?.role !== "assistant" || !parseProviderError(agent.state.errorMessage).transient) break;
      input.trace?.(`retrying after: ${agent.state.errorMessage.slice(0, 200)}`);
      agent.state.messages = agent.state.messages.slice(0, -1);
      await agent.continue();
    }
  } finally {
    clearTimeout(timer);
  }

  const assistant = agent.state.messages.filter((m) => m.role === "assistant");
  const last = assistant.at(-1);
  const reply = run.replyText ?? last?.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim() ?? "";
  const errorMessage = agent.state.errorMessage;
  return {
    reply,
    changes: [...run.changes.values()],
    batchId: run.batchId,
    question: run.question,
    error: errorMessage && !timedOut ? parseProviderError(errorMessage) : null,
    timedOut,
    costUsd,
    turns,
    searches: run.researches,
    hitCostCap: costUsd >= config.agent.maxRunCostUsd,
    generationIds,
  };
}
