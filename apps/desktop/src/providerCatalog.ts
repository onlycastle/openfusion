import type { ProviderKind } from "./engineClient";

/** UI-side provider preset. The engine exposes no model-enumeration RPC, so
 * `models` is sourced from the engine pricing table
 * (`packages/engine/src/models/pricing.ts`) and must be kept in sync with it.
 * DeepSeek's retiring aliases (deepseek-chat / deepseek-reasoner, hard-retire
 * 2026-07-24) are deliberately omitted. */
export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  /** Prefilled + editable (Moonshot/Z.ai). Undefined when hidden or required. */
  defaultBaseURL?: string;
  /** Required field (OpenAI-compatible has no default endpoint). */
  baseURLRequired: boolean;
  /** Hidden field — the SDK supplies the endpoint (DeepSeek). */
  baseURLHidden: boolean;
  /** Fixed catalog for a `<select>`. Empty => free-text model input. */
  models: string[];
  /** `<datalist>` suggestions when `models` is empty (OpenAI-compatible). */
  modelSuggestions?: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    kind: "moonshot",
    label: "Moonshot",
    defaultBaseURL: "https://api.moonshot.ai/v1",
    baseURLRequired: false,
    baseURLHidden: false,
    models: ["kimi-k2.6", "kimi-k2.7-code"],
  },
  {
    kind: "zai",
    label: "Z.ai",
    defaultBaseURL: "https://api.z.ai/api/paas/v4",
    baseURLRequired: false,
    baseURLHidden: false,
    models: ["glm-5.2"],
  },
  {
    kind: "deepseek",
    label: "DeepSeek",
    baseURLRequired: false,
    baseURLHidden: true,
    models: ["deepseek-v4-flash", "deepseek-v4-pro"],
  },
  {
    kind: "openai-compatible",
    label: "OpenAI-compatible",
    baseURLRequired: true,
    baseURLHidden: false,
    models: [],
    modelSuggestions: ["qwen3-coder-next", "qwen3-coder", "minimax-m2.5"],
  },
];

export function presetFor(kind: ProviderKind): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.kind === kind);
  if (preset === undefined) {
    throw new Error(`no provider preset for kind ${kind}`);
  }
  return preset;
}
