import {
  AiSettings,
  aiSettings,
  CustomProvider,
  isCustomReady,
  RESEARCH,
} from "../domain/ai-settings.ts";
import type {
  ChatProvider,
  Connection,
  ResearchProvider,
} from "../services/llm.ts";
import type { Ctx } from "./context.ts";

export type Providers = {
  chat: ChatProvider;
  research: ResearchProvider | null;
  settings: AiSettings;
};

export async function connectionFor(
  ctx: Ctx,
  c: CustomProvider,
): Promise<Connection | null> {
  if (!c.baseUrl) return null;
  const secret = await ctx.db.keys.getProvider();
  return {
    baseUrl: c.baseUrl,
    token: secret?.token ?? null,
    auth: c.auth,
    authHeader: c.authHeader,
    headers: secret?.headers ?? {},
  };
}

/**
 * The enabled custom provider, else OpenRouter. Research uses the custom provider's research model when one is set,
 * else OpenRouter when there is a key; null when neither applies or research is off. Null overall without a usable
 * chat provider.
 */
export async function resolveProviders(ctx: Ctx): Promise<Providers | null> {
  const settings = aiSettings(ctx.user.aiSettings);
  const c = settings.custom;
  const openRouterKey = await ctx.db.keys.get();
  const connection =
    c.enabled && isCustomReady(c) ? await connectionFor(ctx, c) : null;

  const chat: ChatProvider | null =
    connection && c.model
      ? {
          kind: "custom",
          connection,
          model: c.model,
          images: c.images,
          reasoningParam: c.reasoningParam,
        }
      : openRouterKey
        ? { kind: "openrouter", apiKey: openRouterKey }
        : null;
  if (!chat) return null;

  const depth = RESEARCH[settings.researchDepth];
  const research: ResearchProvider | null =
    depth.lookups === 0
      ? null
      : connection && c.researchModel
        ? { kind: "custom", connection, model: c.researchModel }
        : openRouterKey
          ? {
              kind: "openrouter",
              apiKey: openRouterKey,
              maxResults: depth.results,
            }
          : null;
  return { chat, research, settings };
}
