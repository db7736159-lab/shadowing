// 生词本 + 句子收藏 + 备份导出（全部本机 localStorage）

const KEY = 'es.collect.v1';

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    const d = raw ? JSON.parse(raw) : null;
    return d && typeof d === 'object' ? { words: d.words || {}, sentences: d.sentences || {} } : { words: {}, sentences: {} };
  } catch {
    return { words: {}, sentences: {} };
  }
}

function write(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // 配额满就算了，不影响练习
  }
}

const normWord = (w) => String(w || '').toLowerCase().trim();

export const collect = {
  addWord({ word, phonetic = '', meaning = '', pack = '', idx = -1, en = '', zh = '' }) {
    const key = normWord(word);
    if (!key) return false;
    const d = read();
    const prev = d.words[key];
    d.words[key] = {
      word: word.trim(),
      phonetic,
      meaning,
      pack,
      idx,
      en,
      zh,
      added: prev ? prev.added : Date.now(),
      reviews: prev ? prev.reviews : 0,
      last: prev ? prev.last : 0,
    };
    write(d);
    return true;
  },
  addSentence({ pack, idx, en, zh = '' }) {
    if (!pack || idx == null || idx < 0) return false;
    const key = `${pack}#${idx}`;
    const d = read();
    const prev = d.sentences[key];
    d.sentences[key] = {
      pack,
      idx,
      en,
      zh,
      added: prev ? prev.added : Date.now(),
      reviews: prev ? prev.reviews : 0,
      last: prev ? prev.last : 0,
    };
    write(d);
    return true;
  },
  hasWord(word) {
    return !!read().words[normWord(word)];
  },
  hasSentence(pack, idx) {
    return !!read().sentences[`${pack}#${idx}`];
  },
  removeWord(word) {
    const d = read();
    delete d.words[normWord(word)];
    write(d);
  },
  removeSentence(pack, idx) {
    const d = read();
    delete d.sentences[`${pack}#${idx}`];
    write(d);
  },
  /** 练过一次：复习次数 +1、记住时间 */
  touch(kind, key) {
    const d = read();
    const bucket = kind === 'word' ? d.words : d.sentences;
    if (bucket[key]) {
      bucket[key].reviews += 1;
      bucket[key].last = Date.now();
      write(d);
    }
  },
  words() {
    return Object.entries(read().words).map(([k, v]) => ({ ...v, key: k }));
  },
  sentences() {
    return Object.entries(read().sentences).map(([k, v]) => ({ ...v, key: k }));
  },
  counts() {
    const d = read();
    return { words: Object.keys(d.words).length, sentences: Object.keys(d.sentences).length };
  },
  /** 复习排序：没练过的优先，其次练得少的，再按加入时间 */
  reviewQueue(limit = 50) {
    const score = (x) => (x.reviews || 0) * 1e12 + (x.last || x.added || 0);
    return [...this.words().map((w) => ({ ...w, kind: 'word' })), ...this.sentences().map((s) => ({ ...s, kind: 'sentence' }))]
      .sort((a, b) => score(a) - score(b))
      .slice(0, limit);
  },
};
