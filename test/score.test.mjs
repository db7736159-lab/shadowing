// node --test test/score.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAttempt, feedback, tokenize, align, wordStates } from '../app/score.js';

test('tokenize 去标点、统一大小写', () => {
  assert.deepEqual(tokenize("I'd like a latte, please!"), ["i'd", 'like', 'a', 'latte', 'please']);
});

test('完全一致拿满分', () => {
  const r = scoreAttempt({ refText: 'what can I get for you', heardText: 'What can I get for you?', durationSec: 2 });
  assert.equal(r.accuracy, 100);
  assert.equal(r.completeness, 100);
  assert.ok(r.total >= 95, `total=${r.total}`);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.wrong, []);
});

test('漏一个词：完整度掉，missing 指出是哪个', () => {
  const r = scoreAttempt({ refText: 'could I get a large iced latte', heardText: 'could I get a large latte' });
  assert.deepEqual(r.missing, ['iced']);
  assert.ok(r.accuracy < 100);
  assert.equal(r.accuracy, Math.round((6 / 7) * 100));
});

test('读错词：算 sub，既不是漏读也不是多读', () => {
  const r = scoreAttempt({ refText: 'card or cash', heardText: 'card or cat' });
  assert.deepEqual(r.wrong, [{ want: 'cash', got: 'cat' }]);
  assert.deepEqual(r.missing, []);
  assert.equal(r.accuracy, Math.round((2 / 3) * 100));
  assert.equal(r.completeness, 100);
});

test('多词：extra 单独列出，不影响完整度', () => {
  const r = scoreAttempt({ refText: 'thanks a lot', heardText: 'thanks a lot very much' });
  assert.deepEqual(r.extra, ['very', 'much']);
  assert.equal(r.completeness, 100);
});

test('什么都没识别到：给 0 分并提示', () => {
  const r = scoreAttempt({ refText: 'see you on Thursday', heardText: '' });
  assert.equal(r.total, 0);
  const lines = feedback(r, { heardText: '' });
  assert.match(lines[0], /没听清/);
});

test('语速太慢会扣流利度', () => {
  const fast = scoreAttempt({ refText: 'good morning', heardText: 'good morning', durationSec: 1 });
  const slow = scoreAttempt({ refText: 'good morning', heardText: 'good morning', durationSec: 9 });
  assert.ok(fast.fluency > slow.fluency, `${fast.fluency} vs ${slow.fluency}`);
});

test('总分落在 0–100 且随错误下降', () => {
  const perfect = scoreAttempt({ refText: 'here you are', heardText: 'here you are', durationSec: 1.4 });
  const oneWrong = scoreAttempt({ refText: 'here you are', heardText: 'here you is', durationSec: 1.4 });
  assert.ok(perfect.total <= 100 && perfect.total >= 0);
  assert.ok(perfect.total > oneWrong.total, `${perfect.total} vs ${oneWrong.total}`);
});

test('对齐结果按原句顺序', () => {
  const ops = align(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(ops.map((o) => o.type), ['ok', 'del', 'ok']);
});

test('wordStates 输出的词数与原句一致', () => {
  const ref = 'Is breakfast included in the price';
  const ops = align(tokenize(ref), tokenize('Is breakfast in the price'));
  const states = wordStates(ref, ops);
  assert.equal(states.filter((s) => s.state).length, 6);
  assert.ok(states.some((s) => s.state === 'del'));
});
