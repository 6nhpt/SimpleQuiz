"""SimpleQuiz - 列挙クイズ用の極小Webサーバー（Python標準ライブラリのみ）

使い方:  python server.py [port]   (既定 8080)
"""
import json
import mimetypes
import os
import re
import sys
import time
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data" / "quizzes"
SEED = ROOT / "seed"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


# ---------------------------------------------------------------- データ層

def parse_text(text):
    """シード用テキスト形式をクイズ辞書に変換する。

    @title タイトル / @category カテゴリ / @suffix 座,ざ / @fuzzy on|off / @order 10 がヘッダ。
    以降は 1行1項目:  名前 | 別解 | 別解 # メモ
    「## 区分名」の行以降の項目はその区分（group）に入る。
    """
    quiz = {"title": "", "category": "", "options": {"suffix": [], "fuzzy": True}, "items": []}
    group = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("@"):
            key, _, val = line[1:].partition(" ")
            val = val.strip()
            if key == "title":
                quiz["title"] = val
            elif key == "category":
                quiz["category"] = val
            elif key == "suffix":
                quiz["options"]["suffix"] = [s.strip() for s in val.split(",") if s.strip()]
            elif key == "fuzzy":
                quiz["options"]["fuzzy"] = val.lower() in ("on", "true", "1", "yes")
            elif key == "order":
                quiz["created"] = float(val)
            continue
        if line.startswith("##"):
            group = line[2:].strip()
            continue
        body, _, note = line.partition("#")
        parts = [p.strip() for p in body.split("|") if p.strip()]
        if not parts:
            continue
        quiz["items"].append({"name": parts[0], "aliases": parts[1:], "note": note.strip(), "group": group})
    return quiz


def seed_new():
    """seed/*.txt のうち、まだ取り込んでいないものを data に取り込む。
    取り込み済みIDは data/seeded.json に記録するので、ユーザーが削除したクイズは復活しない。"""
    DATA.mkdir(parents=True, exist_ok=True)
    log = DATA.parent / "seeded.json"
    seeded = set(json.loads(log.read_text(encoding="utf-8"))) if log.exists() else set()
    if not seeded:  # 記録導入前のデータは、既存ファイルを取り込み済み扱いにする
        seeded = {p.stem for p in DATA.glob("*.json")}
    for i, path in enumerate(sorted(SEED.glob("*.txt"))):
        if path.stem in seeded:
            continue
        quiz = parse_text(path.read_text(encoding="utf-8"))
        quiz["id"] = path.stem
        quiz.setdefault("created", float(i))
        save_quiz(quiz)
        seeded.add(path.stem)
        print(f"  seeded: {quiz['title']} ({len(quiz['items'])})")
    log.write_text(json.dumps(sorted(seeded), ensure_ascii=False, indent=1), encoding="utf-8")


def quiz_path(qid):
    return DATA / f"{qid}.json"


def load_quiz(qid):
    p = quiz_path(qid)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def save_quiz(quiz):
    p = quiz_path(quiz["id"])
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(quiz, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def list_quizzes():
    out = []
    for p in DATA.glob("*.json"):
        try:
            q = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        out.append({"id": q["id"], "title": q.get("title", ""), "category": q.get("category", ""),
                    "count": len(q.get("items", [])),
                    "created": q.get("created", 0)})
    out.sort(key=lambda q: q["created"])
    return out


def clean_quiz(body, qid, created):
    """クライアントから来たJSONを検証・整形する。"""
    if not isinstance(body, dict):
        raise ValueError("invalid body")
    title = str(body.get("title", "")).strip()
    if not title:
        raise ValueError("タイトルが空です")
    opts = body.get("options") or {}
    items = []
    for it in body.get("items") or []:
        name = str(it.get("name", "")).strip()
        if not name:
            continue
        aliases = [str(a).strip() for a in it.get("aliases") or [] if str(a).strip()]
        items.append({"name": name, "aliases": aliases, "note": str(it.get("note", "")).strip(),
                      "group": str(it.get("group", "")).strip()})
    if not items:
        raise ValueError("項目がありません")
    return {
        "id": qid,
        "title": title,
        "category": str(body.get("category", "")).strip(),
        "options": {
            "suffix": [str(s).strip() for s in opts.get("suffix") or [] if str(s).strip()],
            "fuzzy": bool(opts.get("fuzzy", True)),
        },
        "items": items,
        "created": created,
    }


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "SimpleQuiz/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def send_json(self, obj, status=HTTPStatus.OK):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, status, msg):
        self.send_json({"error": msg}, status)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 5_000_000:
            raise ValueError("too large")
        return json.loads(self.rfile.read(n).decode("utf-8") or "null")

    def api_target(self):
        """'/api/quizzes' -> (True, None), '/api/quizzes/<id>' -> (True, id)"""
        path = urlparse(self.path).path.rstrip("/")
        if path == "/api/quizzes":
            return True, None
        m = re.fullmatch(r"/api/quizzes/([^/]+)", path)
        if m:
            return True, unquote(m.group(1))
        return False, None

    # --- GET
    def do_GET(self):
        is_api, qid = self.api_target()
        if is_api:
            if qid is None:
                return self.send_json(list_quizzes())
            if not ID_RE.match(qid) or not (q := load_quiz(qid)):
                return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
            return self.send_json(q)
        if urlparse(self.path).path.startswith("/api/"):
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        self.serve_static()

    def serve_static(self):
        rel = unquote(urlparse(self.path).path).lstrip("/") or "index.html"
        target = (PUBLIC / rel).resolve()
        if PUBLIC not in target.parents or not target.is_file():
            target = PUBLIC / "index.html"
        data = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # --- POST（新規）
    def do_POST(self):
        is_api, qid = self.api_target()
        if not is_api or qid is not None:
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        try:
            quiz = clean_quiz(self.read_body(), "q-" + uuid.uuid4().hex[:10], time.time())
        except ValueError as e:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        save_quiz(quiz)
        self.send_json(quiz, HTTPStatus.CREATED)

    # --- PUT（更新）
    def do_PUT(self):
        is_api, qid = self.api_target()
        if not is_api or not qid or not ID_RE.match(qid) or not (old := load_quiz(qid)):
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        try:
            quiz = clean_quiz(self.read_body(), qid, old.get("created", time.time()))
        except ValueError as e:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, str(e))
        save_quiz(quiz)
        self.send_json(quiz)

    # --- DELETE
    def do_DELETE(self):
        is_api, qid = self.api_target()
        if not is_api or not qid or not ID_RE.match(qid) or not quiz_path(qid).exists():
            return self.send_error_json(HTTPStatus.NOT_FOUND, "not found")
        quiz_path(qid).unlink()
        self.send_json({"ok": True})


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    mimetypes.add_type("application/javascript", ".js")
    mimetypes.add_type("application/manifest+json", ".webmanifest")
    seed_new()
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"SimpleQuiz listening on http://0.0.0.0:{port}/")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
