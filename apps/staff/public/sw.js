/**
 * Service Worker —— 只做两件事：让 PWA 能装到主屏，让静态资源秒开。
 *
 * ⚠️⚠️ **绝不做离线写入队列**（宪法第 18 条）。
 *
 * 一个装在技师口袋里、信号时有时无的设备，如果能把「开始/完成/打卡」
 * 攒起来晚点再发，就一定会在某天把半小时前的状态覆盖掉现在的状态，
 * 而且没有任何人看得出来发生了什么。断网时正确的行为是：
 * 界面明确告诉技师「现在连不上」，写操作置灰，让人去喊前台。
 *
 * 所以这里的缓存策略是：
 *   · 导航请求（HTML）走 network-first —— 版本更新必须立刻生效，
 *     缓存优先会让技师用着上周的代码而毫不知情
 *   · 带 hash 的静态资源走 cache-first —— 它们的内容永不改变
 *   · **API 请求一律不碰**：既不缓存也不重放
 */

const CACHE = 'gf-staff-v1';
const SHELL = ['/', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // 写操作永远直连

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // API 与 Supabase 一律不碰

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        // 断网时给出上次的应用外壳；页面自己会显示"连不上"横幅并置灰写操作
        .catch(() => caches.match('/').then((r) => r ?? Response.error())),
    );
    return;
  }

  if (/\.[0-9a-f]{8,}\./.test(url.pathname) || SHELL.includes(url.pathname)) {
    e.respondWith(
      caches.match(req).then((hit) => hit ?? fetch(req).then((res) => {
        const copy = res.clone();
        void caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
  }
});
