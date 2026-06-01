import { DraftboardApiError } from "../client.js";

/**
 * MCP tool annotation presets (hints for hosts: auto-approve reads, prompt/guard writes).
 * - READ_ONLY: never changes data.
 * - WRITE: changes data but is additive and idempotent (re-running is a no-op), not destructive.
 * - DESTRUCTIVE: irreversible data loss — hosts should require explicit confirmation.
 */
export const READ_ONLY = { readOnlyHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true } as const;
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
} as const;

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Run a handler, converting any thrown error into a safe (key-free) error result. */
export async function safeHandler(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DraftboardApiError) {
      const detail = err.body ? `\n${err.body}` : "";
      return errorResult(`${err.message}${detail}`);
    }
    return errorResult(`Unexpected error: ${(err as Error).message}`);
  }
}
