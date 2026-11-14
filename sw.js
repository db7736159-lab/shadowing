// 离线壳：只缓存界面和场景 JSON，音频按需缓存。
const VERSION = 'v1';

/* 分享进来的文件先塞进 IndexedDB，页面启动时取走 */
function openMediaDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('es-media', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('media')) req.result.createObjectStore('media');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function stageShared(blob, name, type) {
  const db = await openMediaDb();
  await new Promise((resolve, reject) => {
    const t = db.transaction('media', 'readwrite');
    t.objectStore('media').put({ blob, name, type }, '__shared__');
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './app/main.js',
  './app/util.js',
  './app/store.js',
  './app/score.js',
  './app/speech.js',
  './app/dict.js',
  './app/subtitle.js',
  './app/importer.js',
  './app/collect.js',
  './app/backup.js',
  './packs/index.json',
  './data/dict.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // 安卓「分享」菜单把视频丢进来：POST /share-target
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('media');
        if (file && file.size) await stageShared(file, file.name, file.type);
      } catch {
        // 收不到就退回导入页，让用户手动选
      }
      return Response.redirect(new URL('./index.html#/import', self.registration.scope).href, 303);
    })());
    return;
  }

  if (req.method !== 'GET') return;
  if (url.origin !== location.origin) return;

  // 音频/视频：整段请求走缓存（练过一次就不用再下载）；
  // 带 Range 的分段请求直接放行，避免把半截文件存进缓存。
  if (/\.(mp3|mp4|m4a|webm)$/.test(url.pathname)) {
    if (req.headers.get('range')) return;
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // 其它：网络优先，断网回落缓存
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
