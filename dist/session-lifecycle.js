// Host adapter for the installed AgentLoop/Cordis lifecycle shape. Unknown shapes fail before storage changes.
import { AsyncLocalStorage } from 'node:async_hooks';
export function createSessionLifecycle(ctx, symbols) {
    const raw = (value) => value?.[symbols.original] ?? value;
    const loop = raw(ctx.get('agentLoop'));
    const agents = ctx.get('agents');
    const sessions = ctx.get('sessions');
    const controller = raw(ctx.get('sessionController'));
    const locks = new Map();
    const scope = new AsyncLocalStorage();
    const undo = [];
    const idleWaiters = new Set();
    let closing = false;
    let disposed = false;
    function allowed(id) {
        if (locks.has(id) && scope.getStore() !== locks.get(id))
            throw new Error('该会话正在重置，请稍后重试');
    }
    // resolveAgent/resolveObservedAgent 的失败契约是结果值（{ error }）而非同步抛出：定时器
    // 上下文里的调用方（如 a2a reconcile 的 materialize）接不到同步异常，会击穿 timer 崩掉宿主
    // （dsh-open-a2a-net#756）。契约化后同步调用方拿到被拒绝的 Promise，走各自的退避策略。
    function guard(object, method, identify, resultFailure = false) {
        const previous = object?.[method];
        if (typeof previous !== 'function')
            return;
        const owned = Object.hasOwn(object, method);
        const wrapper = function (...args) {
            try {
                allowed(identify(args));
            }
            catch (error) {
                if (resultFailure)
                    return Promise.resolve({ error: { message: error.message } });
                throw error;
            }
            return previous.apply(this, args);
        };
        object[method] = wrapper;
        const restore = () => {
            if (object[method] !== wrapper)
                return;
            if (owned)
                object[method] = previous;
            else
                delete object[method];
        };
        undo.push(restore);
        return restore;
    }
    guard(loop, 'prepare', (args) => args[1]);
    guard(controller, 'prompt', (args) => args[0]?.sessionId);
    guard(controller, 'create', (args) => args[0]?.sessionId);
    guard(controller.agents, 'resolveAgent', (args) => args[0], true);
    guard(controller.agents, 'resolveObservedAgent', (args) => args[0]?.header?.id, true);
    function disposalOf(id, agent) {
        const fiber = loop?.runtime?.ctx?.fiber;
        const disposables = fiber?._disposables;
        if (!disposables?.[Symbol.iterator] || typeof fiber.getEffects !== 'function')
            throw new Error('宿主不提供已核验的单会话释放入口');
        const scopeLabel = `agentLoop.scope(${id})`;
        const scopes = [...disposables].filter((dispose) => dispose[symbols.effect]?.label === scopeLabel);
        const ownerFibers = [...new Set([controller?.ctx?.fiber, raw(controller?.agents)?.ctx?.fiber, raw(controller?.commands)?.ctx?.fiber, loop?.ctx?.fiber, fiber].filter(Boolean))];
        const ownerLabel = `agentLoop.lifecycle(${id})`;
        const owners = ownerFibers.flatMap((owner) => typeof owner.getEffects === 'function' && owner._disposables?.[Symbol.iterator] ? [...owner._disposables].filter((dispose) => dispose[symbols.effect]?.label === ownerLabel) : []);
        if (!agent) {
            if (sessions.get(id) || scopes.length)
                throw new Error('会话存在未归属的运行时，已停止重置');
            return owners.length ? async () => { for (const dispose of owners)
                await dispose(); } : null;
        }
        if (agent.status !== 'idle')
            throw new Error('会话正在运行，请先停止当前任务');
        if (agent.session?.header?.origin === 'subagent' || agent.session?.header?.delegationDepth > 0)
            throw new Error('子代理会话不支持原地重置');
        if (scopes.length !== 1 || !owners.length || raw(sessions.get(id)) !== raw(agent.session))
            throw new Error('无法唯一确认该会话的完整生命周期拥有者，已停止重置');
        // The outer lifecycle unregisters both ownership effects; disposing scope alone leaves the old Session retained.
        return async () => { for (const dispose of owners)
            await dispose(); };
    }
    return {
        inspect(id) {
            if (closing)
                return { canReset: false, blockedReason: '插件正在卸载，请稍后重试' };
            try {
                disposalOf(id, agents.get(id));
                return { canReset: true };
            }
            catch (error) {
                return { canReset: false, blockedReason: error.message };
            }
        },
        async run(id, operation) {
            if (closing && !scope.getStore())
                throw new Error('插件正在卸载，未接受新操作');
            if (locks.has(id))
                throw new Error('该会话已有重置操作，请勿重复提交');
            const agent = agents.get(id);
            const dispose = disposalOf(id, agent);
            const token = {};
            locks.set(id, token);
            const restoreDeliveries = [];
            const droppedDeliveries = new Set();
            if (agent)
                for (const method of ['send', 'followup', 'steer', 'inject']) {
                    const previous = agent[method];
                    if (typeof previous !== 'function')
                        continue;
                    // 宿主契约里 send/followup/steer/inject 是 void 的即发即弃投递。持锁期间旧会话的
                    // 滞留投递按重置语义丢弃：同步 throw 会击穿裸定时器调用方（如 a2a armAsyncNudge
                    // 的 steerRelay），而转 rejected promise 又会被宿主 failLoud 判为致命未处理拒绝。
                    const wrapper = function (...args) {
                        if (locks.has(id) && scope.getStore() !== locks.get(id)) {
                            if (!droppedDeliveries.has(method)) {
                                droppedDeliveries.add(method);
                                ctx.logger?.warn?.(`session-reset: dropped ${method} delivery targeting ${id} during in-place reset`);
                            }
                            return undefined;
                        }
                        return previous.apply(this, args);
                    };
                    const originalAgent = raw(agent);
                    const owned = Object.hasOwn(originalAgent, method);
                    originalAgent[method] = wrapper;
                    restoreDeliveries.push(() => {
                        if (originalAgent[method] !== wrapper)
                            return;
                        if (owned)
                            originalAgent[method] = previous;
                        else
                            delete originalAgent[method];
                    });
                }
            try {
                return await scope.run(token, () => operation({
                    async release() {
                        if (raw(agents.get(id)) !== raw(agent))
                            throw new Error('会话运行时已变化，已停止重置');
                        if (agent?.status !== undefined && agent.status !== 'idle')
                            throw new Error('会话在检查后开始运行，已停止重置');
                        await dispose?.();
                        if (agents.get(id) || sessions.get(id))
                            throw new Error('会话写入或运行时尚未释放，未修改存储');
                    },
                }));
            }
            finally {
                for (const restore of restoreDeliveries.reverse())
                    restore();
                locks.delete(id);
                if (!locks.size) {
                    for (const resolve of idleWaiters)
                        resolve();
                    idleWaiters.clear();
                }
            }
        },
        async releaseCurrent(id) {
            if (!locks.has(id) || scope.getStore() !== locks.get(id))
                throw new Error('释放操作不属于当前重置');
            await disposalOf(id, agents.get(id))?.();
            if (agents.get(id) || sessions.get(id))
                throw new Error('会话运行时尚未释放');
        },
        async dispose() {
            closing = true;
            if (locks.size)
                await new Promise((resolve) => idleWaiters.add(resolve));
            if (disposed)
                return;
            disposed = true;
            for (const restore of undo.reverse())
                restore();
        },
    };
}
