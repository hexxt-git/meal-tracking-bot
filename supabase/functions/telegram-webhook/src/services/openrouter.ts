const ENDPOINT = "https://openrouter.ai/api/v1";

export async function isValidKey(apiKey: string): Promise<boolean> {
  const res = await fetch(`${ENDPOINT}/key`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  await res.body?.cancel();
  return res.ok;
}

export const looksLikeKey = (s: string) => /^sk-or-[\w-]{20,}$/.test(s.trim());
