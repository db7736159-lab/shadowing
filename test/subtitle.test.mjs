// node test/subtitle.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubtitles, mergeSentences, buildSentences, attachTranslations } from '../app/subtitle.js';

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hi, what can I get

2
00:00:03,500 --> 00:00:05,000
for you today?

3
00:00:06,000 --> 00:00:09,000
Could I get a large iced latte, please?

4
00:00:09,200 --> 00:00:11,000
Sure.
`;

test('SRT 能解析出时间轴和文本', () => {
  const cues = parseSubtitles(SRT);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.5);
  assert.equal(cues[0].text, 'Hi, what can I get');
});

test('相邻字幕合并成一句，句号处断开', () => {
  const sents = mergeSentences(parseSubtitles(SRT));
  assert.ok(sents.length >= 2, `got ${sents.length}`);
  assert.equal(sents[0].text, 'Hi, what can I get for you today?');
  assert.ok(sents.some((s) => /iced latte/.test(s.text)));
});

test('VTT 也能解析（带 cue 标记和 <c> 标签）', () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.500
<c.yellow>Hello</c> there

00:00:02.500 --> 00:00:04.000
how are you doing today?
`;
  const cues = parseSubtitles(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'Hello there');
  const sents = mergeSentences(cues);
  assert.equal(sents[0].text, 'Hello there how are you doing today?');
});

test('中文字幕按时间贴到句子上', () => {
  const en = `00:00:01,000 --> 00:00:03,000
I would like a coffee please.

00:00:04,000 --> 00:00:06,000
Any milk with that?
`;
  const zh = `00:00:01,000 --> 00:00:03,000
我想要一杯咖啡。

00:00:04,000 --> 00:00:06,000
要加奶吗？
`;
  const sents = buildSentences(en, zh);
  assert.equal(sents.length, 2);
  assert.equal(sents[0].zh, '我想要一杯咖啡。');
  assert.equal(sents[1].zh, '要加奶吗？');
});

test('没字幕就报错，不静默失败', () => {
  assert.throws(() => buildSentences('这不是字幕'), /没解析出字幕/);
});

test('重复的滚动字幕不会重复出现', () => {
  const dup = `1
00:00:01,000 --> 00:00:03,000
from your life.

2
00:00:01,000 --> 00:00:03,000
from your life.

3
00:00:03,100 --> 00:00:05,000
That was it.
`;
  const sents = mergeSentences(parseSubtitles(dup));
  const joined = sents.map((s) => s.text).join(' ');
  assert.equal(joined.match(/from your life/g).length, 1, joined);
});

test('attachTranslations 不改变没有中文字幕的句子', () => {
  const sents = [{ start: 0, end: 2, text: 'hello' }];
  assert.deepEqual(attachTranslations(sents, []), sents);
});
