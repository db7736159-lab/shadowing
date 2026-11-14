// 本地语音识别：Whisper 跑在浏览器里（WASM），模型文件跟站点一起发布。
// 不需要 key、不联网（除了第一次加载识别库），音频不出手机。

import { mergeSentences } from './subtitle.js';

// 识别库和 wasm 都放在站点自己的 vendor/ 目录里：
// 手机连不上 jsDelivr（实测会 Failed to fetch），不能依赖任何 CDN。
const LIB = new URL('../vendor/transformers/transformers.min.js', import.meta.url).href;
const WASM_PATH = new URL('../vendor/transformers/', import.meta.url).href;

export const MODELS = {
  tiny: { id: 'Xenova/whisper-tiny.en', dir: 'whisper-tiny.en', label: '快速版（43MB，约 1 倍实时）' },
  base: { id: 'Xenova/whisper-base.en', dir: 'whisper-base.en', label: '更准版（79MB，慢 2–3 倍）' },
};

// 模型文件跟站点一起发布（models/ 目录），不从 HuggingFace 下载：
// 国内直连 HuggingFace 不稳定，浏览器直连 hf-mirror 也会被 CORS 挡掉。
let libPromise = null;
const pipes = new Map();

function loadLib() {
  if (!libPromise) libPromise = import(/* @vite-ignore */ LIB);
  return libPromise;
}

/** 加载识别模型（第一次要下载，之后走浏览器缓存） */
export async function loadModel(model = 'tiny', onProgress) {
  const key = MODELS[model] ? model : 'tiny';
  if (pipes.has(key)) return pipes.get(key);
  const { pipeline, env } = await loadLib();
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = new URL('models/', document.baseURI).href;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = WASM_PATH;

  const pipe = await pipeline('automatic-speech-recognition', MODELS[key].dir, {
    dtype: 'q8',
    progress_callback: (p) => {
      if (!onProgress) return;
      if (p.status === 'progress' && p.total) onProgress({ phase: 'model', pct: p.progress / 100, file: p.file });
      else if (p.status === 'done') onProgress({ phase: 'model', pct: 1, file: p.name });
    },
  });
  pipes.set(key, pipe);
  return pipe;
}

/** 视频/音频文件 → 16kHz 单声道 Float32 */
export async function decodeTo16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let audio;
  try {
    audio = await ctx.decodeAudioData(buf.slice(0));
  } finally {
    ctx.close().catch(() => {});
  }
  const ch = audio.getChannelData(0);
  const ratio = audio.sampleRate / 16000;
  const len = Math.floor(ch.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, ch.length - 1);
    const f = pos - i0;
    out[i] = ch[i0] * (1 - f) + ch[i1] * f;
  }
  return { pcm: out, duration: audio.duration };
}

/**
 * 识别一个视频/音频文件，返回能直接进导入流程的句子。
 * @returns {{sentences: Array<{text,start,end}>, duration: number, text: string}}
 */
export async function transcribeFile(blob, { model = 'tiny', onProgress } = {}) {
  const asr = await loadModel(model, onProgress);
  onProgress?.({ phase: 'decode', pct: 0 });
  const { pcm, duration } = await decodeTo16k(blob);
  const seconds = pcm.length / 16000;

  onProgress?.({ phase: 'asr', pct: 0, seconds });
  const res = await asr(pcm, {
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
  });

  const chunks = (res.chunks || []).map((c) => {
    const start = Array.isArray(c.timestamp) ? c.timestamp[0] : 0;
    const end = Array.isArray(c.timestamp) && c.timestamp[1] != null ? c.timestamp[1] : start + 2;
    const text = (c.text || '')
      .replace(/\[[^\]]*\]/g, ' ')   // 去掉 [MUSIC] [APPLAUSE] 这类标记
      .replace(/\s+/g, ' ')
      .trim();
    return { start: Math.max(0, start), end: Math.max(start + 0.2, end), text };
  }).filter((c) => c.text && /[a-z]/i.test(c.text));

  // Whisper 常把好几句话塞进一个片段，按标点再切开，时间按字数比例分
  const split = [];
  for (const c of chunks) {
    const parts = c.text.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (parts.length <= 1) {
      split.push(c);
      continue;
    }
    const totalChars = parts.reduce((n, p) => n + p.length, 0) || 1;
    let t = c.start;
    for (const p of parts) {
      const d = (c.end - c.start) * (p.length / totalChars);
      split.push({ start: t, end: t + d, text: p });
      t += d;
    }
  }

  const merged = mergeSentences(split, { maxGap: 1.0, maxSec: 15, minChars: 12 });
  return {
    sentences: merged.map((s) => ({ text: s.text, start: s.start, end: s.end })),
    duration: duration || seconds,
    text: res.text || '',
  };
}
