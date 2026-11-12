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
    const previewPhases                                                       = { preparing: '准备材料', inventory: '梳理全局任务', resolution: '核对任务闭环与撤销', selection: '并行筛选', audit: '并行核对', repair: '保守候选复核', aggregation: '汇总结果', complete: '评估结束' };
    const contextSummary = (report             ) => ({ goal: report.continuation?.goal ?? '', task: report.continuation?.entries.filter((entry) => entry.kinds.includes('task')).length ?? 0, constraint: report.continuation?.entries.filter((entry) => entry.kinds.includes('constraint')).length ?? 0, change: report.continuation?.entries.filter((entry) => entry.kinds.includes('change')).length ?? 0 });
    const topicPhases = { preparing: '读取会话模型', topics: '分析候选主题', merging: '汇总主题', complete: '主题分析结束' };
    const modelLabel = (value                       ) => `${value.provider} / ${value.model}${value.reasoningEffort ? ` · ${value.reasoningEffort}` : ''}`;
    const checkLabels                         = { constraints: '目标与约束', state: '任务状态与纠正', faithful: '角色、来源与事实边界' };

    async function rpc         (method        , args        , signal              )             {
      const endpoint = method.includes('/') ? method : `sessionReset/${method}`;
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
      const [presets, setPresets] = React.useState                         (null);
      const [presetError, setPresetError] = React.useState               (null);
      const [agentPreset, setAgentPreset] = React.useState('');
      const [presetAttempt, setPresetAttempt] = React.useState(0);
      const [model, setModel] = React.useState                    (null);
      const [continuationGoal, setContinuationGoal] = React.useState('');
      const [selectedTopics, setSelectedTopics] = React.useState          ([]);
      const [selectedModel, setSelectedModel] = React.useState                    (null);
      const [modelLoading, setModelLoading] = React.useState(false);
      const [modelError, setModelError] = React.useState               (null);
      const [modelTask, setModelTask] = React.useState                        (null);
      const modelRequest = React.useRef                        (null);
      const [topicTask, setTopicTask] = React.useState                      (null);
      const [topicLoading, setTopicLoading] = React.useState(false);
      const [topicError, setTopicError] = React.useState               (null);
      const topicRequest = React.useRef                        (null);
      const topicOptions = React.useRef                            (null);
      const readyTopics = topicTask?.report?.status === 'ready' ? topicTask.taskId : '';
      React.useEffect(() => { if (readyTopics) topicOptions.current?.scrollIntoView({ block: 'nearest' }); }, [readyTopics]);
      const [recovery, setRecovery] = React.useState                     (null);
      const [recoveryAttempt, setRecoveryAttempt] = React.useState(0);
      const [recoveryError, setRecoveryError] = React.useState               (null);
      const [recovering, setRecovering] = React.useState(false);
      const recoveryReady = !!recovery && !recovery.operations.length && !recovery.issues.length;
      React.useEffect(() => () => { modelRequest.current?.abort(); topicRequest.current?.abort(); }, []);
      const shortId = sessionId.slice(8, 16);
      const close = () => { if (!executing && !recovering) onClose(); };
      const useGoal = (value        , topicIds           = []) => { setContinuationGoal(value); setSelectedTopics(topicIds); setModel(null); setSelectedModel(null); setModelTask(null); setConfirmText(''); };
      const acceptTopics = (value               , taskId         ) => {
        const p = value?.progress;
        if (value?.sessionId !== sessionId || taskId && value.taskId !== taskId || !/^[a-f0-9-]{36}$/i.test(value.taskId ?? '') || typeof value.running !== 'boolean' || !value.model || typeof value.model.provider !== 'string' || !value.model.provider || typeof value.model.model !== 'string' || !value.model.model || !['session', 'default'].includes(value.modelSource) || !p || !Object.hasOwn(topicPhases, p.phase) || !(['completedBatches', 'totalBatches', 'running', 'concurrency', 'requests']         ).every((key) => Number.isSafeInteger(p[key]) && p[key] >= 0) || p.completedBatches > p.totalBatches || p.running > p.concurrency || p.concurrency < 1 || p.concurrency > 4) throw new Error('主题分析数据不完整或不属于所选会话');
        if (value.error) throw new Error(value.error);
        const report = value.report;
        if (report && (report.sessionId !== sessionId || !/^[a-f0-9]{64}$/.test(report.sourceHash) || !['ready', 'unavailable'].includes(report.status) || !Array.isArray(report.topics) || report.topics.length > 3 || !report.topics.every((topic) => typeof topic.id === 'string' && typeof topic.title === 'string' && typeof topic.goal === 'string' && topic.goal.length <= 2000 && Array.isArray(topic.evidence) && topic.evidence.length > 0 && topic.evidence.every((item) => typeof item.quote === 'string' && Number.isSafeInteger(item.seq))) || !Number.isSafeInteger(report.coverage?.assessed) || !Number.isSafeInteger(report.coverage?.total) || report.coverage.assessed < 0 || report.coverage.assessed > report.coverage.total)) throw new Error('候选主题或引用来源不可校验');
        return value;
      };
      const previewTopics = async () => {
        if (!dry || executing || recovering || modelLoading || topicLoading) return;
        const controller = new AbortController(); topicRequest.current = controller;
        setTopicLoading(true); setTopicError(null); setTopicTask(null); setSelectedTopics([]); setConfirmText('');
        try {
          let task = acceptTopics(await rpc               ('sessionResetTopicPreviewStart', { sessionId }, controller.signal));
          const taskId = task.taskId;
          if (!controller.signal.aborted) setTopicTask(task);
          while (task.running) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            if (controller.signal.aborted) return;
            task = acceptTopics(await rpc               ('sessionResetTopicPreviewStatus', { request: { sessionId, taskId } }, controller.signal), taskId);
            if (!controller.signal.aborted) setTopicTask(task);
          }
          if (!task.report) throw new Error('未收到完整的主题分析');
        } catch (reason) { if (!controller.signal.aborted) setTopicError(errorMessage(reason)); }
        finally { if (!controller.signal.aborted) setTopicLoading(false); }
      };
      const chooseTopic = async (topicId        , checked         ) => {
        if (!topicTask || topicLoading || modelLoading || executing || recovering) return;
        const controller = new AbortController(); topicRequest.current = controller;
        setTopicLoading(true); setTopicError(null);
        try {
          const value = acceptTopics(await rpc               ('sessionResetTopicPreviewStatus', { request: { sessionId, taskId: topicTask.taskId } }, controller.signal), topicTask.taskId);
          const topics = value.report?.status === 'ready' ? value.report.topics : [];
          if (!topics.some((item) => item.id === topicId) || value.running) throw new Error('候选主题已变化，请重新分析');
          const wanted = new Set(checked ? [...selectedTopics, topicId] : selectedTopics.filter((id) => id !== topicId));
          const picked = topics.filter((item) => wanted.has(item.id));
          if (picked.length !== wanted.size) throw new Error('部分已选主题已变化，请重新分析');
          const goal = picked.length === 1 ? picked[0].goal : picked.map((item, index) => `${index + 1}. ${item.title}\n${item.goal}`).join('\n\n');
          if (goal.length > 2000) throw new Error('合并目标超过2000字，请减少主题或手动编辑；未截断目标');
          if (!controller.signal.aborted) { setTopicTask(value); useGoal(goal, picked.map((item) => item.id)); }
        } catch (reason) { if (!controller.signal.aborted) setTopicError(errorMessage(reason)); }
        finally { if (!controller.signal.aborted) setTopicLoading(false); }
      };

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
        if (completed || recoveryOnly) return;
        const controller = new AbortController();
        setPresetError(null);
        rpc                               ('agentPresets/list', {}, controller.signal).then((value) => {
          if (!Array.isArray(value?.presets) || !value.presets.every((row) => typeof row.id === 'string' && !!row.id && typeof row.isDefault === 'boolean' && (row.name === undefined || typeof row.name === 'string') && (row.broken === undefined || typeof row.broken === 'string'))) throw new Error('Agent预设列表不可校验');
          if (!controller.signal.aborted) setPresets(value.presets);
        }).catch((reason) => { if (!controller.signal.aborted) setPresetError(errorMessage(reason)); });
        return () => controller.abort();
      }, [sessionId, presetAttempt, recoveryOnly, completed]);

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
        if (executing || recovering || modelLoading || topicLoading || confirmText.trim() !== shortId) return;
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
        if (!dry || executing || recovering || modelLoading || topicLoading) return;
        const controller = new AbortController();
        modelRequest.current = controller;
        setModelLoading(true);
        setModel(null);
        setSelectedModel(null);
        setModelError(null);
        setModelTask(null);
        try {
          let task = await rpc                 ('sessionResetModelPreviewStartWithGoal', { request: { sessionId, continuationGoal } }, controller.signal);
          const taskId = task?.taskId;
          const acceptTask = (value                 ) => {
            const p = value?.progress;
            if (value?.sessionId !== sessionId || value.taskId !== taskId || !/^[a-f0-9-]{36}$/i.test(taskId ?? '') || typeof value.running !== 'boolean' || !Number.isFinite(Date.parse(value.startedAt)) || !p || !Object.hasOwn(previewPhases, p.phase) || !(['completedBatches', 'totalBatches', 'running', 'concurrency', 'requestCount', 'requestLimit', 'assessed', 'sourceTotal']         ).every((key) => Number.isSafeInteger(p[key]) && p[key] >= 0) || p.completedBatches > p.totalBatches || p.running > p.concurrency || p.concurrency < 1 || p.concurrency > 4 || p.requestCount > p.requestLimit || p.assessed > p.sourceTotal) throw new Error('评估进度不完整或不属于所选任务');
            if (!controller.signal.aborted) setModelTask(value);
          };
          acceptTask(task);
          while (task.running) {
            await new Promise((resolve) => setTimeout(resolve, 800));
            if (controller.signal.aborted) return;
            task = await rpc                 ('sessionResetModelPreviewStatus', { request: { sessionId, taskId } }, controller.signal);
            acceptTask(task);
          }
          if (task.error) throw new Error(task.error);
          const value = task.report;
          if (!value) throw new Error('评估已结束但未收到完整报告，请重新预览');
          if (value?.sessionId !== sessionId || typeof value.reportId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.reportId) || !/^[a-f0-9]{64}$/.test(value.sourceHash) || value.mode !== 'shadow' || value.applied !== false || !['pass', 'fail', 'pending', 'unavailable'].includes(value.status) || !Array.isArray(value.selected) || !Array.isArray(value.checks) || !Number.isSafeInteger(value.coverage?.assessed) || !Number.isSafeInteger(value.coverage?.total) || value.coverage.assessed < 0 || value.coverage.total < value.coverage.assessed) throw new Error('模型预览数据不完整或不属于所选会话');
          if (!value.selected.every((item) => typeof item?.text === 'string' && typeof item.id === 'string' && Number.isSafeInteger(item.seq)) || !value.checks.every((check) => ['constraints', 'state', 'faithful'].includes(check?.key) && Number.isFinite(check.probability) && check.probability >= 0 && check.probability <= 1 && ['pass', 'fail', 'pending'].includes(check.outcome))) throw new Error('模型预览的原文或核对项无效');
          const context = value.continuation;
          if (!context || context.scopeOnly !== true || typeof context.goal !== 'string' || !/^[a-f0-9]{64}$/.test(context.hash) || !Array.isArray(context.entries) || !context.entries.every((entry) => typeof entry.candidate?.id === 'string' && typeof entry.candidate.text === 'string' && Number.isSafeInteger(entry.candidate.seq) && Array.isArray(entry.kinds) && entry.kinds.every((kind) => ['task', 'constraint', 'change'].includes(kind)))) throw new Error('缺少可校验的续接目标或全局任务清单');
          if (value.status === 'pass' && (!context.coverage.complete || !context.resolutionComplete || context.uncertain || context.overflow)) throw new Error('全局任务清单未完整核对，不能显示通过');
          if (value.status === 'pass' && (value.auditComplete !== true || !value.coverage.complete || value.budgetOmissions && value.budgetOmissions > 0 || !value.selected.length || new Set(value.checks.map((check) => check.key)).size !== 3 || !value.checks.every((check) => check.outcome === 'pass' && check.probability >= 0.7))) throw new Error('未收到完整的模型核对，不能显示通过');
          if (!controller.signal.aborted) setModel(value);
        } catch (reason) {
          if (!controller.signal.aborted) setModelError(errorMessage(reason));
        } finally {
          if (!controller.signal.aborted) setModelLoading(false);
        }
      };

      const execute = async () => {
        if (!dry || dry.canReset === false || !recoveryReady || loading || executing || modelLoading || topicLoading || recovering || confirmText.trim() !== shortId) return;
        setExecuting(true);
        setError(null);
        try {
          const value = await rpc(selectedModel ? 'sessionResetExecuteModel' : 'sessionResetExecute', {
            request: { sessionId, confirmShortId: confirmText.trim(), ...(agentPreset ? { agentPreset } : {}), ...(selectedModel ? { modelReportId: selectedModel.reportId, sourceHash: selectedModel.sourceHash, continuationGoal: selectedModel.continuation .goal } : {}) },
          });
          if (!isSuccess(value, sessionId) || value.phase !== 'DONE' || agentPreset && value.after?.agentPreset !== agentPreset || selectedModel && (value.handoffMode !== 'model' || value.modelReportId !== selectedModel.reportId || value.modelSourceHash !== selectedModel.sourceHash)) {
            setResult({ phase: 'NOT_RESET', note: value?.reason ?? value?.note ?? '未收到重置成功的读回校验，不能判定完成', forkId: value?.forkId });
            return;
          }
          setResult(value);
          setDry(null);
          try {
            const { ok, phase, verified, sameId, sessionId: id, before, after, forkId, operationId, auditWarning, handoffMode, modelReportId, modelSourceHash, memory } = value;
            window.sessionStorage.setItem(completedKey, JSON.stringify({ sessionId: id, displayTitle, completed: { ok, phase, verified, sameId, sessionId: id, before, after, forkId, operationId, auditWarning, handoffMode, modelReportId, modelSourceHash, memory } }));
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
            disabled: !dry || dry.canReset === false || !recoveryReady || loading || executing || modelLoading || topicLoading || recovering || confirmText.trim() !== shortId,
            onClick: execute,
          }, executing ? (selectedModel ? '正在应用候选…' : '正在备份…') : selectedModel ? '应用候选并重置' : '备份并重置'),
        ),
      },
        h('div', { 'data-inplace-reset-session': sessionId, 'aria-busy': loading || executing || recovering || modelLoading || topicLoading, style: { maxHeight: '65vh', overflowY: 'auto', paddingRight: 4 } },
          h('p', { style: { marginTop: 0, overflowWrap: 'anywhere' } }, displayTitle || '未命名会话'),
          h('code', { style: { fontSize: 12, overflowWrap: 'anywhere' } }, sessionId),
          loading && h('p', { role: 'status' }, '正在读取该会话的预览…'),
          error && h('p', { role: 'alert' }, error),
          !result && !recoveryOnly && !loading && !dry && h(Button, { variant: 'outline', onClick: () => setAttempt((n) => n + 1) }, '重新读取预览'),
          dry && h('div', { 'data-inplace-reset-stats': true, style: { margin: '16px 0' } },
            h('div', null, `原日志轮次：${Number.isSafeInteger(dry.totalTurns) ? dry.totalTurns.toLocaleString() : '未提供'}`),
            h('div', null, `事件数：${dry.totalEvents.toLocaleString()}`),
            h('div', null, `消息数：${dry.messages.toLocaleString()}`),
            h('div', null, `交接包大小：${((selectedModel?.size ?? dry.size) / 1024).toFixed(1)} KB`),
            h('div', null, selectedModel ? `已选模型候选 ${selectedModel.selected.length} 个片段；新日志收敛为 1 轮交接记录` : `交接包最多采样 ${dry.k} 轮；新日志收敛为 1 轮交接记录`),
            dry.canReset === false && h('p', { role: 'alert' }, `当前不可重置：${dry.blockedReason}`),
          ),
          !result && !recoveryOnly && dry && h('section', { 'data-inplace-reset-preset': true, style: { margin: '16px 0' } },
            h('label', { htmlFor: 'inplace-reset-agent-preset' }, '重生后的 Agent 预设'),
            h('select', { id: 'inplace-reset-agent-preset', value: agentPreset, disabled: executing || recovering || modelLoading || !presets, onChange: (event                                           ) => { setAgentPreset(event.target.value); setConfirmText(''); }, style: { display: 'block', width: '100%', marginTop: 6, padding: 8, color: 'inherit', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 } },
              h('option', { value: '' }, `沿用原预设${dry.agentPreset ? `（${presets?.find((row) => row.id === dry.agentPreset)?.name ?? dry.agentPreset}）` : '（原会话未指定，使用宿主默认）'}`),
              presets?.map((row) => h('option', { key: row.id, value: row.id, disabled: row.broken !== undefined }, `${row.name ?? row.id}${row.name && row.name !== row.id ? ` (${row.id})` : ''}${row.isDefault ? ' · 默认' : ''}${row.broken !== undefined ? ' · 不可用' : ''}`)),
            ),
            h('p', { style: { fontSize: 12 } }, '预设决定重生后的工具和工作方式。历史备份保留原预设，失败恢复原会话。'),
            agentPreset && h('p', { 'data-inplace-reset-preset-choice': agentPreset }, `已选择：${presets?.find((row) => row.id === agentPreset)?.name ?? agentPreset}`),
            presetError && h(React.Fragment, null, h('p', { role: 'alert' }, `预设列表读取失败：${presetError}。可继续沿用原预设。`), h(Button, { variant: 'outline', onClick: () => setPresetAttempt((value) => value + 1) }, '重读预设列表')),
          ),
          recoveryError && h('p', { role: 'alert', 'data-reset-recovery-error': true }, recoveryError),
          recovery && (recovery.operations.length > 0 || recovery.issues.length > 0 || recovery.warnings.length > 0) && h('section', { 'data-reset-recovery': true },
            h('b', null, recovery.operations.length || recovery.issues.length ? '存在未完成的重置' : '历史记录提示'),
            recovery.operations.length > 0 && h('p', null, '恢复前会校验原件，并先保留原位可能已有的新内容。请输入下方短ID后明确选择恢复。'),
            recovery.warnings.slice(0, 5).map((warning, index) => h('p', { key: `warning-${index}`, role: 'status' }, warning)),
            recovery.issues.map((issue, index) => h('p', { key: index, role: 'alert' }, issue)),
            recovery.operations.map((operation) => h('div', { key: operation.operationId },
              h('p', null, `操作 ${operation.operationId} · ${operation.createdAt}`),
              h(Button, { variant: 'outline', disabled: executing || recovering || modelLoading || topicLoading || recovery.operations.length !== 1 || confirmText.trim() !== shortId, onClick: () => recover(operation.operationId) }, recovering ? '正在恢复…' : '恢复原日志'),
            )),
          ),
          !result && dry && h('div', { 'data-inplace-reset-model': true, style: { margin: '16px 0' } },
            h('section', { 'data-inplace-reset-topics': true, style: { marginBottom: 16, padding: 12, border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8 } },
              h('b', null, '候选续接主题'),
              (topicTask?.model ?? dry.topicModel?.selection) && h('p', { 'data-inplace-reset-topic-model': true, style: { fontSize: 12, overflowWrap: 'anywhere' } }, `主题分析模型：${modelLabel(topicTask?.model ?? dry.topicModel .selection)}${(topicTask?.modelSource ?? dry.topicModel?.source) === 'default' ? '（会话沿用宿主默认）' : '（本会话已选模型）'}`),
              h(Button, { variant: 'outline', disabled: loading || executing || recovering || modelLoading || topicLoading, onClick: previewTopics }, topicLoading ? '正在分析主题…' : topicTask?.report ? '检查并更新候选主题' : '使用本会话模型分析主题'),
              h('p', { style: { fontSize: 12 } }, '先由当前会话模型提出带原文引用的主题，选择后填写下方目标；只做分析，不运行历史命令。'),
              topicLoading && topicTask && h('div', { 'data-inplace-reset-topic-progress': topicTask.progress.phase, role: 'status', 'aria-live': 'polite' },
                h('p', null, `${topicPhases[topicTask.progress.phase]} · ${topicTask.progress.completedBatches} / ${topicTask.progress.totalBatches} 批 · 并行 ${topicTask.progress.running} / ${topicTask.progress.concurrency}`),
                h('progress', { 'aria-label': '候选主题分析进度', max: Math.max(1, topicTask.progress.totalBatches), value: topicTask.progress.totalBatches ? topicTask.progress.completedBatches : undefined, style: { width: '100%' } }),
              ),
              topicError && h('p', { role: 'alert' }, topicError),
              topicTask?.report && h('div', { 'data-inplace-reset-topic-result': topicTask.report.status },
                topicTask.report.status === 'unavailable' && h('p', { role: 'alert' }, `主题分析未成功，暂无可选主题。${topicTask.report.note}`),
                topicTask.report.status === 'ready' && !topicTask.report.topics.length && h('p', { role: 'status' }, '本次未识别到有依据的主题，可直接填写续接目标。'),
                topicTask.report.topics.length > 0 && h('fieldset', { ref: topicOptions, 'data-inplace-reset-topic-options': true, disabled: topicLoading || modelLoading || executing || recovering, style: { margin: '12px 0', padding: 8, border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 } },
                  h('legend', { 'data-inplace-reset-topic-count': topicTask.report.topics.length }, `已生成 ${topicTask.report.topics.length} 个候选主题，可多选`),
                  topicTask.report.topics.map((topic, index) => h('label', { key: topic.id, 'data-inplace-reset-topic-option': topic.id, style: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 4px', cursor: 'pointer', overflowWrap: 'anywhere' } },
                    h('input', { type: 'checkbox', value: topic.id, checked: selectedTopics.includes(topic.id), onChange: (event                                          ) => chooseTopic(topic.id, event.target.checked), style: { marginTop: 4, flexShrink: 0 } }),
                    h('span', null, `${index + 1}. ${topic.title}`),
                  )),
                ),
                topicTask.report.topics.length > 0 && h('p', { 'data-inplace-reset-selected-topic-count': selectedTopics.length, style: { fontSize: 12 } }, `已选 ${selectedTopics.length} 个主题；按列表顺序合并到续接目标。取消全部恢复默认范围，手动编辑目标会清除勾选。`),
                h('small', null, `主题材料 ${topicTask.report.coverage.assessed} / ${topicTask.report.coverage.total} 个片段`),
                !topicTask.report.coverage.complete && h('p', null, '部分主题材料未覆盖，候选不代表完整会话主题。'),
                topicTask.report.topics.filter((topic) => selectedTopics.includes(topic.id)).map((topic) => h('article', { key: topic.id, 'data-inplace-reset-topic': topic.id, style: { paddingTop: 10, marginTop: 10, borderTop: '1px solid var(--dsw-alias-border-l3)' } },
                  h('b', null, `已选：${topic.title}`), h('p', null, topic.goal),
                  h('details', null, h('summary', null, '查看主题来源原文'), topic.evidence.map((item, index) => h('div', { key: index }, h('small', null, `事件 #${item.seq} · ${item.historical ? '历史引用' : item.role}${item.truncated ? ' · 原文节选' : ''}`), h('blockquote', { style: { margin: '6px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 } }, item.quote)))),
                )),
                h('details', { style: { marginTop: 8 } }, h('summary', null, '查看分析范围与说明'), h('p', { style: { fontSize: 12 } }, topicTask.report.note)),
              ),
            ),
            h('label', { htmlFor: 'inplace-reset-continuation-goal' }, '续接目标'),
            h('textarea', { id: 'inplace-reset-continuation-goal', value: continuationGoal, maxLength: 2000, rows: selectedTopics.length > 1 ? 6 : 2, placeholder: '留空：接续全部未完成任务，保留持续约束与有效纠正', disabled: executing || recovering || modelLoading || topicLoading, onChange: (event                                             ) => useGoal(event.target.value), style: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, padding: 8, color: 'inherit', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 } }),
            h('p', { style: { fontSize: 12 } }, '此目标决定模型筛选范围；其他主题的未完成任务和持续约束也会保留。修改目标后需重新预览，筛选目标不增加操作授权。'),
            h(Button, { variant: 'outline', disabled: loading || executing || recovering || modelLoading || topicLoading, onClick: previewModel }, modelLoading ? '正在筛选并核对…' : '模型筛选预览'),
            h('p', { style: { fontSize: 12 } }, '预览先不修改会话。通过检查后可明确选用这份候选；未选择时使用近期采样。'),
            h('p', { style: { fontSize: 12 } }, '先梳理全局清单再并行筛选，最多64批、192次请求；每阶段最多4个请求并行，完成即停止。'),
            modelLoading && !modelTask && h('p', { role: 'status' }, '正在准备材料并拆分批次…'),
            modelLoading && modelTask && h('section', { 'data-inplace-reset-progress': modelTask.progress.phase, role: 'status', 'aria-live': 'polite', style: { padding: 12, margin: '12px 0', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8 } },
              h('b', null, previewPhases[modelTask.progress.phase]),
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, margin: '8px 0', fontSize: 12 } },
                h('span', null, `本阶段完成 ${modelTask.progress.completedBatches} / ${modelTask.progress.totalBatches} 批`),
                h('span', { 'data-inplace-reset-parallel': modelTask.progress.running }, `并行 ${modelTask.progress.running} / ${modelTask.progress.concurrency}`),
              ),
              h('progress', { 'aria-label': `${previewPhases[modelTask.progress.phase]}批次进度`, max: Math.max(1, modelTask.progress.totalBatches), value: modelTask.progress.totalBatches ? modelTask.progress.completedBatches : undefined, style: { width: '100%', height: 8 } }),
              h('p', { style: { fontSize: 12, marginBottom: 0 } }, `已梳理 ${modelTask.progress.catalogued ?? 0} / ${modelTask.progress.sourceTotal} 个片段 · 已评分 ${modelTask.progress.assessed} 个 · 已用 ${modelTask.progress.requestCount} / ${modelTask.progress.requestLimit} 次请求 · 已用时 ${Math.max(0, Math.floor((Date.now() - Date.parse(modelTask.startedAt)) / 1000))} 秒`),
            ),
            modelLoading && h('p', { style: { fontSize: 12 } }, '关闭窗口后评估会继续；来源和配置未变时，再次预览可接回当前任务。'),
            modelError && h('p', { role: 'alert' }, modelError),
            model && h('div', { 'data-inplace-reset-model-status': model.status, 'data-inplace-reset-model-report': model.reportId, role: 'status' },
              h('b', null, ({ pass: '送评材料内检查通过', fail: '预览未通过', pending: '预览待核验', unavailable: '模型未评估' })[model.status]),
              h('p', null, `送评 ${model.coverage.assessed} / ${model.coverage.total} 个文本片段；保留 ${model.selected.length} 个${model.size ? `；交接包 ${(model.size / 1024).toFixed(1)} KB` : ''}`),
              h('section', { 'data-inplace-reset-continuation': contextSummary(model).goal, style: { margin: '12px 0' } },
                h('b', null, '本次续接依据'),
                h('p', { 'data-inplace-reset-goal': true }, model.continuation .goal),
                h('p', null, `清单梳理 ${model.continuation .coverage.assessed} / ${model.continuation .coverage.total} 个片段；任务 ${contextSummary(model).task} · 约束 ${contextSummary(model).constraint} · 纠正/状态变更 ${contextSummary(model).change}`),
                h('small', null, '状态为模型推断。清单原文优先保留，不把闭环判断当独立验证。'),
                (model.continuation .uncertain || model.continuation .overflow) && h('p', { role: 'alert' }, model.continuation .overflow ? '清单超过共享预算，未截断原文，不能应用。' : '任务分类或闭环状态存在待核验项，不能应用。'),
                h('details', null, h('summary', null, '查看任务、约束与纠正的原文依据'),
                  h('div', { style: { maxHeight: 240, overflow: 'auto' } }, model.continuation .entries.map((entry) => h('div', { key: entry.candidate.id, style: { marginTop: 10 } },
                    h('small', null, `${entry.kinds.map((kind) => ({ task: '任务', constraint: '约束', change: '纠正/变更' })[kind]).join('、')} · 事件 #${entry.candidate.seq} · ${entry.candidate.historical ? '历史引用' : entry.candidate.role} · ${entry.candidate.id}`),
                    entry.resolved && h('p', { style: { fontSize: 12 } }, entry.resolved.outcome === 'pass' ? '模型推断可能已闭环/撤销；原文仍保留' : entry.resolved.outcome === 'pending' ? '闭环/撤销状态待核验' : '未发现充分闭环/撤销依据'),
                    h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12 } }, entry.candidate.text),
                  ))),
                ),
              ),
              !!model.batchCount && h('p', null, `筛选 ${model.batchCount} 批，核对 ${model.auditAttempts?.reduce((sum, attempt) => sum + (attempt.batches?.length ?? 0), 0) ?? 0} 批；使用 ${model.requestCount} 次请求${model.concurrency ? `；并行峰值 ${model.peakConcurrency ?? 0} / ${model.concurrency}` : ''}。`),
              !model.coverage.complete && h('p', null, '存在未送评文本，不能视为完整覆盖。'),
              (model.budgetOmissions ?? 0) > 0 && h('p', null, `体积预算另省略 ${model.budgetOmissions} 个待保留片段。`),
              h('ul', null, model.checks.map((check) => h('li', { key: check.key }, `${checkLabels[check.key] ?? check.key}：${({ pass: '通过', fail: '未通过', pending: '待核验' })[check.outcome]}（${model.batchCount && model.batchCount > 1 ? '最低批次P' : 'P'}=${Number(check.probability).toFixed(2)}）`))),
              model.strategy === 'conservative' && h('p', null, '本候选保守保留了全部送评原文，已重新核对；未改写原来的必要程度评分。'),
              h('p', { style: { fontSize: 12 } }, model.note),
              h(Button, { variant: 'outline', 'data-inplace-reset-use-model': true, 'aria-pressed': selectedModel?.reportId === model.reportId, disabled: model.status !== 'pass' || loading || executing || recovering || modelLoading || dry.canReset === false, onClick: () => setSelectedModel(model) }, selectedModel?.reportId === model.reportId ? '已选用此候选' : '本次使用模型候选'),
              selectedModel && h(Button, { variant: 'ghost', disabled: executing || recovering, onClick: () => setSelectedModel(null) }, '改用近期采样'),
              selectedModel && h('p', { role: 'status', 'data-inplace-reset-selected-model': selectedModel.reportId }, '本次重置将保存这份候选。请先查看原文及来源，再输入短ID确认。执行前会重新核对会话和评估配置。'),
              h('details', null,
                h('summary', null, '查看保留原文及来源'),
                h('div', { style: { maxHeight: 260, overflow: 'auto' } }, model.selected.map((item) => h('div', { key: item.id, style: { marginTop: 12 } },
                  h('small', null, `事件 #${item.seq} · ${item.historical ? '历史引用' : item.role === 'assistant' ? '助手陈述' : item.role === 'tool' ? '工具返回' : item.sourceKind === 'user' ? '用户消息' : '上下文消息'} · 片段 ${item.id}${item.retention === 'pending' || item.superseded === 'pending' ? ' · 保留待核验' : model.strategy === 'conservative' && item.retention === 'fail' ? ' · 保守保留原文' : ''}${item.superseded === 'pass' ? ' · 可能已被后续纠正，需对照来源' : ''}`),
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
              disabled: loading || executing || modelLoading || topicLoading || recovering,
              style: { display: 'block', width: '100%', boxSizing: 'border-box', marginTop: 6, padding: 8, color: 'inherit', background: 'var(--dsw-alias-bg-base)', border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 6 },
            }),
          ),
          result && h('div', { role: result.phase === 'NOT_RESET' ? 'alert' : 'status', 'data-inplace-reset-result': result.phase },
            h('b', null, result.phase === 'DONE' ? '重置已完成并校验' : result.phase === 'RECOVERED' ? '原日志已恢复并校验' : '未重置'),
            result.phase === 'DONE' && h('p', { 'data-inplace-reset-after': true }, `原日志轮次：${result.before.totalTurns} → ${result.after.totalTurns}；事件数：${result.before.totalEvents} → ${result.after.totalEvents}`),
            result.phase === 'DONE' && result.memory && Array.isArray(result.memory.warnings) && ['heapUsed', 'rss'].every((key) => Number.isFinite(result.memory?.before?.[key                            ]) && Number.isFinite(result.memory?.after?.[key                            ])) && h('div', { 'data-inplace-reset-memory': true },
              h('p', null, `同进程内存观测：堆 ${(result.memory.before.heapUsed / 1048576).toFixed(1)} → ${(result.memory.after.heapUsed / 1048576).toFixed(1)} MB；RSS ${(result.memory.before.rss / 1048576).toFixed(1)} → ${(result.memory.after.rss / 1048576).toFixed(1)} MB`),
              h('small', null, `已清理 ${result.memory.queryEntries + result.memory.persistenceEntries} 项读取缓存；${result.memory.gcCompleted ? '已请求运行时回收' : '等待自然回收'}。其他会话活动会影响进程总量。`),
              result.memory.warnings.map((warning, index) => h('p', { key: index, role: 'status' }, warning)),
            ),
            result.phase === 'NOT_RESET' && h('p', null, result.note),
            result.phase !== 'NOT_RESET' && result.auditWarning && h('p', { role: 'alert' }, result.auditWarning),
            result.phase === 'DONE' && result.handoffMode === 'model' && h('p', { 'data-inplace-reset-applied-model': result.modelReportId }, `交接来源：模型候选 ${result.modelReportId}`),
            result.phase === 'DONE' && result.after.agentPreset && h('p', { 'data-inplace-reset-after-preset': result.after.agentPreset }, `重生后的 Agent 预设：${result.after.agentPreset}`),
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
