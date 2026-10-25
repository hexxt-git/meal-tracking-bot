// Advanced settings: assistant behaviour and a custom OpenAI-compatible provider.
import { config } from "../../config.ts";
import {
  AiSettings,
  aiSettings,
  AUTH_STYLES,
  BUDGETS,
  CustomProvider,
  DEFAULT_SETTINGS,
  EFFORTS,
  InputField,
  isAwaiting,
  isCustomReady,
  isHeaderName,
  parseBaseUrl,
  parseHeaders,
  parseModelId,
  REASONING_PARAMS,
  REPLY_DETAILS,
  RESEARCH,
  RESEARCH_DEPTHS,
} from "../../domain/ai-settings.ts";
import { testConnection } from "../../services/llm.ts";
import { esc, telegram } from "../../telegram/api.ts";
import type { Message } from "../../telegram/types.ts";
import type { Ctx } from "../context.ts";
import { connectionFor } from "../providers.ts";
import { btn, Reply, View } from "../ui.ts";
import { credentialsSaved, welcomeView } from "./onboarding.ts";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const usd = (n: number | null) => (n == null ? "No limit" : `$${n.toFixed(2)}`);
const settingsOf = (ctx: Ctx) => aiSettings(ctx.user.aiSettings);

async function save(ctx: Ctx, change: (s: AiSettings) => AiSettings) {
  ctx.user = await ctx.db.users.update({ aiSettings: change(settingsOf(ctx)) });
}

const saveCustom = (ctx: Ctx, patch: Partial<CustomProvider>) =>
  save(ctx, (s) => ({ ...s, custom: { ...s.custom, ...patch } }));

function host(url: string | null) {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
}

function providerLabel(s: AiSettings) {
  const c = s.custom;
  return c.enabled && isCustomReady(c)
    ? `Custom: ${c.model} at ${host(c.baseUrl)}`
    : `OpenRouter (${config.model})`;
}

const RESEARCH_LABEL: Record<(typeof RESEARCH_DEPTHS)[number], string> = {
  off: "Off",
  quick: "Quick",
  standard: "Standard",
  deep: "Deep",
};

export function advancedView(ctx: Ctx): View {
  const s = settingsOf(ctx);
  const r = RESEARCH[s.researchDepth];
  const line = (label: string, value: string) =>
    `<b>${label}</b>: ${esc(value)}`;
  return {
    text: [
      "<b>Advanced</b>",
      "",
      line("AI provider", providerLabel(s)),
      line("Reasoning", cap(s.effort)),
      line(
        "Research",
        r.lookups
          ? `${RESEARCH_LABEL[s.researchDepth]}, up to ${r.lookups} lookup${r.lookups > 1 ? "s" : ""} per message`
          : "Off",
      ),
      line("Daily budget", usd(s.dailyBudgetUsd)),
      line("Reply detail", cap(s.replyDetail)),
    ].join("\n"),
    keyboard: [
      [btn("AI provider", "prov")],
      [
        btn(`Reasoning: ${cap(s.effort)}`, "adv:e"),
        btn(`Research: ${RESEARCH_LABEL[s.researchDepth]}`, "adv:r"),
      ],
      [
        btn(`Budget: ${usd(s.dailyBudgetUsd)}`, "adv:b"),
        btn(`Replies: ${cap(s.replyDetail)}`, "adv:d"),
      ],
      [btn("Reset to defaults", "adv:reset")],
      [btn("‹ Settings", "set")],
    ],
  };
}

type Choice = { label: string; value: string };

type ChoiceScreen = {
  title: string;
  about: (s: AiSettings) => string;
  choices: Choice[];
  current: (s: AiSettings) => string;
  apply: (s: AiSettings, value: string) => AiSettings | null;
};

const CHOICES: Record<string, ChoiceScreen> = {
  e: {
    title: "Reasoning effort",
    about: () =>
      "How long the model thinks before answering. More effort reads photos and portions more carefully but costs more: " +
      "a meal photo measured about $0.0055 at minimal and $0.011 to $0.0125 at low or medium. " +
      "With a custom provider it is only sent if you enable it there.",
    choices: EFFORTS.map((e) => ({ label: cap(e), value: e })),
    current: (s) => s.effort,
    apply: (s, v) =>
      EFFORTS.includes(v as never)
        ? { ...s, effort: v as AiSettings["effort"] }
        : null,
  },
  r: {
    title: "Research depth",
    about: (s) =>
      "How much the assistant may look up packaged and restaurant food on the web, per message. " +
      "Quick: 1 lookup, 3 results. Standard: 2 lookups, 3 results each. Deep: 4 lookups, 5 results each. " +
      `An OpenRouter lookup costs about $0.009.\n\nLookups use ${
        s.custom.enabled && s.custom.researchModel
          ? `your custom research model (${esc(s.custom.researchModel)})`
          : "OpenRouter, when you have a key"
      }.`,
    choices: RESEARCH_DEPTHS.map((d) => ({
      label: RESEARCH_LABEL[d],
      value: d,
    })),
    current: (s) => s.researchDepth,
    apply: (s, v) =>
      RESEARCH_DEPTHS.includes(v as never)
        ? { ...s, researchDepth: v as AiSettings["researchDepth"] }
        : null,
  },
  b: {
    title: "Daily budget",
    about: () =>
      "The most the assistant may spend on your key per UTC day. Web research stops at 60% of it so logging keeps working. " +
      "When it runs out you can still continue for the day. Custom providers usually don't report cost, so only OpenRouter spending counts.",
    choices: BUDGETS.map((b, i) => ({ label: usd(b), value: String(i) })),
    current: (s) => String(BUDGETS.indexOf(s.dailyBudgetUsd as never)),
    apply: (s, v) => {
      const i = Number(v);
      return Number.isInteger(i) && i >= 0 && i < BUDGETS.length
        ? { ...s, dailyBudgetUsd: BUDGETS[i] }
        : null;
    },
  },
  d: {
    title: "Reply detail",
    about: () =>
      "How much the assistant explains. Short: only the key assumption. Normal: its main assumptions about portions, fats and sources. " +
      "Detailed: every item's portion, source and how confident it is. Longer replies cost slightly more.",
    choices: REPLY_DETAILS.map((d) => ({ label: cap(d), value: d })),
    current: (s) => s.replyDetail,
    apply: (s, v) =>
      REPLY_DETAILS.includes(v as never)
        ? { ...s, replyDetail: v as AiSettings["replyDetail"] }
        : null,
  },
};

/** `adv` view, `adv:<field>` choices, `adv:<field>:<value>` saves, `adv:reset`. */
export async function advancedAction(
  ctx: Ctx,
  [field, value]: string[],
): Promise<Reply> {
  if (field === "reset") {
    await save(ctx, (s) => ({ ...DEFAULT_SETTINGS, custom: s.custom }));
    return { view: advancedView(ctx), toast: "Reset to defaults" };
  }
  const screen = field ? CHOICES[field] : undefined;
  if (!screen) return { view: advancedView(ctx) };
  const s = settingsOf(ctx);
  if (value !== undefined) {
    const next = screen.apply(s, value);
    if (next) await save(ctx, () => next);
    return { view: advancedView(ctx), toast: next ? "Saved" : undefined };
  }
  const current = screen.current(s);
  return {
    view: {
      text: `<b>${screen.title}</b>\n\n${screen.about(s)}`,
      keyboard: [
        ...screen.choices.map((c) => [
          btn(
            c.value === current ? `${c.label} (current)` : c.label,
            `adv:${field}:${c.value}`,
          ),
        ]),
        [btn("‹ Advanced", "adv")],
      ],
    },
  };
}

const AUTH_LABEL: Record<(typeof AUTH_STYLES)[number], string> = {
  bearer: "Bearer token",
  header: "API key header",
  none: "None",
};
const REASONING_LABEL: Record<(typeof REASONING_PARAMS)[number], string> = {
  none: "Not sent",
  reasoning_effort: "reasoning_effort",
  reasoning: "reasoning.effort",
};

const next = <T>(list: readonly T[], v: T) =>
  list[(list.indexOf(v) + 1) % list.length];

export async function providerView(ctx: Ctx, note = ""): Promise<View> {
  const c = settingsOf(ctx).custom;
  const secret = await ctx.db.keys.getProvider();
  const headerCount = Object.keys(secret?.headers ?? {}).length;
  const onboarding = ctx.user.onboardingStep === "key";
  const auth =
    c.auth === "none"
      ? "None"
      : `${c.auth === "bearer" ? "Bearer token" : `Header ${c.authHeader}`}, ${secret?.token ? "saved" : "not set"}`;
  const line = (label: string, value: string) =>
    `<b>${label}</b>: ${esc(value)}`;
  return {
    text: [
      ...(note ? [note, ""] : []),
      "<b>Custom provider</b>",
      "Any OpenAI-compatible chat completions API over https, such as OpenAI, Groq, DeepSeek, Together or your own LiteLLM or vLLM server. When on, it replaces OpenRouter for the assistant.",
      "",
      line("Status", c.enabled ? "On" : "Off"),
      line("Base URL", c.baseUrl ?? "not set"),
      line("Model", c.model ?? "not set"),
      line("Auth", auth),
      line("Extra headers", headerCount ? `${headerCount} saved` : "none"),
      line(
        "Images",
        c.images ? "sent to the model" : "not sent (text-only model)",
      ),
      line("Reasoning effort", REASONING_LABEL[c.reasoningParam]),
      line(
        "Research model",
        c.researchModel ?? "not set (research uses OpenRouter)",
      ),
    ].join("\n"),
    keyboard: [
      [btn("Set base URL", "prov:in:url"), btn("Set model", "prov:in:model")],
      [
        btn(`Auth: ${AUTH_LABEL[c.auth]}`, "prov:auth"),
        ...(c.auth !== "none"
          ? [
              btn(
                c.auth === "bearer" ? "Set token" : "Set key",
                "prov:in:token",
              ),
            ]
          : []),
      ],
      ...(c.auth === "header"
        ? [[btn(`Header name: ${c.authHeader}`, "prov:in:authHeader")]]
        : []),
      [
        btn("Set extra headers", "prov:in:headers"),
        ...(headerCount ? [btn("Clear headers", "prov:clr:headers")] : []),
      ],
      [
        btn(`Images: ${c.images ? "On" : "Off"}`, "prov:img"),
        btn(`Effort: ${REASONING_LABEL[c.reasoningParam]}`, "prov:rp"),
      ],
      [
        btn("Set research model", "prov:in:researchModel"),
        ...(c.researchModel ? [btn("Clear", "prov:clr:researchModel")] : []),
      ],
      [btn("Test connection", "prov:test")],
      [c.enabled ? btn("Turn off", "prov:off") : btn("Turn on", "prov:on")],
      ...(c.baseUrl || secret
        ? [[btn("Remove custom provider", "prov:rm")]]
        : []),
      [onboarding ? btn("‹ Back", "wel") : btn("‹ Advanced", "adv")],
    ],
  };
}

const PROMPTS: Record<InputField, string> = {
  url: "Send the base URL of the API, for example <code>https://api.groq.com/openai/v1</code>. Requests go to <code>&lt;base URL&gt;/chat/completions</code>.",
  model:
    "Send the model id exactly as the API expects it, for example <code>gpt-4o-mini</code>.",
  token:
    "Send the API key or token. Your message is deleted right after it's saved, and it's stored encrypted.",
  authHeader:
    "Send the name of the header that carries the key, for example <code>api-key</code> or <code>x-api-key</code>.",
  headers:
    "Send extra headers, one per line as <code>Name: value</code>. They replace any saved ones. Your message is deleted right after, and they're stored encrypted.",
  researchModel:
    "Send the id of a model on the same API that can search the web itself (for example a Perplexity <code>sonar</code> model). Food lookups will use it instead of OpenRouter.",
};

/** Messages carrying secrets are deleted once read. */
const SECRET_FIELDS = new Set<InputField>(["token", "headers"]);

/** `prov` view and its actions. */
export async function providerAction(
  ctx: Ctx,
  [action, arg]: string[],
): Promise<Reply> {
  const c = settingsOf(ctx).custom;
  switch (action) {
    case "in": {
      if (!(arg in PROMPTS)) return {};
      ctx.user = await ctx.db.users.update({
        awaitingInput: {
          field: arg as InputField,
          at: new Date().toISOString(),
        },
      });
      return {
        view: {
          text: PROMPTS[arg as InputField],
          keyboard: [[btn("Cancel", "prov:cancel")]],
        },
      };
    }
    case "cancel":
      ctx.user = await ctx.db.users.update({ awaitingInput: null });
      return { view: await providerView(ctx) };
    case "auth":
      await saveCustom(ctx, { auth: next(AUTH_STYLES, c.auth) });
      return { view: await providerView(ctx) };
    case "img":
      await saveCustom(ctx, { images: !c.images });
      return { view: await providerView(ctx) };
    case "rp":
      await saveCustom(ctx, {
        reasoningParam: next(REASONING_PARAMS, c.reasoningParam),
      });
      return { view: await providerView(ctx) };
    case "clr": {
      if (arg === "researchModel")
        await saveCustom(ctx, { researchModel: null });
      if (arg === "headers") {
        const secret = await ctx.db.keys.getProvider();
        if (secret) await ctx.db.keys.setProvider({ ...secret, headers: {} });
      }
      return { view: await providerView(ctx), toast: "Cleared" };
    }
    case "off":
      await saveCustom(ctx, { enabled: false });
      return { view: await providerView(ctx), toast: "Using OpenRouter" };
    case "rm":
      await ctx.db.keys.deleteProvider();
      await saveCustom(ctx, DEFAULT_SETTINGS.custom);
      return {
        view: await providerView(ctx),
        toast: "Custom provider removed",
      };
    case "test":
    case "on": {
      if (!isCustomReady(c))
        return { toast: "Set the base URL and model first" };
      return {
        view: { text: "Testing the connection…", keyboard: [] },
        after: () => testAndReport(ctx, action === "on"),
      };
    }
    default:
      return { view: await providerView(ctx) };
  }
}

async function testAndReport(ctx: Ctx, enable: boolean) {
  const c = settingsOf(ctx).custom;
  const connection = await connectionFor(ctx, c);
  if (!connection || !c.model) return ctx.send(await providerView(ctx));
  const result = await testConnection(connection, c.model);
  if (!result.ok) {
    return ctx.send(
      await providerView(
        ctx,
        `<b>Connection failed</b>: ${esc(result.error.slice(0, 500))}${enable ? "\nThe custom provider stays off." : ""}`,
      ),
    );
  }
  const reply = result.reply
    ? ` The model replied "${esc(result.reply.slice(0, 60))}".`
    : "";
  if (!enable)
    return ctx.send(
      await providerView(ctx, `<b>Connection works.</b>${reply}`),
    );
  const firstSetup = ctx.user.onboardingStep === "key";
  await saveCustom(ctx, { enabled: true });
  if (firstSetup)
    return credentialsSaved(
      ctx,
      `Connected to ${esc(c.model)}. The custom provider is on.`,
    );
  return ctx.send(
    await providerView(
      ctx,
      `<b>Connected. The custom provider is on.</b>${reply}`,
    ),
  );
}

/** Text typed after a provider prompt. Returns false when no prompt is waiting, so the message is handled normally. */
export async function handleSettingInput(
  ctx: Ctx,
  msg: Message,
): Promise<boolean> {
  const awaiting = ctx.user.awaitingInput;
  const text = msg.text?.trim();
  if (!isAwaiting(awaiting, Date.now()) || !text) return false;
  const field = awaiting.field;
  if (SECRET_FIELDS.has(field))
    await telegram.deleteMessage(ctx.user.chatId, msg.message_id);

  const error = await applyInput(ctx, field, text);
  if (error) {
    await ctx.send({
      text: `${esc(error)}\n\n${PROMPTS[field]}`,
      keyboard: [[btn("Cancel", "prov:cancel")]],
    });
    return true;
  }
  ctx.user = await ctx.db.users.update({ awaitingInput: null });
  await ctx.send(
    await providerView(
      ctx,
      SECRET_FIELDS.has(field)
        ? "Saved, and your message was deleted."
        : "Saved.",
    ),
  );
  return true;
}

async function applyInput(
  ctx: Ctx,
  field: InputField,
  text: string,
): Promise<string | null> {
  switch (field) {
    case "url": {
      const r = parseBaseUrl(text);
      if ("error" in r) return r.error;
      await saveCustom(ctx, { baseUrl: r.url });
      return null;
    }
    case "model":
    case "researchModel": {
      const id = parseModelId(text);
      if (!id)
        return "A model id is one word without spaces, up to 200 characters.";
      await saveCustom(
        ctx,
        field === "model" ? { model: id } : { researchModel: id },
      );
      return null;
    }
    case "authHeader":
      if (!isHeaderName(text)) return "That isn't a usable header name.";
      await saveCustom(ctx, { authHeader: text });
      return null;
    case "token": {
      if (text.length > 4000) return "That's too long for a key.";
      const secret = await ctx.db.keys.getProvider();
      await ctx.db.keys.setProvider({
        token: text,
        headers: secret?.headers ?? {},
      });
      return null;
    }
    case "headers": {
      const r = parseHeaders(text);
      if ("error" in r) return r.error;
      const secret = await ctx.db.keys.getProvider();
      await ctx.db.keys.setProvider({
        token: secret?.token ?? null,
        headers: r.headers,
      });
      return null;
    }
  }
}

export const welcomeAction = (): Reply => ({ view: welcomeView() });
