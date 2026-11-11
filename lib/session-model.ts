export interface SessionModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelObservation { cursor: number; projections?: { asOfSeq: number; values: { modelSelection?: { next: SessionModelSelection | null } } } }

/** Use the same cold-readable model-selection view as the host selector, including pending changes. */
export function sessionModel(observation: ModelObservation, defaults?: { currentSelection(): SessionModelSelection }): { selection: SessionModelSelection; source: 'session' | 'default' } {
  const projection = observation.projections;
  if (!projection || projection.asOfSeq !== observation.cursor || !Object.hasOwn(projection.values, 'modelSelection')) throw new Error('当前会话模型投影不可校验，未改用其他模型');
  const picked = projection.values.modelSelection?.next;
  const selection = picked === null ? defaults?.currentSelection() : picked;
  if (!selection || typeof selection.provider !== 'string' || !selection.provider.trim() || typeof selection.model !== 'string' || !selection.model.trim() || selection.reasoningEffort !== undefined && (typeof selection.reasoningEffort !== 'string' || !selection.reasoningEffort.trim())) throw new Error('该会话尚无可用模型配置，请先在会话中选择模型');
  return { selection: { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }, source: picked === null ? 'default' : 'session' };
}
