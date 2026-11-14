// 语音：浏览器识别（Web Speech）、录音 + 静音检测、WAV 编码、Azure 精评。
// 全部在浏览器里跑，音频不经过我们的服务器。

/* ---------------- 浏览器语音识别 ---------------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

export function recognitionSupported() {
  return !!SR;
}

/**
 * 一次性识别：start() 后自动累积 final 结果，stop() 后 resolve 全量文本。
 * 注意：Chrome 要求 start() 处在一次用户手势里，别在定时器里偷偷启动。
 */
export class Recognizer {
  constructor({ lang = 'en-US', onInterim } = {}) {
    this.lang = lang;
    this.onInterim = onInterim;
    this.finalText = '';
    this.error = null;
    this._done = null;
  }

  static supported() {
    return !!SR;
  }

  start() {
    if (!SR) throw new Error('这个浏览器没有语音识别接口');
    const rec = new SR();
    this.rec = rec;
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += (this.finalText ? ' ' : '') + r[0].transcript.trim();
        else interim += r[0].transcript;
      }
      if (this.onInterim) this.onInterim(interim, this.finalText);
    };
    rec.onerror = (e) => {
      this.error = e.error || 'unknown';
    };
    rec.onend = () => {
      if (this._done) this._done();
    };
    try {
      rec.start();
    } catch (e) {
      this.error = e.message || String(e);
    }
    return this;
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec) return resolve({ text: '', error: 'not-started' });
      this._done = () => resolve({ text: this.finalText.trim(), error: this.error });
      try {
        this.rec.stop();
      } catch {
        resolve({ text: this.finalText.trim(), error: this.error });
      }
      // 兜底：某些浏览器 stop 后不触发 onend
      setTimeout(() => {
        if (this._done) {
          const d = this._done;
          this._done = null;
          d();
        }
      }, 1500);
    });
  }
}

/* ---------------- 录音 + 静音检测 ---------------- */

const TARGET_RATE = 16000;

export class Recorder {
  constructor({ onLevel, onAutoStop } = {}) {
    this.onLevel = onLevel;
    this.onAutoStop = onAutoStop;
  }

  async start({ silenceMs = 1000, minMs = 900, maxMs = 15000 } = {}) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.samples = new Float32Array(this.analyser.fftSize);
    this.chunks = [];

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    this.mr = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this._stopped = new Promise((resolve) => {
      this.mr.onstop = async () => {
        const blob = new Blob(this.chunks, { type: this.mr.mimeType || 'audio/webm' });
        resolve(blob);
      };
    });
    this.mr.start(100);

    this.startedAt = performance.now();
    this.endedAt = null;
    this.spoke = false;
    this.silenceStart = 0;
    this._raf = requestAnimationFrame(() => this._tick({ silenceMs, minMs, maxMs }));
    return this;
  }

  _tick({ silenceMs, minMs, maxMs }) {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (let i = 0; i < this.samples.length; i++) sum += this.samples[i] * this.samples[i];
    const rms = Math.sqrt(sum / this.samples.length);
    this.onLevel?.(rms);
    const now = performance.now();
    const elapsed = now - this.startedAt;
    if (rms > 0.012) {
      this.spoke = true;
      this.silenceStart = 0;
    } else if (this.spoke && !this.silenceStart) {
      this.silenceStart = now;
    }
    if (elapsed > maxMs) return this._autoStop('max');
    if (this.spoke && this.silenceStart && now - this.silenceStart > silenceMs && elapsed > minMs) {
      return this._autoStop('silence');
    }
    this._raf = requestAnimationFrame(() => this._tick({ silenceMs, minMs, maxMs }));
  }

  _autoStop(reason) {
    this.endedAt = performance.now();
    this.onAutoStop?.(reason);
    this.stop();
  }

  get durationSec() {
    const end = this.endedAt || performance.now();
    return Math.max(0, (end - this.startedAt) / 1000);
  }

  async stop() {
    if (!this.mr) return null;
    cancelAnimationFrame(this._raf);
    if (this.mr.state !== 'inactive') this.mr.stop();
    const blob = await this._stopped;
    const durationSec = this.durationSec;
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.analyser = null;
    this.mr = null;
    return { blob, url: URL.createObjectURL(blob), durationSec, spoke: this.spoke };
  }
}

/* ---------------- WAV 编码（给 Azure 用） ---------------- */

export async function audioToWav16k(blob) {
  const buf = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  await ctx.close();
  const ch = decoded.getChannelData(0);
  const ratio = decoded.sampleRate / TARGET_RATE;
  const outLen = Math.floor(ch.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // 线性插值重采样
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, ch.length - 1);
    const frac = pos - i0;
    const v = ch[i0] * (1 - frac) + ch[i1] * frac;
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return wavFromPcm(out, TARGET_RATE);
}

function wavFromPcm(int16, sampleRate) {
  const bytes = int16.length * 2;
  const ab = new ArrayBuffer(44 + bytes);
  const dv = new DataView(ab);
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  dv.setUint32(4, 36 + bytes, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  w(36, 'data');
  dv.setUint32(40, bytes, true);
  new Int16Array(ab, 44).set(int16);
  return ab;
}

/* ---------------- Azure 发音评估（可选精评） ---------------- */

export async function azureAssess({ key, region, refText, wav }) {
  if (!key || !region) throw new Error('还没填 Azure key / region');
  const assessment = {
    ReferenceText: refText,
    GradingSystem: 'HundredMark',
    Granularity: 'Word',
    Dimension: 'Comprehensive',
    EnableMiscue: true,
  };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(assessment))));
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US&format=detailed`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
      'Pronunciation-Assessment': b64,
      Accept: 'application/json',
    },
    body: wav,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Azure ${resp.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  if (data.RecognitionStatus !== 'Success') throw new Error(`没识别出来（${data.RecognitionStatus}）`);
  const best = data.NBest?.[0];
  const pa = best?.PronunciationAssessment || {};
  return {
    display: data.DisplayText || best?.DisplayText || '',
    total: Math.round(pa.PronScore ?? pa.AccuracyScore ?? 0),
    accuracy: Math.round(pa.AccuracyScore ?? 0),
    completeness: Math.round(pa.CompletenessScore ?? 0),
    fluency: Math.round(pa.FluencyScore ?? 0),
    words: (best?.Words || []).map((w) => ({
      word: w.Word,
      score: Math.round(w.PronunciationAssessment?.AccuracyScore ?? 0),
      error: w.PronunciationAssessment?.ErrorType || 'None',
    })),
  };
}
