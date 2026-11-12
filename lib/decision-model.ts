import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Question = { type: 'boolean' | 'score' | 'choice'; instructions: string; criteria?: string[] | Record<string, string> };
export type Questions = Record<string, Question>;
export interface Answer { type?: string; probability?: number; score?: number; choice?: string; probabilities?: Record<string, number> }
export interface Evaluation { answers?: Partial<Record<string, Answer>>; error?: string; usage?: { inputTokens?: number; outputTokens?: number } }
export type Evaluator = (state: unknown, questions: Questions) => Promise<Evaluation>;
export type Outcome = 'pass' | 'fail' | 'pending';
export function outcome(p: unknown): Outcome {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) throw new Error('invalid probability');
  return p >= 0.7 ? 'pass' : p <= 0.4 ? 'fail' : 'pending';
}

export interface EvaluationConnection { apiBase: string; apiKey: string }
export const DEFAULT_API_BASE = 'https://ai-gateway.vercel.sh/v4/ai/evaluation-model';

export async function legacyConnection(): Promise<EvaluationConnection> {
  let token = process.env.AI_GATEWAY_API_KEY?.trim();
  if (!token) {
    try {
      const text = await readFile(join(homedir(), '.vercel.ai-gateway.env'), 'utf8');
      token = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith('token='))?.slice(6).trim();
    } catch { token = ''; }
  }
  return { apiBase: DEFAULT_API_BASE, apiKey: token ?? '' };
}

export async function evaluateConnection(connection: EvaluationConnection, state: unknown, questions: Questions, signal?: AbortSignal): Promise<Evaluation> {
  if (!connection.apiKey) return { error: '未配置决策模型凭证' };
  try {
    const response = await fetch(connection.apiBase, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json',
        'ai-model-id': 'typesafe-ai/jev', 'ai-evaluation-model-specification-version': '4',
        'ai-gateway-protocol-version': '0.0.1', 'ai-gateway-auth-method': 'api-key',
      },
      body: JSON.stringify({ state, questions }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    if (!response.ok) return { error: `决策模型不可用（HTTP ${response.status}）` };
    const result = await response.json();
    if (!result?.answers || typeof result.answers !== 'object' || Array.isArray(result.answers)) return { error: '评估响应格式无效' };
    return { answers: result.answers, usage: result.usage };
  } catch { return { error: '决策模型连接失败或超时' }; }
}

/** Standalone checks retain the existing environment/file defaults. DSH resolves saved settings per preview. */
export const evaluate: Evaluator = async (state, questions) => evaluateConnection(await legacyConnection(), state, questions);
