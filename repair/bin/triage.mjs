// 红字自动分诊：贴上装载/校验错误原文，给出病种判定与对应修复命令。
// 用法：node repair/bin/triage.mjs "<错误原文>"（或管道 stdin；可给多段，任一命中即报）。
// 输出：判定＋修法命令＋验证命令。查不到 → 建议先跑 sweep / 双门槛。
import { readFileSync } from 'node:fs';

const text = process.argv[2] ?? readFileSync(0, 'utf8');

// 病征表（与 repair/README.md 病征速查同源；模式=子串，先命中先报）
const CATALOG = [
  { p: 'turn/start does not open the expected turn', layer: 'turn 回退', cause: 'rewind 后 turn/start 重写旧号、后缀未抬（复位/重拉后高发）', fix: ['node repair/bin/fix-turn-rewind.mjs check <file>', 'node repair/bin/fix-turn-rewind.mjs fix <file> -o out.zstd'], note: '若 check 报「缺 turn/end / 未闭合轮」则属人工判例，工具拒修是守卫不是判据' },
  { p: 'replacement sourceEventSeqs omit a shadowed surface node', layer: 'sourceEventSeqs 区间对', cause: 'v0 的 seq-range 编码 [a,b] 漏进 v4（v4 只认扁平数字）', fix: ['node repair/bin/fix-surface-ranges.mjs fix <file> -o out.zstd'] },
  { p: 'sourceEventSeqs ranges must contain unique earlier seqs', layer: '平移撞号重复', cause: '历次平移后区间展开撞号', fix: ['人工：展开后去重（同 fix-surface-ranges 的 flatten 语义）再全门验证'] },
  { p: 'has seq gap', layer: 'seq 跳号', cause: '宿主恢复续写跳号或历次手术残留', fix: ['人工：先推编号代数（存储值=原值±历史平移叠加），再决定平移/补插；换件纪律见 repair/README.md'] },
  { p: 'shadowedSeqs do not name an exact current surface span', layer: 'compaction 跨度错', cause: '撤回（withdraw）后 compaction 引用旧时间线面序', fix: ['node repair/bin/fix-compaction-span.mjs <file> out.zstd'] },
  { p: 'must name an earlier event', layer: '前向引用', cause: 'command/done 的 sourceEventSeq 指向其后事件', fix: ['人工：删该可选字段或重定向；标本=撤回写坏编号族'] },
  { p: 'image/offload: target seq', layer: 'offload 目标错面', cause: '历次 seq 平移漏掉 targets[].seq', fix: ['人工：按面重放+类型匹配重定向（语义极限，图必须真实存在）'] },
  { p: 'image/offload: image index', layer: '孤儿 offload', cause: '指向的图片已不存在（被 offload/撤回链剥光）', fix: ['审计确认孤儿后：node repair/bin/prune-events.mjs <file> out.zstd <seq…>'] },
  { p: 'stored log is corrupt', layer: '未定位', cause: '泛型包装，需要看内层红字', fix: ['node repair/bin/sweep.mjs --gates --root <会话根>', 'node repair/bin/oracle.mjs <file> && node repair/bin/preflight-v4.mjs <file>'] },
];

const hits = CATALOG.filter(c => text.includes(c.p));
if (!hits.length) {
  console.log('未命中病征表。建议：');
  console.log('  1) node repair/bin/sweep.mjs --gates --root <会话根>   # 全层体检定位');
  console.log('  2) 把完整错误原文（含内层 SessionFormatError 行）再喂一次 triage');
  process.exit(1);
}
for (const h of hits) {
  console.log(`判定：${h.layer}`);
  console.log(`成因：${h.cause}`);
  for (const f of h.fix) console.log(`修法：${f}`);
  if (h.note) console.log(`注意：${h.note}`);
}
console.log('验证：oracle + preflight 双门槛 PASS 后，闲置窗口换入并 md5 回拉（换件纪律见 repair/README.md）');
