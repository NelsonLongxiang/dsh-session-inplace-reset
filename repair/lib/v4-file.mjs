// v4 会话文件读写公共件：zstd 多帧遍历、逐行解析、逐行一帧写回、surface 重放。
// 帧律：dsh 追加写入＝每行一个独立 zstd 帧，但历史件存在多行帧——
// 必须解压全部帧 concat 后再按 \n 切行，不能假设「帧＝行」。
import fs from 'node:fs';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
export const SURFACE_TYPES = new Set(['system/message', 'user/message', 'developer/message', 'assistant/message', 'tool/result']);

/** 走位一个 zstd 帧（帧头 → block 链 → 可选校验和），返回帧尾偏移。规范 RFC 8878。 */
export function frameEnd(buf, off) {
  let p = off + 4; // 跳过 magic
  const fhd = buf[p++];
  const singleSeg = (fhd & 0x20) !== 0;
  const checksum = (fhd & 0x04) !== 0;
  const fcsCode = (fhd >> 6) & 0x3;
  const didCode = fhd & 0x3;
  if (!singleSeg) p++; // window descriptor
  p += didCode === 0 ? 0 : didCode === 1 ? 1 : didCode === 2 ? 2 : 4;
  if (fcsCode === 0 && singleSeg) p += 1; else if (fcsCode === 1) p += 2; else if (fcsCode === 2) p += 4; else if (fcsCode === 3) p += 8;
  for (;;) {
    const h = buf.readUIntLE(p, 3); p += 3;
    const type = (h >> 1) & 3;
    const size = h >>> 3;
    p += type === 1 ? 1 : size; // RLE 块磁盘上只占 1 字节
    if (h & 1) break;
  }
  if (checksum) p += 4;
  return p;
}

/**
 * 读会话文件 → { rows（首行 header）, frames, isZstd }。明文 .jsonl 也收。
 * 尾部无换行＝截断件（在途写入），拒收。
 */
export function openSession(file) {
  const buf = fs.readFileSync(file);
  const isZstd = buf.subarray(0, 4).equals(MAGIC);
  let frames = 0;
  let text;
  if (isZstd) {
    const parts = [];
    let i = 0;
    while (i < buf.length) {
      if (buf.subarray(i, i + 4).equals(MAGIC)) {
        const e = frameEnd(buf, i);
        parts.push(zstdDecompressSync(buf.subarray(i, e)));
        i = e; frames++;
      } else if (i + 8 <= buf.length && buf.readUInt32BE(i) >= 0x184d2a50 && buf.readUInt32BE(i) <= 0x184d2a5f) {
        i += 8 + buf.readUInt32LE(i + 4); // 可跳过帧：magic + 4B 大小
      } else throw new Error(`非 zstd 帧边界 @${i}`);
    }
    text = Buffer.concat(parts).toString('utf8');
    if (!text.endsWith('\n')) throw new Error('尾部无换行（截断件）');
  } else {
    text = buf.toString('utf8');
  }
  return { rows: text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l)), frames, isZstd };
}

/** 逐行一帧写回（dsh 原生追加格式；单一大帧会被 committedBytes 断言拒绝）。 */
export function writeSession(file, rows) {
  fs.writeFileSync(file, Buffer.concat(rows.map(r => zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n', 'utf8')))));
}

/**
 * 按 session-format-v3-to-v4 relationships.ts 的 foldSurface 重放到 uptoSeq（不含）：
 * append 入面；replace 用本事件顶替面上 [startSeq..endSeq]。返回 { surface } 或 { error }。
 */
export function replaySurface(events, uptoSeq) {
  const surface = [];
  for (const ev of events) {
    if (ev.seq > uptoSeq) break;
    if (!SURFACE_TYPES.has(ev.type)) continue;
    const op = ev.surfaceOp;
    if (op === 'append') { surface.push(ev.seq); continue; }
    if (op && typeof op === 'object') {
      const first = surface.indexOf(op.startSeq), last = surface.indexOf(op.endSeq);
      if (first < 0 || last < first) return { error: `replace ${ev.seq} op=${JSON.stringify(op)} first=${first} last=${last}` };
      surface.splice(first, last - first + 1, ev.seq);
      continue;
    }
    return { error: `surface event ${ev.seq} bad surfaceOp ${String(op)}` };
  }
  return { surface };
}
