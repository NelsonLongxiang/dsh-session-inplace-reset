export function optionalAgentPreset(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 256) throw new TypeError('Agent预设ID无效，请从当前预设列表选择');
  return value;
}

interface Observation {
  header: { agentPreset?: string };
  events: { type: string; data?: { agentPreset?: string } }[];
  projections?: { values: { agentPreset?: string | null } };
}
export function observedAgentPreset(observation: Observation): string | undefined {
  const projected = observation.projections?.values.agentPreset;
  if (projected !== undefined) return projected ?? undefined;
  return observation.events.findLast((event) => event.type === 'agent-preset/selected')?.data?.agentPreset
    ?? observation.header.agentPreset;
}

interface Presets { resolve(id?: string): Promise<{ id: string; broken?: string }> }
/** Resolve without starting an Agent; a declared but broken preset must fail before storage changes. */
export async function resetAgentPreset(registry: Presets | undefined, requested: string | undefined, original: string | undefined) {
  const chosen = requested ?? original;
  if (!registry) {
    if (requested !== undefined) throw new Error('宿主没有可用的Agent预设服务，未执行重置');
    return chosen;
  }
  const resolved = await registry.resolve(chosen);
  if (resolved.broken !== undefined) throw new Error(`Agent预设 ${resolved.id} 不可用：${resolved.broken}`);
  if (chosen !== undefined && resolved.id !== chosen) throw new Error('Agent预设解析结果与选择不一致，未执行重置');
  return optionalAgentPreset(resolved.id);
}
