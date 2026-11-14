# -*- coding: utf-8 -*-
"""把一个 TED 演讲做成「视频 + 逐句文本 + 中文」的场景包。

用法：python tools/build_talk_pack.py <ted-slug> [pack-id]
产物：packs/<id>/pack.json、packs/<id>/media.mp4，并更新 packs/index.json 和 data/dict.json
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS = os.path.join(ROOT, "packs")
DATA = os.path.join(ROOT, "data")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}


def get(url, timeout=40):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def parse_ts(s):    # 00:00:12.345 或 00:12.345
    parts = s.strip().split(":")
    parts = [float(x.replace(",", ".")) for x in parts]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return parts[0] * 60 + parts[1]


def vtt_cues(text):
    cues = []
    blocks = re.split(r"\n\s*\n", text.replace("\r\n", "\n"))
    for b in blocks:
        m = re.search(r"(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})", b)
        if not m:
            continue
        body = b[m.end():].strip()
        body = re.sub(r"<[^>]+>", "", body)          # 去 <c> / <v> 标签
        body = re.sub(r"\s+", " ", body).strip()
        if body:
            cues.append((parse_ts(m.group(1)), parse_ts(m.group(2)), body))
    return cues


def fetch_subtitles(base, uri):
    """字幕 m3u8 → 各段 vtt → 合并 cues"""
    url = urllib.parse.urljoin(base, uri)
    m3u8 = get(url).decode("utf-8", "ignore")
    segs = [l.strip() for l in m3u8.splitlines() if l.strip() and not l.startswith("#")]
    cues = []
    for seg in segs:
        seg_url = urllib.parse.urljoin(url, seg)
        try:
            cues += vtt_cues(get(seg_url).decode("utf-8", "ignore"))
        except Exception as e:
            print("   seg fail", seg_url[:80], e)
    cues.sort(key=lambda c: c[0])
    # 同一时间点重复出现的字幕（TED 常见）只留一条
    dedup = []
    for c in cues:
        if dedup and abs(dedup[-1][0] - c[0]) < 0.01 and norm(dedup[-1][2]) == norm(c[2]):
            continue
        dedup.append(c)
    return dedup


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def merge_sentences(cues, max_gap=0.9, min_chars=18, max_sec=14):
    out = []
    cur = None
    for start, end, text in cues:
        if cur is None:
            cur = {"start": start, "end": end, "text": text}
        elif end - cur["start"] > max_sec or start - cur["end"] > max_gap:
            out.append(cur)
            cur = {"start": start, "end": end, "text": text}
        else:
            # 滚动字幕常把上一行重复一遍：如果当前句已经是这句结尾，就跳过
            if norm(text) and not norm(cur["text"]).endswith(norm(text)):
                cur["text"] = (cur["text"] + " " + text).strip()
            cur["end"] = max(cur["end"], end)
        if re.search(r"[.!?][\"')\]]?$", cur["text"]):
            out.append(cur)
            cur = None
    if cur:
        out.append(cur)

    # 太碎的句子并进上一句
    merged = []
    for s in out:
        if merged and len(s["text"]) < min_chars:
            merged[-1]["text"] += " " + s["text"]
            merged[-1]["end"] = s["end"]
        else:
            merged.append(s)
    for s in merged:
        s["text"] = re.sub(r"\s+", " ", s["text"]).strip()
    return [s for s in merged if len(s["text"]) >= 8]


def zh_for(sentences, zh_cues):
    for s in sentences:
        parts = []
        for start, end, text in zh_cues:
            mid = (start + end) / 2
            if s["start"] - 0.4 <= mid <= s["end"] + 0.4:
                parts.append(text)
        zh = "".join(parts)
        zh = re.sub(r"\s+", "", zh)
        s["zh"] = zh
    return sentences


def download(url, path):
    tmp = path + ".part"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
        total = int(r.headers.get("content-length", 0))
        done = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total:
                print(f"\r   {done/1e6:.1f}/{total/1e6:.1f} MB", end="", flush=True)
    os.replace(tmp, path)
    print()


WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’-]*")


def translate(word):
    q = urllib.parse.quote(word)
    url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q={q}"
    data = json.loads(get(url, 20))
    return "".join(seg[0] for seg in data[0] if seg and seg[0]).strip()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    slug = sys.argv[1]
    pid = sys.argv[2] if len(sys.argv) > 2 else "talk-" + slug.split("_")[-1][:20]

    print("取页面…", slug)
    html = get(f"https://www.ted.com/talks/{slug}").decode("utf-8", "ignore")
    data = json.loads(re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S).group(1))
    pp = data["props"]["pageProps"]["videoData"]
    vpd = pp["videoPlayerData"]
    title = pp.get("title") or slug
    dur = vpd.get("duration")
    mp4 = vpd["resources"]["h264"][0]["file"]
    manifest = vpd["resources"]["hls"]["stream"]
    print(f"  {title} / {dur}s")

    print("取字幕轨道…")
    mani = get(manifest, 60).decode("utf-8", "ignore")
    subs = dict(re.findall(r'#EXT-X-MEDIA:TYPE=SUBTITLES.*?LANGUAGE="([^"]+)".*?URI="([^"]+)"', mani))
    if "en" not in subs:
        print("没有英文字幕，放弃")
        return 1
    en_cues = fetch_subtitles(manifest, subs["en"])
    print(f"  en cues: {len(en_cues)}")
    zh_cues = []
    for code in ("zh-cn", "zh-tw"):
        if code in subs:
            try:
                zh_cues = fetch_subtitles(manifest, subs[code])
                print(f"  {code} cues: {len(zh_cues)}")
                break
            except Exception as e:
                print("  zh fail", e)

    sents = merge_sentences(en_cues)
    sents = zh_for(sents, zh_cues)
    print(f"  合成 {len(sents)} 句")

    pdir = os.path.join(PACKS, pid)
    os.makedirs(pdir, exist_ok=True)
    media = os.path.join(pdir, "media.mp4")
    if not os.path.exists(media):
        print("下载视频…")
        download(mp4, media)

    pack = {
        "id": pid,
        "title": title + "（TED 演讲）",
        "title_en": title,
        "tag": "真人视频",
        "level": "B1-B2",
        "intro": "TED 演讲原声，逐句跟读。演讲语速偏快，先慢速 0.7x 跟两遍再原速。",
        "format": "timeline",
        "video": "media.mp4",
        "duration": dur,
        "source": {"name": "TED", "url": f"https://www.ted.com/talks/{slug}", "license": "CC BY-NC-ND 4.0（个人学习用）"},
        "sentences": [
            {"role": "speaker", "en": s["text"], "zh": s.get("zh", ""), "start": round(s["start"], 2), "end": round(s["end"], 2)}
            for s in sents
        ],
    }
    with open(os.path.join(pdir, "pack.json"), "w", encoding="utf-8") as f:
        json.dump(pack, f, ensure_ascii=False, indent=2)

    # 更新 index
    idx_path = os.path.join(PACKS, "index.json")
    idx = json.load(open(idx_path, encoding="utf-8")) if os.path.exists(idx_path) else {"packs": []}
    idx["packs"] = [p for p in idx["packs"] if p["id"] != pid]
    idx["packs"].insert(0, {
        "id": pid, "title": pack["title"], "title_en": title, "tag": pack["tag"],
        "level": pack["level"], "count": len(pack["sentences"]),
    })
    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)

    # 词典补词
    dict_path = os.path.join(DATA, "dict.json")
    dic = json.load(open(dict_path, encoding="utf-8")) if os.path.exists(dict_path) else {}
    words = {w.lower().strip("'’-") for s in pack["sentences"] for w in WORD_RE.findall(s["en"])}
    todo = sorted(w for w in words if len(w) > 1 and w not in dic)
    print(f"  词典补 {len(todo)} 个词")
    for i, w in enumerate(todo, 1):
        try:
            dic[w] = {"m": [translate(w)]}
        except Exception:
            pass
        if i % 25 == 0:
            json.dump(dic, open(dict_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
            print(f"    {i}/{len(todo)}")
        time.sleep(0.15)
    json.dump(dic, open(dict_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("完成:", pid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
