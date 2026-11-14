// 导入自己的视频 + 字幕：视频存 IndexedDB，句子存 localStorage。
// 不上传任何东西，全在这台设备里。

const DB = 'es-media';
const STORE = 'media';
const META_KEY = 'es.imports.v1';
const PACK_KEY = 'es.importPack.v1';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    try {
      out = fn(store);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
    t.onerror = () => reject(t.error);
  });
}

export const media = {
  put(id, blob, name, type) {
    return tx('readwrite', (s) => s.put({ blob, name, type }, id));
  },
  get(id) {
    return tx('readonly', (s) => s.get(id));
  },
  del(id) {
    return tx('readwrite', (s) => s.delete(id));
  },
};

function readMeta() {
  try {
    return JSON.parse(localStorage.getItem(META_KEY) || '[]');
  } catch {
    return [];
  }
}

export const imported = {
  list() {
    return readMeta();
  },
  has(id) {
    return readMeta().some((m) => m.id === id);
  },
  pack(id) {
    try {
      const all = JSON.parse(localStorage.getItem(PACK_KEY) || '{}');
      return all[id] || null;
    } catch {
      return null;
    }
  },
  async remove(id) {
    const all = JSON.parse(localStorage.getItem(PACK_KEY) || '{}');
    delete all[id];
    localStorage.setItem(PACK_KEY, JSON.stringify(all));
    localStorage.setItem(META_KEY, JSON.stringify(readMeta().filter((m) => m.id !== id)));
    await media.del(id).catch(() => {});
  },
  async save({ title, file, sentences }) {
    const id = 'imp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    await media.put(id, file, file.name, file.type);
    const pack = {
      id,
      title: title || file.name.replace(/\.[^.]+$/, ''),
      title_en: file.name,
      tag: '我的导入',
      level: '自选',
      intro: `来自 ${file.name}，共 ${sentences.length} 句。`,
      format: 'timeline',
      imported: true,
      video: '',
      duration: sentences.length ? sentences[sentences.length - 1].end : 0,
      source: { name: file.name, license: '你自己的素材' },
      sentences: sentences.map((s, i) => ({
        role: 'speaker',
        en: s.text,
        zh: s.zh || '',
        start: Number(s.start.toFixed(2)),
        end: Number(s.end.toFixed(2)),
      })),
    };
    const all = JSON.parse(localStorage.getItem(PACK_KEY) || '{}');
    all[id] = pack;
    try {
      localStorage.setItem(PACK_KEY, JSON.stringify(all));
    } catch {
      // 句子太多可能超配额，只留句子文本
      all[id] = { ...pack, sentences: pack.sentences.map((s) => ({ ...s, zh: '' })) };
      localStorage.setItem(PACK_KEY, JSON.stringify(all));
    }
    localStorage.setItem(META_KEY, JSON.stringify([
      { id, title: pack.title, count: pack.sentences.length, createdAt: Date.now() },
      ...readMeta(),
    ]));
    return pack;
  },
};

/** 给播放器用的可播放地址 */
export async function mediaUrl(id) {
  const rec = await media.get(id);
  if (!rec || !rec.blob) throw new Error('找不到这个导入视频（可能被清掉了）');
  return URL.createObjectURL(rec.blob);
}

/* ---------- 分享菜单进来（安卓 Web Share Target） ---------- */

const SHARED = '__shared__';

/** Service Worker 收到 POST /share-target 时调用 */
export async function stageShared(blob, name, type) {
  await media.put(SHARED, blob, name, type);
}

/** 导入页启动时取走暂存的文件（只取一次） */
export async function takeShared() {
  const rec = await media.get(SHARED);
  if (!rec || !rec.blob) return null;
  await media.del(SHARED);
  return new File([rec.blob], rec.name || 'shared.mp4', { type: rec.type || 'video/mp4' });
}
