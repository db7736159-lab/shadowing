// 纯函数：文本归一化、逐词对齐、打分、中文反馈。
// 不依赖 DOM，可在 Node 里直接单测。

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

/**
 * 词级编辑距离对齐。
 * 返回按原句顺序排列的 ops：[{type:'ok'|'sub'|'del'|'ins', ref, hyp}]
 *  - ok  ：读对
 *  - sub ：读成了别的词（ref 是目标词，hyp 是听到的词）
 *  - del ：漏读（目标句里有，没听到）
 *  - ins ：多读（目标句里没有）
 */
export function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      if (dp[i][j] === dp[i - 1][j - 1] + cost) {
        ops.push({ type: cost ? 'sub' : 'ok', ref: ref[i - 1], hyp: hyp[j - 1] });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: 'del', ref: ref[i - 1], hyp: null });
      i--;
      continue;
    }
    if (j > 0) {
      ops.push({ type: 'ins', ref: null, hyp: hyp[j - 1] });
      j--;
    } else {
      ops.push({ type: 'del', ref: ref[i - 1], hyp: null });
      i--;
    }
  }
  return ops.reverse();
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 打分。
 * @param {{refText:string, heardText:string, durationSec?:number}} input
 * @returns {{total:number, accuracy:number, completeness:number, fluency:number,
 *            ops:Array, missing:string[], wrong:Array, extra:string[], rate:number|false}}
 */
export function scoreAttempt({ refText, heardText, durationSec = 0 }) {
  const ref = tokenize(refText);
  const hyp = tokenize(heardText);
  const ops = ref.length || hyp.length ? align(ref, hyp) : [];

  const ok = ops.filter((o) => o.type === 'ok').length;
  const sub = ops.filter((o) => o.type === 'sub').length;
  const del = ops.filter((o) => o.type === 'del').length;
  const ins = ops.filter((o) => o.type === 'ins').length;

  const accuracy = ref.length ? clamp(ok / ref.length, 0, 1) : 0;
  const completeness = ref.length ? clamp((ok + sub) / ref.length, 0, 1) : 0;

  // 流利度：按 150 词/分的参考语速算期望时长，偏离越多扣得越多；
  // 没有录音时长（例如只拿到转写）就记为中性 70。
  let fluency = 70;
  let rate = false;
  if (durationSec > 0.8 && ref.length > 0) {
    const expected = (ref.length / 2.5) * 1000;
    const ratio = (durationSec * 1000) / expected;
    fluency = clamp(100 - 55 * Math.abs(Math.log(ratio)), 0, 100);
    rate = (ref.length / durationSec) * 60; // 词/分钟
  }

  const total = hyp.length
    ? clamp(Math.round((0.45 * accuracy + 0.3 * completeness + 0.25 * (fluency / 100)) * 100), 0, 100)
    : 0;

  const missing = ops.filter((o) => o.type === 'del').map((o) => o.ref);
  const extra = ops.filter((o) => o.type === 'ins').map((o) => o.hyp);
  const wrong = ops.filter((o) => o.type === 'sub').map((o) => ({ want: o.ref, got: o.hyp }));

  return {
    total,
    accuracy: Math.round(accuracy * 100),
    completeness: Math.round(completeness * 100),
    fluency: Math.round(fluency),
    ops,
    missing,
    wrong,
    extra,
    rate,
    counts: { ok, sub, del, ins },
  };
}

/** 把打分结果翻成人话 */
export function feedback(result, { heardText = '' } = {}) {
  const lines = [];
  const { total, missing, wrong, extra, rate } = result;

  if (!tokenize(heardText).length) {
    return ['没听清——可能是麦克风没开，或者离手机太远。再试一次？'];
  }
  if (total >= 95) lines.push('几乎完美，这句可以过了。');
  else if (total >= 85) lines.push('挺稳的，个别词再收一下。');
  else if (total >= 70) lines.push('大意对了，细节还要抠。');
  else if (total >= 50) lines.push('能听出你在说什么，但和原句差得有点多。');
  else lines.push('先别急着快，跟着示范慢速读两遍再录。');

  if (missing.length) lines.push(`漏读了：${missing.slice(0, 8).join('、')}${missing.length > 8 ? ' …' : ''}`);
  if (wrong.length) {
    const pairs = wrong.slice(0, 5).map((w) => `${w.want}（你读成 ${w.got}）`);
    lines.push(`这几个词不对：${pairs.join('；')}${wrong.length > 5 ? ' …' : ''}`);
  }
  if (extra.length) lines.push(`多出来的词：${extra.slice(0, 6).join('、')}`);

  if (rate && rate > 200) lines.push(`语速偏快（${Math.round(rate)} 词/分），清楚比快重要。`);
  else if (rate && rate < 80) lines.push(`语速偏慢（${Math.round(rate)} 词/分），可以再顺一点。`);
  return lines;
}

/** 把 ops 映射回原句词序，给每个词标一个状态，用于高亮 */
export function wordStates(refText, ops) {
  const words = String(refText).split(/(\s+)/); // 保留空格，方便原样渲染
  const byWord = [];
  for (const op of ops) {
    if (op.ref) byWord.push(op.type); // ok / sub / del
  }
  let k = 0;
  return words.map((w) => {
    if (!w.trim()) return { text: w, state: null };
    const state = byWord[k] || 'ok';
    k++;
    return { text: w, state };
  });
}
