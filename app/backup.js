// 备份：把进度、收藏、设置导出成一个 json；换手机/换域名时导回来。
// 注意：导入的视频本体（IndexedDB 里的文件）不进备份，只备份视频句子的索引。

const KEYS = ['es.progress.v1', 'es.settings.v1', 'es.days.v1', 'es.last.v1', 'es.collect.v1', 'es.imports.v1', 'es.importPack.v1'];

export function exportBackup() {
  const data = { version: 1, exportedAt: new Date().toISOString(), app: 'english-shadowing', data: {} };
  for (const k of KEYS) {
    const raw = localStorage.getItem(k);
    if (raw != null) data.data[k] = raw;
  }
  // 不把 Azure key 写进备份文件
  if (data.data['es.settings.v1']) {
    try {
      const s = JSON.parse(data.data['es.settings.v1']);
      delete s.azureKey;
      data.data['es.settings.v1'] = JSON.stringify(s);
    } catch {}
  }
  return data;
}

export function downloadBackup() {
  const data = exportBackup();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `shadowing-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return data;
}

export function importBackup(json) {
  if (!json || json.app !== 'english-shadowing' || !json.data) {
    throw new Error('这不是本应用的备份文件');
  }
  let n = 0;
  for (const k of KEYS) {
    if (typeof json.data[k] === 'string') {
      localStorage.setItem(k, json.data[k]);
      n++;
    }
  }
  return n;
}
