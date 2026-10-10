// Background worker: settings, per-tab counts, badge, EasyList engine.
// Answers batched URL classification for content scripts.
// Observes only — never blocks traffic; the list is parsed data, never executed.
import { FiltersEngine, Request } from '@cliqz/adblocker';
import {
  DEFAULT_SETTINGS,
  type ClassifyResponse,
  type HighlightSettings,
  type RuntimeMsg,
  type UpdateListResponse,
} from '@/utils/settings';
import {
  EASYLIST_CACHE_KEY,
  EASYLIST_TTL_MS,
  EASYLIST_URL,
  MAX_BATCH_URLS,
  type ClassifyRequest,
  type EngineStatus,
} from '@/utils/easylist';

const SETTINGS_KEY = 'highlightAdsSettings';
const tabCounts = new Map<number, number>();
// Per-frame counts, summed per tab.
const frameCounts = new Map<string, number>();
const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const lastBadgeText = new Map<number, string>();
// Peak per tab load — the badge never drops below the max seen.
const peakCounts = new Map<number, number>();
const BADGE_DEBOUNCE_MS = 500;

export default defineBackground(() => {
  void ensureDefaults();
  void ensureEngine();

  chrome.runtime.onInstalled.addListener(() => {
    void ensureDefaults();
    void ensureEngine();
  });
  chrome.runtime.onStartup?.addListener(() => {
    void ensureDefaults();
    void ensureEngine();
  });

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as RuntimeMsg;
    if (msg.type === 'AD_COUNT') {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        // Sum per-frame counts so frames can't overwrite each other.
        frameCounts.set(`${tabId}:${sender.frameId ?? 0}`, msg.count);
        scheduleBadge(tabId);
      }
      return;
    }
    if (msg.type === 'GET_AD_COUNT') {
      // Popup has no tab context — resolve via the active tab.
      void resolveActiveCount().then((count) => sendResponse({ count }));
      return true;
    }
    if (msg.type === 'CLASSIFY_URLS') {
      void classifyBatch(msg.requests).then((res) => sendResponse(res));
      return true;
    }
    if (msg.type === 'GET_ENGINE_STATUS') {
      void getEngineStatus().then((status) => sendResponse(status));
      return true;
    }
    if (msg.type === 'UPDATE_LIST') {
      void forceUpdateList().then((res) => sendResponse(res));
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]?.newValue) return;
    const settings = changes[SETTINGS_KEY].newValue as HighlightSettings;
    void broadcastSettings(settings);
  });

  chrome.tabs.onActivated.addListener((info) => {
    const count = tabCounts.get(info.tabId) ?? 0;
    void updateBadge(info.tabId, count);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      // New navigation — drop the old page's counts.
      for (const key of frameCounts.keys()) {
        if (key.startsWith(`${tabId}:`)) frameCounts.delete(key);
      }
      const timer = badgeTimers.get(tabId);
      if (timer !== undefined) {
        clearTimeout(timer);
        badgeTimers.delete(tabId);
      }
      lastBadgeText.delete(tabId);
      tabCounts.delete(tabId);
      peakCounts.delete(tabId);
      void updateBadge(tabId, 0);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    tabCounts.delete(tabId);
    peakCounts.delete(tabId);
    lastBadgeText.delete(tabId);
    const timer = badgeTimers.get(tabId);
    if (timer !== undefined) {
      clearTimeout(timer);
      badgeTimers.delete(tabId);
    }
    for (const key of frameCounts.keys()) {
      if (key.startsWith(`${tabId}:`)) frameCounts.delete(key);
    }
  });
});

async function ensureDefaults(): Promise<void> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  if (!raw?.[SETTINGS_KEY]) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  }
}

async function getSettings(): Promise<HighlightSettings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(raw?.[SETTINGS_KEY] ?? {}) };
}

// Push settings to every tab's content scripts.
async function broadcastSettings(
  settings: HighlightSettings,
): Promise<void> {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map(async (t) => {
      if (t.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(t.id, {
          type: 'SETTINGS_CHANGED',
          settings,
        } satisfies RuntimeMsg);
      } catch {
        // No content script yet.
      }
    }),
  );
}

function tabTotal(tabId: number): number {
  let total = 0;
  for (const [key, count] of frameCounts) {
    if (key.startsWith(`${tabId}:`)) total += count;
  }
  return total;
}

// Debounced badge write — paints once, only when the text changes.
function scheduleBadge(tabId: number): void {
  const pending = badgeTimers.get(tabId);
  if (pending !== undefined) clearTimeout(pending);
  badgeTimers.set(
    tabId,
    setTimeout(() => {
      badgeTimers.delete(tabId);
      const total = Math.max(tabTotal(tabId), peakCounts.get(tabId) ?? 0);
      peakCounts.set(tabId, total);
      tabCounts.set(tabId, total);
      void updateBadge(tabId, total);
    }, BADGE_DEBOUNCE_MS),
  );
}

async function updateBadge(tabId: number, count: number): Promise<void> {
  try {
    const settings = await getSettings();
    const text = !settings.enabled || count <= 0 ? '' : String(count);
    if (lastBadgeText.get(tabId) === text) return;
    lastBadgeText.set(tabId, text);
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({
      tabId,
      color: '#ffffff',
    });
  } catch {
    // Tab may be gone.
  }
}

async function resolveActiveCount(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId === undefined) return 0;
  try {
    const res = (await chrome.tabs.sendMessage(tabId, {
      type: 'GET_AD_COUNT',
    } satisfies RuntimeMsg)) as { count?: number } | undefined;
    const count = res?.count ?? tabCounts.get(tabId) ?? 0;
    tabCounts.set(tabId, count);
    return count;
  } catch {
    return tabCounts.get(tabId) ?? 0;
  }
}

interface CachedList {
  text: string;
  fetchedAt: string;
}

let engine: FiltersEngine | null = null;
let engineMeta: Omit<EngineStatus, 'ready'> = {};
let enginePromise: Promise<void> | null = null;

function isStale(fetchedAt: string | undefined): boolean {
  if (!fetchedAt) return true;
  return Date.now() - Date.parse(fetchedAt) > EASYLIST_TTL_MS;
}

function countCandidateRules(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[')) continue;
    if (t.includes('##') || t.includes('#@#') || t.includes('#?#')) continue;
    n += 1;
  }
  return n;
}

// Parse the cached list now; refresh in the background if stale.
function ensureEngine(): Promise<void> {
  if (!enginePromise) enginePromise = loadEngine().finally(() => {
    enginePromise = null;
  });
  return enginePromise;
}

async function loadEngine(): Promise<void> {
  // 1. Bundled snapshot first — full engine even offline or first run.
  let activeAt = 0;
  try {
    const res = await fetch(chrome.runtime.getURL('lists/easylist.txt'));
    if (res.ok) {
      const text = await res.text();
      if (validateListText(text).ok) {
        const at = bundledDate(text) ?? 0;
        await setEngine(text, new Date(at || Date.now()).toISOString());
        activeAt = at;
      }
    }
  } catch {
    // No bundled file — fall through to cache/network below.
  }

  // 2. Storage cache wins if newer than the bundle.
  let cached: CachedList | null = null;
  try {
    const raw = await chrome.storage.local.get(EASYLIST_CACHE_KEY);
    cached = (raw?.[EASYLIST_CACHE_KEY] as CachedList | undefined) ?? null;
  } catch {
    cached = null;
  }

  if (cached?.text) {
    const verdict = validateListText(cached.text);
    const cachedAt = Date.parse(cached.fetchedAt);
    if (verdict.ok && cachedAt > activeAt) {
      await setEngine(cached.text, cached.fetchedAt);
      activeAt = cachedAt;
    } else if (!verdict.ok) {
      // Drop invalid cached payloads.
      cached = null;
      try {
        await chrome.storage.local.remove(EASYLIST_CACHE_KEY);
      } catch {
        // Storage unavailable — fetch from network below.
      }
    }
  }
  if (activeAt === 0 || isStale(new Date(activeAt).toISOString())) {
    // Refresh in the background while serving the current engine.
    void refreshList().catch(() => {});
  }
}

// Read the list's own date from its "! Last modified:" header.
function bundledDate(text: string): number {
  const m = text.match(/^! Last modified:\s*(.+)$/m);
  if (!m) return 0;
  const t = Date.parse((m[1] ?? '').trim());
  return Number.isNaN(t) ? 0 : t;
}

async function setEngine(text: string, fetchedAt: string): Promise<void> {
  const parsed = await FiltersEngine.parse(text);
  engine = parsed;
  engineMeta = { updatedAt: fetchedAt, ruleCount: countCandidateRules(text) };
}

// Reject non-EasyList payloads before caching or parsing.
function validateListText(text: unknown): { ok: boolean; reason?: string } {
  if (typeof text !== 'string') return { ok: false, reason: 'not text' };
  if (text.length < 50_000) return { ok: false, reason: 'too small' };
  if (text.length > 15_000_000) return { ok: false, reason: 'too large' };
  if (text.includes('\0')) return { ok: false, reason: 'null bytes' };
  const firstLine = text.split('\n', 1)[0]?.trim();
  if (firstLine !== '[Adblock Plus 2.0]') {
    return { ok: false, reason: 'missing ABP header' };
  }
  if (!text.includes('! Title: EasyList')) {
    return { ok: false, reason: 'not EasyList' };
  }
  const lines = text.split('\n');
  if (lines.length < 5000) return { ok: false, reason: 'too few rules' };
  let networkRules = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[')) continue;
    if (t.includes('##') || t.includes('#@#') || t.includes('#?#')) continue;
    if (t.startsWith('||') || t.startsWith('|') || t.startsWith('@@')) {
      networkRules += 1;
    }
  }
  if (networkRules < 1000) return { ok: false, reason: 'no network rules' };
  return { ok: true };
}

async function refreshList(): Promise<void> {
  const res = await fetch(EASYLIST_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`EasyList fetch failed: ${res.status}`);
  const text = await res.text();
  const verdict = validateListText(text);
  if (!verdict.ok) throw new Error(`Rejected EasyList: ${verdict.reason}`);
  const fetchedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [EASYLIST_CACHE_KEY]: { text, fetchedAt } satisfies CachedList,
  });
  await setEngine(text, fetchedAt);
}

// Popup "Update list now" — always fetches fresh.
async function forceUpdateList(): Promise<UpdateListResponse> {
  try {
    await refreshList();
    const status = await getEngineStatus();
    return {
      ok: true,
      updatedAt: status.updatedAt,
      ruleCount: status.ruleCount,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function getEngineStatus(): Promise<EngineStatus> {
  await ensureEngine().catch(() => {});
  return { ready: engine !== null, ...engineMeta };
}

async function classifyBatch(
  requests: ClassifyRequest[],
): Promise<ClassifyResponse> {
  await ensureEngine().catch(() => {});
  if (!engine) {
    // Engine not ready — caller uses the local fallback.
    void refreshList()
      .then(() => {})
      .catch(() => {});
    return { ready: false, results: [] };
  }
  const active = engine;
  const results = requests.slice(0, MAX_BATCH_URLS).map((r) => {
    try {
      const match = active.match(
        Request.fromRawDetails({
          url: r.url,
          sourceUrl: r.sourceUrl,
          type: r.reqType,
        }),
      );
      if (match.match) {
        const rawLine = match.filter?.rawLine;
        return {
          url: r.url,
          isAd: true,
          filter:
            typeof rawLine === 'string' ? rawLine.slice(0, 140) : undefined,
        };
      }
      return { url: r.url, isAd: false };
    } catch {
      return { url: r.url, isAd: false };
    }
  });
  return { ready: true, results };
}
