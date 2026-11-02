// オフライン用の Service Worker（公開版のみ登録する）
// 版番号と、初回に取っておく全ファイルの一覧は build.py が埋める。
// 以後はネットを優先しつつ、繋がらない・遅いときは取っておいた分を返す
const CACHE = "sq-__VERSION__";
const FILES = __FILES__;
const WAIT = 3000;  // これ以上ネットが遅ければキャッシュを返す（ms）

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    // 1つでも取れなければ全体が失敗する（中途半端に保存しない）
    const cache = await caches.open(CACHE);
    await cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("sq-") && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(handle(req, url));
});

async function handle(req, url) {
  const cache = await caches.open(CACHE);
  // ?v= はブラウザのキャッシュ避けなので、キーからは外す
  const key = req.mode === "navigate" ? "./" : url.pathname.slice(new URL("./", location).pathname.length) || "./";
  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  const cached = await cache.match(key);
  if (!cached) return net;
  net.catch(() => {});
  return Promise.race([
    net.catch(() => cached),
    new Promise((r) => setTimeout(() => r(cached), WAIT)),
  ]);
}
