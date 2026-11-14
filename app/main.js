import { h, $, toast, scoreClass } from './util.js';
import { store } from './store.js';
import { scoreAttempt, feedback, wordStates } from './score.js';
import { Recognizer, Recorder, recognitionSupported, audioToWav16k, azureAssess } from './speech.js';
import { loadDict, lookupAt, youdaoUrl } from './dict.js';
import { buildSentences } from './subtitle.js';
import { imported, mediaUrl, takeShared } from './importer.js';
import { collect } from './collect.js';
import { downloadBackup, importBackup } from './backup.js';
import { transcribeFile } from './asr-local.js';

const app = $('#app');
const sheet = $('#sheet');

/* ---------------- 数据 ---------------- */

let indexCache = null;
const packCache = new Map();

async function getIndex() {
  if (!indexCache) {
    const r = await fetch('packs/index.json');
    indexCache = await r.json();
  }
  return indexCache;
}

async function getPack(id) {
  if (packCache.has(id)) return packCache.get(id);
  if (imported.has(id)) {
    const p = imported.pack(id);
    if (p) {
      packCache.set(id, p);
      return p;
    }
  }
  const r = await fetch(`packs/${id}/pack.json`);
  if (!r.ok) throw new Error('找不到这个场景');
  const pack = await r.json();
  packCache.set(id, pack);
  return pack;
}

/** 导入的包要先把视频从 IndexedDB 里拿出来变成可播放地址 */
async function ensurePlayable(pack) {
  if (!pack.imported || pack._url) return pack;
  try {
    pack._url = await mediaUrl(pack.id);
    pack.video = pack._url;
  } catch (e) {
    throw new Error('视频读不出来：' + e.message);
  }
  return pack;
}

/* ---------------- 播放器状态 ---------------- */

const P = {
  pack: null,
  i: 0,
  audio: null,
  media: null,
  timer: null,
  speed: 1,
  loop: false,
  recording: false,
  rec: null,
  recog: null,
  lastBlobUrl: null,
  result: null,
  busy: false,
};

function cleanup() {
  clearTimeout(P.timer);
  try { P.audio?.pause(); } catch {}
  try { P.media?.pause(); } catch {}
  if (P.recording) stopAll();
  P.audio = null;
  P.media = null;
  P.rec = null;
  P.recog = null;
  P.recording = false;
  P.result = null;
  P.pack = null;
  P.busy = false;
}

/* ---------------- 句子播放 ---------------- */

function sentenceAudioUrl(pack, idx) {
  if (pack.format === 'timeline') return pack.media;
  const s = pack.sentences[idx];
  return `packs/${pack.id}/${s.audio}`;
}

function speakFallback(text) {
  if (!('speechSynthesis' in window)) {
    toast('这个浏览器不能朗读，建议换 Chrome / Edge');
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'en-US';
  u.rate = P.speed;
  const voice = speechSynthesis.getVoices().find((v) => /en[-_]US/i.test(v.lang));
  if (voice) u.voice = voice;
  speechSynthesis.speak(u);
}

function playSentence({ rate = P.speed } = {}) {
  const pack = P.pack;
  if (!pack) return;
  const idx = P.i;
  const s = pack.sentences[idx];

  if (pack.format === 'timeline') {
    const el = P.media;
    if (!el) return;
    el.currentTime = s.start;
    el.playbackRate = rate;
    P.stopAt = s.end;
    el.play().catch((e) => toast('播放失败：' + e.message));
    return;
  }

  if (!s.audio) return speakFallback(s.en);
  if (P.audio) P.audio.pause();
  const a = new Audio(sentenceAudioUrl(pack, idx));
  P.audio = a;
  a.playbackRate = rate;
  a.onended = () => { if (P.loop) playSentence({ rate }); };
  a.play().catch((e) => {
    toast('播放失败，改用朗读');
    speakFallback(s.en);
  });
}

function stopPlayback() {
  try { P.audio?.pause(); } catch {}
  try { P.media?.pause(); } catch {}
  P.stopAt = null;
}

/* ---------------- 录音 + 识别 ---------------- */

function canRecord() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

async function startRecord() {
  if (P.recording || P.busy) return;
  const pack = P.pack;
  const s = pack.sentences[P.i];
  if (!canRecord()) {
    toast('这个浏览器不能录音，建议用 Chrome / Edge，并确认是 https 打开');
    return;
  }
  P.recording = true;
  P.result = null;
  renderPlayer(true);
  setMeter(0);
  setInterim('准备听你说…');

  try {
    const engine = store.settings().engine || 'browser';
    P.recog = engine === 'browser' && recognitionSupported() ? new Recognizer({ onInterim: (t) => setInterim(t || '…') }).start() : null;
    P.rec = await new Recorder({
      onLevel: (rms) => setMeter(Math.min(1, rms * 12)),
      onAutoStop: () => setInterim('说完自动停了'),
    }).start({ maxMs: Math.max(6000, Math.min(20000, s.en.length * 130 + 3000)) });
  } catch (e) {
    P.recording = false;
    setInterim('');
    toast('麦克风打不开：' + (e.message || e));
    renderPlayer(true);
    return;
  }
  renderPlayer(false);
}

async function stopAll() {
  if (!P.recording) return;
  const rec = P.rec;
  const recog = P.recog;
  P.recording = false;
  P.busy = true;

  const [recRes, asrRes] = await Promise.all([
    rec ? rec.stop().catch(() => null) : Promise.resolve(null),
    recog
      ? recog.stop().catch(() => ({ text: '', error: 'stop-failed' }))
      : Promise.resolve({ text: '', error: (store.settings().engine || 'browser') === 'none' ? 'engine-off' : 'unsupported' }),
  ]);

  const heard = (asrRes && asrRes.text) || '';
  const durationSec = recRes ? recRes.durationSec : 0;

  if (recRes?.url) {
    if (P.lastBlobUrl) URL.revokeObjectURL(P.lastBlobUrl);
    P.lastBlobUrl = recRes.url;
  }

  if (!heard) {
    P.busy = false;
    P.result = { empty: true, error: asrRes?.error };
    renderPlayer();
    return;
  }

  const result = scoreAttempt({ refText: P.pack.sentences[P.i].en, heardText: heard, durationSec });
  result.heard = heard;

  // 配了 Azure 就用音素级精评；失败就退回浏览器打分，不打断练习
  const st = store.settings();
  if (st.azureKey && st.azureRegion && recRes?.blob) {
    try {
      const wav = await audioToWav16k(recRes.blob);
      const az = await azureAssess({ key: st.azureKey, region: st.azureRegion, refText: P.pack.sentences[P.i].en, wav });
      result.azure = az;
      result.total = az.total;
      result.accuracy = az.accuracy;
      result.completeness = az.completeness;
      result.fluency = az.fluency;
      result.heard = az.display || heard;
      store.record(P.pack.id, P.i, result.total);
    } catch (e) {
      result.azureError = String(e.message || e);
      store.record(P.pack.id, P.i, result.total);
    }
  } else {
    store.record(P.pack.id, P.i, result.total);
  }

  P.result = result;
  P.busy = false;
  renderPlayer();
}

function setMeter(v) {
  const el = $('#meter > i');
  if (el) el.style.width = `${Math.round(v * 100)}%`;
}
function setInterim(t) {
  const el = $('#interim');
  if (el) el.textContent = t;
}

/* ---------------- 评分展示 ---------------- */

function renderResult(pack) {
  const r = P.result;
  if (!r) return null;
  if (r.empty) {
    const why = r.error === 'engine-off' ? '设置里选了「只录音，不识别」'
      : r.error === 'not-allowed' ? '浏览器拒绝了语音识别权限'
      : r.error === 'unsupported' ? '这个浏览器没有语音识别接口'
      : '没听到你说的话';
    return h('div', { class: 'card' },
      h('div', { class: 'scorehead' }, h('div', { class: 'big bad' }, '—'), h('div', { class: 'lbl' }, '这次没结果')),
      h('p', { class: 'muted' }, `${why}。可以再录一次；如果一直这样，先点上面的「示范」听一遍，再检查麦克风权限。`),
      r.error === 'engine-off'
        ? h('p', { class: 'muted' }, '想打分就把设置里的识别引擎改成「浏览器识别」。')
        : h('p', { class: 'muted' }, `刚才识别到：${r.heard || '（空）'}`)
    );
  }

  const lines = feedback(r, { heardText: r.heard });

  if (r.azure) {
    return h('div', { class: 'card' },
      h('div', { class: 'scorehead' },
        h('div', { class: `big ${scoreClass(r.azure.total)}` }, String(r.azure.total)),
        h('div', { class: 'lbl' }, 'Azure 发音评估（音素级）')
      ),
      h('div', { class: 'three' },
        h('div', {}, h('b', {}, String(r.azure.accuracy)), h('span', {}, '准确度')),
        h('div', {}, h('b', {}, String(r.azure.completeness)), h('span', {}, '完整度')),
        h('div', {}, h('b', {}, String(r.azure.fluency)), h('span', {}, '流利度'))
      ),
      h('p', { class: 'wordsline' }, '逐词：',
        ...r.azure.words.map((w) => h('span', {
          class: 'w ' + (w.error !== 'None' ? 'del' : w.score >= 80 ? 'ok' : w.score >= 60 ? '' : 'sub'),
          style: 'margin-right:6px;',
        }, `${w.word}${w.score < 80 ? ` ${w.score}` : ''}`))
      ),
      h('ul', { class: 'fb' }, lines.map((t) => h('li', {}, t))),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'ctl', onclick: () => playSentence() }, '▶ 再听'),
        P.lastBlobUrl ? h('button', { class: 'ctl', onclick: () => new Audio(P.lastBlobUrl).play() }, '🎧 我的录音') : null,
        h('button', { class: 'ctl primary', onclick: () => nextSentence() }, '下一句 →')
      )
    );
  }

  const wordEls = wordStates(pack.sentences[P.i].en, r.ops).map((w) =>
    w.state ? h('span', { class: `w ${w.state}` }, w.text) : w.text
  );

  return h('div', { class: 'card' },
    h('div', { class: 'scorehead' },
      h('div', { class: `big ${scoreClass(r.total)}` }, String(r.total)),
      h('div', { class: 'lbl' }, '本句得分' + (r.rate ? ` · ${Math.round(r.rate)} 词/分` : ''))
    ),
    h('div', { class: 'three' },
      h('div', {}, h('b', {}, String(r.accuracy)), h('span', {}, '准确度')),
      h('div', {}, h('b', {}, String(r.completeness)), h('span', {}, '完整度')),
      h('div', {}, h('b', {}, String(r.fluency)), h('span', {}, '流利度'))
    ),
    h('ul', { class: 'fb' }, lines.map((t) => h('li', {}, t))),
    h('p', { class: 'wordsline' }, '对照：', ...wordEls),
    h('p', { class: 'wordsline' }, '识别到：', h('b', {}, r.heard)),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('button', { class: 'ctl', onclick: () => playSentence() }, '▶ 再听'),
      P.lastBlobUrl ? h('button', { class: 'ctl', onclick: () => new Audio(P.lastBlobUrl).play() }, '🎧 我的录音') : null,
      h('button', { class: 'ctl primary', onclick: () => nextSentence() }, '下一句 →')
    )
  );
}

/* ---------------- 视图 ---------------- */

function topbar(title, sub, { back = false, right = null } = {}) {
  return h('div', { class: 'topbar' },
    back ? h('button', { class: 'iconbtn', onclick: () => history.back() }, '‹') : null,
    h('h1', {}, title, sub ? h('div', { class: 'sub' }, sub) : null),
    right
  );
}

async function viewHome() {
  const index = await getIndex();
  const mine = imported.list();
  const all = [
    ...mine.map((m) => ({ id: m.id, title: m.title, title_en: '', tag: '我的导入', count: m.count })),
    ...index.packs,
  ];
  const last = store.lastPack();
  const streak = store.streak();

  const lastPack = last ? all.find((p) => p.id === last.id) : null;
  const counts = collect.counts();

  return h('div', {},
    topbar('影子跟读', streak ? `已经连续练了 ${streak} 天` : '听一句，读一句，立刻知道差在哪',
      { right: h('button', { class: 'iconbtn', onclick: () => (location.hash = '#/settings') }, '⚙') }),

    h('button', {
      class: 'ctl',
      style: 'width:100%;margin-bottom:14px;justify-content:flex-start',
      onclick: () => (location.hash = '#/mine'),
    }, `★ 我的词句 · 生词 ${counts.words} · 句子 ${counts.sentences}`),

    lastPack ? h('div', { class: 'card', style: 'border-color:#2f4a7a' },
      h('div', { class: 'muted' }, '接着上次'),
      h('h2', {}, lastPack.title),
      h('div', { class: 'muted' }, `第 ${(last.sentenceIndex || 0) + 1} 句 · ${lastPack.title_en || ''}`),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', {
          class: 'ctl primary',
          onclick: () => (location.hash = `#/play/${lastPack.id}?i=${last.sentenceIndex || 0}`),
        }, '继续练')
      )
    ) : null,

    h('div', { class: 'grid' }, all.map((p) => packCard(p))),

    h('button', {
      class: 'ctl',
      style: 'width:100%;margin-top:14px',
      onclick: () => (location.hash = '#/import'),
    }, '＋ 导入自己的视频 + 字幕'),

    h('p', { class: 'muted', style: 'text-align:center;margin:18px 0 0' },
      '点词可以查意思 · 录音只存在本机')
  );
}

function packCard(p) {
  const st = store.packStats(p.id, p.count || 10);
  return h('div', { class: 'packcard', onclick: () => (location.hash = `#/pack/${p.id}`) },
    h('span', { class: 'tag' }, p.tag || '情景'),
    h('div', {},
      h('div', { class: 't' }, p.title),
      h('div', { class: 'e' }, p.title_en || '')
    ),
    h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(st.rate * 100)}%` }))
  );
}

async function viewPack(id) {
  const pack = await getPack(id);
  const prog = store.progress(id);
  return h('div', {},
    topbar(pack.title, `${pack.sentences.length} 句 · ${pack.level || ''}`, { back: true }),
    h('p', { class: 'muted', style: 'margin-top:-6px;margin-bottom:16px' }, pack.intro || ''),
    !recognitionSupported() ? h('div', { class: 'notice' },
      '这个浏览器没有语音识别接口，打分用不了；录音和示范还能用。换成 Chrome / Edge（安卓）打开这个网址试试。') : null,
    h('div', { class: 'row', style: 'margin-bottom:16px' },
      h('button', { class: 'ctl primary', onclick: () => (location.hash = `#/play/${id}?i=0`) }, '开始逐句跟读'),
      h('button', { class: 'ctl', onclick: () => (location.hash = `#/shadow/${id}`) }, '整段影子跟读')
    ),
    pack.imported ? h('button', {
      class: 'ctl',
      style: 'width:100%;margin-bottom:16px',
      onclick: async () => {
        if (!confirm('删掉这个导入？视频和句子都会从本机移除。')) return;
        await imported.remove(pack.id);
        packCache.delete(pack.id);
        toast('已删除');
        location.hash = '#/';
      },
    }, '删除这个导入') : null,
    h('ul', { class: 'list' }, pack.sentences.map((s, i) => {
      const sc = prog[i]?.score;
      return h('li', { onclick: () => (location.hash = `#/play/${id}?i=${i}`) },
        h('span', { class: 'no' }, String(i + 1)),
        h('span', { class: 'txt' }, s.en, s.zh ? h('small', {}, s.zh) : null),
        h('span', { class: `sc ${scoreClass(sc)}` }, sc == null ? '—' : String(sc))
      );
    }))
  );
}

async function viewPlay(id, params) {
  const pack = await ensurePlayable(await getPack(id));
  P.pack = pack;
  P.i = Math.max(0, Math.min(pack.sentences.length - 1, Number(params.get('i') || 0)));
  P.speed = store.settings().speed || 1;
  store.setLastPack(id, P.i);
  renderPlayer();

  // 演示模式：?demo=1 直接摆一张「模拟打分」结果，用来检查界面长什么样
  if (params.get('demo') === '1') {
    const s = pack.sentences[P.i];
    const toks = s.en.replace(/[^A-Za-z' ]/g, '').split(/\s+/).filter(Boolean);
    const drop = Math.min(2, toks.length - 1);
    const heard = toks.filter((_, k) => k !== drop).join(' ').toLowerCase();
    const r = scoreAttempt({ refText: s.en, heardText: heard, durationSec: Math.max(1.2, toks.length / 2.1) });
    r.heard = heard;
    P.result = r;
    renderPlayer();
  }
}

function currentSentence() {
  return P.pack.sentences[P.i];
}

function renderPlayer(forceControls = true) {
  if (!P.pack) return;
  const pack = P.pack;
  const s = currentSentence();
  const settings = store.settings();
  const existing = $('#playerroot');

  const words = s.en.split(/(\s+)/).map((w, idx) => {
    if (!w.trim()) return w;
    const wordIndex = s.en.split(/(\s+)/).slice(0, idx + 1).filter((x) => x.trim()).length - 1;
    return h('span', { class: 'w', dataset: { i: String(wordIndex) }, onclick: () => openWord(wordIndex) }, w);
  });

  const media = pack.video
    ? h('div', { class: 'mediabox' },
        h('video', {
          class: 'media', src: pack.video, playsinline: true, preload: 'metadata',
          controls: false,
          onloadedmetadata: (e) => { P.media = e.target; if (pack.format === 'timeline') e.target.currentTime = s.start + 0.05; },
          ontimeupdate: (e) => {
            if (P.stopAt && e.target.currentTime >= P.stopAt) {
              e.target.pause();
              P.stopAt = null;
              if (P.loop) setTimeout(() => playSentence(), 500);
            }
          },
        }),
        h('button', { class: 'playover', 'aria-label': '播放这句', onclick: () => playSentence() }, '▶')
      )
    : pack.audio
      ? h('audio', {
          class: 'media', src: pack.audio, controls: true, preload: 'metadata',
          onloadedmetadata: (e) => { P.media = e.target; },
          ontimeupdate: (e) => {
            if (P.stopAt && e.target.currentTime >= P.stopAt) {
              e.target.pause();
              P.stopAt = null;
            }
          },
        })
      : null;

  const root = h('div', { id: 'playerroot' },
    topbar(pack.title, `第 ${P.i + 1} / ${pack.sentences.length} 句`, { back: true }),
    media,
    h('div', { class: 'card' },
      h('div', { class: 'row', style: 'margin-bottom:10px' },
        h('button', { class: 'ctl', onclick: () => playSentence() }, '▶ 示范'),
        h('button', { class: 'ctl', onclick: () => playSentence({ rate: 0.7 }) }, '🐢 慢速'),
        h('button', {
          class: 'ctl',
          style: P.loop ? 'background:#2a3342;border-color:#3a4757' : '',
          onclick: () => { P.loop = !P.loop; renderPlayer(); },
        }, P.loop ? '🔁 循环中' : '🔁 循环')
      ),
      h('p', { class: 'sentence' }, words),
      settings.showZh && s.zh ? h('p', { class: 'zh' }, s.zh) : null,
      s.tip ? h('p', { class: 'tip' }, '💡 ' + s.tip) : null,
      h('div', { class: 'row', style: 'justify-content:space-between;margin-top:8px' },
        h('span', { class: 'muted' },
          s.role === 'you' ? '👤 这句是你说的'
            : s.role === 'speaker' ? '🎙 演讲者原声'
            : s.role === 'staff' ? '🗣 这句是对方说的，先听懂' : ''),
        h('button', {
          class: 'ctl',
          style: 'height:34px;min-width:34px;padding:0 12px;font-size:13px',
          onclick: () => {
            if (collect.hasSentence(P.pack.id, P.i)) {
              collect.removeSentence(P.pack.id, P.i);
              toast('已取消收藏');
            } else {
              collect.addSentence({ pack: P.pack.id, idx: P.i, en: s.en, zh: s.zh || '' });
              toast('已收藏这句');
            }
            renderPlayer();
          },
        }, collect.hasSentence(P.pack.id, P.i) ? '★ 已收藏' : '☆ 收藏这句')
      ),
      h('div', { class: 'meter', id: 'meter' }, h('i')),
      h('div', { class: 'interim', id: 'interim' }, P.recording ? '准备听你说…' : ''),
      h('div', { class: 'controls' },
        h('button', { class: 'ctl', onclick: () => prevSentence() }, '‹'),
        h('button', {
          class: `ctl ${P.recording ? 'rec on' : 'primary'}`,
          onclick: () => (P.recording ? stopAll() : startRecord()),
          disabled: P.busy ? 'disabled' : null,
        }, P.recording ? '■ 停止' : '🎤 跟读这句'),
        h('button', { class: 'ctl', onclick: () => nextSentence() }, '›')
      )
    ),
    renderResult(pack)
  );

  if (existing) existing.replaceWith(root);
  else app.replaceChildren(root);
  window.scrollTo({ top: 0 });
}

function prevSentence() {
  if (P.i > 0) {
    stopPlayback();
    P.result = null;
    P.i--;
    store.setLastPack(P.pack.id, P.i);
    renderPlayer();
  }
}

function nextSentence() {
  if (P.i < P.pack.sentences.length - 1) {
    stopPlayback();
    P.result = null;
    P.i++;
    store.setLastPack(P.pack.id, P.i);
    renderPlayer();
  } else {
    toast('这一课练完了，可以整段影子跟读一遍');
  }
}

/* ---------------- 查词 ---------------- */

async function openWord(i) {
  const s = currentSentence();
  const tokens = s.en.split(/\s+/).filter(Boolean);
  await loadDict();
  const hit = lookupAt(tokens, i);
  const raw = tokens[i] || '';
  const phrase = hit ? hit.phrase : raw.replace(/[^A-Za-z'’-]/g, '');
  const meaning = hit ? (hit.entry.m || []).join('；') : '';
  const phonetic = hit && hit.entry.p ? hit.entry.p : '';

  const favBtn = () => {
    const on = collect.hasWord(phrase);
    return h('button', {
      class: 'ctl',
      onclick: (e) => {
        if (on) {
          collect.removeWord(phrase);
          toast('已从生词本移除');
        } else {
          collect.addWord({
            word: phrase,
            phonetic,
            meaning,
            pack: P.pack.id,
            idx: P.i,
            en: s.en,
            zh: s.zh || '',
          });
          toast('已加入生词本');
        }
        closeSheet();
      },
    }, on ? '★ 已收藏' : '☆ 收藏');
  };

  const inner = hit
    ? h('div', { class: 'inner' },
        h('h3', {}, hit.phrase, hit.entry.p ? h('span', { class: 'ph' }, hit.entry.p) : null),
        h('div', { class: 'mean' }, (hit.entry.m || []).map((m) => h('div', {}, m))),
        h('div', { class: 'row' },
          favBtn(),
          h('button', { class: 'ctl', onclick: () => speakFallback(hit.phrase) }, '🔊 读一下'),
          h('a', { class: 'ctl', href: youdaoUrl(hit.phrase), target: '_blank' }, '有道'),
          h('button', { class: 'ctl primary', onclick: closeSheet }, '知道了')
        )
      )
    : h('div', { class: 'inner' },
        h('h3', {}, phrase),
        h('p', { class: 'muted' }, '本地词典里没有这个词。可以去有道看，或者先在句子里猜意思。'),
        h('div', { class: 'row' },
          favBtn(),
          h('a', { class: 'ctl primary', href: youdaoUrl(raw), target: '_blank' }, '有道查这个词'),
          h('button', { class: 'ctl', onclick: closeSheet }, '关掉')
        )
      );

  sheet.replaceChildren(inner);
  sheet.hidden = false;
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
}

function closeSheet() {
  sheet.hidden = true;
}

/* ---------------- 影子跟读（整段） ---------------- */

async function viewShadow(id) {
  const pack = await ensurePlayable(await getPack(id));
  P.pack = pack;
  P.i = 0;

  let streaming = false;
  let mediaEl = null;
  let seqToken = 0;

  const rec = new Recorder();
  const state = { url: null, sec: 0 };

  const stopBtn = h('button', { class: 'ctl primary', onclick: () => finish() }, '开始影子跟读');
  const info = h('p', { class: 'muted' }, '点开始后，示范会连续播放，你同时跟着说。戴耳机效果最好。');
  const playbackBox = h('div', {});

  async function finish() {
    streaming = false;
    seqToken++;
    try { mediaEl?.pause(); } catch {}
    const res = await rec.stop().catch(() => null);
    if (res) {
      state.url = res.url;
      state.sec = res.durationSec;
    }
    render();
  }

  function render() {
    const body = state.url
      ? h('div', {},
          h('div', { class: 'card' },
            h('h2', {}, '你的跟读'),
            h('audio', { class: 'media', src: state.url, controls: true }),
            h('p', { class: 'muted' }, `录了 ${state.sec.toFixed(1)} 秒。和上面的示范对比着听，看是节奏跟不上，还是某些词读得不一样。`)
          )
        )
      : h('div', { class: 'card' },
          h('p', { class: 'muted' }, '影子跟读不打分：一边放音一边说，麦克风会同时收到示范的声音，分数没有意义。这里只录音，用来和示范对比。'),
          stopBtn
        );

    app.replaceChildren(
      topbar('整段影子跟读', pack.title, { back: true }),
      h('div', { class: 'card' },
        h('h2', {}, '示范'),
        pack.format === 'timeline'
          ? h(pack.video ? 'video' : 'audio', { class: 'media', src: pack.video || pack.audio, controls: true })
          : h('div', {}, pack.sentences.map((s) => h('p', { class: 'muted', style: 'margin:4px 0' }, s.en))),
        info
      ),
      body
    );
  }

  async function startShadow() {
    if (streaming) return finish();
    streaming = true;
    stopBtn.textContent = '■ 停止并听回放';
    try {
      await rec.start({ maxMs: 180000, silenceMs: 100000, minMs: 999999 });
    } catch (e) {
      streaming = false;
      toast('麦克风打不开：' + (e.message || e));
      return;
    }
    // 连续播放
    const token = ++seqToken;
    if (pack.format === 'timeline') {
      mediaEl = app.querySelector('video, audio');
      if (mediaEl) {
        mediaEl.currentTime = pack.sentences[0].start;
        await mediaEl.play().catch(() => {});
        mediaEl.onended = () => streaming && finish();
      }
    } else {
      for (let i = 0; i < pack.sentences.length && token === seqToken; i++) {
        const s = pack.sentences[i];
        await new Promise((resolve) => {
          if (!s.audio) {
            const u = new SpeechSynthesisUtterance(s.en);
            u.lang = 'en-US';
            u.onend = resolve;
            u.onerror = resolve;
            speechSynthesis.speak(u);
            return;
          }
          const a = new Audio(`packs/${pack.id}/${s.audio}`);
          a.onended = resolve;
          a.onerror = resolve;
          a.play().catch(resolve);
        });
      }
      if (token === seqToken && streaming) finish();
    }
  }

  stopBtn.onclick = startShadow;
  render();
}

/* ---------------- 导入自己的视频 ---------------- */

async function viewImport() {
  const state = { file: null, en: '', zh: '', sentences: null };
  const status = h('p', { class: 'muted' }, '选一个视频（或音频），再选它的英文字幕。中文字幕可选，有的话每句下面会显示中文。');

  // 从安卓分享菜单进来的文件
  try {
    const shared = await takeShared();
    if (shared) {
      state.file = shared;
      status.textContent = `从分享菜单收到：${shared.name}（${(shared.size / 1e6).toFixed(1)} MB）。还差英文字幕，选一下。`;
      status.style.color = 'var(--good)';
    }
  } catch {}

  const nameInput = h('input', { type: 'text', placeholder: '片段名字，留空就用文件名' });

  const videoInput = h('input', {
    type: 'file',
    accept: 'video/*,audio/*',
    onchange: (e) => {
      state.file = e.target.files[0] || null;
      status.textContent = state.file
        ? `已选：${state.file.name}（${(state.file.size / 1e6).toFixed(1)} MB）`
        : '没选文件';
    },
  });

  const enInput = h('input', {
    type: 'file',
    accept: '.srt,.vtt,text/plain',
    onchange: async (e) => {
      const f = e.target.files[0];
      state.en = f ? await f.text() : '';
      tryParse();
    },
  });

  const zhInput = h('input', {
    type: 'file',
    accept: '.srt,.vtt,text/plain',
    onchange: async (e) => {
      const f = e.target.files[0];
      state.zh = f ? await f.text() : '';
      tryParse();
    },
  });

  function tryParse() {
    if (!state.en) return;
    try {
      state.sentences = buildSentences(state.en, state.zh);
      status.textContent = `解析成功：${state.sentences.length} 句。确认没问题就点下面的按钮存进来。`;
      status.style.color = 'var(--good)';
    } catch (err) {
      state.sentences = null;
      status.textContent = '字幕解析失败：' + err.message;
      status.style.color = 'var(--bad)';
    }
  }

  const asrBtn = h('button', { class: 'ctl', style: 'width:100%;margin-top:4px', onclick: runAsr },
    '🎙 没有字幕？在本机自动生成');
  const asrHint = h('p', { class: 'muted', style: 'margin:8px 0 0' },
    'Whisper 在这台手机上跑，音频不上传。3 分钟的视频大概等 3–8 分钟，等的时候别锁屏。');

  let asrBusy = false;
  async function runAsr() {
    if (asrBusy) return;
    if (!state.file) return toast('先选视频');
    if (state.file.size > 400e6) return toast('文件超过 400MB，先剪短一点再导入');
    asrBusy = true;
    asrBtn.disabled = true;
    const t0 = Date.now();
    const tick = setInterval(() => {
      asrHint.textContent = `处理中…已等 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`;
    }, 1000);
    try {
      const model = store.settings().model || 'tiny';
      const res = await transcribeFile(state.file, {
        model,
        onProgress: (p) => {
          if (p.phase === 'model') asrHint.textContent = `准备模型 ${Math.round((p.pct || 0) * 100)}%`;
          else if (p.phase === 'decode') asrHint.textContent = '解析音频…';
          else if (p.phase === 'asr') asrHint.textContent = `识别中…（音频 ${Math.round(p.seconds)} 秒）`;
        },
      });
      state.sentences = res.sentences;
      status.textContent = `识别出 ${res.sentences.length} 句（音频 ${Math.round(res.duration)} 秒）。检查一下，没问题点「导入」。`;
      status.style.color = 'var(--good)';
      asrHint.textContent = `用时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒。不满意可以在设置里换「更准版」再跑一次。`;
    } catch (e) {
      status.textContent = '识别失败：' + (e.message || e);
      status.style.color = 'var(--bad)';
      asrHint.textContent = '可能是模型文件没下来，或者这个音频格式解不开。也可以改用手动字幕。';
    } finally {
      clearInterval(tick);
      asrBusy = false;
      asrBtn.disabled = false;
    }
  }

  const go = h('button', {
    class: 'ctl primary',
    style: 'width:100%',
    onclick: async () => {
      if (!state.file) return toast('先选一个视频文件');
      if (!state.sentences) {
        if (!state.en) return toast('要么点「自动生成」，要么选一个英文字幕');
        tryParse();
      }
      if (!state.sentences) return toast('字幕解析失败，检查一下文件');
      go.disabled = true;
      go.textContent = '存到本机…';
      try {
        const pack = await imported.save({ title: nameInput.value.trim(), file: state.file, sentences: state.sentences });
        toast(`导入成功，${pack.sentences.length} 句`);
        location.hash = `#/pack/${pack.id}`;
      } catch (e) {
        go.disabled = false;
        go.textContent = '导入';
        toast('存不进去：' + (e.message || e));
      }
    },
  }, '导入');

  return h('div', {},
    topbar('导入自己的视频', null, { back: true }),
    h('div', { class: 'notice' },
      '视频只存在这台手机里，不上传。字幕有两种给法：自己选 SRT/VTT 文件，或者点下面的按钮让它在本机自动生成。'),
    h('div', { class: 'card' },
      h('div', { class: 'field' }, h('label', {}, '视频 / 音频'), videoInput),
      h('div', { class: 'field', style: 'background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:16px' },
        h('label', { style: 'margin-bottom:8px' }, '自动生成字幕（推荐）'),
        asrBtn,
        asrHint
      ),
      h('div', { class: 'field' }, h('label', {}, '或者：自己选英文字幕'), enInput),
      h('div', { class: 'field' }, h('label', {}, '中文字幕（可选，自动生成的不带中文）'), zhInput),
      h('div', { class: 'field' }, h('label', {}, '名字'), nameInput),
      status,
      h('div', { style: 'margin-top:14px' }, go)
    ),
    h('p', { class: 'muted' }, '自动生成只适合 3 分钟以内的片段；再长会等到没耐心。句子太多也会占用不少存储。')
  );
}

/* ---------------- 我的词句 ---------------- */

async function viewMine() {
  const index = await getIndex();
  const titles = new Map();
  for (const p of index.packs) titles.set(p.id, p.title);
  for (const m of imported.list()) titles.set(m.id, m.title);

  const words = collect.words().sort((a, b) => (b.added || 0) - (a.added || 0));
  const sents = collect.sentences().sort((a, b) => (b.added || 0) - (a.added || 0));
  const queue = collect.reviewQueue(1)[0];

  const jump = (pack, idx) => {
    if (!pack || idx == null || idx < 0) return toast('这句的来源已经找不到了');
    location.hash = `#/play/${pack}?i=${idx}`;
  };

  const wordRow = (w) => h('li', { onclick: () => jump(w.pack, w.idx) },
    h('span', { class: 'txt' },
      h('b', {}, w.word),
      w.phonetic ? h('span', { class: 'ph', style: 'margin-left:8px' }, w.phonetic) : null,
      h('small', {}, `${w.meaning || '（无释义）'} · 来自《${titles.get(w.pack) || w.pack || '?'}》· 练过 ${w.reviews || 0} 次`)
    ),
    h('button', {
      class: 'iconbtn', style: 'height:32px;width:32px;font-size:14px',
      onclick: (e) => { e.stopPropagation(); collect.removeWord(w.word); render(); toast('已移除'); },
    }, '✕')
  );

  const sentRow = (s) => h('li', { onclick: () => jump(s.pack, s.idx) },
    h('span', { class: 'txt' },
      s.en,
      h('small', {}, `${s.zh || ''} · 来自《${titles.get(s.pack) || s.pack || '?'}》· 练过 ${s.reviews || 0} 次`)
    ),
    h('button', {
      class: 'iconbtn', style: 'height:32px;width:32px;font-size:14px',
      onclick: (e) => { e.stopPropagation(); collect.removeSentence(s.pack, s.idx); render(); toast('已移除'); },
    }, '✕')
  );

  const body = h('div', {});
  function render() {
    body.replaceChildren(
      h('div', { class: 'card' },
        h('h2', {}, `生词 ${words.length} 个 · 句子 ${sents.length} 句`),
        h('p', { class: 'muted' }, '点一条回到原句，听一遍、跟读一遍，就算复习过一次。'),
        queue ? h('button', {
          class: 'ctl primary', style: 'width:100%;margin-top:10px',
          onclick: () => jump(queue.kind === 'word' ? queue.pack : queue.pack, queue.idx),
        }, '▶ 复习下一条') : null
      ),
      h('div', { class: 'card' },
        h('h2', {}, '生词'),
        words.length ? h('ul', { class: 'list' }, words.map(wordRow))
          : h('p', { class: 'muted' }, '还没有。练的时候点句子里不认识的词，弹层里按「☆ 收藏」。')
      ),
      h('div', { class: 'card' },
        h('h2', {}, '句子'),
        sents.length ? h('ul', { class: 'list' }, sents.map(sentRow))
          : h('p', { class: 'muted' }, '还没有。练习页句子下面按「☆ 收藏这句」。')
      )
    );
  }
  render();

  return h('div', {}, topbar('我的词句', null, { back: true }), body);
}

/* ---------------- 设置 ---------------- */

async function viewSettings() {
  const s = store.settings();
  const cap = {
    recognition: recognitionSupported(),
    mic: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
    audioCtx: !!(window.AudioContext || window.webkitAudioContext),
    tts: 'speechSynthesis' in window,
    secure: window.isSecureContext,
  };

  const row = (label, ok, extra = '') => h('li', {},
    h('span', { class: 'txt' }, label, extra ? h('small', {}, extra) : null),
    h('span', { class: 'sc ' + (ok ? 'good' : 'bad') }, ok ? '✓ 可用' : '✕ 不可用')
  );

  return h('div', {},
    topbar('设置', null, { back: true }),

    h('div', { class: 'card' },
      h('h2', {}, '这台手机能不能用'),
      h('ul', { class: 'list' },
        row('语音识别（打分要用）', cap.recognition, cap.recognition ? 'Web Speech API' : '换 Edge / Chrome 试试'),
        row('麦克风', cap.mic),
        row('音频处理', cap.audioCtx),
        row('系统朗读', cap.tts, '示范音频缺失时兜底'),
        row('安全上下文（https）', cap.secure, cap.secure ? '' : '必须 https 才能用麦克风')
      ),
      !cap.recognition ? h('div', { class: 'notice', style: 'margin-top:12px' },
        '你的浏览器没有语音识别接口。安卓上一般是：换成 Edge 或 Chrome；国产浏览器（夸克/UC/微信内置）大多不支持。') : null
    ),

    h('div', { class: 'card' },
      h('h2', {}, '练习偏好'),
      h('div', { class: 'field' },
        h('label', {}, '显示中文'),
        h('select', {
          onchange: (e) => { store.saveSettings({ showZh: e.target.value === '1' }); toast('已保存'); },
        },
          h('option', { value: '1', selected: s.showZh ? 'selected' : null }, '显示'),
          h('option', { value: '0', selected: !s.showZh ? 'selected' : null }, '隐藏')
        )
      ),
      h('div', { class: 'field' },
        h('label', {}, '默认示范语速'),
        h('select', {
          onchange: (e) => { store.saveSettings({ speed: Number(e.target.value) }); toast('已保存'); },
        },
          h('option', { value: '0.7', selected: s.speed === 0.7 ? 'selected' : null }, '慢速 0.7x'),
          h('option', { value: '1', selected: s.speed === 1 ? 'selected' : null }, '正常 1.0x'),
          h('option', { value: '1.15', selected: s.speed === 1.15 ? 'selected' : null }, '稍快 1.15x')
        )
      ),
      h('div', { class: 'field' },
        h('label', {}, '识别引擎（用来把你说的转成文字）'),
        h('select', {
          onchange: (e) => { store.saveSettings({ engine: e.target.value }); toast('已保存'); },
        },
          h('option', { value: 'browser', selected: (s.engine || 'browser') === 'browser' ? 'selected' : null }, '浏览器识别（免费，国内安卓可能不可用）'),
          h('option', { value: 'none', selected: s.engine === 'none' ? 'selected' : null }, '只录音，不识别（不打分）'),
          h('option', { value: 'doubao', disabled: true }, '豆包识别（待接入）')
        ),
        h('p', { class: 'muted', style: 'margin:6px 0 0' }, '上面「语音识别」那行如果显示 ✕，就说明这个浏览器没有识别接口，先用「只录音」也能练。')
      ),
      h('div', { class: 'field' },
        h('label', {}, '自动生成字幕用的模型'),
        h('select', {
          onchange: (e) => { store.saveSettings({ model: e.target.value }); toast('已保存'); },
        },
          h('option', { value: 'tiny', selected: (s.model || 'tiny') === 'tiny' ? 'selected' : null }, '快速版 whisper-tiny（43MB，约 1 倍实时）'),
          h('option', { value: 'base', disabled: true }, '更准版 whisper-base（79MB，暂未随站点发布）')
        )
      )
    ),

    h('div', { class: 'card' },
      h('h2', {}, '精评（可选）'),
      h('p', { class: 'muted' }, '默认用浏览器识别打分，免费。填了 Azure 的 key 之后可以切换成音素级发音评分；key 只存在你这台手机上，不会上传到别处。'),
      h('div', { class: 'field' },
        h('label', {}, 'Azure region（如 eastus）'),
        h('input', { type: 'text', value: s.azureRegion, placeholder: 'eastus', oninput: (e) => (s.azureRegion = e.target.value.trim()) })
      ),
      h('div', { class: 'field' },
        h('label', {}, 'Azure key'),
        h('input', { type: 'password', value: s.azureKey, placeholder: '粘贴 key', oninput: (e) => (s.azureKey = e.target.value.trim()) })
      ),
      h('button', {
        class: 'ctl primary',
        onclick: () => { store.saveSettings({ azureKey: s.azureKey, azureRegion: s.azureRegion }); toast('已保存（精评接入下一版在练习页出现）'); },
      }, '保存')
    ),

    h('div', { class: 'card' },
      h('h2', {}, '数据'),
      h('p', { class: 'muted' }, '进度、生词、收藏、设置都只在这台手机上。换手机或换网址前，先导出一份备份。'),
      h('div', { class: 'row', style: 'margin-bottom:12px' },
        h('button', { class: 'ctl', onclick: () => { downloadBackup(); toast('备份文件已下载'); } }, '导出备份'),
        h('label', { class: 'ctl', style: 'cursor:pointer' },
          '导入备份',
          h('input', {
            type: 'file', accept: '.json,application/json', style: 'display:none',
            onchange: async (e) => {
              const f = e.target.files[0];
              if (!f) return;
              try {
                const json = JSON.parse(await f.text());
                const n = importBackup(json);
                toast(`导入了 ${n} 项，正在刷新`);
                setTimeout(() => location.reload(), 600);
              } catch (err) {
                toast('导入失败：' + (err.message || err));
              }
            },
          })
        )
      ),
      h('button', {
        class: 'ctl',
        onclick: () => { if (confirm('清空所有练习进度、生词和设置？')) { store.resetAll(); location.hash = '#/'; toast('已清空'); } },
      }, '清空本机数据')
    ),

    h('p', { class: 'muted', style: 'text-align:center;margin-top:20px' }, 'v0.1 · 自用')
  );
}

/* ---------------- 路由 ---------------- */

async function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  cleanup();
  closeSheet();
  try {
    if (!parts.length) app.replaceChildren(await viewHome());
    else if (parts[0] === 'pack') app.replaceChildren(await viewPack(parts[1]));
    else if (parts[0] === 'play') await viewPlay(parts[1], params);
    else if (parts[0] === 'shadow') await viewShadow(parts[1]);
    else if (parts[0] === 'import') app.replaceChildren(await viewImport());
    else if (parts[0] === 'mine') app.replaceChildren(await viewMine());
    else if (parts[0] === 'settings') app.replaceChildren(await viewSettings());
    else app.replaceChildren(await viewHome());
  } catch (e) {
    app.replaceChildren(
      topbar('出错了', null, { back: true }),
      h('div', { class: 'card' }, h('p', { class: 'muted' }, String(e.message || e)))
    );
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
if (document.readyState !== 'loading') route();

// 离线壳（必须 https，本地 http://localhost 也算安全上下文）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
