import { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { config } from "../config.ts";
import type { Meal } from "../db/index.ts";
import { countryName } from "../domain/countries.ts";
import type { QuestionAnswer } from "../domain/question.ts";
import { isoOffset, localIso, localStamp } from "../domain/time.ts";
import { base64, chatModel, Media, openRouterStream, OpenRouterError, parseProviderError } from "../services/openrouter.ts";
import { systemPrompt } from "./prompt.ts";
import { Change, MealStore, mealTools, RunState } from "./tools.ts";

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
  photoIds: string[];
  sentAt: Date;
  messageId: number;
  /** Meals logged in the last day, most recent first. */
  recentMeals: Meal[];
  fixMeal: Meal | null;
  answers: QuestionAnswer[];
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
  /** As billed by OpenRouter, including search. */
  costUsd: number;
  turns: number;
  searches: number;
};

export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const u = input.user;
  const off = u.utcOffsetMinutes;
  const canAsk = input.answers.length < config.agent.maxQuestions;
  const run = new RunState(input.store, off, input.sentAt, input.text || null, input.photoIds, input.messageId);

  const prompt = systemPrompt({
    now: localStamp(input.sentAt, off),
    nowIso: localIso(input.sentAt, off),
    offset: isoOffset(off),
    country: countryName(u.country),
    units: u.units,
    targets: u.targetKcal
      ? `${u.targetKcal} kcal, protein ${u.targetProteinG} g, carbs ${u.targetCarbsG} g, fat ${u.targetFatG} g`
      : null,
    recentMeals: input.recentMeals.map((m) => run.view(m)),
    fixMeal: input.fixMeal && run.view(input.fixMeal),
    answers: input.answers,
    canAsk,
  });

  let turns = 0;
  let searches = 0;
  let costUsd = 0;
  const agent = new Agent({
    initialState: { systemPrompt: prompt, model: chatModel(), thinkingLevel: config.reasoningEffort, tools: mealTools(run, canAsk) },
    streamFn: openRouterStream(input.apiKey, input.media.filter((m) => m.kind === "audio"), (u) => {
      searches += u.searches;
      costUsd += u.costUsd;
      for (const url of u.sources) input.trace?.(`source ${url}`);
      if (u.costUsd || u.searches) input.trace?.(`request cost $${u.costUsd.toFixed(4)}, searches ${u.searches}`);
    }),
    toolExecution: "sequential",
    finishTurn: ({ message }) => {
      turns++;
      if (message.stopReason === "error" || message.stopReason === "aborted") return;
      if (run.question || turns >= config.agent.maxTurns) return { action: "end" };
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

  const images: ImageContent[] = input.media.flatMap((m) =>
    m.kind === "image" ? [{ type: "image", data: base64(m.data), mimeType: m.mime }] : []
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, config.agent.timeoutMs);
  try {
    await agent.prompt(input.text || "(no text)", images);
  } finally {
    clearTimeout(timer);
  }

  const assistant = agent.state.messages.filter((m) => m.role === "assistant");
  const last = assistant.at(-1);
  const reply = last?.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("").trim() ?? "";
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
    searches,
  };
}
