/* VolumFocus — Service Worker
 * Estratégia:
 *  - Cache First  → App Shell (index.html/manifest) + Google Fonts (CSS + arquivos .woff2)
 *  - Network First → chamadas dinâmicas (Google APIs / Apps Script / qualquer XHR de dados)
 * Objetivo: abrir e treinar 100% offline (academia sem sinal), sem tela branca.
 */
const SW_VERSION = 'vf-v1';
const STATIC_CACHE = `vf-static-${SW_VERSION}`;
const FONT_CACHE = `vf-fonts-${SW_VERSION}`;
const RUNTIME_CACHE = `vf-runtime-${SW_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json'
];

const FONT_ORIGINS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// Hosts que representam DADOS dinâmicos — nunca "Cache First" (senão o aluno
// vê dados velhos como se fossem atuais). Network First com fallback de cache.
const DYNAMIC_HOSTS = ['googleapis.com', 'script.google.com', 'script.googleusercontent.com', 'accounts.google.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.warn('[SW] Falha ao pré-cachear app shell', err))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = [STATIC_CACHE, FONT_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function isFontRequest(url) {
  return FONT_ORIGINS.some((h) => url.hostname.includes(h));
}
function isDynamicRequest(url) {
  return DYNAMIC_HOSTS.some((h) => url.hostname.includes(h));
}

/** Cache First: tenta o cache; se não tiver, busca na rede e guarda uma cópia. */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    // Sem rede e sem cache: devolve algo neutro em vez de estourar erro
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

/** Network First: tenta a rede (dados sempre frescos); se falhar (academia
 *  sem sinal), cai pro último snapshot em cache — nunca quebra o fluxo. */
async function networkFirst(request, cacheName) {
  try {
    const res = await fetch(request);
    if (res && res.ok && request.method === 'GET') {
      const cache = await caches.open(cacheName);
      cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST/PATCH (uploads Drive etc.) sempre direto na rede

  const url = new URL(request.url);

  // 0) Esquemas que a Cache API não aceita (chrome-extension:, moz-extension:
  // etc.) — normalmente requisições internas de extensões do navegador
  // interceptadas pelo listener. Deixa o próprio navegador resolver, sem
  // tentar cachear (evita "Failed to execute 'put' on 'Cache'").
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1) Google Fonts → Cache First (CSS + arquivos de fonte .woff2)
  if (isFontRequest(url)) {
    event.respondWith(cacheFirst(request, FONT_CACHE));
    return;
  }

  // 2) Dados dinâmicos (Drive API, Apps Script, OAuth) → Network First
  if (isDynamicRequest(url)) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  // 3) Mesma origem (app shell: HTML/CSS/JS embutido no index.html) → Cache First
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // 4) Qualquer outra coisa externa → Network First genérico, sem travar o app
  event.respondWith(networkFirst(request, RUNTIME_CACHE));
});
