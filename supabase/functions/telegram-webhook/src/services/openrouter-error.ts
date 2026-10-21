export class OpenRouterError extends Error {
  /** 0 when no HTTP status was received, e.g. the connection dropped mid-stream. */
  constructor(public status: number, message: string) {
    super(message);
  }

  /** Worth sending again as is: the connection dropped, the provider failed, or it asked to slow down. */
  get transient() {
    return this.status === 0 || this.status === 408 || this.status === 409 || this.status === 429 || this.status >= 500;
  }
}

/** pi reports provider failures as "<status>: <body>". */
export function parseProviderError(message: string): OpenRouterError {
  const status = Number(message.match(/^(\d{3})\b/)?.[1] ?? 0);
  const detail = message.replace(/^\d{3}:\s*/, "");
  try {
    return new OpenRouterError(status, JSON.parse(detail).message ?? detail);
  } catch {
    return new OpenRouterError(status, detail);
  }
}
