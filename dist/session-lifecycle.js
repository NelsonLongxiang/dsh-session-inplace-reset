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
    function guard(object, method, identify) {
        const previous = object?.[method];
        if (typeof previous !== 'function')
            return;
        const owned = Object.hasOwn(object, method);
        const wrapper = function (...args) { allowed(identify(args)); return previous.apply(this, args); };
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
    guard(controller.agents, 'resolveAgent', (args) => args[0]);
    guard(controller.agents, 'resolveObservedAgent', (args) => args[0]?.header?.id);
    function disposalOf(id, agent) {
        if (!agent) {
            if (sessions.get(id))
                throw new Error('会话存在未归属的运行时，已停止重置');
            return null;
        }
        if (agent.status !== 'idle')
            throw new Error('会话正在运行，请先停止当前任务');
        if (agent.session?.header?.origin === 'subagent' || agent.session?.header?.delegationDepth > 0)
            throw new Error('子代理会话不支持原地重置');
        const fiber = loop?.runtime?.ctx?.fiber;
        const disposables = fiber?._disposables;
        if (!disposables?.[Symbol.iterator] || typeof fiber.getEffects !== 'function')
            throw new Error('宿主不提供已核验的单会话释放入口');
        const label = `agentLoop.scope(${id})`;
        const matches = [...disposables].filter((dispose) => dispose[symbols.effect]?.label === label);
        if (matches.length !== 1 || raw(sessions.get(id)) !== raw(agent.session))
            throw new Error('无法唯一确认该会话的生命周期拥有者，已停止重置');
        // The owner's composite runs teardown (cancel/drain/close/detach) before raw scope disposal.
        return matches[0];
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
            if (agent)
                for (const method of ['send', 'followup', 'steer', 'inject']) {
                    const previous = agent[method];
                    if (typeof previous !== 'function')
                        continue;
                    const wrapper = function (...args) { allowed(id); return previous.apply(this, args); };
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
