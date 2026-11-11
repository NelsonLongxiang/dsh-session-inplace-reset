import { pathToFileURL } from 'node:url';
import type { SourceSnapshot } from './handoff-eval.ts';

interface Observation { events: any[]; header: { id: string; [key: string]: unknown }; cursor: number; inheritedEventCount: number }
/** Both preview and execution derive their text from the same host projection, inside the caller's observation lease. */
export async function snapshotFromObservation(sessionId: string, observation: Observation, messageProjections: unknown, loader: { resolve(name: string): string }): Promise<SourceSnapshot> {
  if (observation.header.id !== sessionId || !Number.isSafeInteger(observation.cursor)) throw new Error('源观察不属于所选会话或游标不可校验');
  const { Session } = await import(pathToFileURL(loader.resolve('@deepseek-ai/dsh-session')).href);
  const replay = Session.fromRestore(sessionId, observation.events, observation.header, observation.inheritedEventCount, 'shared-frozen', messageProjections);
  const messages = replay.surface.nodes.flatMap((seq: number) => {
    const message = replay.deriveEventMessage(observation.events[seq]);
    const text = message?.content.filter((part: { type: string; text?: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n');
    return text ? [{ seq, role: message.role, sourceKind: message.source.kind, text }] : [];
  });
  return { sessionId, cursor: observation.cursor, messages };
}
