// Service worker of the locked demo (see lock.mjs). Once the code page has
// stored the key, every request inside the site is answered by fetching the
// encrypted copy (<path>.enc) and decrypting it here. Without the key,
// requests go to the host as usual, which serves only the code page.
const DB = "deho360-demo";
const scope = new URL(self.registration.scope).pathname;
const TYPES = {
  html: "text/html; charset=utf-8",
  js: "text/javascript",
  css: "text/css",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  glb: "model/gltf-binary",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
};
const OPEN = new Set(["sw.js", "lock.json"]);

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("keys");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function storedKey() {
  const d = await db();
  return new Promise((resolve) => {
    const r = d.transaction("keys").objectStore("keys").get("key");
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => resolve(null);
  });
}

self.addEventListener("message", (e) => {
  if (e.data?.type !== "key") return;
  e.waitUntil(
    db().then(
      (d) =>
        new Promise((resolve) => {
          const tx = d.transaction("keys", "readwrite");
          if (e.data.key) tx.objectStore("keys").put(e.data.key, "key");
          else tx.objectStore("keys").delete("key");
          tx.oncomplete = () => {
            e.source?.postMessage({ type: "stored" });
            resolve();
          };
        }),
    ),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(scope) || e.request.method !== "GET") return;
  let path = decodeURIComponent(url.pathname.slice(scope.length));
  if (OPEN.has(path) || path.endsWith(".enc")) return;
  e.respondWith(
    (async () => {
      const key = await storedKey();
      if (!key) return fetch(e.request);
      if (path === "" || path.endsWith("/")) path += "index.html";
      let res = await fetch(`${scope}${path}.enc`);
      // Pages are folders with an index.html ("_not-found/").
      if (res.status === 404 && !/\.[a-z0-9]+$/i.test(path)) {
        path += "/index.html";
        res = await fetch(`${scope}${path}.enc`);
      }
      if (!res.ok) return new Response("Not found", { status: 404 });
      const bytes = new Uint8Array(await res.arrayBuffer());
      try {
        const data = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(path) },
          key,
          bytes.slice(12),
        );
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        return new Response(data, { headers: { "Content-Type": TYPES[ext] ?? "application/octet-stream" } });
      } catch {
        // The site was locked again with another code: forget the old key.
        const d = await db();
        d.transaction("keys", "readwrite").objectStore("keys").delete("key");
        return fetch(e.request);
      }
    })(),
  );
});
