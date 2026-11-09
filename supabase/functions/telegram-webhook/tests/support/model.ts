import { setExternalFetch } from "./env.ts";

type Call = { name: string; args: unknown };
/** One scripted model turn: tool calls to make, an HTTP error to return, or a request that hangs until aborted. */
type Step = Call[] | { status: number; body: string } | "hang";

type Seen = { url: string; headers: Headers; body: Record<string, unknown> };

/** A fake OpenAI-compatible API that streams the scripted turns in order. */
export function fakeModel(script: Step[]) {
  const seen: Seen[] = [];
  setExternalFetch(async (input, init) => {
    const req = new Request(input, init);
    seen.push({
      url: req.url,
      headers: req.headers,
      body: await req.json(),
    });
    const step = script.shift();
    if (!step) return new Response("script exhausted", { status: 500 });
    if (step === "hang")
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal ?? (input as Request).signal;
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    if (!Array.isArray(step))
      return new Response(step.body, {
        status: step.status,
        headers: { "content-type": "application/json" },
      });
    const id = `gen-${seen.length}`;
    const chunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    const sse =
      chunk({
        id,
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: step.map((c, i) => ({
                index: i,
                id: `call_${seen.length}_${i}`,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            },
            finish_reason: null,
          },
        ],
      }) +
      chunk({
        id,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }) +
      "data: [DONE]\n\n";
    return new Response(sse, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  return seen;
}
