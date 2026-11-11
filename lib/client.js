// Generated from src/client.ts; run node tools/build-client.ts
// 会话行菜单入口；预览独立挂在 shell.overlay，关闭菜单不会丢失目标会话。
window.__ModuleLoader__.load({
  id: '@local/dsh-session-inplace-reset',
  factory(require) {
    const React = require('react')                     ;
    const { MenuItemButton, Modal, Button } = require('@deepseek-ai/dsh-client-ui-primitives')                                                 ;
    const h = React.createElement;
    const completedKey = '@local/dsh-session-inplace-reset/completed';
    const isSuccess = (value     , id        )                   => value?.ok === true && value.verified === true && value.sameId === true && value.sessionId === id && (value.phase === 'DONE' ? Number.isSafeInteger(value.before?.totalTurns) && Number.isSafeInteger(value.after?.totalTurns) : value.phase === 'RECOVERED' && typeof value.operationId === 'string');

    const validRecovery = (value                   ) => !!value && Array.isArray(value.operations) && Array.isArray(value.issues) && Array.isArray(value.warnings) && value.issues.every((item) => typeof item === 'string') && value.warnings.every((item) => typeof item === 'string') && value.operations.every((operation) => /^session-[a-f0-9-]{36}$/i.test(operation.sessionId) && /^[a-f0-9-]{36}$/i.test(operation.operationId) && typeof operation.createdAt === 'string');

    const errorMessage = (reason         ) => reason instanceof Error ? reason.message : String(reason);
    const checkLabels                         = { constraints: '目标与约束', state: '任务状态与纠正', faithful: '角色、来源与事实边界' };

    async function rpc         (method        , args        , signal              )             {
      const endpoint = `sessionReset/${method}`;
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

    function ResetDialog({ sessionId, displayTitle, onClose, completed, recoveryOnly }             ) {
      const [dry, setDry] = React.useState               (null);
      const [loading, setLoading] = React.useState(true);
      const [executing, setExecuting] = React.useState(false);
      const [result, setResult] = React.useState               (completed ?? null);
      const [error, setError] = React.useState               (null);
      const [confirmText, setConfirmText] = React.useState('');
      const [attempt, setAttempt] = React.useState(0);
      const [model, setModel] = React.useState                    (null);
      const [modelLoading, setModelLoading] = React.useState(false);
      const [modelError, setModelError] = React.useState               (null);
      const modelRequest = React.useRef                        (null);
      const [recovery, setRecovery] = React.useState                     (null);
      const [recoveryAttempt, setRecoveryAttempt] = React.useState(0);
      const [recoveryError, setRecoveryError] = React.useState               (null);
      const [recovering, setRecovering] = React.useState(false);
      const recoveryReady = !!recovery && !recovery.operations.length && !recovery.issues.length;
      React.useEffect(() => () => modelRequest.current?.abort(), []);
      const shortId = sessionId.slice(8, 16);
      const close = () => { if (!executing && !recovering) onClose(); };

      React.useEffect(() => {
        if (completed || recoveryOnly) { setLoading(false); return; }
        const controller = new AbortController();
        setLoading(true);
        setDry(null);
        setError(null);
        rpc        ('sessionResetDryRun', { sessionId }, controller.signal).then((value) => {
          if (value?.sessionId !== sessionId || !(['totalEvents', 'messages', 'size', 'k']         ).every((key) => Number.isFinite(value[key]) && value[key] >= 0)) {
            throw new Error('预览数据不完整或不属于所选会话，请重试');
          }
          if (!controller.signal.aborted) setDry(value);
        }).catch((reason) => {
          if (!controller.signal.aborted) setError(String(reason.message ?? reason));
        }).finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
        return () => controller.abort();
      }, [sessionId, attempt, recoveryOnly, completed]);

      React.useEffect(() => {
        if (completed) return;
        const controller = new AbortController();
        setRecovery(null);
        rpc              ('sessionResetRecoveryStatus', { sessionId }, controller.signal).then((value) => {
          if (value?.sessionId !== sessionId || !validRecovery(value) || !value.operations.every((operation) => operation.sessionId === sessionId)) throw new Error('恢复状态不可校验，未允许新的重置');
          if (!controller.signal.aborted) setRecovery(value);
        }).catch((reason) => { if (!controller.signal.aborted) setRecoveryError(errorMessage(reason)); });
        return () => controller.abort();
      }, [sessionId, recoveryAttempt]);
      const recover = async (operationId        ) => {
        if (executing || recovering || modelLoading || confirmText.trim() !== shortId) return;
        setRecovering(true);
        setRecoveryError(null);
        try {
          const value = await rpc           ('sessionResetResume', { request: { sessionId, operationId, confirmShortId: confirmText.trim() } });
          if (!isSuccess(value, sessionId) || value.phase !== 'RECOVERED') throw new Error('未收到原日志恢复校验');
          setResult(value);
          try {
            window.sessionStorage.setItem(completedKey, JSON.stringify({ sessionId, displayTitle, completed: value }));
            window.location.reload();
          } catch { setRecoveryError('原日志已校验恢复，请刷新当前标签页以读取原历史。'); }
        } catch (reason) { setRecoveryError(errorMessage(reason)); setAttempt((value) => value + 1); }
        finally { setRecovering(false); setRecoveryAttempt((value) => value + 1); }
      };

      const previewModel = async () => {
        if (!dry || executing || recovering || modelLoading) return;
        const controller = new AbortController();
        modelRequest.current = controller;
        setModelLoading(true);
        setModel(null);
        setModelError(null);
        try {
          const value = await rpc             ('sessionResetModelPreview', { sessionId }, controller.signal);
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
        if (!dry || dry.canReset === false || !recoveryReady || loading || executing || modelLoading || recovering || confirmText.trim() !== shortId) return;
        setExecuting(true);
        setError(null);
        try {
          const value = await rpc('sessionResetExecute', {
            request: { sessionId, confirmShortId: confirmText.trim() },
          });
          if (!isSuccess(value, sessionId) || value.phase !== 'DONE') {
            setResult({ phase: 'NOT_RESET', note: value?.reason ?? value?.note ?? '未收到重置成功的读回校验，不能判定完成', forkId: value?.forkId });
            return;
          }
          setResult(value);
          setDry(null);
          try {
            const { ok, phase, verified, sameId, sessionId: id, before, after, forkId, operationId, auditWarning } = value;
            window.sessionStorage.setItem(completedKey, JSON.stringify({ sessionId: id, displayTitle, completed: { ok, phase, verified, sameId, sessionId: id, before, after, forkId, operationId, auditWarning } }));
            window.location.reload();
          } catch { setError('后端重置已校验完成，请刷新当前标签页以清除旧统计。'); }
        } catch (reason) {
          setResult({ phase: 'NOT_RESET', note: errorMessage(reason) });
          setRecoveryAttempt((value) => value + 1);
        } finally {
          setExecuting(false);
        }
      };

      return h(Modal, {
        open: true,
        title: recoveryOnly || completed?.phase === 'RECOVERED' ? '恢复原日志' : '原地重置会话',
        onClose: close,
        closeLabel: '关闭',
        footer: h(React.Fragment, null,
          h(Button, { variant: 'outline', disabled: executing || recovering, onClick: close }, '关闭'),
          !result && !recoveryOnly && h(Button, {
            variant: 'primary',
            disabled: !dry || dry.canReset === false || !recoveryReady || loading || executing || modelLoading || recovering || confirmText.trim() !== shortId,
            onClick: execute,
          }, executing ? '正在备份…' : '备份并重置'),
        ),
      },
        h('div', { 'data-inplace-reset-session': sessionId, 'aria-busy': loading || executing || recovering || modelLoading, style: { maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 } },
          h('p', { style: { marginTop: 0, overflowWrap: 'anywhere' } }, displayTitle || '未命名会话'),
          h('code', { style: { fontSize: 12, overflowWrap: 'anywhere' } }, sessionId),
          loading && h('p', { role: 'status' }, '正在读取该会话的预览…'),
          error && h('p', { role: 'alert' }, error),
          !result && !recoveryOnly && !loading && !dry && h(Button, { variant: 'outline', onClick: () => setAttempt((n) => n + 1) }, '重新读取预览'),
          dry && h('div', { 'data-inplace-reset-stats': true, style: { margin: '16px 0' } },
            h('div', null, `原日志轮次：${Number.isSafeInteger(dry.totalTurns) ? dry.totalTurns.toLocaleString() : '未提供'}`),
            h('div', null, `事件数：${dry.totalEvents.toLocaleString()}`),
            h('div', null, `消息数：${dry.messages.toLocaleString()}`),
            h('div', null, `交接包大小：${(dry.size / 1024).toFixed(1)} KB`),
            h('div', null, `交接包最多采样 ${dry.k} 轮；新日志收敛为 1 轮交接记录`),
            dry.canReset === false && h('p', { role: 'alert' }, `当前不可重置：${dry.blockedReason}`),
          ),
          recoveryError && h('p', { role: 'alert', 'data-reset-recovery-error': true }, recoveryError),
          recovery && (recovery.operations.length > 0 || recovery.issues.length > 0 || recovery.warnings.length > 0) && h('section', { 'data-reset-recovery': true },
            h('b', null, recovery.operations.length || recovery.issues.length ? '存在未完成的重置' : '历史记录提示'),
            recovery.operations.length > 0 && h('p', null, '恢复前会校验原件，并先保留原位可能已有的新内容。请输入下方短ID后明确选择恢复。'),
            recovery.warnings.slice(0, 5).map((warning, index) => h('p', { key: `warning-${index}`, role: 'status' }, warning)),
            recovery.issues.map((issue, index) => h('p', { key: index, role: 'alert' }, issue)),
            recovery.operations.map((operation) => h('div', { key: operation.operationId },
              h('p', null, `操作 ${operation.operationId} · ${operation.createdAt}`),
              h(Button, { variant: 'outline', disabled: executing || recovering || modelLoading || recovery.operations.length !== 1 || confirmText.trim() !== shortId, onClick: () => recover(operation.operationId) }, recovering ? '正在恢复…' : '恢复原日志'),
            )),
          ),
          !result && dry && h('div', { 'data-inplace-reset-model': true, style: { margin: '16px 0' } },
            h(Button, { variant: 'outline', disabled: loading || executing || recovering || modelLoading, onClick: previewModel }, modelLoading ? '正在筛选并核对…' : '模型筛选预览'),
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
          (!result || !!recovery?.operations.length) && h(React.Fragment, null,
            h('p', null, recoveryOnly ? '恢复会先保留原位的新内容，再按摘要校验原日志。' : '重置前会验证完整历史备份。正在运行或无法安全释放的会话会拒绝操作。'),
            h('label', { htmlFor: 'inplace-reset-confirm' }, `输入 ${shortId} 确认所选会话`),
            h('input', {
              id: 'inplace-reset-confirm',
              value: confirmText,
              onChange: (event                                          ) => setConfirmText(event.target.value),
              autoComplete: 'off',
              disabled: loading || executing || modelLoading || recovering,
              style: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, padding: 8, color: 'inherit', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 },
            }),
          ),
          result && h('div', { role: result.phase === 'NOT_RESET' ? 'alert' : 'status', 'data-inplace-reset-result': result.phase },
            h('b', null, result.phase === 'DONE' ? '重置已完成并校验' : result.phase === 'RECOVERED' ? '原日志已恢复并校验' : '未重置'),
            result.phase === 'DONE' && h('p', { 'data-inplace-reset-after': true }, `原日志轮次：${result.before.totalTurns} → ${result.after.totalTurns}；事件数：${result.before.totalEvents} → ${result.after.totalEvents}`),
            result.phase === 'NOT_RESET' && h('p', null, result.note),
            result.phase !== 'NOT_RESET' && result.auditWarning && h('p', { role: 'alert' }, result.auditWarning),
            result.phase === 'DONE' && result.forkId && h('p', { style: { overflowWrap: 'anywhere' } }, `历史备份：${result.forkId}`),
          ),
        ),
      );
    }

    function RecoveryList({ onChoose, onClose }                                                         ) {
      const [view, setView] = React.useState                          (null);
      const [error, setError] = React.useState               (null);
      const [attempt, setAttempt] = React.useState(0);
      React.useEffect(() => {
        const controller = new AbortController();
        setError(null);
        setView(null);
        rpc                   ('sessionResetRecoveries', {}, controller.signal).then((value) => {
          if (!validRecovery(value)) throw new Error('恢复列表不可校验');
          if (!controller.signal.aborted) setView(value);
        }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
        return () => controller.abort();
      }, [attempt]);
      return h(Modal, { open: true, title: '恢复中断重置', onClose, closeLabel: '关闭', footer: h(Button, { variant: 'outline', onClick: () => setAttempt((value) => value + 1) }, '刷新列表') },
        h('div', { 'data-reset-recoveries-list': true },
          !view && !error && h('p', { role: 'status' }, '正在读取恢复记录…'),
          error && h('p', { role: 'alert' }, error),
          view && h(React.Fragment, null,
            !view.operations.length && !view.issues.length && h('p', null, '没有待恢复的重置。'),
            view.issues.map((issue, index) => h('p', { key: index, role: 'alert' }, issue)),
            view.warnings.slice(0, 5).map((warning, index) => h('p', { key: `warning-${index}` }, warning)),
            view.operations.map((operation) => h('div', { key: operation.operationId, style: { marginTop: 12 } },
              h('p', { style: { overflowWrap: 'anywhere' } }, `${operation.sessionId} · ${operation.createdAt}`),
              h(Button, { variant: 'outline', onClick: () => onChoose(operation.sessionId) }, '核对并恢复…'),
            )),
          ),
        ),
      );
    }

    function EvaluationSettings() {
      const [view, setView] = React.useState                               (null);
      const [apiBase, setApiBase] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      const [loading, setLoading] = React.useState(true);
      const [saving, setSaving] = React.useState(false);
      const [error, setError] = React.useState               (null);
      const [notice, setNotice] = React.useState               (null);
      const [attempt, setAttempt] = React.useState(0);
      const validView = (value                        ) => value && typeof value.apiBase === 'string' && Object.keys(value).every((key) => ['apiBase', 'configured', 'hasSavedKey', 'usingDefault', 'writable'].includes(key)) && ['configured', 'hasSavedKey', 'usingDefault', 'writable'].every((key) => typeof (value                                      )[key] === 'boolean');
      React.useEffect(() => {
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        rpc                        ('sessionResetEvaluationSettings', {}, controller.signal).then((value) => {
          if (!validView(value)) throw new Error('评估模型配置响应无效');
          if (!controller.signal.aborted) { setView(value); setApiBase(value.apiBase); }
        }).catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [attempt]);
      const save = async (event                      ) => {
        event.preventDefault();
        if (!view?.writable || loading || saving || !apiBase.trim() || (!apiKey.trim() && !view.hasSavedKey)) return;
        setSaving(true);
        setError(null);
        setNotice(null);
        try {
          const value = await rpc                        ('sessionResetSaveEvaluationSettings', { request: { apiBase: apiBase.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } });
          if (!validView(value)) throw new Error('保存结果无效，请重新读取配置');
          setView(value);
          setApiBase(value.apiBase);
          setApiKey('');
          setNotice('已保存，将用于下一次评估。');
        } catch (reason) { setError(errorMessage(reason)); }
        finally { setSaving(false); }
      };
      const inputStyle                           = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 };
      return h('section', { 'data-evaluation-settings': true, 'aria-busy': loading || saving, style: { maxWidth: 720, marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--dsw-alias-border-l3)' } },
        h('h3', { style: { margin: '0 0 8px' } }, '评估模型'),
        h('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, '用于采样质量评估，使用 typesafe-ai/jev 评估协议。'),
        loading && h('p', { role: 'status' }, '正在读取配置…'),
        error && h('p', { role: 'alert' }, error),
        !loading && !view && h(Button, { variant: 'outline', onClick: () => setAttempt((value) => value + 1) }, '重新读取配置'),
        view && h('form', { onSubmit: save, style: { display: 'flex', flexDirection: 'column', gap: 10 } },
          h('label', { htmlFor: 'evaluation-api-base' }, 'API Base'),
          h('input', { id: 'evaluation-api-base', type: 'url', value: apiBase, maxLength: 2048, disabled: saving || !view.writable, placeholder: 'https://ai-gateway.vercel.sh', autoComplete: 'off', onChange: (event                                          ) => { setApiBase(event.target.value); setNotice(null); }, style: inputStyle }),
          h('small', null, '仅填域名会补全 /v4/ai/evaluation-model；也可填写完整评估接口地址。'),
          h('label', { htmlFor: 'evaluation-api-key' }, 'API Key'),
          h('input', { id: 'evaluation-api-key', type: 'password', value: apiKey, maxLength: 16384, disabled: saving || !view.writable, placeholder: view.hasSavedKey ? '已保存，留空保留现有 Key' : '首次保存请填写 API Key', autoComplete: 'new-password', spellCheck: false, onChange: (event                                          ) => { setApiKey(event.target.value); setNotice(null); }, style: inputStyle }),
          h('small', { 'data-evaluation-key-status': true }, view.hasSavedKey ? 'API Key 已保存，不回显；更换服务域名时请重新填写。' : view.configured ? '当前使用现有默认凭证；保存自定义配置时请填写 Key。' : '尚未配置 API Key。'),
          !view.writable && h('p', { role: 'alert' }, '当前环境没有可写的凭证存储。'),
          notice && h('p', { role: 'status', 'data-evaluation-saved': true }, notice),
          h(Button, { type: 'submit', variant: 'primary', disabled: saving || !view.writable || !apiBase.trim() || (!apiKey.trim() && !view.hasSavedKey) }, saving ? '正在保存…' : '保存评估模型配置'),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx               ) {
        let target                       = null;
        try {
          const saved = JSON.parse(window.sessionStorage.getItem(completedKey) ?? 'null');
          if (saved?.completed && isSuccess(saved.completed, saved.sessionId)) target = saved;
        } catch { /* An unavailable browser store must not block plugin activation. */ }
        const listeners = new Set            ();
        const publish = (next                      ) => {
          try { window.sessionStorage.removeItem(completedKey); } catch {}
          target = next;
          for (const listener of listeners) listener();
        };
        const subscribe = (listener            ) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
        const snapshot = () => target;

        function ResetMenuItem({ sessionId, displayTitle, useMenuOpenState }           ) {
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
          if (!request) return null;
          if ('kind' in request) return h(RecoveryList, { onChoose: (id) => publish({ sessionId: id, displayTitle: `中断重置 · ${id.slice(8, 16)}`, recoveryOnly: true }), onClose: () => publish(null) });
          return h(ResetDialog, { ...request, key: request.recoveryOnly ? `${request.sessionId}/recovery` : request.sessionId, onClose: () => publish(null) });
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
        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: '@local/dsh-session-inplace-reset/recoveries', order: 100,
        }, ({ wide }                   ) => h(Button, { type: 'button', variant: 'ghost', title: '恢复中断重置', 'aria-label': '恢复中断重置', 'data-reset-recoveries-entry': true, onClick: () => publish({ kind: 'recoveries' }) }, wide ? '恢复重置' : '↶'))), 'session-reset: global recovery entry');
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
