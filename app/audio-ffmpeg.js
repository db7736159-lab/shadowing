// 兜底：用 ffmpeg.wasm 自己从文件里抠音频，不依赖系统的解码器。
// 只在浏览器的 decodeAudioData 解不开时才加载（31MB，别让正常文件也付这个代价）。

const BASE = new URL('../vendor/ffmpeg/', import.meta.url);

let ffmpegPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('ffmpeg 脚本加载失败'));
    document.head.append(s);
  });
}

function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      if (!window.FFmpegWASM) await loadScript(new URL('ffmpeg.js', BASE).href);
      if (!window.FFmpegWASM) throw new Error('ffmpeg 未初始化');
      const ff = new window.FFmpegWASM.FFmpeg();
      await ff.load({
        coreURL: new URL('ffmpeg-core.js', BASE).href,
        wasmURL: new URL('ffmpeg-core.wasm', BASE).href,
      });
      return ff;
    })();
  }
  return ffmpegPromise;
}

const EXT = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/**
 * 抽音频并转成 16k 单声道 wav。
 * @returns {Promise<{blob: Blob, truncated: boolean}>}
 */
export async function extractWav(blob, { maxSeconds = 300, onProgress, name = '' } = {}) {
  const ff = await getFFmpeg();
  onProgress?.(0.02);

  const ext = EXT[blob.type] || (name.split('.').pop() || 'mp4').toLowerCase();
  const input = `input.${ext}`;
  const output = 'out.wav';

  const buf = new Uint8Array(await blob.arrayBuffer());
  await ff.writeFile(input, buf);
  onProgress?.(0.05);

  const onFF = ({ progress }) => {
    if (typeof progress === 'number') onProgress?.(0.05 + Math.min(0.9, progress) * 0.85);
  };
  ff.on('progress', onFF);

  let truncated = false;
  try {
    await ff.exec(['-i', input, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', output]);
  } catch (e) {
    // 超过时长限制时 ffmpeg 会返回非 0，但文件其实写出来了
    truncated = true;
  }
  ff.off?.('progress', onFF);

  let data;
  try {
    data = await ff.readFile(output);
  } catch {
    throw new Error('ffmpeg 没能从这个文件里取出音频');
  } finally {
    ff.deleteFile(input).catch(() => {});
    ff.deleteFile(output).catch(() => {});
  }
  if (!data || !data.length) throw new Error('ffmpeg 输出是空的');
  onProgress?.(1);
  return { blob: new Blob([data.buffer], { type: 'audio/wav' }), truncated };
}
