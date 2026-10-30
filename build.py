"""公開用の静的サイトを dist/ に書き出す（GitHub Pages 用、読み取り専用）

使い方:  python build.py
"""
import json
import shutil
import time

import server

DIST = server.ROOT / "dist"


def main():
    server.seed_new()  # seed/ に未取り込みの txt があれば data/ に取り込む
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(server.PUBLIC, DIST, ignore=shutil.ignore_patterns("_*"))

    # JS/CSS の URL にビルドごとのバージョンを付けて、古いキャッシュを使わせない
    ver = str(int(time.time()))
    index = DIST / "index.html"
    html = index.read_text(encoding="utf-8")
    html = html.replace('<html lang="ja">', '<html lang="ja" data-static="1">', 1)
    html = html.replace('src="app.js"', f'src="app.js?v={ver}"').replace('href="style.css"', f'href="style.css?v={ver}"')
    index.write_text(html, encoding="utf-8")
    app = DIST / "app.js"
    app.write_text(app.read_text(encoding="utf-8").replace('"./matcher.js"', f'"./matcher.js?v={ver}"'), encoding="utf-8")

    out = DIST / "data"
    out.mkdir()
    quizzes = server.list_quizzes()
    for q in quizzes:
        shutil.copy(server.quiz_path(q["id"]), out / f"{q['id']}.json")
    (out / "index.json").write_text(json.dumps(quizzes, ensure_ascii=False), encoding="utf-8")
    (DIST / ".nojekyll").write_text("", encoding="utf-8")
    print(f"built {len(quizzes)} quizzes -> {DIST}")


if __name__ == "__main__":
    main()
