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

// ---- Per-generation behaviour -------------------------------------------------
// Gemini 2.5 Flash can (and should, for short chat replies) disable thinking via
// thinkingConfig.thinkingBudget: 0. Gemini 3.x models REJECT that setting outright
// (400 INVALID_ARGUMENT "Request contains an invalid argument." — several 3.x/lite
// models cannot turn thinking off at all), and they also REQUIRE a thoughtSignature
// on every functionCall part replayed in the conversation. Google documents the
// escape hatch value 'skip_thought_signature_validator' for callers that do not
// store signatures (we do not). Both behaviours are model-aware below.
const isGemini3 = (model: string) => /^gemini-[3-9]/.test(model);
/** 2.5 Flash / Flash-Lite can disable thinking. Pro (and 3.x+) cannot. */
const canDisableThinking = (model: string) => /2\.5/.test(model) && /flash/.test(model) && !/pro/.test(model);

/** Gemini accepts an OpenAPI-style schema subset: drop keys it rejects. */
function geminiSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(geminiSchema);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'additionalProperties' && k !== '$schema').map(([k, x]) => [k, geminiSchema(x)]));
  }
  return v;
}

export function toGeminiContents(messages: Msg[], opts: { signToolCalls?: boolean } = {}): Array<{ role: 'user' | 'model'; parts: GPart[] }> {
  const names = new Map<string, string>();          // tool_use id -> function name (Gemini responses are matched by name)
  for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' as const : 'user' as const,
    parts: typeof m.content === 'string' ? [{ text: m.content }] : m.content.map((b): GPart =>
      b.type === 'text' ? { text: b.text }
        : b.type === 'tool_use' ? {
            functionCall: { name: b.name, args: b.input },
            // Gemini 3+ refuses replayed function calls that carry no thought signature.
            ...(opts.signToolCalls ? { thoughtSignature: 'skip_thought_signature_validator' } : {}),
          }
        : { functionResponse: { name: names.get(b.tool_use_id) ?? 'tool', response: b.is_error ? { error: b.content } : { result: b.content } } }),
  }));
}

export class GeminiLlm implements Llm {
  private n = 0;
  constructor(
    private onUsage?: UsageHook,
    private apiKey?: string,
    private model = config.geminiModel,
    private fetchImpl: GFetch = (url, init) => fetch(url, init),
  ) {}

  async complete(a: CompleteArgs): Promise<LlmResult> {
    const three = isGemini3(this.model);
    const body = {
      systemInstruction: { parts: [{ text: a.system }] },
      contents: toGeminiContents(a.messages, { signToolCalls: three }),
      ...(a.tools?.length ? {
        tools: [{ functionDeclarations: a.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.input_schema) })) }],
        toolConfig: { functionCallingConfig: a.toolChoice?.type === 'tool' ? { mode: 'ANY', allowedFunctionNames: [a.toolChoice.name] } : { mode: 'AUTO' } },
      } : {}),
      generationConfig: {
        // Gemini 3.x always thinks, so its thought tokens need headroom inside the output
        // budget or every reply gets cut off at MAX_TOKENS before a single word is written.
        maxOutputTokens: three ? Math.max(a.maxTokens, 1500) : a.maxTokens,
        // 2.5 Flash "thinks" by default and thinking tokens eat the output budget; short chat replies do not need it.
        // NEVER send thinkingConfig to 3.x+ models: thinkingBudget 0 is INVALID_ARGUMENT there.
        ...(canDisableThinking(this.model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
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
      else if (p.functionCall) content.push({ type: 'tool_use', id: `gemini_${Date.now()}_${this.n++}`, name: p.functionCall.name, input: p.functionCall.args ?? {} });
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
