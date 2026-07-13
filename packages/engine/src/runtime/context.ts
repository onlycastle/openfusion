import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

export const CONTEXT_COMPACTION_TRIGGER = 0.7;
export const CONTEXT_RECENT_FRACTION = 0.2;
export const CONTEXT_RECENT_MIN_TOKENS = 16_000;
export const CONTEXT_SUMMARY_MAX_TOKENS = 8_000;

export interface FrozenToolContract {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface FrozenRuntimeContext {
  version: 1;
  instructionBundle: string;
  tools: FrozenToolContract[];
  policy: {
    sandboxGrants: string[];
    interactive: boolean;
    childrenEnabled?: boolean;
    experimentVariant?: string;
  };
  policyFingerprint: string;
  sandboxProfileId: string;
  skills: Array<{ id: string; fingerprint: string; snapshot?: unknown }>;
  mcpServers: Array<{ id: string; fingerprint: string; configuration?: unknown }>;
  hooks: Array<{ id: string; fingerprint: string; configuration?: unknown }>;
  adapters: Array<{ id: string; version: string }>;
  compiledContext?: {
    fingerprint: string;
    baseSha: string;
    wikiDigest?: string | null;
    sources: Array<{ id: string; kind: string; digest: string; bytes: number }>;
  };
}

export interface FrozenRuntimeContextRecord {
  fingerprint: string;
  context: Readonly<FrozenRuntimeContext>;
}

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

export function canonicalRuntimeJson(value: unknown): string {
  const canonical = (input: unknown): Canonical | undefined => {
    if (input === undefined) return undefined;
    if (input === null || typeof input === "boolean" || typeof input === "number") return input;
    if (typeof input === "string") return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (Array.isArray(input)) return input.map((item) => canonical(item) ?? null);
    if (typeof input === "object") {
      const result: Record<string, Canonical> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) {
        const item = canonical((input as Record<string, unknown>)[key]);
        if (item !== undefined) result[key] = item;
      }
      return result;
    }
    throw new TypeError(`cannot canonicalize ${typeof input}`);
  };
  return JSON.stringify(canonical(value));
}

export function runtimeFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalRuntimeJson(value)).digest("hex")}`;
}

export function freezeRuntimeContext(
  input: Omit<FrozenRuntimeContext, "version">,
): FrozenRuntimeContextRecord {
  const context: FrozenRuntimeContext = {
    version: 1,
    ...input,
    tools: input.tools.map((entry) => ({ ...entry })),
    skills: input.skills.map((entry) => ({ ...entry })),
    mcpServers: input.mcpServers.map((entry) => ({ ...entry })),
    hooks: input.hooks.map((entry) => ({ ...entry })),
    adapters: input.adapters.map((entry) => ({ ...entry })),
    ...(input.compiledContext === undefined
      ? {}
      : {
          compiledContext: {
            ...input.compiledContext,
            sources: input.compiledContext.sources.map((entry) => ({ ...entry })),
          },
        }),
  };
  return {
    fingerprint: runtimeFingerprint(context),
    context: Object.freeze(context),
  };
}

export interface CompactedHistory {
  messages: ModelMessage[];
  summary: string;
  sourceRange: { startMessage: number; endMessage: number };
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export function estimateMessageTokens(message: ModelMessage): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(message), "utf8") / 4));
}

function boundedSummary(messages: ModelMessage[]): string {
  const lines: string[] = ["Compacted prior session history (derived from the authoritative trace):"];
  for (const message of messages) {
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const text = content
        .filter((part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join(" ");
      const tools = content
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolName)
        .join(", ");
      if (text.length > 0) lines.push(`assistant: ${text.slice(0, 2_000)}`);
      if (tools.length > 0) lines.push(`assistant tools: ${tools}`);
    } else if (message.role === "tool") {
      const parts = Array.isArray(message.content) ? message.content : [];
      const names = parts
        .map((part) => "toolName" in part && typeof part.toolName === "string" ? part.toolName : part.type)
        .join(", ");
      lines.push(`tool results recorded: ${names}`);
    } else if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
      lines.push(`user: ${text.slice(0, 2_000)}`);
    }
    if (lines.join("\n").length >= CONTEXT_SUMMARY_MAX_TOKENS * 4) break;
  }
  return lines.join("\n").slice(0, CONTEXT_SUMMARY_MAX_TOKENS * 4);
}

/**
 * Derives a compact prompt view without modifying the authoritative event
 * stream. Message zero is the stable task/instruction prefix. The newest
 * 20% of the family window, with a 16K-token floor, remains verbatim.
 */
export function compactModelHistory(
  messages: readonly ModelMessage[],
  contextWindow: number,
): CompactedHistory | null {
  if (messages.length < 3 || contextWindow < 1) return null;
  const estimatedTokensBefore = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  if (estimatedTokensBefore < Math.floor(contextWindow * CONTEXT_COMPACTION_TRIGGER)) return null;

  const recentTarget = Math.min(
    Math.max(CONTEXT_RECENT_MIN_TOKENS, Math.floor(contextWindow * CONTEXT_RECENT_FRACTION)),
    Math.max(1, contextWindow - CONTEXT_SUMMARY_MAX_TOKENS - estimateMessageTokens(messages[0]!)),
  );
  let recentTokens = 0;
  let recentStart = messages.length;
  while (recentStart > 1 && recentTokens < recentTarget) {
    recentStart -= 1;
    recentTokens += estimateMessageTokens(messages[recentStart]!);
  }
  if (recentStart <= 1) return null;

  const compacted = messages.slice(1, recentStart);
  const summary = boundedSummary([...compacted]);
  const summaryMessage: ModelMessage = {
    role: "user",
    content: summary,
  };
  const next = [messages[0]!, summaryMessage, ...messages.slice(recentStart)];
  return {
    messages: next,
    summary,
    sourceRange: { startMessage: 1, endMessage: recentStart - 1 },
    estimatedTokensBefore,
    estimatedTokensAfter: next.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
  };
}
