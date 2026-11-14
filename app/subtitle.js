// 字幕解析与断句：纯函数，可在 Node 里单测。
// 支持 SRT / VTT，输出按句合并的 [{start, end, en, zh?}]

const TS_RE = /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/g;

export function parseTimestamp(s) {
  const parts = String(s).trim().replace(',', '.').split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function clean(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SRT/VTT → cues [{start, end, text}] */
export function parseSubtitles(raw) {
  const text = String(raw).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const blocks = text.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [a, b] = timeLine.split('-->');
    if (!a || !b) continue;
    const start = parseTimestamp(a.trim());
    const end = parseTimestamp(b.trim().split(/\s+/)[0]);
    const body = lines.slice(lines.indexOf(timeLine) + 1).join(' ');
    const t = clean(body);
    if (t) cues.push({ start, end: Math.max(end, start + 0.2), text: t });
  }
  cues.sort((x, y) => x.start - y.start);

  // 同一时间点重复（滚动字幕常见）
  const out = [];
  for (const c of cues) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.start - c.start) < 0.02 && norm(prev.text) === norm(c.text)) continue;
    out.push(c);
  }
  return out;
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');

/**
 * cues → 句子。
 * 断句规则：句末标点 / 停顿超过 maxGap / 单句超过 maxSec / 太碎并入上一句。
 */
export function mergeSentences(cues, { maxGap = 0.9, maxSec = 14, minChars = 18 } = {}) {
  const chunks = [];
  let cur = null;
  for (const c of cues) {
    if (!cur) {
      cur = { start: c.start, end: c.end, text: c.text };
    } else if (c.end - cur.start > maxSec || c.start - cur.end > maxGap) {
      chunks.push(cur);
      cur = { start: c.start, end: c.end, text: c.text };
    } else {
      if (!norm(cur.text).endsWith(norm(c.text))) cur.text += ' ' + c.text;
      cur.end = Math.max(cur.end, c.end);
    }
    if (/[.!?]["')\]]?$/.test(cur.text)) {
      chunks.push(cur);
      cur = null;
    }
  }
  if (cur) chunks.push(cur);

  const merged = [];
  for (const s of chunks) {
    if (merged.length && s.text.length < minChars) {
      merged[merged.length - 1].text += ' ' + s.text;
      merged[merged.length - 1].end = s.end;
    } else {
      merged.push({ ...s });
    }
  }
  return merged
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.text.length >= 8);
}

/** 把中文字幕按时间重叠贴到英文句子上 */
export function attachTranslations(sentences, zhCues) {
  if (!zhCues || !zhCues.length) return sentences;
  return sentences.map((s) => {
    const parts = [];
    for (const c of zhCues) {
      const mid = (c.start + c.end) / 2;
      if (mid >= s.start - 0.4 && mid <= s.end + 0.4) parts.push(c.text);
    }
    s.zh = parts.join('').replace(/\s+/g, '');
    return s;
  });
}

/** 一次搞定：英文字幕 + 可选中文字幕 → 句子数组 */
export function buildSentences(enRaw, zhRaw) {
  const cues = parseSubtitles(enRaw);
  if (!cues.length) throw new Error('没解析出字幕，确认是 SRT 或 VTT 文件');
  const sentences = mergeSentences(cues);
  if (!sentences.length) throw new Error('字幕解析出来了，但切不出句子');
  if (zhRaw) attachTranslations(sentences, parseSubtitles(zhRaw));
  return sentences;
}
