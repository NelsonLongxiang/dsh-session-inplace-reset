import type * as ReactTypes from 'react';
import type { PreviewReport } from '../lib/handoff-eval.ts';
import type { EvaluationSettingsView } from '../lib/evaluation-settings.ts';

type Complete = { ok: true; phase: 'DONE'; verified: true; sameId: true; sessionId: string; before: { totalTurns: number; totalEvents: number }; after: { totalTurns: number; totalEvents: number }; forkId?: string; operationId?: string };
type Result = Complete | { phase: 'NOT_RESET'; note: string; forkId?: string };
type DryRun = { sessionId: string; totalTurns: number; totalEvents: number; messages: number; size: number; k: number; canReset?: boolean; blockedReason?: string };
type ModelReport = PreviewReport & { reportId?: string };
type DialogTarget = { sessionId: string; displayTitle?: string; completed?: Complete };
type DialogProps = DialogTarget & { onClose: () => void };
type MenuProps = { sessionId: string; displayTitle?: string; useMenuOpenState: () => [boolean, (value: boolean) => void] };
interface ClientContext { slots: { inject(name: string, mount: () => unknown): unknown; register(options: object, component: ReactTypes.ComponentType<any>): () => void }; effect(mount: () => unknown, label: string): unknown }
declare global { interface Window { __ModuleLoader__: { load(plugin: { id: string; factory(require: (name: string) => unknown): unknown }): void } } }

// 会话行菜单入口；预览独立挂在 shell.overlay，关闭菜单不会丢失目标会话。
window.__ModuleLoader__.load({
  id: '@local/dsh-session-inplace-reset',
  factory(require) {
    const React = require('react') as typeof ReactTypes;
    const { MenuItemButton, Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives') as Record<string, ReactTypes.ComponentType<any>>;
    const h = React.createElement;
    const completedKey = '@local/dsh-session-inplace-reset/completed';

    const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
    const checkLabels: Record<string, string> = { constraints: '目标与约束', state: '任务状态与纠正', faithful: '角色、来源与事实边界' };

    async function rpc<T = any>(method: string, args: object, signal?: AbortSignal): Promise<T> {
      const endpoint = `workspaceRegistry/${method}`;
      const rpcId = crypto.randomUUID();
      const response = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const full = await response.json();
      if (full.rpcId !== rpcId) throw new Error('响应与请求不匹配，请重试');
      if (!full.result?.ok) throw new Error(full.result?.error?.message ?? '请求失败');
      return full.result.value;
    }

    function ResetDialog({ sessionId, displayTitle, onClose, completed }: DialogProps) {
      const [dry, setDry] = React.useState<DryRun | null>(null);
      const [loading, setLoading] = React.useState(true);
      const [executing, setExecuting] = React.useState(false);
      const [result, setResult] = React.useState<Result | null>(completed ?? null);
      const [error, setError] = React.useState<string | null>(null);
      const [confirmText, setConfirmText] = React.useState('');
      const [attempt, setAttempt] = React.useState(0);
      const [model, setModel] = React.useState<ModelReport | null>(null);
      const [modelLoading, setModelLoading] = React.useState(false);
      const [modelError, setModelError] = React.useState<string | null>(null);
      const modelRequest = React.useRef<AbortController | null>(null);
      React.useEffect(() => () => modelRequest.current?.abort(), []);
      const shortId = sessionId.slice(8, 16);
      const close = () => { if (!executing) onClose(); };

      React.useEffect(() => {
        if (completed) { setLoading(false); return; }
        const controller = new AbortController();
        setLoading(true);
        setDry(null);
        setError(null);
        rpc<DryRun>('sessionResetDryRun', { sessionId }, controller.signal).then((value) => {
          if (value?.sessionId !== sessionId || !(['totalEvents', 'messages', 'size', 'k'] as const).every((key) => Number.isFinite(value[key]) && value[key] >= 0)) {
            throw new Error('预览数据不完整或不属于所选会话，请重试');
          }
          if (!controller.signal.aborted) setDry(value);
        }).catch((reason) => {
          if (!controller.signal.aborted) setError(String(reason.message ?? reason));
        }).finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
      }, [sessionId, attempt]);

      const previewModel = async () => {
        if (!dry || executing || modelLoading) return;
        const controller = new AbortController();
        modelRequest.current = controller;
        setModelLoading(true);
        setModel(null);
        setModelError(null);
        try {
          const value = await rpc<ModelReport>('sessionResetModelPreview', { sessionId }, controller.signal);
          if (value?.sessionId !== sessionId || value.mode !== 'shadow' || value.applied !== false || !['pass', 'fail', 'pending', 'unavailable'].includes(value.status) || !Array.isArray(value.selected) || !Array.isArray(value.checks) || !Number.isSafeInteger(value.coverage?.assessed) || !Number.isSafeInteger(value.coverage?.total) || value.coverage.assessed < 0 || value.coverage.total < value.coverage.assessed) throw new Error('模型预览数据不完整或不属于所选会话');
          if (!value.selected.every((item) => typeof item?.text === 'string' && typeof item.id === 'string' && Number.isSafeInteger(item.seq)) || !value.checks.every((check) => ['constraints', 'state', 'faithful'].includes(check?.key) && Number.isFinite(check.probability) && check.probability >= 0 && check.probability <= 1 && ['pass', 'fail', 'pending'].includes(check.outcome))) throw new Error('模型预览的原文或核对项无效');
          if (value.status === 'pass' && (!value.coverage.complete || value.budgetOmissions && value.budgetOmissions > 0 || !value.selected.length || new Set(value.checks.map((check) => check.key)).size !== 3 || !value.checks.every((check) => check.outcome === 'pass' && check.probability >= 0.7))) throw new Error('未收到完整的模型核对，不能显示通过');
          if (!controller.signal.aborted) setModel(value);
        } catch (reason) {
          if (!controller.signal.aborted) setModelError(errorMessage(reason));
        } finally {
          if (!controller.signal.aborted) setModelLoading(false);
        }
      };

      const execute = async () => {
        if (!dry || dry.canReset === false || loading || executing || modelLoading || confirmText.trim() !== shortId) return;
        setExecuting(true);
        setError(null);
        try {
          const value = await rpc('sessionResetExecute', {
            request: { sessionId, confirmShortId: confirmText.trim() },
          });
          if (value?.phase !== 'DONE' || value.ok !== true || value.verified !== true || value.sameId !== true || value.sessionId !== sessionId || !Number.isSafeInteger(value.after?.totalTurns) || !Number.isSafeInteger(value.before?.totalTurns)) {
            setResult({ phase: 'NOT_RESET', note: value?.reason ?? value?.note ?? '未收到重置成功的读回校验，不能判定完成', forkId: value?.forkId });
            return;
          }
          setResult(value);
          setDry(null);
          try {
            const { ok, phase, verified, sameId, sessionId: id, before, after, forkId, operationId } = value;
            window.sessionStorage.setItem(completedKey, JSON.stringify({ sessionId: id, displayTitle, completed: { ok, phase, verified, sameId, sessionId: id, before, after, forkId, operationId } }));
            window.location.reload();
          } catch { setError('后端重置已校验完成，请刷新当前标签页以清除旧统计。'); }
        } catch (reason) {
          setResult({ phase: 'NOT_RESET', note: errorMessage(reason) });
        } finally {
          setExecuting(false);
        }
      };

      return h(Modal, {
        open: true,
        title: '原地重置会话',
        onClose: close,
        closeLabel: '关闭',
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: executing, onClick: close }, '关闭'),
          !result && h(Button, {
            variant: 'primary',
            disabled: !dry || dry.canReset === false || loading || executing || modelLoading || confirmText.trim() !== shortId,
            onClick: execute,
          }, executing ? '正在备份…' : '备份并重置'),
        ),
      },
        h('div', { 'data-inplace-reset-session': sessionId, 'aria-busy': loading || executing || modelLoading, style: { maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 } },
          h('p', { style: { marginTop: 0, overflowWrap: 'anywhere' } }, displayTitle || '未命名会话'),
          h('code', { style: { fontSize: 12, overflowWrap: 'anywhere' } }, sessionId),
          loading && h('p', { role: 'status' }, '正在读取该会话的预览…'),
          error && h('p', { role: 'alert' }, error),
          !result && !loading && !dry && h(Button, { variant: 'outline', onClick: () => setAttempt((n) => n + 1) }, '重新读取预览'),
          dry && h('div', { 'data-inplace-reset-stats': true, style: { margin: '16px 0' } },
            h('div', null, `原日志轮次：${Number.isSafeInteger(dry.totalTurns) ? dry.totalTurns.toLocaleString() : '未提供'}`),
            h('div', null, `事件数：${dry.totalEvents.toLocaleString()}`),
            h('div', null, `消息数：${dry.messages.toLocaleString()}`),
            h('div', null, `交接包大小：${(dry.size / 1024).toFixed(1)} KB`),
            h('div', null, `交接包最多采样 ${dry.k} 轮；新日志收敛为 1 轮交接记录`),
            dry.canReset === false && h('p', { role: 'alert' }, `当前不可重置：${dry.blockedReason}`),
          ),
          !result && dry && h('div', { 'data-inplace-reset-model': true, style: { margin: '16px 0' } },
            h(Button, { variant: 'outline', disabled: loading || executing || modelLoading, onClick: previewModel }, modelLoading ? '正在筛选并核对…' : '模型筛选预览'),
            h('p', { style: { fontSize: 12 } }, '向现有决策模型发送文字片段，只生成预览。下方重置操作仍使用上方近期采样。'),
            modelError && h('p', { role: 'alert' }, modelError),
            model && h('div', { 'data-inplace-reset-model-status': model.status, 'data-inplace-reset-model-report': model.reportId, role: 'status' },
              h('b', null, ({ pass: '送评材料内检查通过', fail: '预览未通过', pending: '预览待核验', unavailable: '模型未评估' })[model.status]),
              h('p', null, `送评 ${model.coverage.assessed} / ${model.coverage.total} 个文本片段；保留 ${model.selected.length} 个${model.size ? `；交接包 ${(model.size / 1024).toFixed(1)} KB` : ''}`),
              !model.coverage.complete && h('p', null, '存在未送评文本，不能视为完整覆盖。'),
              (model.budgetOmissions ?? 0) > 0 && h('p', null, `体积预算另省略 ${model.budgetOmissions} 个待保留片段。`),
              h('ul', null, model.checks.map((check) => h('li', { key: check.key }, `${checkLabels[check.key] ?? check.key}：${({ pass: '通过', fail: '未通过', pending: '待核验' })[check.outcome]}（P=${Number(check.probability).toFixed(2)}）`))),
              h('p', { style: { fontSize: 12 } }, model.note),
              h('details', null,
                h('summary', null, '查看保留原文及来源'),
                h('div', { style: { maxHeight: 260, overflow: 'auto' } }, model.selected.map((item) => h('div', { key: item.id, style: { marginTop: 12 } },
                  h('small', null, `事件 #${item.seq} · ${item.historical ? '历史引用' : item.role === 'assistant' ? '助手陈述' : item.role === 'tool' ? '工具返回' : item.sourceKind === 'user' ? '用户消息' : '上下文消息'} · 片段 ${item.id}${item.retention === 'pending' ? ' · 保留待核验' : ''}${item.superseded === 'pass' ? ' · 可能已被后续纠正，需对照来源' : ''}`),
                  h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 } }, item.text),
                ))),
              ),
            ),
          ),
          !result && h(React.Fragment, null,
            h('p', null, '先验证完整历史备份，再释放并重建该会话。只刷新目标会话的历史，不重启 DSH。任务运行中或无法确认释放入口时会拒绝操作。'),
            h('label', { htmlFor: 'inplace-reset-confirm' }, `输入 ${shortId} 确认重置`),
            h('input', {
              id: 'inplace-reset-confirm',
              value: confirmText,
              onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => setConfirmText(event.target.value),
              autoComplete: 'off',
              disabled: loading || executing || modelLoading,
              style: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, padding: 8, color: 'inherit', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 },
            }),
          ),
          result && h('div', { role: result.phase === 'DONE' ? 'status' : 'alert', 'data-inplace-reset-result': result.phase },
            h('b', null, result.phase === 'DONE' ? '重置已完成并校验' : '未重置'),
            result.phase === 'DONE' && h('p', { 'data-inplace-reset-after': true }, `原日志轮次：${result.before.totalTurns} → ${result.after.totalTurns}；事件数：${result.before.totalEvents} → ${result.after.totalEvents}`),
            result.phase !== 'DONE' && h('p', null, result.note),
            result.forkId && h('p', { style: { overflowWrap: 'anywhere' } }, `历史备份：${result.forkId}`),
          ),
        ),
      );
    }

    function EvaluationSettings() {
      const [view, setView] = React.useState<EvaluationSettingsView | null>(null);
      const [apiBase, setApiBase] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState<string | null>(null);
      const [notice, setNotice] = React.useState<string | null>(null);
      const [attempt, setAttempt] = React.useState(0);
      const validView = (value: EvaluationSettingsView) => value && typeof value.apiBase === 'string' && Object.keys(value).every((key) => ['apiBase', 'configured', 'hasSavedKey', 'usingDefault', 'writable'].includes(key)) && ['configured', 'hasSavedKey', 'usingDefault', 'writable'].every((key) => typeof (value as unknown as Record<string, unknown>)[key] === 'boolean');
      React.useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        rpc<EvaluationSettingsView>('sessionResetEvaluationSettings', {}, controller.signal).then((value) => {
          if (!validView(value)) throw new Error('评估模型配置响应无效');
          if (!controller.signal.aborted) { setView(value); setApiBase(value.apiBase); }
        }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [attempt]);
      const save = async (event: ReactTypes.FormEvent) => {
        event.preventDefault();
        if (!view?.writable || loading || saving || !apiBase.trim() || (!apiKey.trim() && !view.hasSavedKey)) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
          const value = await rpc<EvaluationSettingsView>('sessionResetSaveEvaluationSettings', { request: { apiBase: apiBase.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } });
          if (!validView(value)) throw new Error('保存结果无效，请重新读取配置');
          setView(value);
          setApiBase(value.apiBase);
          setApiKey('');
          setNotice('已保存，将用于下一次评估。');
        } catch (reason) { setError(errorMessage(reason)); }
        finally { setSaving(false); }
      };
      const inputStyle: ReactTypes.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 };
      return h('section', { 'data-evaluation-settings': true, 'aria-busy': loading || saving, style: { maxWidth: 720, marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--dsw-alias-border-l3)' } },
        h('h3', { style: { margin: '0 0 8px' } }, '评估模型'),
        h('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '用于采样质量评估，使用 typesafe-ai/jev 评估协议。'),
        loading && h('p', { role: 'status' }, '正在读取配置…'),
        error && h('p', { role: 'alert' }, error),
        !loading && !view && h(Button, { variant: 'outline', onClick: () => setAttempt((value) => value + 1) }, '重新读取配置'),
        view && h('form', { onSubmit: save, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('label', { htmlFor: 'evaluation-api-base' }, 'API Base'),
          h('input', { id: 'evaluation-api-base', type: 'url', value: apiBase, maxLength: 2048, disabled: saving || !view.writable, placeholder: 'https://ai-gateway.vercel.sh', autoComplete: 'off', onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => { setApiBase(event.target.value); setNotice(null); }, style: inputStyle }),
          h('small', null, '仅填域名会补全 /v4/ai/evaluation-model；也可填写完整评估接口地址。'),
          h('label', { htmlFor: 'evaluation-api-key' }, 'API Key'),
          h('input', { id: 'evaluation-api-key', type: 'password', value: apiKey, maxLength: 16384, disabled: saving || !view.writable, placeholder: view.hasSavedKey ? '已保存，留空保留现有 Key' : '首次保存请填写 API Key', autoComplete: 'new-password', spellCheck: false, onChange: (event: ReactTypes.ChangeEvent<HTMLInputElement>) => { setApiKey(event.target.value); setNotice(null); }, style: inputStyle }),
          h('small', { 'data-evaluation-key-status': true }, view.hasSavedKey ? 'API Key 已保存，不回显；更换服务域名时请重新填写。' : view.configured ? '当前使用现有默认凭证；保存自定义配置时请填写 Key。' : '尚未配置 API Key。'),
          !view.writable && h('p', { role: 'alert' }, '当前环境没有可写的凭证存储。'),
          notice && h('p', { role: 'status', 'data-evaluation-saved': true }, notice),
          h(Button, { type: 'submit', variant: 'primary', disabled: saving || !view.writable || !apiBase.trim() || (!apiKey.trim() && !view.hasSavedKey) }, saving ? '正在保存…' : '保存评估模型配置'),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx: ClientContext) {
        let target: DialogTarget | null = null;
        try {
          const saved = JSON.parse(window.sessionStorage.getItem(completedKey) ?? 'null');
          if (saved?.completed?.verified === true && saved.completed.phase === 'DONE' && saved.completed.sessionId === saved.sessionId && Number.isSafeInteger(saved.completed.after?.totalTurns) && Number.isSafeInteger(saved.completed.before?.totalTurns)) target = saved;
        } catch { /* An unavailable browser store must not block plugin activation. */ }
        const listeners = new Set<() => void>();
        const publish = (next: DialogTarget | null) => {
          try { window.sessionStorage.removeItem(completedKey); } catch {}
          target = next;
          for (const listener of listeners) listener();
        };
        const subscribe = (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
        const snapshot = () => target;

        function ResetMenuItem({ sessionId, displayTitle, useMenuOpenState }: MenuProps) {
          const [, setMenuOpen] = useMenuOpenState();
          return h(MenuItemButton, {
            icon: h('span', { 'aria-hidden': true }, '⟲'),
            onSelect: () => {
              setMenuOpen(false);
              publish({ sessionId, displayTitle });
            },
          }, '原地重置…');
        }

        function ResetOverlay() {
          const request = React.useSyncExternalStore(subscribe, snapshot, snapshot);
          return request && h(ResetDialog, { ...request, key: request.sessionId, onClose: () => publish(null) });
        }

        ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: '@local/dsh-session-inplace-reset/menu',
          order: 350,
        }, ResetMenuItem)), 'session-reset-inplace: session menu');
        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: '@local/dsh-session-inplace-reset/dialog',
        }, ResetOverlay)), 'session-reset-inplace: reset dialog');
        ctx.effect(() => ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer',
          id: '@local/dsh-session-inplace-reset/evaluation-settings',
          order: 100,
        }, EvaluationSettings)), 'session-reset: evaluation settings');
        ctx.effect(() => () => { target = null; listeners.clear(); }, 'session-reset-inplace: dialog state');
      },
    };
  },
});
