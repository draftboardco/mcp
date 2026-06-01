import { DraftboardClient } from "./client.js";

export interface Config {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
}

/** Read configuration from the environment. Throws a clear, key-free error if misconfigured. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.DRAFTBOARD_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "DRAFTBOARD_API_KEY is not set. Set it in the MCP server `env` block or your shell before starting the server.",
    );
  }
  const timeoutMs = env.DRAFTBOARD_TIMEOUT_MS ? Number(env.DRAFTBOARD_TIMEOUT_MS) : 20_000;
  return {
    apiKey,
    baseUrl: env.DRAFTBOARD_BASE_URL?.trim() || undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000,
  };
}

export function createClient(config: Config): DraftboardClient {
  return new DraftboardClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
  });
}
