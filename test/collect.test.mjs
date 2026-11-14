// node test/collect.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const { collect } = await import('../app/collect.js');
const { exportBackup, importBackup } = await import('../app/backup.js');

function reset() {
  mem.clear();
}

test('生词：加入、判重、移除', () => {
  reset();
  assert.equal(collect.addWord({ word: 'Latte', meaning: '拿铁', pack: 'cafe-order', idx: 1, en: 'iced latte' }), true);
  assert.equal(collect.hasWord('latte'), true);
  assert.equal(collect.hasWord('LATTE'), true);
  assert.equal(collect.counts().words, 1);
  // 再收藏同一个词不重复计数
  collect.addWord({ word: 'latte', meaning: '拿铁', pack: 'cafe-order', idx: 1 });
  assert.equal(collect.counts().words, 1);
  collect.removeWord('latte');
  assert.equal(collect.counts().words, 0);
});

test('句子：加入、判重、移除', () => {
  reset();
  collect.addSentence({ pack: 'cafe-order', idx: 3, en: 'Oat milk, please.', zh: '燕麦奶。' });
  assert.equal(collect.hasSentence('cafe-order', 3), true);
  assert.equal(collect.hasSentence('cafe-order', 4), false);
  assert.equal(collect.counts().sentences, 1);
  collect.removeSentence('cafe-order', 3);
  assert.equal(collect.counts().sentences, 0);
});

test('复习队列：没练过的排前面', () => {
  reset();
  collect.addWord({ word: 'a', pack: 'p', idx: 0 });
  collect.addWord({ word: 'b', pack: 'p', idx: 1 });
  collect.touch('word', 'b');   // b 练过一次
  const q = collect.reviewQueue(10);
  assert.equal(q[0].word, 'a');
  assert.equal(q[1].reviews, 1);
});

test('touch 会累加复习次数', () => {
  reset();
  collect.addWord({ word: 'x', pack: 'p', idx: 0 });
  collect.touch('word', 'x');
  collect.touch('word', 'x');
  assert.equal(collect.words()[0].reviews, 2);
});

test('备份导出能原样导回', () => {
  reset();
  localStorage.setItem('es.progress.v1', JSON.stringify({ 'cafe-order': { 0: { score: 88, ts: 1 } } }));
  localStorage.setItem('es.collect.v1', JSON.stringify({ words: { hey: { word: 'hey', pack: 'p', idx: 0 } }, sentences: {} }));
  localStorage.setItem('es.settings.v1', JSON.stringify({ azureKey: 'SECRET', speed: 1 }));

  const backup = exportBackup();
  assert.equal(backup.app, 'english-shadowing');
  assert.ok(backup.data['es.progress.v1']);
  // 备份里不能带 Azure key
  assert.ok(!JSON.stringify(backup).includes('SECRET'), 'backup leaked azure key');

  reset();
  assert.equal(localStorage.getItem('es.progress.v1'), null);
  const n = importBackup(backup);
  assert.ok(n >= 3);
  const progress = JSON.parse(localStorage.getItem('es.progress.v1'));
  assert.equal(progress['cafe-order'][0].score, 88);
});

test('导入不是本应用的备份会报错', () => {
  reset();
  assert.throws(() => importBackup({ hello: 'world' }), /不是本应用/);
});
