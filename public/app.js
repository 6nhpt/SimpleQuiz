import { Matcher, itemsToText, textToItems } from "./matcher.js";

const $app = document.getElementById("app");
const $title = document.getElementById("bar-title");
const $right = document.getElementById("bar-right");
const $back = document.getElementById("back");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// メモ中の {答え|伏せ字} は、その答えを回答済みなら答え、まだなら伏せ字（省略時は○○）で表示する
const noteText = (note, known = () => true) =>
  (note || "").replace(/\{([^{}|]+)(?:\|([^{}]*))?\}/g, (_, name, mask) => (known(name) ? name : mask ?? "○○"));

// ---------------------------------------------------------------- API / 保存

// 静的公開版（build.py で書き出したもの）は読み取り専用。クイズは data/*.json から読む
const STATIC = document.documentElement.dataset.static === "1";

async function api(method, path, body) {
  if (STATIC) {
    if (method !== "GET") throw new Error("公開版では編集できません");
    // Pages は max-age=600 で配信されるので、毎回サーバーに更新を確認させる
    const res = await fetch(path ? `data/${encodeURIComponent(path)}.json` : "data/index.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("クイズが見つかりません");
    return res.json();
  }
  const res = await fetch("api/quizzes" + (path ? "/" + encodeURIComponent(path) : ""), {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// 進捗は項目名で保存（クイズを編集しても崩れにくいように）
const progKey = (id) => "sq:prog:" + id;
function loadProg(id) {
  try { return JSON.parse(localStorage.getItem(progKey(id))) || { answered: [], gaveUp: false }; }
  catch { return { answered: [], gaveUp: false }; }
}
function saveProg(id, p) { localStorage.setItem(progKey(id), JSON.stringify(p)); }

const foundKey = (id) => "sq:found:" + id;
function loadFound(id) {
  try { return new Set(JSON.parse(localStorage.getItem(foundKey(id))) || []); }
  catch { return new Set(); }
}
function addFound(id, name) {
  const f = loadFound(id);
  if (f.has(name)) return;
  f.add(name);
  localStorage.setItem(foundKey(id), JSON.stringify([...f]));
}

// 項目を区分（group）ごとにまとめる。並びは区分が最初に登場した順
function groupItems(items) {
  const groups = new Map();
  items.forEach((it, i) => {
    const g = it.group || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(i);
  });
  return [...groups];
}

// ---------------------------------------------------------------- カテゴリの色

// カテゴリごとの色相とアイコン。知らないカテゴリは名前から色相を決める
const CATS = {
  "世界の地理": [200, "🌍"], "日本の地理": [150, "🗾"], "理科・天文": [255, "🔭"], "鉄道": [25, "🚄"],
  "歴史・文化": [345, "🏯"], "ことば・記号": [185, "🔤"], "エンタメ・スポーツ": [300, "🎬"], "くらし": [45, "🏠"],
};
function catHue(c) {
  if (CATS[c]) return CATS[c][0];
  let h = 0;
  for (const ch of c || "") h = (h * 31 + ch.codePointAt(0)) % 360;
  return c ? h : 220;
}
const catIcon = (c) => (CATS[c] ? CATS[c][1] : "📁");
// 回答・一覧画面はそのクイズのカテゴリ色にする（ホームなどでは null で既定色に戻す）
function setTheme(cat) {
  const root = document.documentElement;
  if (cat == null) root.style.removeProperty("--h");
  else root.style.setProperty("--h", catHue(cat));
}

// ---------------------------------------------------------------- ルーター

function setBar(title, back, right = "") {
  $title.textContent = title;
  document.title = title === "列挙クイズ" ? title : `${title} - 列挙クイズ`;
  $back.hidden = !back;
  $back.onclick = () => (location.hash = back || "#/");
  $right.innerHTML = right;
}

async function route() {
  const [, view, id] = location.hash.replace(/^#/, "").split("/");
  window.scrollTo(0, 0);
  setTheme(null);
  try {
    if (view === "play" && id) await renderPlay(id);
    else if (view === "view" && id) await renderView(id);
    else if (view === "edit" && id && !STATIC) await renderEdit(id);
    else if (view === "new" && !STATIC) await renderEdit(null);
    else await renderHome();
  } catch (e) {
    setBar("エラー", "#/");
    $app.innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
window.addEventListener("hashchange", route);
route();

// ---------------------------------------------------------------- 更新確認（公開版のみ）

// サーバー上の version.json と、今表示している版の番号を比べ、新しければ読み直す。
// index.html 自体もキャッシュされるので、URLに ?v= を付けて取り直させる
async function checkUpdate() {
  const cur = document.documentElement.dataset.version;
  if (!STATIC || !cur) return;
  try {
    const { v } = await (await fetch("version.json", { cache: "no-cache" })).json();
    if (v && v !== cur && sessionStorage.getItem("sq:reload") !== v) {
      sessionStorage.setItem("sq:reload", v);  // 万一の再読み込みループ防止
      location.replace(`${location.pathname}?v=${v}${location.hash}`);
    }
  } catch { /* オフライン等は無視 */ }
}

// ---------------------------------------------------------------- ホーム

async function renderHome() {
  setBar("列挙クイズ", null);
  checkUpdate();
  const list = await api("GET");
  // カテゴリごとにまとめる（並びは最初に登場した順、未分類は最後）
  const groups = new Map();
  for (const q of list) {
    const c = q.category || "";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(q);
  }
  const cats = [...groups.keys()].sort((a, b) => (a === "") - (b === ""));
  const closed = new Set(JSON.parse(localStorage.getItem("sq:closed") || "[]"));
  const opened = new Set(JSON.parse(localStorage.getItem("sq:series-open") || "[]"));  // まとめは最初は畳んでおく

  const card = (q) => {
    const p = loadProg(q.id);
    const found = p.secrets || 0;
    const n = p.answered.length - found;
    const status = p.gaveUp ? "ギブアップ" : n >= q.count ? "コンプリート" : n ? "挑戦中" : "";
    return `
    <li class="card">
      <a class="card-main" href="#/play/${q.id}">
        <span class="card-title">${esc(q.title)}</span>
        <span class="card-sub">${q.count}個${n ? ` ・ ${n}/${q.count}` : ""}${found ? ` <span class="star">★${found}</span>` : ""}
          ${status ? `<span class="tag ${n >= q.count ? "done" : ""}">${status}</span>` : ""}</span>
      </a>
      <a class="card-side" href="#/view/${q.id}" aria-label="一覧">一覧</a>
    </li>`;
  };

  // 同じまとめ（series）のクイズが2つ以上あれば、最初に出てくる位置に1つの畳めるカードとしてまとめる
  const seriesCard = (c, name, qs) => {
    const key = `${c}/${name}`;
    let n = 0, total = 0, done = 0;
    for (const q of qs) {
      const p = loadProg(q.id);
      const a = p.answered.length - (p.secrets || 0);
      n += Math.min(a, q.count); total += q.count;
      if (a >= q.count) done++;
    }
    return `
    <li class="series">
      <details data-key="${esc(key)}" ${opened.has(key) ? "open" : ""}>
        <summary class="series-head">
          <span class="card-title">${esc(name)}</span>
          <span class="card-sub">${qs.length}クイズ・${total}個${n ? ` ・ ${n}/${total}` : ""}
            ${done === qs.length ? `<span class="tag done">コンプリート</span>` : done ? `<span class="tag">${done}/${qs.length}完了</span>` : ""}</span>
        </summary>
        <ul class="cards">${qs.map(card).join("")}</ul>
      </details>
    </li>`;
  };
  const catBody = (c) => {
    const qs = groups.get(c);
    const bySeries = new Map();
    for (const q of qs) if (q.series) bySeries.set(q.series, [...(bySeries.get(q.series) || []), q]);
    const out = [];
    for (const q of qs) {
      const ss = q.series && bySeries.get(q.series);
      if (ss && ss.length > 1) {
        if (ss[0] === q) out.push(seriesCard(c, q.series, ss));
      } else out.push(card(q));
    }
    return out.join("");
  };

  $app.innerHTML = `
    ${cats.map((c) => `
      <details class="cat" data-cat="${esc(c)}" style="--h:${catHue(c)}" ${closed.has(c) ? "" : "open"}>
        <summary><span class="cat-icon">${catIcon(c)}</span>${esc(c || "未分類")}<span class="muted">${groups.get(c).length}</span></summary>
        <ul class="cards">${catBody(c)}</ul>
      </details>`).join("")}
    ${STATIC ? "" : `<a class="btn primary wide" href="#/new">＋ クイズを追加</a>`}
    <div class="reset-area">
      <button id="reset-open" class="btn small" type="button">記録をリセット…</button>
      <div id="reset-panel" class="reset-panel" hidden></div>
    </div>`;

  // 記録のリセット。シークレットを1個でも見つけていれば「シークレットは残す」も選べる
  document.getElementById("reset-open").onclick = () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("sq:"));
    const foundKeys = keys.filter((k) => k.startsWith("sq:found:"));
    const anySecret = foundKeys.some((k) => { try { return JSON.parse(localStorage.getItem(k)).length > 0; } catch { return false; } });
    const panel = document.getElementById("reset-panel");
    panel.hidden = false;
    panel.innerHTML = `
      <p>すべてのクイズの回答記録を消します。</p>
      ${anySecret ? `<button id="reset-keep" class="btn small" type="button">シークレット以外をリセット</button>` : ""}
      <button id="reset-all" class="btn small danger" type="button">${anySecret ? "シークレット込みで全部リセット" : "全部リセット"}</button>
      <button id="reset-cancel" class="btn small" type="button">やめる</button>`;
    document.getElementById("reset-cancel").onclick = () => (panel.hidden = true);
    document.getElementById("reset-all").onclick = () => {
      if (!confirm("回答記録をすべて消します。よろしいですか？")) return;
      for (const k of keys) if (k.startsWith("sq:prog:") || k.startsWith("sq:found:")) localStorage.removeItem(k);
      renderHome();
    };
    document.getElementById("reset-keep")?.addEventListener("click", () => {
      if (!confirm("見つけたシークレットは残して、それ以外の回答記録を消します。よろしいですか？")) return;
      for (const k of keys.filter((k) => k.startsWith("sq:prog:"))) {
        const id = k.slice("sq:prog:".length);
        const found = loadFound(id);
        const p = loadProg(id);
        const kept = p.answered.filter((n) => found.has(n));
        saveProg(id, { answered: kept, secrets: kept.length, gaveUp: false });
      }
      renderHome();
    });
  };

  for (const d of $app.querySelectorAll(".series > details")) {
    d.addEventListener("toggle", () => {
      d.open ? opened.add(d.dataset.key) : opened.delete(d.dataset.key);
      localStorage.setItem("sq:series-open", JSON.stringify([...opened]));
    });
  }
  for (const d of $app.querySelectorAll("details.cat")) {
    d.addEventListener("toggle", () => {
      d.open ? closed.delete(d.dataset.cat) : closed.add(d.dataset.cat);
      localStorage.setItem("sq:closed", JSON.stringify([...closed]));
    });
  }
}

// ---------------------------------------------------------------- 回答画面

async function renderPlay(id) {
  const quiz = await api("GET", id);
  setTheme(quiz.category || "");
  const matcher = new Matcher(quiz);
  const isSecret = (i) => !!quiz.items[i].secret;
  const isGhost = (i) => !!quiz.items[i].ghost;  // 判定のみ（正解に数えない）
  const base = quiz.items.filter((it) => !it.secret && !it.ghost).length;  // シークレット等を除いた総数
  const prog = loadProg(id);
  const answered = new Set();
  quiz.items.forEach((it, i) => { if (prog.answered.includes(it.name)) answered.add(i); });
  let gaveUp = prog.gaveUp;
  for (const i of answered) if (isSecret(i)) addFound(id, quiz.items[i].name);
  let showHint = localStorage.getItem("sq:hint") === "1";
  const hasNotes = quiz.items.some((it) => it.note);

  setBar(quiz.title, "#/", `<span id="count"></span>`);
  $app.innerHTML = `
    <div id="head" class="play-head">
      <form id="ans" class="answer" autocomplete="off">
        <input id="in" type="text" enterkeyhint="send" placeholder="答えを入力" autocapitalize="off" spellcheck="false">
        <button class="btn primary" type="submit">回答</button>
      </form>
      <div id="fb" class="feedback">&nbsp;</div>
      <div class="progress"><div id="bar-fill"></div></div>
    </div>
    <div class="tools">
      ${hasNotes ? `<label class="check"><input id="hint" type="checkbox" ${showHint ? "checked" : ""}> ヒント表示</label>` : "<span></span>"}
      <span>
        <button id="giveup" class="btn small danger" type="button">ギブアップ</button>
        <button id="reset" class="btn small" type="button">リセット</button>
      </span>
    </div>
    <div id="grid"></div>`;

  const $in = document.getElementById("in");
  const $fb = document.getElementById("fb");
  const $grid = document.getElementById("grid");
  const $head = document.getElementById("head");
  const pending = new Set();
  const known = (name) => [...answered].some((i) => quiz.items[i].name === name);

  // マスが見える位置（固定ヘッダーの下）までスッとスクロールする。見えていれば何もしない
  function scrollToCell(i) {
    const el = $grid.querySelector(`[data-i="${i}"]`);
    if (!el) return Promise.resolve();
    const top = $head.getBoundingClientRect().bottom;
    const bottom = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const r = el.getBoundingClientRect();
    if (r.top >= top && r.bottom <= bottom) return Promise.resolve();
    window.scrollTo({ top: window.scrollY + r.top - top - 24, behavior: "smooth" });
    return new Promise((resolve) => {
      const done = () => { window.removeEventListener("scrollend", done); clearTimeout(t); resolve(); };
      const t = setTimeout(done, 600);  // scrollend 非対応ブラウザ向け
      window.addEventListener("scrollend", done);
    });
  }

  function persist() {
    saveProg(id, {
      answered: quiz.items.filter((_, i) => answered.has(i)).map((it) => it.name),
      secrets: [...answered].filter(isSecret).length,
      gaveUp,
    });
  }

  // シークレットは見つけるまで枠を出さない（ギブアップでも明かさない）。
  // ただし「全部シークレットの区分」（隠し区分）は、1個見つけると区分ごと空き枠付きで現れる
  function cell(it, i, open) {
    if (it.secret && !answered.has(i) && !open) return "";
    const ok = answered.has(i) && !pending.has(i);  // pending: スクロール待ちで、まだ空欄に見せておく
    const miss = gaveUp && !it.secret;
    const cls = (ok ? "ok" : miss ? "miss" : "blank") + (it.secret ? " secret" : "");
    const text = ok || miss ? (it.secret ? "★ " : "") + esc(it.name) : "";
    const hint = (showHint || miss || ok) && it.note && (ok || !it.secret || open) ? `<small>${esc(noteText(it.note, known))}</small>` : "";
    return `<li class="${cls}" data-i="${i}">${text || "&nbsp;"}${hint}</li>`;
  }

  const groups = groupItems(quiz.items)
    .map(([g, idxs]) => [g, idxs.filter((i) => !isGhost(i))])
    .filter(([, idxs]) => idxs.length);
  const hiddenGroup = (idxs) => idxs.every(isSecret);
  const groupOf = (i) => groups.find(([, idxs]) => idxs.includes(i))?.[0];
  // 完成した区分は畳む。タップで開閉した区分はそれに従う。答えたマスの区分は、埋まるのを見せる間だけ開けておく
  const toggled = new Map();  // 区分名 → 開いているか
  const peeking = new Map();  // 区分名 → 畳み直すタイマー
  function peek(g) {
    clearTimeout(peeking.get(g));
    peeking.set(g, null);
  }
  function unpeekLater(g) {
    clearTimeout(peeking.get(g));
    peeking.set(g, setTimeout(() => { peeking.delete(g); renderGrid(); }, 1200));
  }
  function renderGrid(flash) {
    const shown = groups.filter(([, idxs]) => !hiddenGroup(idxs) || idxs.some((i) => answered.has(i)));
    $grid.innerHTML = shown.map(([g, idxs]) => {
      const open = hiddenGroup(idxs);
      const n = idxs.filter((i) => answered.has(i) && !pending.has(i)).length;
      const len = open ? idxs.length : idxs.filter((i) => !isSecret(i) || answered.has(i)).length;
      if (shown.length < 2) return `<section class="grp"><ol class="grid">${idxs.map((i) => cell(quiz.items[i], i, open)).join("")}</ol></section>`;
      const closed = !peeking.has(g) && (toggled.has(g) ? !toggled.get(g) : n === len);
      const head = `<h3 class="grp-head toggle${n === len ? " done" : ""}${open ? " secret" : ""}" data-g="${esc(g)}">${open ? "★ " : ""}${esc(g || "その他")}<span>${n} / ${len}</span></h3>`;
      return `<section class="grp${closed ? " closed" : ""}">${head}<ol class="grid">${idxs.map((i) => cell(quiz.items[i], i, open)).join("")}</ol></section>`;
    }).join("");
    const found = [...answered].filter(isSecret).length;
    const done = answered.size - found;  // シークレット以外の正解数
    document.getElementById("count").textContent = `${answered.size} / ${base + found}`;
    document.getElementById("bar-fill").style.width = `${(done / base) * 100}%`;
    if (flash !== undefined) $grid.querySelector(`[data-i="${flash}"]`)?.classList.add("flash");
    // コンプリート後もシークレット探しができるよう、入力はギブアップ時だけ止める
    $in.disabled = gaveUp;
    if (gaveUp) {
      $fb.className = "feedback ng";
      $fb.textContent = `ギブアップ：${done} / ${base}`;
    } else if (done === base && flash === undefined) {
      $fb.className = "feedback ok";
      $fb.textContent = "🎉 コンプリート！";
    }
  }

  function feedback(cls, text) {
    $fb.className = "feedback " + cls;
    $fb.textContent = text;
  }

  function accept(r) {
    answered.add(r.index);
    if (isSecret(r.index)) addFound(id, quiz.items[r.index].name);
    persist();
    $in.value = "";
    // 空欄のまま描いて、そのマスまでスクロールしてから埋める
    pending.add(r.index);
    const g0 = groupOf(r.index);
    peek(g0);
    renderGrid();
    scrollToCell(r.index).then(() => {
      if (!pending.delete(r.index)) return;  // 途中でリセットされた
      renderGrid(r.index);
      unpeekLater(g0);
    });
    const name = quiz.items[r.index].name + (r.fuzzy ? "（表記ゆれ）" : "");
    const done = [...answered].filter((i) => !isSecret(i)).length;
    const g = groups.find(([, idxs]) => idxs.includes(r.index));
    const firstInHidden = g && hiddenGroup(g[1]) && g[1].filter((i) => answered.has(i)).length === 1;
    if (firstInHidden) feedback("secret", `★ ${g[0]} 解放！ ${name}`);
    else if (isSecret(r.index)) feedback("secret", `★ シークレット発見！ ${name}`);
    else if (done === base) feedback("ok", `🎉 コンプリート！（${name}）`);
    else feedback("ok", `✓ ${name}`);
  }

  // 入力途中: 確実な完全一致だけ即確定（Enter不要）
  let composing = false;
  $in.addEventListener("compositionstart", () => (composing = true));
  $in.addEventListener("compositionend", () => { composing = false; tryAuto(); });
  $in.addEventListener("input", (e) => { if (!composing && !e.isComposing) tryAuto(); });
  function ghost(r) {
    const it = quiz.items[r.index];
    addFound(id, it.name);
    feedback("ghost", `💡 ${it.name}${it.note ? "：" + noteText(it.note, known) : ""}（正解には数えません）`);
    $in.value = "";
  }
  function tryAuto() {
    const r = matcher.judge($in.value, answered, true);
    if (r.status === "ok") accept(r);
    else if (r.status === "ghost") ghost(r);
  }

  document.getElementById("ans").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $in.value.trim();
    if (!v) return;
    const r = matcher.judge(v, answered, false);
    if (r.status === "ok") accept(r);
    else if (r.status === "ghost") ghost(r);
    else if (r.status === "dup") {
      feedback("dup", `回答済み：${quiz.items[r.index].name}`);
      $in.value = "";
      const g0 = groupOf(r.index);
      peek(g0);
      renderGrid();
      scrollToCell(r.index).then(() => {
        $grid.querySelector(`[data-i="${r.index}"]`)?.classList.add("flash");
        unpeekLater(g0);
      });
    } else {
      feedback("ng", `✗ 「${v}」はありません`);
      $in.select();
    }
    $in.focus();
  });

  $grid.addEventListener("click", (e) => {
    const h = e.target.closest(".grp-head.toggle");
    if (!h) return;
    const g = h.dataset.g;
    peeking.delete(g);
    toggled.set(g, h.parentElement.classList.contains("closed"));
    renderGrid();
  });

  document.getElementById("hint")?.addEventListener("change", (e) => {
    showHint = e.target.checked;
    localStorage.setItem("sq:hint", showHint ? "1" : "0");
    renderGrid();
  });
  document.getElementById("giveup").onclick = () => {
    if (gaveUp || !confirm("ギブアップして答えを表示しますか？")) return;
    gaveUp = true;
    persist();
    renderGrid();
  };
  document.getElementById("reset").onclick = () => {
    if (!confirm("回答をリセットしますか？")) return;
    answered.clear();
    pending.clear();
    gaveUp = false;
    persist();
    feedback("", " ");
    renderGrid();
    $in.focus();
  };

  renderGrid();
  if (!$in.disabled) $in.focus();
}

// ---------------------------------------------------------------- 一覧画面

async function renderView(id) {
  const quiz = await api("GET", id);
  setTheme(quiz.category || "");
  const groups = groupItems(quiz.items);
  const normal = groups
    .map(([g, idxs]) => [g, idxs.filter((i) => !quiz.items[i].secret && !quiz.items[i].ghost)])
    .filter(([, idxs]) => idxs.length);
  const found = loadFound(id);
  const secretCount = quiz.items.filter((it) => it.secret).length;
  const ghostCount = quiz.items.filter((it) => it.ghost).length;
  const secrets = quiz.items.map((_, i) => i).filter((i) => quiz.items[i].secret && found.has(quiz.items[i].name));
  const ghosts = quiz.items.map((_, i) => i).filter((i) => quiz.items[i].ghost && found.has(quiz.items[i].name));
  const wiki = quiz.wiki || {};
  const wikiLink = (name) => {
    if (!wiki[name]) return "";
    const [title, frag] = wiki[name].split("#").map((s) => encodeURIComponent(s.replace(/ /g, "_")));
    return `<a class="wiki" href="https://ja.wikipedia.org/wiki/${title}${frag ? "#" + frag : ""}" target="_blank" rel="noopener">Wikipedia</a>`;
  };
  // 別解が多いとき（反水素など）は、先頭だけ見せて残りは折りたたむ
  const ALIAS_SHOW = 4;
  const aliases = (a) => {
    if (!a.length) return "";
    if (a.length <= ALIAS_SHOW + 1) return `<span class="aliases">${a.map(esc).join(" / ")}</span>`;
    return `<details class="aliases"><summary>${a.slice(0, ALIAS_SHOW).map(esc).join(" / ")} <span class="more">ほか${a.length - ALIAS_SHOW}件</span></summary>${a.slice(ALIAS_SHOW).map(esc).join(" / ")}</details>`;
  };
  const li = (it) => `
              <li data-s="${esc([it.name, ...it.aliases, noteText(it.note), it.group || ""].join(" ").toLowerCase())}">
                <span class="name">${esc(it.name)}</span>
                ${it.note ? `<span class="note">${esc(noteText(it.note))}</span>` : ""}
                ${wikiLink(it.name)}
                ${aliases(it.aliases)}
              </li>`;
  setBar(quiz.title, "#/", STATIC ? "" : `<a class="btn small" href="#/edit/${id}">編集</a>`);
  $app.innerHTML = `
    <div class="view-head">
      <span>${quiz.items.length - secretCount - ghostCount}個</span>
      <a class="btn small primary" href="#/play/${id}">挑戦する</a>
    </div>
    <input id="filter" type="search" placeholder="絞り込み">
    <div id="list">
      ${normal.map(([g, idxs]) => `
        ${normal.length > 1 ? `
        <details class="grp" open>
          <summary class="grp-head toggle">${esc(g || "その他")}<span>${idxs.length}</span></summary>
          <ol class="list">${idxs.map((i) => li(quiz.items[i])).join("")}</ol>
        </details>` : `<ol class="list">${idxs.map((i) => li(quiz.items[i])).join("")}</ol>`}`).join("")}
    </div>
    ${secrets.length ? `
      <details class="secret-box">
        <summary>★ 見つけたシークレット（${secrets.length}個）</summary>
        <ul class="list">${secrets.map((i) => li(quiz.items[i])).join("")}</ul>
      </details>` : ""}
    ${ghosts.length ? `
      <details class="secret-box ghost-box">
        <summary>💡 見つけた番外の答え（正解には数えない・${ghosts.length}個）</summary>
        <ul class="list">${ghosts.map((i) => li(quiz.items[i])).join("")}</ul>
      </details>` : ""}`;
  document.getElementById("filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const li of document.querySelectorAll("#list li")) li.hidden = q && !li.dataset.s.includes(q);
    for (const sec of document.querySelectorAll("#list .grp")) {
      sec.hidden = !sec.querySelector("li:not([hidden])");
      if (q) sec.open = true;  // 畳んだ区分の中の該当も見えるように
    }
  });
}

// ---------------------------------------------------------------- 追加・編集画面

async function renderEdit(id) {
  const [quiz, list] = await Promise.all([
    id ? api("GET", id) : { title: "", category: "", options: { suffix: [], fuzzy: true }, items: [] },
    api("GET"),
  ]);
  const cats = [...new Set(list.map((q) => q.category).filter(Boolean))];
  const series = [...new Set(list.map((q) => q.series).filter(Boolean))];
  setBar(id ? "編集" : "クイズを追加", id ? `#/view/${id}` : "#/");
  $app.innerHTML = `
    <form id="edit" class="edit">
      <label>タイトル<input id="e-title" required value="${esc(quiz.title)}" placeholder="例：アメリカ50州"></label>
      <label>カテゴリ（任意）
        <input id="e-cat" list="e-cats" value="${esc(quiz.category || "")}" placeholder="選択 または 新しく入力">
        <datalist id="e-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      </label>
      <label>まとめ（任意・同じ名前のクイズはホームで1つに畳める）
        <input id="e-series" list="e-series-list" value="${esc(quiz.series || "")}" placeholder="例：新幹線の駅">
        <datalist id="e-series-list">${series.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      </label>
      <label>無視する接尾辞（カンマ区切り・任意）
        <input id="e-suffix" value="${esc(quiz.options.suffix.join(","))}" placeholder="例：州,しゅう">
      </label>
      <label class="check"><input id="e-fuzzy" type="checkbox" ${quiz.options.fuzzy ? "checked" : ""}> 1文字違いまで許容（5文字以上の答えのみ）</label>
      <label>項目（1行に1つ）<span id="e-count" class="muted"></span>
        <textarea id="e-items" rows="14" placeholder="## 西部&#10;ハワイ&#10;## 北東部&#10;ペンシルベニア | ペンシルバニア # 中部大西洋">${esc(itemsToText(quiz.items))}</textarea>
      </label>
      <details class="help">
        <summary>書き方</summary>
        <p><code>名前 | 別解 | 別解 # メモ</code></p>
        <ul>
          <li><code>|</code> の後ろは別解。<b>漢字の項目には読みがなを書いておく</b>と、ひらがなでも正解になります</li>
          <li>カタカナの項目はひらがなでも自動で正解になります（ヴァ/バ、ウェ/ウエ、長音の有無なども自動で吸収）</li>
          <li><code>#</code> の後ろはメモ（ヒント・一覧表示用、判定には使いません）</li>
          <li><code>## 区分名</code> の行を入れると、それ以降の項目がその区分にまとまって表示されます</li>
          <li>行頭に <code>*</code> を付けるとシークレット（総数に出ず、答えると+1）。区分の中身が全部シークレットなら、1個見つけた時点で区分ごと現れます</li>
          <li>行頭に <code>?</code> を付けると判定のみ（答えるとメモを表示するが、正解には数えない）</li>
          <li>メモ中の <code>{厚生労働省|○○省}</code> は、その答えを回答済みなら名前、まだなら伏せ字で表示（伏せ字を省くと「○○」）</li>
        </ul>
      </details>
      <label>判定テスト<input id="e-test" placeholder="ここに入力すると、どれに当たるか表示"></label>
      <div id="e-test-out" class="muted">&nbsp;</div>
      <p id="e-err" class="error"></p>
      <div class="row">
        <button class="btn primary" type="submit">保存</button>
        ${id ? `<button id="e-del" class="btn danger" type="button">削除</button>` : ""}
      </div>
    </form>`;

  const $items = document.getElementById("e-items");
  const $count = document.getElementById("e-count");
  const collect = () => ({
    title: document.getElementById("e-title").value.trim(),
    category: document.getElementById("e-cat").value.trim(),
    series: document.getElementById("e-series").value.trim(),
    options: {
      suffix: document.getElementById("e-suffix").value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean),
      fuzzy: document.getElementById("e-fuzzy").checked,
    },
    items: textToItems($items.value),
  });
  const updateCount = () => {
    const items = textToItems($items.value);
    const sec = items.filter((it) => it.secret).length;
    const gh = items.filter((it) => it.ghost).length;
    $count.textContent = ` ${items.length - sec - gh}個${sec ? `＋シークレット${sec}個` : ""}${gh ? `＋判定のみ${gh}個` : ""}`;
  };
  $items.addEventListener("input", updateCount);
  updateCount();

  const $test = document.getElementById("e-test");
  const $testOut = document.getElementById("e-test-out");
  $test.addEventListener("input", () => {
    const q = collect();
    if (!$test.value.trim()) return ($testOut.innerHTML = "&nbsp;");
    const r = new Matcher(q).judge($test.value, new Set(), false);
    $testOut.textContent = r.status === "ok" ? `→ ${q.items[r.index].name}${r.fuzzy ? "（あいまい一致）" : ""}` : "→ 該当なし";
  });

  document.getElementById("edit").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const saved = id ? await api("PUT", id, collect()) : await api("POST", null, collect());
      location.hash = `#/view/${saved.id}`;
    } catch (err) {
      document.getElementById("e-err").textContent = err.message;
    }
  });
  document.getElementById("e-del")?.addEventListener("click", async () => {
    if (!confirm(`「${quiz.title}」を削除しますか？`)) return;
    await api("DELETE", id);
    localStorage.removeItem(progKey(id));
    location.hash = "#/";
  });
}
