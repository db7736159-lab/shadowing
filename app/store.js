// 本地存储：进度、设置、生词。全部留在本机，不上传。

const KEY_PROGRESS = 'es.progress.v1';
const KEY_SETTINGS = 'es.settings.v1';
const KEY_LAST = 'es.last.v1';

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式/配额满：静默失败，不影响练习
  }
}

const DEFAULT_SETTINGS = {
  showZh: true,
  speed: 1,
  autoRecord: false,
  azureKey: '',
  azureRegion: '',
  scorer: 'browser', // browser | azure
};

export const store = {
  settings() {
    return { ...DEFAULT_SETTINGS, ...read(KEY_SETTINGS, {}) };
  },
  saveSettings(patch) {
    const next = { ...this.settings(), ...patch };
    write(KEY_SETTINGS, next);
    return next;
  },

  progress(packId) {
    const all = read(KEY_PROGRESS, {});
    return all[packId] || {};
  },
  best(packId, index) {
    const p = this.progress(packId)[index];
    return p ? p.score : null;
  },
  record(packId, index, score) {
    const all = read(KEY_PROGRESS, {});
    const pack = all[packId] || (all[packId] = {});
    const prev = pack[index];
    if (!prev || score > prev.score) {
      pack[index] = { score, ts: Date.now() };
      write(KEY_PROGRESS, all);
    }
    this.touchDay();
    return pack;
  },
  packStats(packId, total) {
    const p = this.progress(packId);
    let done = 0;
    let sum = 0;
    for (let i = 0; i < total; i++) {
      if (p[i]) {
        done++;
        sum += p[i].score;
      }
    }
    return { done, total, avg: done ? Math.round(sum / done) : 0, rate: total ? done / total : 0 };
  },

  lastPack() {
    return read(KEY_LAST, null);
  },
  setLastPack(id, sentenceIndex) {
    write(KEY_LAST, { id, sentenceIndex });
  },

  touchDay() {
    const days = read('es.days.v1', []);
    const today = new Date().toISOString().slice(0, 10);
    if (!days.includes(today)) {
      days.push(today);
      write('es.days.v1', days.slice(-400));
    }
  },
  streak() {
    const days = read('es.days.v1', []);
    if (!days.length) return 0;
    const set = new Set(days);
    let n = 0;
    const d = new Date();
    for (;;) {
      const k = d.toISOString().slice(0, 10);
      if (!set.has(k)) break;
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  },

  resetAll() {
    [KEY_PROGRESS, KEY_SETTINGS, KEY_LAST, 'es.days.v1'].forEach((k) => localStorage.removeItem(k));
  },
};
