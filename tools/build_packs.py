# -*- coding: utf-8 -*-
"""生成场景包：pack.json + 每句 MP3（Google TTS）+ 全局词典 data/dict.json。

只在本机跑一次，产物直接进 english-shadowing/packs 和 data。
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKS_DIR = os.path.join(ROOT, "packs")
DATA_DIR = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"

PACKS = [
    {
        "id": "airport-checkin",
        "title": "机场值机 · 托运超重",
        "title_en": "Airport Check-in",
        "tag": "旅行",
        "level": "A2",
        "intro": "值机柜台最常听到的十句话。重点练数字、行李和登机口信息。",
        "sentences": [
            ("staff", "Good morning. May I see your passport and ticket, please?", "早上好，请出示您的护照和机票。", ""),
            ("you", "Here you are. I'd like to check in for the flight to London.", "给你。我想办理去伦敦的航班值机。", "I'd like to 读成 /aɪd laɪk tə/，d 和 t 都轻。"),
            ("staff", "Certainly. Are you checking any bags today?", "好的。今天有行李要托运吗？", ""),
            ("you", "Just this one, and I'll keep the small bag with me.", "就这一件，小包我随身带着。", ""),
            ("staff", "Please put it on the scale. It's two kilos over the limit.", "请放上传送带。超重两公斤。", "kilos 重音在第一音节 /ˈkiːloʊz/。"),
            ("you", "Oh, how much would the extra charge be?", "噢，超重费是多少？", "extra charge 连读成 /ˈekstrə tʃɑːdʒ/。"),
            ("staff", "That'll be thirty pounds, or you can move some items to your carry-on.", "三十英镑；或者您可以把一些东西挪到随身行李里。", ""),
            ("you", "I'll move a few things instead. Thanks for the tip.", "那我还是拿点东西出来吧，谢谢提醒。", ""),
            ("staff", "No problem. Here's your boarding pass. Gate twenty-two, boarding at ten forty.", "没问题。这是登机牌。22 号登机口，十点四十登机。", "boarding 的 oa 读 /ɔː/。"),
            ("you", "Great, thank you. Have a nice day.", "好的，谢谢，祝你今天愉快。", ""),
        ],
    },
    {
        "id": "cafe-order",
        "title": "咖啡店点单 · 换奶少糖",
        "title_en": "Ordering at a Café",
        "tag": "旅行",
        "level": "A2",
        "intro": "点单、改配方、问价格、要小票，一次练全。",
        "sentences": [
            ("staff", "Hi there, what can I get for you today?", "你好，今天想喝点什么？", "what can I 连起来像 /wʌdəkaɪ/。"),
            ("you", "Could I get a large iced latte, please?", "可以给我一个大杯冰拿铁吗？", ""),
            ("staff", "Sure. Would you like it with regular or oat milk?", "好的。要普通牛奶还是燕麦奶？", ""),
            ("you", "Oat milk, please. And could you make it less sweet?", "燕麦奶。能做得不那么甜吗？", ""),
            ("staff", "Of course. Anything to eat with that?", "当然。要配点什么吃的吗？", ""),
            ("you", "What's in that sandwich on the top shelf?", "最上层那个三明治里有什么？", ""),
            ("staff", "Chicken, avocado, and a little mayo. It's really good.", "鸡肉、牛油果，还有点蛋黄酱。很好吃。", ""),
            ("you", "I'll take one, then. How much is that altogether?", "那我来一个。一共多少钱？", "altogether 重音在 /ɔːl/ 上。"),
            ("staff", "That's nine eighty. Card or cash?", "九块八。刷卡还是现金？", ""),
            ("you", "Card, please. Could I get a receipt?", "刷卡。能给我张小票吗？", "receipt 的 p 不发音：/rɪˈsiːt/。"),
        ],
    },
    {
        "id": "hotel-checkin",
        "title": "酒店入住 · 换安静房",
        "title_en": "Hotel Check-in",
        "tag": "旅行",
        "level": "A2",
        "intro": "前台常用句：房型、早餐、朝向、Wi-Fi、退房时间。",
        "sentences": [
            ("staff", "Good evening. Do you have a reservation with us?", "晚上好，您有预订吗？", ""),
            ("you", "Yes, under the name Chen. I booked a double room for three nights.", "有的，姓陈。我订了一间双人房，住三晚。", ""),
            ("staff", "Let me check. Yes, here it is. Could I see your ID, please?", "我查一下。找到了。可以看下您的证件吗？", ""),
            ("you", "Sure. Is breakfast included in the price?", "可以。房价含早餐吗？", ""),
            ("staff", "It is, from seven to ten in the morning on the second floor.", "含的，早上七点到十点，在二楼。", ""),
            ("you", "Great. Could I get a room away from the street? I'm a light sleeper.", "太好了。能给我一间不临街的房间吗？我睡觉很轻。", ""),
            ("staff", "I'll put you on the eighth floor, facing the garden.", "我给您安排八楼，朝向花园。", ""),
            ("you", "That sounds perfect. What's the wifi password?", "那太好了。Wi-Fi 密码是什么？", ""),
            ("staff", "It's on the card in your room. Check-out is at noon.", "房间里的卡片上写着。退房时间是中午十二点。", ""),
            ("you", "Thanks a lot. Have a good night.", "多谢，晚安。", ""),
        ],
    },
    {
        "id": "doctor-visit",
        "title": "看医生 · 嗓子疼咳嗽",
        "title_en": "At the Doctor's",
        "tag": "生活",
        "level": "B1",
        "intro": "描述症状、问严重程度、问要不要吃药。医学词汇不多，够用就好。",
        "sentences": [
            ("staff", "What brings you in today?", "今天哪里不舒服？", "口语高频问法，等于 What's the problem。"),
            ("you", "I've had a sore throat and a cough for about four days.", "我嗓子疼、咳嗽，大概四天了。", "I've had 的 v 和 h 连读很轻。"),
            ("staff", "Any fever or headache?", "有发烧或头痛吗？", ""),
            ("you", "A slight fever last night, but no headache.", "昨晚有点低烧，没有头痛。", ""),
            ("staff", "Let me take a look at your throat. Open wide, please.", "我看一下你的嗓子。请张大嘴。", ""),
            ("you", "Is it serious? Do I need antibiotics?", "严重吗？需要吃抗生素吗？", "antibiotics 重音在 /baɪ/。"),
            ("staff", "It looks like a common cold, so antibiotics won't help. Rest and fluids.", "看起来是普通感冒，抗生素没用。多休息、多喝水。", ""),
            ("you", "Should I take anything for the cough?", "咳嗽需要吃什么药吗？", ""),
            ("staff", "You can take this syrup twice a day. Come back if it gets worse.", "这个糖浆一天两次。加重了再来。", "syrup 读 /ˈsɪrəp/，不是 /ˈsaɪrəp/。"),
            ("you", "Got it. Thanks, doctor.", "明白了，谢谢医生。", ""),
        ],
    },
    {
        "id": "rent-viewing",
        "title": "看房租房 · 房租押金",
        "title_en": "Viewing an Apartment",
        "tag": "生活",
        "level": "B1",
        "intro": "看房必问：房租、含不含水电、押金、租期、厨房。",
        "sentences": [
            ("staff", "So this is the one-bedroom on the fifth floor. What do you think?", "这就是五楼的一居室。你觉得怎么样？", ""),
            ("you", "It's brighter than the photos. How much is the rent?", "比照片上亮。房租多少？", ""),
            ("staff", "Eighteen hundred a month, utilities not included.", "每月一千八，不含水电。", "utilities 重音在 /tɪl/。"),
            ("you", "Does that include internet? I work from home.", "含网费吗？我在家办公。", ""),
            ("staff", "No, but the building has fiber. It's about forty a month.", "不含，但楼里有光纤，大概每月四十。", ""),
            ("you", "How long is the lease? And is there a deposit?", "租期多久？要押金吗？", "lease 和 deposit 是租房关键词。"),
            ("staff", "Twelve months, one month's deposit. The landlord prefers a longer stay.", "一年，押一个月。房东希望住得久一点。", ""),
            ("you", "Could I see the kitchen? I cook a lot.", "能看看厨房吗？我经常做饭。", ""),
            ("staff", "Sure, it's this way. The fridge was replaced last year.", "当然，这边走。冰箱去年刚换的。", ""),
            ("you", "I like it. Can I think about it and get back to you tomorrow?", "我挺喜欢。能考虑一下，明天答复你吗？", "get back to you 是「回复你」的常用说法。"),
        ],
    },
    {
        "id": "phone-booking",
        "title": "打电话预约 · 改时间",
        "title_en": "Booking by Phone",
        "tag": "生活",
        "level": "B1",
        "intro": "电话里没有表情和口型，最难的是没听清时怎么说。",
        "sentences": [
            ("staff", "Good afternoon, Riverside Dental. How can I help?", "下午好，河畔牙科。有什么可以帮您？", ""),
            ("you", "Hi, I'd like to book a cleaning appointment, please.", "你好，我想预约洗牙。", ""),
            ("staff", "Of course. Are you a patient with us already?", "好的。您是我们的老病人吗？", ""),
            ("you", "Yes, I came in last spring. My name is Li Wei.", "是的，去年春天来过。我叫李伟。", ""),
            ("staff", "Got it. We have Thursday at three or Friday morning at ten.", "找到了。周四下午三点或者周五上午十点。", ""),
            ("you", "Thursday works better for me. How long will it take?", "周四更合适。大概要多久？", ""),
            ("staff", "About forty minutes. Please arrive ten minutes early.", "四十分钟左右。请提前十分钟到。", ""),
            ("you", "Sorry, could you repeat that? The line is a bit noisy.", "不好意思，能再说一遍吗？信号有点吵。", "没听清就用这句，比「pardon?」自然。"),
            ("staff", "Ten minutes early, please. And bring your insurance card.", "请提前十分钟到，带上医保卡。", ""),
            ("you", "Got it. See you on Thursday.", "好的，周四见。", ""),
        ],
    },
]


def http_get(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.read()
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(1.2 * (i + 1))


def tts(text, path):
    q = urllib.parse.quote(text)
    url = f"https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=en&q={q}"
    data = http_get(url)
    if not data or data[:2] not in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"ID3\x03"):
        raise RuntimeError("TTS 返回的不是 mp3: " + repr(data[:8]))
    with open(path, "wb") as f:
        f.write(data)
    return len(data)


def translate(word):
    q = urllib.parse.quote(word)
    url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q={q}"
    raw = http_get(url)
    data = json.loads(raw)
    return "".join(seg[0] for seg in data[0] if seg and seg[0]).strip()


WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’-]*")


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    words = {}
    index = []

    for p in PACKS:
        pdir = os.path.join(PACKS_DIR, p["id"])
        sdir = os.path.join(pdir, "s")
        os.makedirs(sdir, exist_ok=True)
        sentences = []
        for i, (role, en, zh, tip) in enumerate(p["sentences"], start=1):
            fn = f"s/{i:02d}.mp3"
            path = os.path.join(pdir, fn.replace("/", os.sep))
            if not os.path.exists(path):
                size = tts(en, path)
                print(f"  tts {p['id']} {i:02d} {size}B")
                time.sleep(0.25)
            sentences.append({
                "role": role,
                "en": en,
                "zh": zh,
                "tip": tip,
                "audio": fn,
            })
            for w in WORD_RE.findall(en):
                key = w.lower().strip("'’-")
                if len(key) > 1:
                    words.setdefault(key, set()).add(p["id"])

        pack = {
            "id": p["id"],
            "title": p["title"],
            "title_en": p["title_en"],
            "tag": p["tag"],
            "level": p["level"],
            "intro": p["intro"],
            "format": "sentence-audio",
            "sentences": sentences,
        }
        with open(os.path.join(pdir, "pack.json"), "w", encoding="utf-8") as f:
            json.dump(pack, f, ensure_ascii=False, indent=2)
        index.append({
            "id": p["id"],
            "title": p["title"],
            "title_en": p["title_en"],
            "tag": p["tag"],
            "level": p["level"],
            "count": len(sentences),
        })
        print(f"pack {p['id']} ok ({len(sentences)} sentences)")

    with open(os.path.join(PACKS_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"packs": index}, f, ensure_ascii=False, indent=2)

    # 词典：只收场景里出现过的词，逐个翻中文
    dict_path = os.path.join(DATA_DIR, "dict.json")
    old = {}
    if os.path.exists(dict_path):
        with open(dict_path, encoding="utf-8") as f:
            old = json.load(f)

    todo = [w for w in sorted(words) if w not in old]
    print(f"dict: {len(words)} words total, {len(todo)} to translate")
    for n, w in enumerate(todo, 1):
        try:
            zh = translate(w)
            old[w] = {"m": [zh]}
            if n % 20 == 0:
                print(f"  {n}/{len(todo)} {w} -> {zh}")
                json.dump(old, open(dict_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
            time.sleep(0.18)
        except Exception as e:
            print(f"  ! {w}: {e}")

    with open(dict_path, "w", encoding="utf-8") as f:
        json.dump(old, f, ensure_ascii=False, indent=0)
    print(f"dict saved: {len(old)} entries")


if __name__ == "__main__":
    sys.exit(main())
