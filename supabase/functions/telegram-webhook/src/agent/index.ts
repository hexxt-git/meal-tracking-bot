import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { config } from "../config.ts";
import type { Meal, Weight } from "../db/index.ts";
import { countryName } from "../domain/countries.ts";
import type { QuestionAnswer } from "../domain/question.ts";
import { isoOffset, localIso, localStamp } from "../domain/time.ts";
import type { Effort, ReplyDetail } from "../domain/ai-settings.ts";
import {
  base64,
  ChatProvider,
  chatModel,
  Media,
  parseProviderError,
  ProviderError,
  providerStream,
  ResearchProvider,
  researchFood,
} from "../services/llm.ts";
import { systemPrompt } from "./prompt.ts";
import {
  Change,
  MealStore,
  mealTools,
  PhotoLibrary,
  RunState,
  WeightChange,
  WeightStore,
} from "./tools.ts";

export type { Change, WeightChange } from "./tools.ts";

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
  provider: ChatProvider;
  /** Null when research is off, unavailable or over today's budget. */
  research: ResearchProvider | null;
  maxResearch: number;
  effort: Effort;
  replyDetail: ReplyDetail;
  /** What the user attached that the model can't receive, e.g. "2 photos", "a voice note". */
  unsupported: string[];
  user: AgentUser;
  store: MealStore;
  weights: WeightStore;
  /** Latest weigh-ins, newest first. */
  recentWeights: Weight[];
  text: string;
  /** Messages sent right before this one that got no reply yet, oldest first; handled together with it. */
  earlier?: { text: string; sentAt: Date }[];
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
  /** Earlier messages, oldest first, not including this one. */
  history: {
    role: "user" | "assistant";
    text: string;
    attachments: string[];
    at: Date;
  }[];
  /** Set when the user edited an earlier message; `text` is then the edited version. */
  edit?: { before: string | null; sentAt: Date; meals: Meal[] };
  /** Receives one line per tool call and result, for logs. */
  trace?: (line: string) => void;
  /** Undo batch for every change the run makes; random when not given. */
  batchId?: string;
  /** Stops the run, e.g. once a newer message has taken it over. */
  signal?: AbortSignal;
};

export type AgentResult = {
  reply: string;
  changes: Change[];
  weightChanges: WeightChange[];
  batchId: string;
  question: { question: string; options: string[] } | null;
  error: ProviderError | null;
  timedOut: boolean;
  /** As billed by the provider, including research; custom APIs usually report nothing, so 0. */
  costUsd: number;
  turns: number;
  searches: number;
  hitCostCap: boolean;
  generationIds: string[];
};

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const u = input.user;
  const off = u.utcOffsetMinutes;
  const canAsk = input.answers.length < config.agent.maxQuestions;
  const images: ImageContent[] = input.media.flatMap((m) =>
    m.kind === "image"
      ? [{ type: "image", data: base64(m.data), mimeType: m.mime }]
      : [],
  );
  const country = countryName(u.country);
  const generationIds: string[] = [];
  let costUsd = 0;
  const researchProvider = input.maxResearch > 0 ? input.research : null;
  const research = researchProvider
    ? async (query: string) => {
        const r = await researchFood(researchProvider, query, country);
        costUsd += r.costUsd;
        if (r.generationId) generationIds.push(r.generationId);
        input.trace?.(
          `research $${r.costUsd.toFixed(4)} ${r.generationId ?? ""}`,
        );
        return r;
      }
    : null;
  const photos = images.flatMap((image, i) =>
    input.photoRefs[i] ? [{ id: input.photoRefs[i], image }] : [],
  );
  const earlier = input.earlier ?? [];
  const run = new RunState({
    batchId: input.batchId,
    store: input.store,
    weights: input.weights,
    offsetMin: off,
    sentAt: input.sentAt,
    userText:
      [...earlier.map((m) => m.text), input.text].filter(Boolean).join("\n") ||
      null,
    fileIds: input.photoIds,
    messageId: input.messageId,
    photos,
    library: input.library,
    maxImageViews: config.agent.maxImageViews,
    research,
    maxResearch: input.maxResearch,
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
    fixMeal: input.fixMeal && (await run.view(input.fixMeal)),
    recentWeights: input.recentWeights.map((w) => run.weightView(w)),
    answers: input.answers,
    canAsk,
    canResearch: research != null,
    photoIds: photos.map((p) => p.id),
    replyDetail: input.replyDetail,
    unsupported: input.unsupported,
    messagesInTurn: earlier.length + 1,
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
    initialState: {
      systemPrompt: prompt,
      model: chatModel(input.provider),
      thinkingLevel: input.effort,
      tools: mealTools(run, canAsk),
    },
    streamFn: providerStream(
      input.provider,
      input.effort,
      input.media.filter((m) => m.kind === "audio"),
      (usage) => {
        costUsd += usage.costUsd;
        if (usage.generationId) generationIds.push(usage.generationId);
        input.trace?.(
          `request $${usage.costUsd.toFixed(4)} ${usage.generationId ?? ""}`,
        );
      },
    ),
    toolExecution: "sequential",
    finishTurn: ({ message, toolResults }) => {
      turns++;
      if (message.stopReason === "error" || message.stopReason === "aborted")
        return;
      const failed = toolResults.some((r) => r.isError);
      // A reply sent next to a failed call may describe a change that didn't happen.
      if (failed) run.replyText = null;
      if (run.question || turns >= config.agent.maxTurns)
        return { action: "end" };
      if (run.replyText !== null && !failed) return { action: "end" };
    },
  });

  if (input.trace) {
    const trace = input.trace;
    agent.subscribe((e) => {
      if (e.type === "tool_execution_start")
        trace(`→ ${e.toolName} ${JSON.stringify(e.args).slice(0, 600)}`);
      if (e.type === "tool_execution_end") {
        const text = (e.result.content as { type: string; text?: string }[])
          .map((c) => c.text ?? "")
          .join("");
        trace(`${e.isError ? "✗" : "←"} ${e.toolName} ${text.slice(0, 300)}`);
      }
    });
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, config.agent.timeoutMs);
  const stop = () => agent.abort();
  input.signal?.addEventListener("abort", stop);
  const text = earlier.length
    ? [...earlier, { text: input.text, sentAt: input.sentAt }]
        .map((m) => `[${localStamp(m.sentAt, off)}] ${m.text || "(no text)"}`)
        .join("\n")
    : input.text || "(no text)";
  try {
    if (input.signal?.aborted) throw new Error("run was stopped");
    await agent.prompt(
      input.edit ? `(edited message) ${input.text}` : text,
      images,
    );
    for (
      let retry = 0;
      retry < config.agent.transientRetries &&
      !timedOut &&
      !input.signal?.aborted;
      retry++
    ) {
      const failed = agent.state.messages.at(-1);
      if (
        !agent.state.errorMessage ||
        failed?.role !== "assistant" ||
        !parseProviderError(agent.state.errorMessage).transient
      )
        break;
      input.trace?.(
        `retrying after: ${agent.state.errorMessage.slice(0, 200)}`,
      );
      agent.state.messages = agent.state.messages.slice(0, -1);
      await agent.continue();
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", stop);
  }

  const assistant = agent.state.messages.filter((m) => m.role === "assistant");
  const last = assistant.at(-1);
  const reply =
    run.replyText ??
    last?.content
      .flatMap((c) => (c.type === "text" ? [c.text] : []))
      .join("")
      .trim() ??
    "";
  const errorMessage = agent.state.errorMessage;
  return {
    reply,
    changes: [...run.changes.values()],
    weightChanges: [...run.weightChanges.values()],
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
