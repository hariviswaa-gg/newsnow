// ─── NewsNow Service Worker ─────────────────────────────────────
// Handles background sync, caching, and push notifications

const CACHE_NAME = 'newsnow-v1';
const RSS2JSON   = 'https://api.rss2json.com/v1/api.json?rss_url=';

const FEEDS = {
  world: 'https://feeds.bbci.co.uk/news/world/rss.xml',
  india: 'https://feeds.feedburner.com/ndtvnews-india-news',
  tn:    'https://news.google.com/rss/search?q=Tamil+Nadu+news&hl=en-IN&gl=IN&ceid=IN:en',
};

const LABELS = {
  world: '🌍 World News',
  india: '🇮🇳 India News',
  tn:    '🏛️ Tamil Nadu',
};

// ─── INSTALL ──────────────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html'])
        .catch(() => {}) // don't fail install if cache fails
    )
  );
});

// ─── ACTIVATE ─────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH (cache-first for app shell) ───────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only cache same-origin app files
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      }).catch(() => caches.match('/index.html'))
    );
  }
});

// ─── BACKGROUND SYNC CHECK ────────────────────────────────────────
// Checks for new news every 20 minutes using periodic timer approach
let checkInterval;

self.addEventListener('message', event => {
  if (event.data === 'START_BACKGROUND_CHECK') {
    clearInterval(checkInterval);
    checkInterval = setInterval(checkForNewArticles, 20 * 60 * 1000);
  }
});

// ─── PERIODIC BACKGROUND SYNC (Chrome Android PWA) ───────────────
self.addEventListener('periodicsync', event => {
  if (event.tag === 'newsnow-check') {
    event.waitUntil(checkForNewArticles());
  }
});

// ─── CHECK FOR NEW ARTICLES ───────────────────────────────────────
async function checkForNewArticles() {
  for (const [category, feedUrl] of Object.entries(FEEDS)) {
    try {
      const res  = await fetch(`${RSS2JSON}${encodeURIComponent(feedUrl)}`);
      const data = await res.json();
      if (data.status !== 'ok' || !data.items?.length) continue;

      const latest    = data.items[0];
      const latestId  = latest.guid || latest.link || latest.title;
      const storedId  = await getStored(`bg_top_${category}`);

      if (storedId && storedId !== latestId) {
        // New article found! Show notification
        await showNotification(category, latest);
      }

      await setStored(`bg_top_${category}`, latestId);
    } catch (e) {
      // Network error, skip silently
    }
  }
}

// ─── SHOW NOTIFICATION ────────────────────────────────────────────
async function showNotification(category, article) {
  const title = LABELS[category] || 'NewsNow';
  const body  = cleanTitle(article.title || '');
  const url   = article.link || '/';

  await self.registration.showNotification(title, {
    body:    body.slice(0, 120),
    icon:    '/icon-192.png',
    badge:   '/icon-192.png',
    tag:     `newsnow-${category}`,
    renotify: true,
    actions: [
      { action: 'open',    title: '📖 Read' },
      { action: 'dismiss', title: '✕ Dismiss' },
    ],
    data: { url },
  });
}

// ─── NOTIFICATION CLICK ───────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ─── SIMPLE STORAGE (IndexedDB-like via Cache API trick) ──────────
// We use a simple Map stored in the service worker scope for persistence
const store = new Map();

async function getStored(key) {
  if (store.has(key)) return store.get(key);
  // Try to read from cache storage as KV
  try {
    const cache = await caches.open('newsnow-kv');
    const res   = await cache.match(`/kv/${key}`);
    if (res) {
      const val = await res.text();
      store.set(key, val);
      return val;
    }
  } catch {}
  return null;
}

async function setStored(key, value) {
  store.set(key, value);
  try {
    const cache = await caches.open('newsnow-kv');
    await cache.put(`/kv/${key}`, new Response(value));
  } catch {}
}

function cleanTitle(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
