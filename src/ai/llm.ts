import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

// Our own minimal message types so the conversation logic never depends on SDK shapes
// (this is also what lets tests swap in a scripted fake model).
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolUseBlock;
export interface Msg { role: 'user' | 'assistant'; content: string | Array<TextBlock | ToolUseBlock | ToolResultBlock> }
export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface LlmResult { content: Block[]; stopReason: string | null; usage: Usage }

export interface CompleteArgs {
  system: string;
  messages: Msg[];
  tools?: ToolDef[];
  toolChoice?: { type: 'auto' } | { type: 'tool'; name: string };
  maxTokens: number;
  kind: string;              // for the usage log: converse | classify | opener | triage | followup
  clientId?: string;
}

export interface Llm { complete(a: CompleteArgs): Promise<LlmResult> }

export type UsageHook = (u: { kind: string; clientId?: string } & Usage & { costUsd: number }) => void | Promise<void>;

export function costUsd(u: Usage): number {
  const p = config.prices;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000;
}

export class AnthropicLlm implements Llm {
  private client: Anthropic;
  constructor(private onUsage?: UsageHook, apiKey = config.anthropicKey) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(a: CompleteArgs): Promise<LlmResult> {
    const res = await this.client.messages.create({
      model: config.model,
      max_tokens: a.maxTokens,
      // Static per-client prompt goes in a cacheable system block.
      system: [{ type: 'text', text: a.system, cache_control: { type: 'ephemeral' } }],
      messages: a.messages as Anthropic.MessageParam[],
      ...(a.tools?.length ? { tools: a.tools as Anthropic.Tool[] } : {}),
      ...(a.toolChoice ? { tool_choice: a.toolChoice as Anthropic.ToolChoice } : {}),
    });

    const content: Block[] = [];
    for (const b of res.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
    const usage: Usage = {
      input: res.usage.input_tokens ?? 0,
      output: res.usage.output_tokens ?? 0,
      cacheRead: res.usage.cache_read_input_tokens ?? 0,
      cacheWrite: res.usage.cache_creation_input_tokens ?? 0,
    };
    await this.onUsage?.({ kind: a.kind, clientId: a.clientId, ...usage, costUsd: costUsd(usage) });
    return { content, stopReason: res.stop_reason, usage };
  }
}

// ---------------------------------------------------------------------------------------------
// Google Gemini (REST, no extra dependency). Same Llm interface, so nothing else changes.
// Free-tier friendly: set LLM_PROVIDER=gemini and GEMINI_API_KEY. Cost is logged as 0.
// ---------------------------------------------------------------------------------------------
type GFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
type GPart = { text?: string; thoughtSignature?: string; functionCall?: { name: string; args: unknown }; functionResponse?: { name: string; response: unknown } };

/** Gemini accepts an OpenAPI-style schema subset: drop keys it rejects. */
function geminiSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(geminiSchema);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'additionalProperties' && k !== '$schema').map(([k, x]) => [k, geminiSchema(x)]));
  }
  return v;
}

export function toGeminiContents(messages: Msg[], sigFor?: (toolUseId: string) => string | undefined): Array<{ role: 'user' | 'model'; parts: GPart[] }> {
  const names = new Map<string, string>();          // tool_use id -> function name (Gemini responses are matched by name)
  for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' as const : 'user' as const,
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((b): GPart =>
      b.type === 'text' ? { text: b.text }
        : b.type === 'tool_use' ? { functionCall: { name: b.name, args: b.input }, ...(sigFor?.(b.id) ? { thoughtSignature: sigFor(b.id) } : {}) }
        : { functionResponse: { name: names.get(b.tool_use_id) ?? 'tool', response: b.is_error ? { error: b.content } : { result: b.content } } }),
  }));
}

/**
 * Thinking control differs by model family:
 *  - Gemini 2.5 Flash / Flash-Lite: thinkingBudget 0 switches thinking off.
 *  - Gemini 3.x Flash-Lite: rejects thinkingBudget (HTTP 400); thinkingLevel "minimal" is the closest to off.
 *  - Other Gemini 3+ models: send nothing (thinkingBudget is deprecated there); the caller adds output headroom instead.
 */
export function geminiThinkingConfig(model: string): Record<string, unknown> | undefined {
  if (/^gemini-[3-9]/.test(model)) return model.includes('flash-lite') ? { thinkingLevel: 'minimal' } : undefined;
  return model.includes('flash') ? { thinkingBudget: 0 } : undefined;
}

export class GeminiLlm implements Llm {
  private n = 0;
  /** Gemini 3+ returns a thoughtSignature with each function call and requires it back on the next request. */
  private sigs = new Map<string, string>();
  constructor(
    private onUsage?: UsageHook,
    private apiKey?: string,
    private model = config.geminiModel,
    private fetchImpl: GFetch = (url, init) => fetch(url, init),
  ) {}

  private remember(id: string, sig: string) {
    if (this.sigs.size >= 500) { const first = this.sigs.keys().next().value; if (first !== undefined) this.sigs.delete(first); }
    this.sigs.set(id, sig);
  }

  async complete(a: CompleteArgs): Promise<LlmResult> {
    const g3 = /^gemini-[3-9]/.test(this.model);
    const thinking = geminiThinkingConfig(this.model);
    // Calls we never saw the signature for (e.g. history from another process) use Google's documented bypass value.
    const sigFor = (id: string) => this.sigs.get(id) ?? (g3 ? 'skip_thought_signature_validator' : undefined);
    const body = {
      systemInstruction: { parts: [{ text: a.system }] },
      contents: toGeminiContents(a.messages, sigFor),
      ...(a.tools?.length ? {
        tools: [{ functionDeclarations: a.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) })) }],
        toolConfig: { functionCallingConfig: a.toolChoice?.type === 'tool' ? { mode: 'ANY', allowedFunctionNames: [a.toolChoice.name] } : { mode: 'AUTO' } },
      } : {}),
      generationConfig: {
        // Thinking tokens count against the output budget, so models that keep thinking on get extra headroom.
        maxOutputTokens: a.maxTokens + (g3 && !thinking ? 1024 : 0),
        ...(thinking ? { thinkingConfig: thinking } : {}),
      },
    };
    const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': this.apiKey ?? config.geminiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${raw.slice(0, 300)}`);
    const json = JSON.parse(raw) as {
      candidates?: Array<{ content?: { parts?: GPart[] }; finishReason?: string }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
    };
    const cand = json.candidates?.[0];
    const content: Block[] = [];
    for (const p of cand?.content?.parts ?? []) {
      if (p.text) content.push({ type: 'text', text: p.text });
      else if (p.functionCall) {
        const id = `gemini_${Date.now()}_${this.n++}`;
        if (p.thoughtSignature) this.remember(id, p.thoughtSignature);
        content.push({ type: 'tool_use', id, name: p.functionCall.name, input: p.functionCall.args ?? {} });
      }
    }
    const um = json.usageMetadata ?? {};
    const usage: Usage = { input: um.promptTokenCount ?? 0, output: um.candidatesTokenCount ?? 0, cacheRead: um.cachedContentTokenCount ?? 0, cacheWrite: 0 };
    await this.onUsage?.({ kind: a.kind, clientId: a.clientId, ...usage, costUsd: 0 });
    // Map to the stop reasons the conversation loop already understands.
    const stopReason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : cand?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
    return { content, stopReason, usage };
  }
}

/** LLM_PROVIDER=anthropic (default, Claude Haiku in production) or gemini (free-tier testing). */
export function createLlm(onUsage?: UsageHook): Llm {
  if (config.llmProvider === 'gemini') return new GeminiLlm(onUsage);
  if (config.llmProvider !== 'anthropic') throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}" (use "anthropic" or "gemini")`);
  return new AnthropicLlm(onUsage);
}
