// 本地词典：data/dict.json 由打包脚本从场景内容里抽词生成。
// 查不到就给出「去有道查」的链接，不做网络请求。

let dict = null;
let loading = null;

export function loadDict() {
  if (dict) return Promise.resolve(dict);
  if (!loading) {
    loading = fetch('data/dict.json')
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => (dict = d))
      .catch(() => (dict = {}));
  }
  return loading;
}

export function lookup(word) {
  if (!dict) return null;
  const key = String(word || '').toLowerCase().replace(/[^a-z'`-]/g, '');
  if (!key) return null;
  return dict[key] || null;
}

const MAX_PHRASE = 4;

/**
 * 点某个词时，从它开始试着匹配最长短语（最多 4 个词）。
 * 返回 { phrase, entry, length } 或 null
 */
export function lookupAt(tokens, index) {
  if (!dict) return null;
  for (let len = Math.min(MAX_PHRASE, tokens.length - index); len >= 1; len--) {
    const raw = tokens.slice(index, index + len).join(' ');
    const key = raw.toLowerCase().replace(/[^a-z0-9' `-]/g, '').trim();
    if (dict[key]) return { phrase: raw, entry: dict[key], length: len };
  }
  return null;
}

export function youdaoUrl(word) {
  return `https://dict.youdao.com/result?word=${encodeURIComponent(word)}&lang=en`;
}
