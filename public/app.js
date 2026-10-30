import { Matcher, itemsToText, textToItems } from "./matcher.js";

const $app = document.getElementById("app");
const $title = document.getElementById("bar-title");
const $right = document.getElementById("bar-right");
const $back = document.getElementById("back");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

  $app.innerHTML = `
    ${cats.map((c) => `
      <details class="cat" data-cat="${esc(c)}" ${closed.has(c) ? "" : "open"}>
        <summary>${esc(c || "未分類")}<span class="muted">${groups.get(c).length}</span></summary>
        <ul class="cards">${groups.get(c).map(card).join("")}</ul>
      </details>`).join("")}
    ${STATIC ? "" : `<a class="btn primary wide" href="#/new">＋ クイズを追加</a>`}`;

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
  const matcher = new Matcher(quiz);
  const isSecret = (i) => !!quiz.items[i].secret;
  const base = quiz.items.filter((it) => !it.secret).length;  // シークレットを除いた総数
  const prog = loadProg(id);
  const answered = new Set();
  quiz.items.forEach((it, i) => { if (prog.answered.includes(it.name)) answered.add(i); });
  let gaveUp = prog.gaveUp;
  let showHint = localStorage.getItem("sq:hint") === "1";
  const hasNotes = quiz.items.some((it) => it.note);

  setBar(quiz.title, "#/", `<span id="count"></span>`);
  $app.innerHTML = `
    <form id="ans" class="answer" autocomplete="off">
      <input id="in" type="text" enterkeyhint="send" placeholder="答えを入力" autocapitalize="off" spellcheck="false">
      <button class="btn primary" type="submit">回答</button>
    </form>
    <div id="fb" class="feedback">&nbsp;</div>
    <div class="progress"><div id="bar-fill"></div></div>
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

  function persist() {
    saveProg(id, {
      answered: quiz.items.filter((_, i) => answered.has(i)).map((it) => it.name),
      secrets: [...answered].filter(isSecret).length,
      gaveUp,
    });
  }

  function cell(it, i) {
    const ok = answered.has(i);
    // シークレットは見つけるまで枠を出さない（ギブアップ時は種明かし）
    if (it.secret && !ok && !gaveUp) return "";
    const cls = (ok ? "ok" : gaveUp ? "miss" : "blank") + (it.secret ? " secret" : "");
    const text = ok || gaveUp ? (it.secret ? "★ " : "") + esc(it.name) : "";
    const hint = (showHint || gaveUp || ok) && it.note ? `<small>${esc(it.note)}</small>` : "";
    return `<li class="${cls}" data-i="${i}">${text || "&nbsp;"}${hint}</li>`;
  }

  const groups = groupItems(quiz.items);
  function renderGrid(flash) {
    $grid.innerHTML = groups.map(([g, idxs]) => {
      const n = idxs.filter((i) => answered.has(i)).length;
      const len = idxs.filter((i) => !isSecret(i) || answered.has(i)).length;
      const head = groups.length > 1
        ? `<h3 class="grp-head${n === len ? " done" : ""}">${esc(g || "その他")}<span>${n} / ${len}</span></h3>`
        : "";
      return `<section class="grp">${head}<ol class="grid">${idxs.map((i) => cell(quiz.items[i], i)).join("")}</ol></section>`;
    }).join("");
    const found = [...answered].filter(isSecret).length;
    const done = answered.size - found;  // シークレット以外の正解数
    document.getElementById("count").textContent = `${answered.size} / ${base + found}`;
    document.getElementById("bar-fill").style.width = `${(done / base) * 100}%`;
    if (flash !== undefined) $grid.querySelector(`[data-i="${flash}"]`)?.classList.add("flash");
    // コンプリート後もシークレット探しができるよう、入力はギブアップ時だけ止める
    $in.disabled = gaveUp || answered.size === quiz.items.length;
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
    persist();
    $in.value = "";
    renderGrid(r.index);
    const name = quiz.items[r.index].name + (r.fuzzy ? "（表記ゆれ）" : "");
    const done = [...answered].filter((i) => !isSecret(i)).length;
    if (isSecret(r.index)) feedback("secret", `★ シークレット発見！ ${name}`);
    else if (done === base) feedback("ok", `🎉 コンプリート！（${name}）`);
    else feedback("ok", `✓ ${name}`);
  }

  // 入力途中: 確実な完全一致だけ即確定（Enter不要）
  let composing = false;
  $in.addEventListener("compositionstart", () => (composing = true));
  $in.addEventListener("compositionend", () => { composing = false; tryAuto(); });
  $in.addEventListener("input", (e) => { if (!composing && !e.isComposing) tryAuto(); });
  function tryAuto() {
    const r = matcher.judge($in.value, answered, true);
    if (r.status === "ok") accept(r);
  }

  document.getElementById("ans").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $in.value.trim();
    if (!v) return;
    const r = matcher.judge(v, answered, false);
    if (r.status === "ok") accept(r);
    else if (r.status === "dup") {
      feedback("dup", `回答済み：${quiz.items[r.index].name}`);
      $in.value = "";
      $grid.querySelector(`[data-i="${r.index}"]`)?.classList.add("flash");
    } else {
      feedback("ng", `✗ 「${v}」はありません`);
      $in.select();
    }
    $in.focus();
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
  const groups = groupItems(quiz.items);
  const normal = groups
    .map(([g, idxs]) => [g, idxs.filter((i) => !quiz.items[i].secret)])
    .filter(([, idxs]) => idxs.length);
  const secrets = quiz.items.map((_, i) => i).filter((i) => quiz.items[i].secret);
  const li = (it) => `
              <li data-s="${esc([it.name, ...it.aliases, it.note, it.group || ""].join(" ").toLowerCase())}">
                <span class="name">${esc(it.name)}</span>
                ${it.note ? `<span class="note">${esc(it.note)}</span>` : ""}
                ${it.aliases.length ? `<span class="aliases">${it.aliases.map(esc).join(" / ")}</span>` : ""}
              </li>`;
  setBar(quiz.title, "#/", STATIC ? "" : `<a class="btn small" href="#/edit/${id}">編集</a>`);
  $app.innerHTML = `
    <div class="view-head">
      <span>${quiz.items.length - secrets.length}個</span>
      <a class="btn small primary" href="#/play/${id}">挑戦する</a>
    </div>
    <input id="filter" type="search" placeholder="絞り込み">
    <div id="list">
      ${normal.map(([g, idxs]) => `
        <section class="grp">
          ${normal.length > 1 ? `<h3 class="grp-head">${esc(g || "その他")}<span>${idxs.length}</span></h3>` : ""}
          <ol class="list">${idxs.map((i) => li(quiz.items[i])).join("")}</ol>
        </section>`).join("")}
    </div>
    ${secrets.length ? `
      <details class="secret-box">
        <summary>★ シークレット（ネタバレ注意・${secrets.length}個）</summary>
        <ul class="list">${secrets.map((i) => li(quiz.items[i])).join("")}</ul>
      </details>` : ""}`;
  document.getElementById("filter").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    for (const li of document.querySelectorAll("#list li")) li.hidden = q && !li.dataset.s.includes(q);
    for (const sec of document.querySelectorAll("#list .grp")) sec.hidden = !sec.querySelector("li:not([hidden])");
  });
}

// ---------------------------------------------------------------- 追加・編集画面

async function renderEdit(id) {
  const [quiz, list] = await Promise.all([
    id ? api("GET", id) : { title: "", category: "", options: { suffix: [], fuzzy: true }, items: [] },
    api("GET"),
  ]);
  const cats = [...new Set(list.map((q) => q.category).filter(Boolean))];
  setBar(id ? "編集" : "クイズを追加", id ? `#/view/${id}` : "#/");
  $app.innerHTML = `
    <form id="edit" class="edit">
      <label>タイトル<input id="e-title" required value="${esc(quiz.title)}" placeholder="例：アメリカ50州"></label>
      <label>カテゴリ（任意）
        <input id="e-cat" list="e-cats" value="${esc(quiz.category || "")}" placeholder="選択 または 新しく入力">
        <datalist id="e-cats">${cats.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
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
          <li>行頭に <code>*</code> を付けるとシークレット（総数に出ず、答えると+1）</li>
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
    options: {
      suffix: document.getElementById("e-suffix").value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean),
      fuzzy: document.getElementById("e-fuzzy").checked,
    },
    items: textToItems($items.value),
  });
  const updateCount = () => {
    const items = textToItems($items.value);
    const sec = items.filter((it) => it.secret).length;
    $count.textContent = ` ${items.length - sec}個${sec ? `＋シークレット${sec}個` : ""}`;
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
