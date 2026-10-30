"""一覧画面に出す Wikipedia（日本語版）のリンク先を調べて data/wiki/<id>.json に書き出す

使い方:  python wiki.py [クイズID ...]   (省略時は全クイズ)

項目ごとに記事名の候補を順に試し、実在する記事（リダイレクトは解決、曖昧さ回避ページは除く）を採用する。
同じクイズの多くの項目が同じ記事に行き着く場合（「決まり手」の一覧記事など）は、個別の記事ではないので捨てる。
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request

import server

WIKI = server.DATA.parent / "wiki"
API = "https://ja.wikipedia.org/w/api.php"
UA = "SimpleQuiz/1.0 (https://github.com/6nhpt/SimpleQuiz)"

# クイズごとの候補。{} は項目名、{alias} は別解それぞれ（かなだけ・英字だけのものは除く）、
# {note} はメモ全体、{pref} はメモ中の都道府県名。None はリンクを付けないクイズ
STATION = ["{}駅", "{}駅 ({pref})"]
PATTERNS = {
    "01-us-states": ["{}州"],
    "04-tokyo-23ku": ["{}", "{} (東京都)"],
    "05-tokaido-sanyo-shinkansen": STATION, "09-yamanote": STATION + ["{}駅 (東京都)"],
    "32-tohoku-hokkaido-shinkansen": STATION, "33-joetsu-shinkansen": STATION,
    "34-hokuriku-shinkansen": STATION, "35-kyushu-shinkansen": STATION, "36-mini-shinkansen": STATION,
    "07-un-members": ["{}", "{} (国)"],
    "10-world-capitals": ["{}", "{} ({note})"],
    "16-first-magnitude-stars": ["{}", "{} (恒星)", "{alias}"],
    "17-world-heritage-japan": ["{}", "{alias}"],
    "19-24-sekki": ["{} (二十四節気)", "{}"],
    "20-ryoseikoku": ["{}国"],
    "21-tokaido-53": ["{}宿", "{}宿 (東海道)", "{alias}宿"],
    "22-greek-letters": ["{} (文字)", "{}"],
    "24-si-prefixes": ["{} (接頭辞)", "{}"],
    "28-hyakumeizan": ["{}", "{alias}"],
    "29-ikkyu-suikei": ["{}", "{} ({note})", "{alias}"],
    "41-airports": ["{}空港", "{}飛行場", "{}", "{alias}空港", "{alias}飛行場"],
    "43-ghibli": ["{} (映画)", "{} (アニメ映画)", "{} (2023年の映画)", "{}", "{alias} (映画)", "{alias}"],
    "51-major-arcana": ["{} (タロット)", "{alias} (タロット)"],
    "52-weather-symbols": ["{}", "{alias}"],
    "54-si-derived-units": ["{} (単位)", "{}"],
    "23-nato-phonetic": None, "39-wabun-tsuwahyo": None, "47-allergens": None,
}

# 個別の上書き（先頭から順に試す）
OVERRIDES = {
    "07-un-members": {"タイ": ["タイ王国"], "マリ": ["マリ共和国"]},
    "22-greek-letters": {"アルファ": ["Α"], "ベータ": ["Β"], "デルタ": ["Δ"], "イプシロン": ["Ε"], "エータ": ["Η"],
                         "シータ": ["Θ"], "カッパ": ["Κ"], "ミュー": ["Μ"], "ニュー": ["Ν"], "ロー": ["Ρ"],
                         "タウ": ["Τ"], "カイ": ["Χ"], "パイ": ["Π"], "オメガ": ["Ω"]},
    "27-emperors": {"明仁（上皇）": ["明仁"], "徳仁（今上天皇）": ["徳仁"]},
    "28-hyakumeizan": {"阿寒岳": ["阿寒岳 (北海道)", "雌阿寒岳"], "朝日岳": ["大朝日岳"], "蔵王山": ["蔵王連峰", "蔵王山"],
                       "大山": ["大山 (鳥取県)"]},
    "29-ikkyu-suikei": {"荒川（関東）": ["荒川 (関東)"], "荒川（北陸）": ["荒川 (新潟県)", "荒川 (山形県・新潟県)"],
                        "関川": ["関川 (新潟県)"], "宮川": ["宮川 (三重県)"], "新宮川": ["熊野川"],
                        "旭川": ["旭川 (岡山県)"], "白川": ["白川 (熊本県)"]},
    "40-rokuyo": {"仏滅": ["六曜"]},
    "41-airports": {"千歳（基地）": ["千歳基地"], "入間": ["入間基地"]},
    "43-ghibli": {"風立ちぬ": ["風立ちぬ (2013年の映画)"],
                  "魔女の宅急便": ["魔女の宅急便 (1989年の映画)", "魔女の宅急便 (アニメ映画)"],
                  "おもひでぽろぽろ": ["おもひでぽろぽろ (映画)", "おもひでぽろぽろ (アニメ映画)"],
                  "思い出のマーニー": ["思い出のマーニー (映画)", "思い出のマーニー (アニメ映画)"]},
    "49-sanjurokkasen": {"伊勢": ["伊勢 (歌人)"]},
    "52-weather-symbols": {"ひょう": ["雹"]},
    "55-ministries": {"原子力規制委員会": ["原子力規制委員会 (日本)", "原子力規制委員会"]},
}

# 個別の記事がない項目のリンク先（クイズ全体、または区分ごと）
FALLBACK = {
    "08-elements": {"拡張周期表（119〜173）": "拡張周期表"},
    "24-si-prefixes": "SI接頭語",
    "40-rokuyo": "六曜",
    "42-kimarite": "決まり手",
    "51-major-arcana": "大アルカナ",
    "53-weather-warnings": {"特別警報": "特別警報", "危険警報": "警報 (気象庁)", "警報": "警報 (気象庁)",
                            "注意報": "注意報"},
}


def query(titles):
    """titles -> {入力タイトル: (記事名, 節) or None}"""
    out = {}
    for i in range(0, len(titles), 50):
        chunk = titles[i:i + 50]
        params = {"action": "query", "titles": "|".join(chunk), "redirects": "1", "prop": "pageprops",
                  "ppprop": "disambiguation", "format": "json", "formatversion": "2"}
        req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as res:
            q = json.load(res)["query"]
        norm = {n["from"]: n["to"] for n in q.get("normalized", [])}
        redir = {r["from"]: (r["to"], r.get("tofragment", "")) for r in q.get("redirects", [])}
        pages = {p["title"]: p for p in q.get("pages", [])}
        for t in chunk:
            name = norm.get(t, t)
            name, frag = redir.get(name, (name, ""))
            p = pages.get(name)
            ok = p and not p.get("missing") and not p.get("invalid") and "disambiguation" not in p.get("pageprops", {})
            out[t] = (name, frag) if ok else None
        time.sleep(0.2)
    return out


def candidates(it, patterns, overrides):
    note = (it.get("note") or "").split("（")[0].strip()
    pref = next((s for s in note.split("・") if re.fullmatch(r".+[都道府県]", s)), "")
    aliases = [a for a in it["aliases"] if not re.fullmatch(r"[ぁ-ゖー]+|[\x20-\x7e]+", a)]
    out = list(overrides.get(it["name"], []))
    for p in patterns:
        if ("{note}" in p and not note) or ("{pref}" in p and not pref):
            continue
        p = p.replace("{note}", note).replace("{pref}", pref)
        for t in [p.replace("{alias}", a) for a in aliases] if "{alias}" in p else [p.replace("{}", it["name"])]:
            if t not in out:
                out.append(t)
    return out


def build(qid):
    quiz = server.load_quiz(qid)
    patterns = PATTERNS.get(qid, ["{}"])
    path = WIKI / f"{qid}.json"
    if patterns is None:
        path.unlink(missing_ok=True)
        return
    cands = {it["name"]: candidates(it, patterns, OVERRIDES.get(qid, {})) for it in quiz["items"]}
    fb = FALLBACK.get(qid)
    fbs = set(fb.values()) if isinstance(fb, dict) else {fb} if fb else set()
    found = query(sorted({t for ts in cands.values() for t in ts} | fbs))
    links = {}
    for name, ts in cands.items():
        hit = next((found[t] for t in ts if found.get(t)), None)
        if hit:
            links[name] = hit[0] + ("#" + hit[1] if hit[1] else "")
    # 多くの項目が同じ記事に集まる＝一覧記事への転送なので捨てる
    count = {}
    for v in links.values():
        count[v.split("#")[0]] = count.get(v.split("#")[0], 0) + 1
    links = {k: v for k, v in links.items() if count[v.split("#")[0]] < 3}
    for it in quiz["items"]:
        t = fb.get(it.get("group", "")) if isinstance(fb, dict) else fb
        if it["name"] not in links and not it.get("ghost") and t and found.get(t):
            links[it["name"]] = found[t][0]
    WIKI.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(links, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{qid}: {len(links)}/{len(quiz['items'])}")


def main():
    ids = sys.argv[1:] or [q["id"] for q in server.list_quizzes()]
    for qid in ids:
        build(qid)


if __name__ == "__main__":
    main()
