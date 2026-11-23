// a2a 名册风险探测：dryRun 回执标注「会话在 a2a 名册中」及宿主 a2a 是否仍未修 #756。
// 只读 <home>/a2a/joined.json（sessions 数组）与已装 a2a 包源码特征；读不到一律不猜。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface A2aRosterRisk {
  joined: true;
  hostA2aUnfixed: boolean | null;
  warning: string;
}

/** @param resolveA2aLib 返回已装 a2a lib/index.js 绝对路径；不可解析返回 undefined。 */
export function a2aRosterRisk(home: string, sessionId: string, resolveA2aLib?: () => string | undefined): A2aRosterRisk | undefined {
  let joined: unknown;
  try { joined = JSON.parse(readFileSync(join(home, 'a2a', 'joined.json'), 'utf8')).sessions; } catch { return undefined; }
  if (!Array.isArray(joined) || !joined.includes(sessionId)) return undefined;
  let unfixed: boolean | null = null;
  try {
    const lib = resolveA2aLib?.();
    if (lib) unfixed = /\.resolveAgent\(SessionId\(id\)\)\.then/.test(readFileSync(lib, 'utf8'));
  } catch { /* a2a 未装或不可读：null=未知 */ }
  return {
    joined: true,
    hostA2aUnfixed: unfixed,
    warning: '会话在 a2a 名册中：重置持锁期间 reconcile 会尝试唤醒它。本插件 ≥0.13.4 守卫已契约化，本插件侧不再崩宿主'
      + (unfixed ? '；但宿主 a2a 的 materialize 仍未做同步异常转换（dsh-open-a2a-net#756），其他同步抛出面仍有崩溃风险，保守做法是先摘名册并让新进程冷读' : ''),
  };
}
