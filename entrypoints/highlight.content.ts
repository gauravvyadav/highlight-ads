import '@/assets/highlight.css';
import {
  DEMO_PARAM,
  classifyUrl,
  currentFrameHasDemoParam,
  type AdReason,
} from '@/utils/filterlist';
import {
  MAX_BATCH_URLS,
  requestTypeForTag,
  type AdRequestType,
} from '@/utils/easylist';
import {
  colorHex,
  getSettings,
  type ClassifyResponse,
  type HighlightSettings,
  type RuntimeMsg,
} from '@/utils/settings';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',

  main() {
    main();
  },
});

const OVERLAY_CLASS = '__highlight-ads-overlay';
const BADGE_CLASS = '__highlight-ads-badge';
const OUTLINE_CLASS = '__highlight-ads-flagged';
const FRAME_QUERY = 'iframe, embed, object';
const MEDIA_QUERY = 'img, video';

const REASON_LABEL: Record<AdReason, string> = {
  MatchedBlockingRule: 'Matched filter rule',
  CreatedByAdScript: 'Created by ad script',
  ParentIsAd: 'Inside ad frame',
  DemoParam: 'Demo param (?ad_filterlist_demo_param=1)',
  AdMarker: 'Ad marker in id/class',
  AdLabel: 'Labeled advertisement',
  AdSlotSize: 'Standard ad slot size',
};

interface State {
  settings: HighlightSettings;
  adScriptUrls: Set<string>;
  lastAdScriptAt: number;
  overlays: Map<Element, HTMLDivElement>;
  reportTimer: number | null;
  // EasyList verdicts from the background engine.
  urlCache: Map<string, { isAd: boolean; filter?: string }>;
  // DOM-signal flags, persisted between throttled passes.
  domFlagged: Set<Element>;
}

const state: State = {
  settings: { enabled: true, color: 'red' },
  adScriptUrls: new Set(),
  lastAdScriptAt: 0,
  overlays: new Map(),
  reportTimer: null,
  urlCache: new Map(),
  domFlagged: new Set(),
};

function main(): void {
  // Top frame only — subframes would double-flag and double-count.
  if (window !== window.top) return;

  void getSettings().then((settings) => {
    state.settings = settings;
    if (settings.enabled) boot();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.highlightAdsSettings?.newValue) return;
    state.settings = changes.highlightAdsSettings
      .newValue as HighlightSettings;
    if (state.settings.enabled) {
      boot();
      rescan('settings-on');
    } else {
      clearAll();
    }
  });

  chrome.runtime.onMessage.addListener((raw: RuntimeMsg, _sender, send) => {
    if (raw.type === 'SETTINGS_CHANGED') {
      state.settings = raw.settings;
      if (state.settings.enabled) {
        boot();
        rescan('msg-settings');
      } else {
        clearAll();
      }
    } else if (raw.type === 'GET_AD_COUNT') {
      send({ count: state.overlays.size });
      return true;
    }
  });

  // SPAs don't rerun content scripts — rescan on history changes.
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args as never);
    scheduleRescan('spa-push');
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args as never);
    scheduleRescan('spa-replace');
    return r;
  };
  window.addEventListener('popstate', () => scheduleRescan('spa-pop'));
  window.addEventListener('hashchange', () => scheduleRescan('spa-hash'));
}

let booted = false;
function boot(): void {
  if (booted) return;
  booted = true;
  observe();
  rescan('boot');
  // Reposition overlays every frame while scrolling.
  document.addEventListener('scroll', scheduleRefresh, {
    passive: true,
    capture: true,
  });
  window.addEventListener('resize', refreshOverlays);
  // Backstop for animated/resizing slots.
  window.setInterval(() => {
    if (state.overlays.size > 0) refreshOverlays();
  }, 1500);
}

let refreshQueued = false;
function scheduleRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  window.requestAnimationFrame(() => {
    refreshQueued = false;
    refreshOverlays();
  });
}

function observe(): void {
  const observer = new MutationObserver((mutations) => {
    let dirty = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) {
          ingestNode(node);
          if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(
              `${FRAME_QUERY}, ${MEDIA_QUERY}, script`,
            )) {
              ingestNode(el as HTMLElement);
            }
          }
          dirty = true;
        }
      }
      if (
        m.type === 'attributes' &&
        m.target instanceof HTMLElement &&
        (m.attributeName === 'src' || m.attributeName === 'data-src')
      ) {
        ingestNode(m.target);
        dirty = true;
      }
    }
    if (dirty) scheduleRescan('mutation');
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'data-src'],
  });
}

function ingestNode(el: Element): void {
  if (el.tagName === 'SCRIPT') {
    const src = (el as HTMLScriptElement).src;
    if (src && classifyUrl(src).isAd) {
      state.adScriptUrls.add(src);
      state.lastAdScriptAt = Date.now();
    }
  }
}

function scheduleRescan(_why: string): void {
  window.requestAnimationFrame(() => rescan('scheduled'));
}

// Full scan of the current document.
function rescan(_why: string): void {
  if (!state.settings.enabled) {
    clearAll();
    return;
  }
  recordAdScripts();

  const seen = new Set<Element>();
  const unknown: Candidate[] = [];
  for (const c of collectCandidates()) {
    // Chrome's manual-testing hook.
    if (c.url.includes(DEMO_PARAM)) {
      flag(c.el, 'DemoParam');
      seen.add(c.el);
      continue;
    }
    // Known URL — use the cached verdict.
    const cached = state.urlCache.get(c.url);
    if (cached) {
      if (cached.isAd) {
        flag(c.el, 'MatchedBlockingRule', cached.filter);
        seen.add(c.el);
      }
      continue;
    }
    unknown.push(c);
  }

  // Local fallback for URLs the engine hasn't ruled on.
  applyHeuristicMode(seen, unknown);
  // DOM signals catch what URL matching cannot.
  if (Date.now() - lastDomSignalAt >= DOM_SIGNAL_INTERVAL_MS) {
    // Fresh signal pass — drop stale verdicts so they clear properly.
    state.domFlagged.clear();
  }
  applyDomSignals(seen);
  for (const el of state.domFlagged) {
    if (el.isConnected) seen.add(el);
    else state.domFlagged.delete(el);
  }
  queueBatch(unknown.filter((c) => !seen.has(c.el)));

  // Keep only the innermost highlight when nested.
  dedupeNested(seen);

  // Drop overlays for removed or disqualified elements.
  for (const [el] of state.overlays) {
    if (!seen.has(el) || !el.isConnected) unflag(el);
  }
  queueCountReport();
}

interface Candidate {
  el: Element;
  url: string;
  reqType: AdRequestType;
}

function collectCandidates(): Candidate[] {
  const out: Candidate[] = [];
  document
    .querySelectorAll(`${FRAME_QUERY}, ${MEDIA_QUERY}`)
    .forEach((el) => {
      const url = resolveUrl(el);
      if (!url) return;
      out.push({ el, url, reqType: requestTypeForTag(el.tagName) });
    });
  return out;
}

function resolveUrl(el: Element): string {
  const idlSrc =
    'src' in el ? (el as HTMLImageElement).src : '';
  if (idlSrc) return idlSrc;
  const attr =
    el.getAttribute('src') ??
    el.getAttribute('data-src') ??
    (el.tagName === 'OBJECT' ? el.getAttribute('data') : null);
  if (!attr) return '';
  try {
    return new URL(attr, document.baseURI).href;
  } catch {
    return '';
  }
}

function recordAdScripts(): void {
  // Feeds the created-by-ad-script check.
  for (const s of document.scripts) {
    if (!s.src) continue;
    if (
      classifyUrl(s.src).isAd ||
      state.urlCache.get(s.src)?.isAd
    ) {
      state.adScriptUrls.add(s.src);
      state.lastAdScriptAt = Date.now();
    }
  }
}

/* Batched EasyList classification via the background engine. */

let batchTimer: number | null = null;
let batchInflight = false;
let batchQueued: Candidate[] = [];
let engineRetryTimer: number | null = null;

function queueBatch(cands: Candidate[]): void {
  for (const c of cands) {
    if (
      state.urlCache.has(c.url) ||
      batchQueued.some((q) => q.url === c.url)
    ) {
      continue;
    }
    batchQueued.push(c);
  }
  if (batchQueued.length === 0 || batchTimer !== null) return;
  batchTimer = window.setTimeout(() => {
    batchTimer = null;
    void flushBatch();
  }, 250);
}

async function flushBatch(): Promise<void> {
  if (batchInflight || batchQueued.length === 0) return;
  batchInflight = true;
  const cands = batchQueued.splice(0, MAX_BATCH_URLS);
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'CLASSIFY_URLS',
      requests: cands.map((c) => ({
        url: c.url,
        sourceUrl: location.href,
        reqType: c.reqType,
      })),
    } satisfies RuntimeMsg)) as ClassifyResponse | undefined;
    if (res?.ready) {
      for (const r of res.results) {
        state.urlCache.set(r.url, { isAd: r.isAd, filter: r.filter });
      }
      if (batchQueued.length > 0) void flushBatch();
      else rescan('engine-results');
    } else {
      // Engine not ready — retry later.
      batchQueued.unshift(...cands);
      scheduleEngineRetry();
    }
  } catch {
    // Background unreachable — fallback already applied.
    batchQueued.unshift(...cands);
    scheduleEngineRetry();
  } finally {
    batchInflight = false;
  }
}

function scheduleEngineRetry(): void {
  if (engineRetryTimer !== null) return;
  engineRetryTimer = window.setTimeout(() => {
    engineRetryTimer = null;
    void flushBatch();
  }, 15000);
}

// Local fallback: patterns, ad-script creators, sticky parents.
function applyHeuristicMode(
  seen: Set<Element>,
  candidates: Candidate[],
): void {
  const frameIsDemo = currentFrameHasDemoParam(location.href);
  candidates.forEach(({ el, url }) => {
    if (seen.has(el)) return;
    // Honor engine exceptions (@@) for pattern matching.
    const engineCleared = state.urlCache.get(url)?.isAd === false;
    if (!engineCleared) {
      const match = classifyUrl(url);
      if (match.isAd && match.reason) {
        flag(el, match.reason, match.pattern);
        seen.add(el);
        return;
      }
    }
    // Iframe created by (or shortly after) a known ad script.
    if (el.tagName === 'IFRAME') {
      const creator = document.currentScript as HTMLScriptElement | null;
      if (creator?.src && state.adScriptUrls.has(creator.src)) {
        flag(el, 'CreatedByAdScript', creator.src);
        seen.add(el);
        return;
      }
      if (
        !url &&
        state.adScriptUrls.size > 0 &&
        Date.now() - state.lastAdScriptAt < 2000
      ) {
        flag(el, 'CreatedByAdScript');
        seen.add(el);
        return;
      }
    }
    // Media inside a flagged slot inherits the flag.
    const parentFlag = (el as HTMLElement).closest?.(
      `.${OUTLINE_CLASS}`,
    ) as HTMLElement | null;
    if (parentFlag && el !== parentFlag) {
      flag(el, 'ParentIsAd');
      seen.add(el);
      return;
    }
    if (frameIsDemo && (el.tagName === 'IFRAME' || el.tagName === 'EMBED')) {
      flag(el, 'DemoParam');
      seen.add(el);
    }
  });
}

// Id/class markers that always mean ads.
const HARD_MARKER_ID_PREFIX = [
  'div-gpt-ad',
  'google_ads',
  'google-ad',
  'ad-slot',
  'adslot',
  'banner-ad',
  'ad-banner',
  'ads-container',
  'advert-container',
];
const HARD_MARKER_CLASS = new Set([
  'adsbygoogle',
  'advertisement',
  'sponsored-content',
  'ad-slot',
]);
const HARD_MARKER_ATTR = ['data-ad-client', 'data-ad-slot', 'data-adtest'];

// Markers needing corroboration (embedded frame/media or ad label).
const SOFT_MARKER_RE =
  /(advert|banner|sponsor|taboola|outbrain|mgid|revcontent|criteo|doubleclick|popunder|interstitial)/i;

// Standard IAB slot sizes, ±2px tolerance.
const AD_SLOT_SIZES: Array<[number, number]> = [
  [300, 250], [336, 280], [728, 90], [970, 250], [970, 90], [320, 50],
  [320, 100], [300, 600], [160, 600], [468, 60], [250, 250], [200, 200],
  [300, 50], [320, 480], [336, 48],
];

let lastDomSignalAt = 0;
const DOM_SIGNAL_INTERVAL_MS = 3000;

function applyDomSignals(seen: Set<Element>): void {
  const now = Date.now();
  if (now - lastDomSignalAt < DOM_SIGNAL_INTERVAL_MS) return;
  lastDomSignalAt = now;

  // "ADVERTISEMENT" captions — highlight the creative inside the slot.
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_TEXT,
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue?.trim();
    if (
      text &&
      text.length < 24 &&
      (text.toUpperCase() === 'ADVERTISEMENT' || text.toUpperCase() === 'ADVERTISEMENTS')
    ) {
      const label = node.parentElement;
      const container = label?.parentElement;
      if (container instanceof HTMLElement) {
        const target = resolveCreative(container);
        if (!seen.has(target)) {
          const r = target.getBoundingClientRect();
          // Skip page-level wrappers.
          const tooBig =
            r.width > window.innerWidth * 1.2 &&
            r.height > window.innerHeight * 1.2;
          if (!tooBig && r.width > 10 && r.height > 10) {
            flag(target, 'AdLabel', text);
            seen.add(target);
            state.domFlagged.add(target);
          }
        }
      }
    }
  }

  // Id/class/data-attribute markers, resolved to the creative.
  const marked = document.querySelectorAll(
    'iframe, img, video, embed, object, div, section, aside, ins',
  );
  marked.forEach((el) => {
    if (seen.has(el) || !(el instanceof HTMLElement)) return;
    const id = el.id.toLowerCase();
    const hardId = HARD_MARKER_ID_PREFIX.some((p) => id.startsWith(p));
    const hardClass = [...el.classList].some(
      (c) =>
        HARD_MARKER_CLASS.has(c.toLowerCase()) ||
        c.toLowerCase().startsWith('div-gpt-ad'),
    );
    const hardAttr = HARD_MARKER_ATTR.some((a) => el.hasAttribute(a));
    if (hardId || hardClass || hardAttr || el.tagName === 'INS' && (el as HTMLElement).className.toLowerCase().includes('adsbygoogle')) {
      const target = resolveCreative(el);
      if (!seen.has(target) && isVisible(target as HTMLElement)) {
        flag(target, 'AdMarker', el.id || el.className.toString().slice(0, 80));
        seen.add(target);
        state.domFlagged.add(target);
      }
      return;
    }
    // Soft marker + corroboration.
    const hay = `${el.id} ${el.className.toString()}`;
    if (
      SOFT_MARKER_RE.test(hay) &&
      (el.querySelector('iframe, img, video, embed, object') !== null ||
        /advertisement|sponsored/i.test(el.textContent?.slice(0, 500) ?? ''))
    ) {
      const target = resolveCreative(el);
      if (!seen.has(target) && isVisible(target as HTMLElement)) {
        flag(target, 'AdMarker', hay.slice(0, 80));
        seen.add(target);
        state.domFlagged.add(target);
      }
    }
  });

  // Cross-origin iframes at standard ad sizes.
  document.querySelectorAll('iframe').forEach((el) => {
    if (seen.has(el)) return;
    let origin = '';
    try {
      origin = new URL((el as HTMLIFrameElement).src).origin;
    } catch {
      return;
    }
    if (!origin || origin === 'null' || origin === location.origin) return;
    const r = el.getBoundingClientRect();
    const sized = AD_SLOT_SIZES.some(
      ([w, h]) => Math.abs(r.width - w) <= 2 && Math.abs(r.height - h) <= 2,
    );
    if (sized) {
      flag(el, 'AdSlotSize', `${Math.round(r.width)}x${Math.round(r.height)}`);
      seen.add(el);
      state.domFlagged.add(el);
    }
  });
}

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function dedupeNested(seen: Set<Element>): void {
  for (const el of [...seen]) {
    for (const other of seen) {
      if (other !== el && el.contains(other)) {
        unflag(el);
        seen.delete(el);
        state.domFlagged.delete(el);
        break;
      }
    }
  }
}

// A container resolves to the creative inside it.
const CREATIVE_QUERY = 'iframe, embed, object, img, video';

function resolveCreative(el: Element): Element {
  if (el.matches(CREATIVE_QUERY)) return el;
  return el.querySelector(CREATIVE_QUERY) ?? el;
}

function flag(el: Element, reason: AdReason, detail?: string): void {
  // Never wrap an already-highlighted creative in a bigger highlight.
  for (const o of state.overlays.keys()) {
    if (o !== el && el.contains(o)) return;
  }
  const html = el as HTMLElement;
  html.classList.add(OUTLINE_CLASS);
  html.dataset.highlightAds = reason;
  let overlay = state.overlays.get(el);
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('aria-hidden', 'true');
    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    overlay.appendChild(badge);
    document.documentElement.appendChild(overlay);
    state.overlays.set(el, overlay);
  }
  const badge = overlay.firstElementChild as HTMLElement | null;
  if (badge) {
    // Giant marker; the reason lives in the tooltip.
    badge.textContent = 'AD';
    badge.title = detail ? `${REASON_LABEL[reason] ?? reason} — ${detail}` : (REASON_LABEL[reason] ?? reason);
  }
  // Recolors live when the setting changes.
  const hex = colorHex(state.settings.color);
  overlay.style.borderColor = hexToRgba(hex, 0.9);
  overlay.style.backgroundColor = hexToRgba(hex, 0.35);
  positionOverlay(el, overlay);
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function unflag(el: Element): void {
  (el as HTMLElement).classList?.remove(OUTLINE_CLASS);
  delete (el as HTMLElement).dataset.highlightAds;
  const overlay = state.overlays.get(el);
  overlay?.remove();
  state.overlays.delete(el);
}

function clearAll(): void {
  for (const [el] of state.overlays) unflag(el);
  queueCountReport();
}

function refreshOverlays(): void {
  for (const [el, overlay] of state.overlays) {
    if (!el.isConnected) {
      unflag(el);
      continue;
    }
    positionOverlay(el, overlay);
  }
}

function positionOverlay(el: Element, overlay: HTMLDivElement): void {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    overlay.style.display = 'none';
    return;
  }
  overlay.style.display = 'flex';
  // Fixed overlays use viewport coords — no scroll lag.
  overlay.style.left = `${r.left}px`;
  overlay.style.top = `${r.top}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;
  // Scale the AD lettering to the slot.
  const badge = overlay.firstElementChild as HTMLElement | null;
  if (badge) {
    const size = Math.max(
      20,
      Math.min(r.width * 0.45, r.height * 0.7),
    );
    badge.style.fontSize = `${Math.round(size)}px`;
  }
}

function queueCountReport(): void {
  if (state.reportTimer !== null) window.clearTimeout(state.reportTimer);
  state.reportTimer = window.setTimeout(() => {
    state.reportTimer = null;
    try {
      void chrome.runtime.sendMessage({
        type: 'AD_COUNT',
        count: state.overlays.size,
      } satisfies RuntimeMsg);
    } catch {
      // Count is also served via GET_AD_COUNT.
    }
  }, 300);
}
