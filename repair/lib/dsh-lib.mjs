// DSH 官方格式库定位：oracle / preflight / compaction-span 直接 import 宿主同源的编译件，
// 升级 dsh 后自动跟随新规则。目录下须有 @deepseek-ai 的三个包：
//   dsh-session-format-v3-to-v4 / dsh-session-format-catalog / dsh-session
// 定位法：node -e "console.log(require('path').join(require('path').dirname(require.resolve('@deepseek-ai/dsh/package.json')),'node_modules','@deepseek-ai'))"
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function dshLibDir() {
  const d = process.env.DSH_FORMAT_LIB;
  if (!d || !d.trim()) {
    console.error('请设置 DSH_FORMAT_LIB=<含 @deepseek-ai/dsh-session-format-v3-to-v4 等三包的目录>（定位法见 lib/dsh-lib.mjs 注释）');
    process.exit(1);
  }
  return d.trim();
}

export async function loadDsh() {
  const base = dshLibDir();
  const imp = (p) => import(pathToFileURL(join(base, p)).href);
  const { sessionFormatCatalog } = await imp('dsh-session-format-catalog/lib/index.js');
  const fmt = await imp('dsh-session-format-v3-to-v4/lib/index.js');
  const { KNOWN_SESSION_EVENT_TYPES } = await imp('dsh-session/lib/index.js');
  return { ...fmt, sessionFormatCatalog, KNOWN_SESSION_EVENT_TYPES };
}
