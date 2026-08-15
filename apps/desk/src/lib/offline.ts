/**
 * 断网只读看板（01-ARCHITECTURE §12，宪法第 18 条）
 *
 * 实体店的网说断就断。**页面绝不能变成一堵墙** —— 前台一旦被挡住就会退回纸笔，
 * 而且不一定会回来。
 *
 * 所以：不遮罩、不跳转、不刷新，切成只读看板 + 顶部横幅 + 写按钮置灰。
 *
 * ⚠️ 坚决不做离线写入队列。轮牌顺序、派单、开单是全局强一致状态，
 * 离线改完再合并必然 split-brain（两个前台各自派了同一个技师），
 * 代价远大于收益。断网期间用纸记，恢复后补录 —— 那本来就是他们熟悉的方式。
 */

const DB = 'gf-offline';
const STORE = 'snapshots';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

/** 每次成功请求后写入 —— 断网时这就是前台能看到的最后画面 */
export async function cache(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ value, at: Date.now() }, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    // 缓存失败不该影响正常使用（隐私模式下 IndexedDB 可能不可用）
  }
}

export async function readCache<T>(key: string): Promise<{ value: T; at: number } | null> {
  try {
    const db = await open();
    const out = await new Promise<{ value: T; at: number } | null>((res) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => res((r.result as { value: T; at: number }) ?? null);
      r.onerror = () => res(null);
    });
    db.close();
    return out;
  } catch { return null; }
}

export type NetState = 'online' | 'offline';

/**
 * 断网检测。
 *
 * 不只信 `navigator.onLine` —— 它只反映网卡有没有链路，
 * 门店最常见的情况是「连着 WiFi 但路由器出不去」，那时 onLine 仍是 true。
 * 所以再加一层对自家 /health 的心跳。
 */
export function watchNetwork(
  apiBase: string,
  onChange: (s: NetState, since: number) => void,
  intervalMs = 8_000,
): () => void {
  let state: NetState = navigator.onLine ? 'online' : 'offline';
  let since = Date.now();
  let stopped = false;

  const set = (next: NetState) => {
    if (next === state) return;
    state = next; since = Date.now();
    onChange(state, since);
  };

  const ping = async () => {
    if (stopped) return;
    if (!navigator.onLine) { set('offline'); return; }
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 5_000);
      const r = await fetch(`${apiBase}/health`, { signal: ctl.signal, cache: 'no-store' });
      clearTimeout(t);
      set(r.ok ? 'online' : 'offline');
    } catch {
      set('offline');
    }
  };

  const onOnline = () => void ping();
  const onOffline = () => set('offline');
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  const timer = setInterval(() => void ping(), intervalMs);
  void ping();

  return () => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  };
}
