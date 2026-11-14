// node test/importer.test.mjs
// 用 fake-indexeddb 模拟浏览器存储，验证导入功能的存取链路。
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';

// 最小 localStorage 垫片
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { imported, media, mediaUrl } = await import('../app/importer.js');

const srt = `1
00:00:01,000 --> 00:00:03,000
Could I get a coffee, please?

2
00:00:03,200 --> 00:00:06,000
Sure. Milk or sugar?
`;

const { buildSentences } = await import('../app/subtitle.js');

test('导入：存视频、存句子、读回来、删掉', async () => {
  const sentences = buildSentences(srt);
  const file = new File([new Uint8Array(4096)], 'demo.mp4', { type: 'video/mp4' });

  const pack = await imported.save({ title: '测试片段', file, sentences });
  assert.match(pack.id, /^imp-/);
  assert.equal(pack.imported, true);
  assert.equal(pack.sentences.length, 2);
  assert.equal(pack.sentences[0].en, 'Could I get a coffee, please?');

  const meta = imported.list();
  assert.equal(meta.length, 1);
  assert.equal(meta[0].title, '测试片段');
  assert.equal(meta[0].count, 2);

  const back = imported.pack(pack.id);
  assert.equal(back.sentences[1].en, 'Sure. Milk or sugar?');
  assert.equal(back.format, 'timeline');

  const rec = await media.get(pack.id);
  assert.equal(rec.blob.size, 4096);
  assert.equal(rec.name, 'demo.mp4');

  const url = await mediaUrl(pack.id);
  const blob = await (await fetch(url)).blob();
  assert.equal(blob.size, 4096);

  await imported.remove(pack.id);
  assert.equal(imported.list().length, 0);
  assert.equal(imported.has(pack.id), false);
  assert.equal(await media.get(pack.id), undefined);
});

test('两个不同的导入互不覆盖', async () => {
  const sentences = buildSentences(srt);
  const f1 = new File([new Uint8Array(100)], 'a.mp4', { type: 'video/mp4' });
  const f2 = new File([new Uint8Array(200)], 'b.mov', { type: 'video/quicktime' });
  const p1 = await imported.save({ title: 'A', file: f1, sentences });
  const p2 = await imported.save({ title: 'B', file: f2, sentences });
  assert.notEqual(p1.id, p2.id);
  assert.equal(imported.list().length, 2);
  assert.equal((await media.get(p1.id)).blob.size, 100);
  assert.equal((await media.get(p2.id)).blob.size, 200);
  await imported.remove(p1.id);
  await imported.remove(p2.id);
  assert.equal(imported.list().length, 0);
});
