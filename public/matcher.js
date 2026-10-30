// 表記ゆれを吸収して回答を判定するロジック
// 入力と正解データの両方に同じ normalize() をかけてから突き合わせる。

const SMALL = { "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お", "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "ゎ": "わ", "っ": "つ", "ゕ": "か", "ゖ": "け" };
const VU = { "ゔぁ": "ば", "ゔぃ": "び", "ゔぇ": "べ", "ゔぉ": "ぼ", "ゔ": "ぶ" };

export function normalize(s) {
  s = String(s).normalize("NFKC").toLowerCase();
  // カタカナ → ひらがな
  s = s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  s = s.replace(/ゔ[ぁぃぇぉ]?/g, (m) => VU[m] ?? "ぶ");
  s = s.replace(/[ぁぃぅぇぉゃゅょゎっゕゖ]/g, (c) => SMALL[c]);
  s = s.replace(/ぢ/g, "じ").replace(/づ/g, "ず").replace(/を/g, "お");
  s = s.replace(/[ーｰ〜～]/g, "");
  // 記号・空白を除去（漢字・かな・英数字・々 は残す）
  s = s.replace(/[^\p{L}\p{N}]/gu, "");
  return s;
}

function stripSuffix(s, suffixes) {
  for (const suf of suffixes) {
    if (suf && s.length > suf.length && s.endsWith(suf)) return s.slice(0, -suf.length);
  }
  return null;
}

function levenshtein(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const FUZZY_MIN_LEN = 5;

export class Matcher {
  constructor(quiz) {
    this.items = quiz.items;
    // 長い接尾辞から先に試す
    this.suffixes = [...new Set((quiz.options?.suffix || []).map(normalize).filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    this.fuzzy = quiz.options?.fuzzy !== false;
    this.full = new Map();   // 正規化したキー → 項目index[]
    this.loose = new Map();  // 接尾辞を除いたキー → 項目index[]
    this.allKeys = [];       // [key, index]（前方一致・あいまい検索用）
    quiz.items.forEach((it, idx) => {
      for (const raw of [it.name, ...(it.aliases || [])]) {
        const k = normalize(raw);
        if (!k) continue;
        add(this.full, k, idx);
        this.allKeys.push([k, idx]);
        const st = stripSuffix(k, this.suffixes);
        if (st) {
          add(this.loose, st, idx);
          this.allKeys.push([st, idx]);
        }
      }
    });
    function add(map, k, idx) {
      const a = map.get(k) || [];
      if (!a.includes(idx)) a.push(idx);
      map.set(k, a);
    }
  }

  // 完全一致（正規化後）の候補を優先度順に探す
  exact(input) {
    const n = normalize(input);
    if (!n) return { key: "", hits: [] };
    const st = stripSuffix(n, this.suffixes);
    const tries = [[this.full, n], [this.loose, n]];
    if (st) tries.push([this.full, st], [this.loose, st]);
    for (const [map, k] of tries) {
      const hits = map.get(k);
      if (hits) return { key: n, hits };
    }
    return { key: n, hits: [] };
  }

  /**
   * 判定する。answered は回答済み index の Set。
   * strict=true（入力途中の自動判定）では、あいまい一致は使わず、
   * 他の未回答項目の前方一致になる入力（例: ギニア / ギニアビサウ）は保留する。
   * 判定のみ項目（ghost）に当たった場合は status:'ghost'（正解ではない）。
   * 戻り値: {status:'ok'|'dup'|'ghost'|'none'|'wait', index, fuzzy}
   */
  judge(input, answered, strict = false) {
    const { key, hits: all } = this.exact(input);
    if (!key) return { status: "none" };
    const hits = all.filter((i) => !this.items[i].ghost);
    if (!hits.length && all.length) return { status: "ghost", index: all[0] };
    if (hits.length) {
      const fresh = hits.find((i) => !answered.has(i));
      if (fresh === undefined) return { status: "dup", index: hits[0] };
      // シークレット・判定のみ項目は待ちの判定に使わない（「博多」で止まると博多南の存在がばれるため）。
      // ただし英字は1文字ずつ入力されるので、待たないと「u」でウランが確定して「Uue」が打てない
      const ascii = /^[\x20-\x7e]+$/.test(key);
      const hidden = (i) => !ascii && (this.items[i].secret || this.items[i].ghost);
      if (strict && this.allKeys.some(([k, i]) => i !== fresh && !answered.has(i) && !hidden(i) && k !== key && k.startsWith(key))) {
        return { status: "wait" };
      }
      return { status: "ok", index: fresh };
    }
    if (strict || !this.fuzzy || key.length < FUZZY_MIN_LEN) return { status: "none" };
    // あいまい一致: 編集距離1以内の項目がちょうど1つに絞れる場合だけ
    const cands = new Set();
    for (const [k, i] of this.allKeys) {
      if (k.length >= FUZZY_MIN_LEN - 1 && levenshtein(key, k, 1) <= 1) cands.add(i);
    }
    if (cands.size !== 1) return { status: "none" };
    const [idx] = cands;
    if (this.items[idx].ghost) return { status: "ghost", index: idx, fuzzy: true };
    return { status: answered.has(idx) ? "dup" : "ok", index: idx, fuzzy: true };
  }
}

// 編集画面のテキスト形式 ⇔ items
export function itemsToText(items) {
  const lines = [];
  let group = "";
  for (const it of items) {
    if ((it.group || "") !== group) {
      group = it.group || "";
      if (lines.length) lines.push("");
      lines.push("## " + (group || "（区分なし）"));
    }
    let s = (it.secret ? "* " : it.ghost ? "? " : "") + [it.name, ...(it.aliases || [])].join(" | ");
    if (it.note) s += " # " + it.note;
    lines.push(s);
  }
  return lines.join("\n");
}

export function textToItems(text) {
  const items = [];
  let group = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("##")) {
      group = line.slice(2).trim();
      if (group === "（区分なし）") group = "";
      continue;
    }
    const secret = line.startsWith("*");
    const ghost = line.startsWith("?");
    const rest = secret || ghost ? line.slice(1).trim() : line;
    const hash = rest.indexOf("#");
    const body = hash >= 0 ? rest.slice(0, hash) : rest;
    const note = hash >= 0 ? rest.slice(hash + 1).trim() : "";
    const parts = body.split("|").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) continue;
    items.push({ name: parts[0], aliases: parts.slice(1), note, group, secret, ghost });
  }
  return items;
}
