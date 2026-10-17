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
  isSiteExcluded,
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
  NativeAdWidget: 'Sponsored native item',
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
  // Overlays anchored to the viewport (fixed/sticky creatives).
  fixedOverlays: Set<Element>;
  // Direct-child frames that reported themselves as ads.
  reportedFrames: Map<Element, { reason: AdReason; detail?: string }>;
}

const state: State = {
  settings: { enabled: true, color: 'red', excludedSites: [] },
  adScriptUrls: new Set(),
  lastAdScriptAt: 0,
  overlays: new Map(),
  reportTimer: null,
  urlCache: new Map(),
  domFlagged: new Set(),
  fixedOverlays: new Set(),
  reportedFrames: new Map(),
};

function main(): void {
  // Subframes report upward instead of highlighting.
  if (window !== window.top) {
    reportSubframeAd();
    return;
  }

  void getSettings().then((settings) => {
    state.settings = settings;
    const isExcluded = isSiteExcluded(
      location.hostname,
      settings.excludedSites,
    );
    if (settings.enabled && !isExcluded) boot();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.highlightAdsSettings?.newValue) return;
    state.settings = changes.highlightAdsSettings
      .newValue as HighlightSettings;
    const isExcluded = isSiteExcluded(
      location.hostname,
      state.settings.excludedSites,
    );
    if (state.settings.enabled && !isExcluded) {
      boot();
      recolorAllOverlays();
      rescan('settings-on');
    } else {
      clearAll();
    }
  });

  chrome.runtime.onMessage.addListener((raw: RuntimeMsg, _sender, send) => {
    if (raw.type === 'SETTINGS_CHANGED') {
      state.settings = raw.settings;
      const isExcluded = isSiteExcluded(
        location.hostname,
        state.settings.excludedSites,
      );
      if (state.settings.enabled && !isExcluded) {
        boot();
        recolorAllOverlays();
        rescan('msg-settings');
      } else {
        clearAll();
      }
    } else if (raw.type === 'GET_AD_COUNT') {
      const isExcluded = isSiteExcluded(
        location.hostname,
        state.settings.excludedSites,
      );
      send({ count: isExcluded ? 0 : state.overlays.size, isExcluded });
      return true;
    }
  });

  // Reports from direct-child ad frames (sticky frame classification).
  window.addEventListener('message', onSubframeReport);

  // SPAs don't rerun content scripts — rescan on history changes.
  const origPush = history.pushState;  const origReplace = history.replaceState;
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
  ensureResizeObserver();
  observe();
  rescan('boot');
  // Anchored overlays track natively; the JS fallback below only handles fixed/sticky and nested scrollers.
  document.addEventListener('scroll', onScrollCapture, {
    passive: true,
    capture: true,
  });
  window.addEventListener('resize', refreshOverlays);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', refreshOverlays);
    window.visualViewport.addEventListener('scroll', onScrollCapture);
  }
}

let scrollRafId: number | null = null;
// Page scroll only repositions fixed-mode overlays; nested scrollers reposition overlays inside them.
function onScrollCapture(e: Event): void {
  if (state.overlays.size === 0) return;
  if (scrollRafId !== null) return;
  const target = e.target;
  scrollRafId = window.requestAnimationFrame(() => {
    scrollRafId = null;
    if (
      target === document ||
      target === document.documentElement ||
      target === document.scrollingElement ||
      target === window
    ) {
      if (state.fixedOverlays.size > 0) refreshFixedOverlays();
      return;
    }
    if (target instanceof HTMLElement) {
      refreshOverlaysIn(target);
      return;
    }
    if (state.fixedOverlays.size > 0) refreshFixedOverlays();
  });
}

let resizeObserver: ResizeObserver | null = null;
function ensureResizeObserver(): void {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const overlay = state.overlays.get(entry.target);
      if (overlay) positionOverlay(entry.target, overlay);
    }
  });
}

// Viewport-anchored (fixed/sticky) creatives need viewport coords; everything else uses document coords.
function isViewportAnchored(el: Element): boolean {
  let cur: Element | null = el;
  while (cur instanceof HTMLElement) {
    const pos = window.getComputedStyle(cur).position;
    if (pos === 'fixed') return true;
    if (cur === el && pos === 'sticky') return true;
    cur = cur.parentElement;
  }
  return false;
}

// Anchored overlays track their ad natively (zero JS repositioning); older engines use the JS fallback.
const ANCHOR_SUPPORTED =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('position-anchor: --had-test');
let anchorCounter = 0;

const SUBFRAME_MSG = '__hadAdFrame';

// Accepted subframe report reasons (same vocabulary as local verdicts).
const VALID_REPORT_REASONS: ReadonlySet<string> = new Set([
  'MatchedBlockingRule',
  'CreatedByAdScript',
  'ParentIsAd',
  'DemoParam',
  'AdMarker',
  'AdLabel',
  'AdSlotSize',
  'NativeAdWidget',
]);

// Subframe role: classify this frame and report upward.
function reportSubframeAd(): void {
  const send = (reason: AdReason, detail?: string): void => {
    try {
      window.parent.postMessage(
        { [SUBFRAME_MSG]: true, reason, detail },
        '*',
      );
    } catch {
      // No parent to report to.
    }
  };
  const self = classifyUrl(location.href);
  if (self.isAd && self.reason) {
    send(self.reason, self.pattern);
    return;
  }
  const checkScripts = (): boolean => {
    for (const s of document.scripts) {
      if (!s.src) continue;
      const m = classifyUrl(s.src);
      if (m.isAd) {
        send('CreatedByAdScript', s.src.slice(0, 160));
        return true;
      }
    }
    return false;
  };
  if (checkScripts()) return;
  // Late-loading ad scripts (e.g. Taboola/Outbrain bootstraps).
  try {
    const root = document.documentElement ?? document;
    const obs = new MutationObserver((mutations) => {
      let hasScript = false;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n instanceof HTMLScriptElement && n.src) {
            hasScript = true;
            break;
          }
        }
        if (hasScript) break;
      }
      if (hasScript && checkScripts()) obs.disconnect();
    });
    obs.observe(root, { childList: true, subtree: true });
    window.setTimeout(() => obs.disconnect(), 6000);
  } catch {
    // Static document — nothing more to watch.
  }
}

// Top-frame role: match an incoming report to its child frame via event.source.
function onSubframeReport(e: MessageEvent): void {
  const d = e.data as {
    __hadAdFrame?: unknown;
    reason?: unknown;
    detail?: unknown;
  } | null;
  if (!d || d.__hadAdFrame !== true || typeof d.reason !== 'string') return;
  if (!VALID_REPORT_REASONS.has(d.reason)) return;
  const reason = d.reason as AdReason;
  const detail =
    typeof d.detail === 'string' ? d.detail.slice(0, 160) : undefined;
  const frames = document.querySelectorAll('iframe, embed, object');
  for (const f of frames) {
    let win: WindowProxy | null = null;
    try {
      win = (f as HTMLIFrameElement).contentWindow;
    } catch {
      continue;
    }
    if (win && win === e.source) {
      state.reportedFrames.set(f, { reason, detail });
      scheduleRescan('subframe-report');
      break;
    }
  }
}

function observe(): void {
  const observer = new MutationObserver((mutations) => {
    let dirty = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node instanceof HTMLElement) {
          // Ignore our own overlays/badges to avoid recursive mutation storms
          if (
            node.classList.contains(OVERLAY_CLASS) ||
            node.classList.contains(BADGE_CLASS)
          ) {
            continue;
          }
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
        if (!m.target.classList.contains(OVERLAY_CLASS)) {
          ingestNode(m.target);
          dirty = true;
        }
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

let rescanDebounceTimer: number | null = null;
let rescanRaf: number | null = null;
const RESCAN_DEBOUNCE_MS = 250;

function scheduleRescan(_why: string): void {
  if (rescanDebounceTimer !== null) return;
  rescanDebounceTimer = window.setTimeout(() => {
    rescanDebounceTimer = null;
    if (rescanRaf !== null) cancelAnimationFrame(rescanRaf);
    rescanRaf = window.requestAnimationFrame(() => {
      rescanRaf = null;
      rescan('scheduled');
    });
  }, RESCAN_DEBOUNCE_MS);
}

// Full scan of the current document.
function rescan(_why: string): void {
  const isExcluded = isSiteExcluded(
    location.hostname,
    state.settings.excludedSites,
  );
  if (!state.settings.enabled || isExcluded) {
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
  // Flag direct-child frames that reported themselves as ads.
  for (const [el, rep] of state.reportedFrames) {
    if (el.isConnected) {
      flag(el, rep.reason, rep.detail);
      seen.add(el);
    } else {
      state.reportedFrames.delete(el);
    }
  }
  // Creator-hook attributions: elements inserted while an ad script ran.
  for (const el of document.querySelectorAll('[data-had-ac]')) {
    if (seen.has(el) || !el.isConnected) continue;
    const creator = el.getAttribute('data-had-ac') || '';
    flag(el, 'CreatedByAdScript', creator.slice(0, 120));
    seen.add(el);
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

const checkedScriptUrls = new Set<string>();

function recordAdScripts(): void {
  // Feeds the created-by-ad-script check.
  for (const s of document.scripts) {
    if (!s.src || checkedScriptUrls.has(s.src)) continue;
    checkedScriptUrls.add(s.src);
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

// Native widgets: paid-only markup signals (URL matching is blind here — no Taboola/Outbrain list rules).
const TABOOLA_SPONSORED_BOX = '.trc-content-sponsored';
const TABOOLA_ITEM =
  '.syndicatedItem, [data-item-syndicated="true"], .videoCube[data-item-id], a.item-thumbnail-href';
const OUTBRAIN_PAID_LINK =
  'a[href^="https://paid.outbrain.com/network/redir?"]' +
  ', a[data-oburl^="https://paid.outbrain.com/network/redir?"]' +
  ', a[data-redirect^="https://paid.outbrain.com/network/redir?"]';

// Standard IAB slot sizes, ±2px tolerance.
const AD_SLOT_SIZES: Array<[number, number]> = [
  [300, 250], [336, 280], [728, 90], [970, 250], [970, 90], [320, 50],
  [320, 100], [300, 600], [160, 600], [468, 60], [250, 250], [200, 200],
  [300, 50], [320, 480], [336, 48],
];

let lastDomSignalAt = 0;
const DOM_SIGNAL_INTERVAL_MS = 3000;

const AD_MARKER_SELECTOR = [
  'ins.adsbygoogle',
  '[data-ad-client]',
  '[data-ad-slot]',
  '[data-adtest]',
  '[id^="div-gpt-ad"]',
  '[id^="google_ads"]',
  '[id^="google-ad"]',
  '[id^="ad-slot"]',
  '[id^="adslot"]',
  '[id^="banner-ad"]',
  '[id^="ad-banner"]',
  '[id^="ads-container"]',
  '[id^="advert-container"]',
  '.adsbygoogle',
  '.advertisement',
  '.sponsored-content',
  '.ad-slot',
  '[class*="div-gpt-ad"]',
  '[class*="advert"]',
  '[class*="sponsor"]',
  '[class*="taboola"]',
  '[class*="outbrain"]',
  '[class*="criteo"]',
  '[id*="advert"]',
  '[id*="sponsor"]',
  '[id*="taboola"]',
  '[id*="outbrain"]',
  '[id*="criteo"]',
].join(', ');

function applyDomSignals(seen: Set<Element>): void {
  const now = Date.now();
  if (now - lastDomSignalAt < DOM_SIGNAL_INTERVAL_MS) return;
  lastDomSignalAt = now;

  // "ADVERTISEMENT" captions — highlight the creative inside the slot.
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(n) {
        const val = n.nodeValue;
        if (!val || val.length > 30 || val.length < 13) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    },
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue?.trim();
    if (
      text &&
      (text.toUpperCase() === 'ADVERTISEMENT' || text.toUpperCase() === 'ADVERTISEMENTS')
    ) {
      const label = node.parentElement;
      const container = label?.parentElement;
      if (container instanceof HTMLElement) {
        const target = resolveCreative(container);
        if (target && !seen.has(target)) {
          const r = target.getBoundingClientRect();
          // Skip page-level wrappers.
          const tooBig =
            r.width > window.innerWidth * 0.95 ||
            r.height > window.innerHeight * 0.95;
          if (!tooBig && r.width > 10 && r.height > 10) {
            flag(target, 'AdLabel', text);
            seen.add(target);
            state.domFlagged.add(target);
          }
        }
      }
    }
  }

  // Targeted id/class/data-attribute markers, resolved to the creative.
  const marked = document.querySelectorAll(AD_MARKER_SELECTOR);
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
      if (target && !seen.has(target) && isVisible(target as HTMLElement)) {
        flag(target, 'AdMarker', el.id || el.className.toString().slice(0, 80));
        seen.add(target);
        state.domFlagged.add(target);
      }
      return;
    }
    // Soft marker + corroboration (native-widget subtrees belong to the native pass).
    const hay = `${el.id} ${el.className.toString()}`;
    const inWidget =
      el.closest('.trc-content-sponsored, .trc-content, .ob-widget') !== null ||
      el.querySelector('.trc-content-sponsored, .trc-content, .ob-widget') !==
        null;
    if (
      !inWidget &&
      SOFT_MARKER_RE.test(hay) &&
      (el.querySelector('iframe, img, video, embed, object') !== null ||
        /advertisement|sponsored/i.test(el.textContent?.slice(0, 500) ?? ''))
    ) {
      const target = resolveCreative(el);
      if (target && !seen.has(target) && isVisible(target as HTMLElement)) {
        flag(target, 'AdMarker', hay.slice(0, 80));
        seen.add(target);
        state.domFlagged.add(target);
      }
    }
  });

  applyNativeWidgets(seen);

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

// Flags each paid native-widget item; organic-only markup is left alone.
function applyNativeWidgets(seen: Set<Element>): void {
  for (const box of document.querySelectorAll(TABOOLA_SPONSORED_BOX)) {
    if (!(box instanceof HTMLElement)) continue;
    for (const item of box.querySelectorAll(TABOOLA_ITEM)) {
      if (seen.has(item) || !(item instanceof HTMLElement)) continue;
      const target = resolveCreative(item);
      if (target && !seen.has(target) && isVisible(target as HTMLElement)) {
        const title =
          item.getAttribute('data-item-title')?.trim().slice(0, 80) ||
          'taboola-sponsored';
        flag(target, 'NativeAdWidget', title);
        seen.add(target);
        state.domFlagged.add(target);
      }
    }
  }
  for (const link of document.querySelectorAll(OUTBRAIN_PAID_LINK)) {
    if (seen.has(link) || !(link instanceof HTMLElement)) continue;
    const target = resolveCreative(link);
    if (target && !seen.has(target) && isVisible(target as HTMLElement)) {
      flag(target, 'NativeAdWidget', 'paid.outbrain.com');
      seen.add(target);
      state.domFlagged.add(target);
    }
  }
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

  // Drop overlays that contain another overlay.
  for (const [parent] of [...state.overlays]) {
    for (const [child] of state.overlays) {
      if (parent !== child && parent.contains(child)) {
        unflag(parent);
        state.domFlagged.delete(parent);
        seen.delete(parent);
        break;
      }
    }
  }
}

// A container resolves to the creative inside it.
const CREATIVE_QUERY = 'iframe, embed, object, img, video';

function resolveCreative(el: Element): Element | null {
  if (el.matches(CREATIVE_QUERY)) return el;

  const creatives = el.querySelectorAll<HTMLElement>(CREATIVE_QUERY);
  for (const c of creatives) {
    const r = c.getBoundingClientRect();
    // Prefer visible creatives (ignore 1x1 tracking pixels).
    if (r.width > 10 && r.height > 10) {
      return c;
    }
  }

  if (creatives.length > 0) {
    return creatives[0] ?? null;
  }

  // Never highlight container boxes themselves.
  const isContainer = /^(DIV|SECTION|ASIDE|INS|ARTICLE|HEADER|FOOTER|MAIN|P|SPAN)$/i.test(
    el.tagName,
  );
  if (isContainer) {
    return null;
  }

  return el;
}

function flag(rawEl: Element, reason: AdReason, detail?: string): void {
  const resolved = resolveCreative(rawEl);
  if (!resolved) return;
  const el = resolved;

  // Never flag page-level or overly large elements
  const r = el.getBoundingClientRect();
  if (
    r.width > window.innerWidth * 0.95 &&
    r.height > window.innerHeight * 0.95
  ) {
    return;
  }

  // Drop any ancestor-container overlay of this creative.
  for (const o of [...state.overlays.keys()]) {
    if (o !== el && o.contains(el)) {
      unflag(o);
      state.domFlagged.delete(o);
    }
  }

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
  // Recolors live when the setting changes or theme adapts.
  applyOverlayTheme(overlay, badge);
  if (ANCHOR_SUPPORTED) attachAnchor(el, overlay);
  positionOverlay(el, overlay);
  resizeObserver?.observe(el);
}

function applyOverlayTheme(
  overlay: HTMLDivElement,
  badge: HTMLElement | null,
): void {
  const hex = colorHex(state.settings.color);
  overlay.style.borderColor = hexToRgba(hex, 0.9);
  overlay.style.backgroundColor = hexToRgba(hex, 0.35);
  if (badge) {
    badge.style.color = 'rgba(255, 255, 255, 0.85)';
    badge.style.textShadow = 'none';
  }
}

function recolorAllOverlays(): void {
  for (const [_, overlay] of state.overlays) {
    const badge = overlay.firstElementChild as HTMLElement | null;
    applyOverlayTheme(overlay, badge);
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function attachAnchor(el: Element, overlay: HTMLDivElement): void {
  if (overlay.dataset.anchor) return;
  anchorCounter += 1;
  const name = `--had-${anchorCounter}`;
  overlay.dataset.anchor = name;
  (el as HTMLElement).style?.setProperty('anchor-name', name);
  overlay.style.position = 'fixed';
  overlay.style.setProperty('position-anchor', name);
  overlay.style.top = 'anchor(top)';
  overlay.style.left = 'anchor(left)';
  overlay.style.width = 'anchor-size(width)';
  overlay.style.height = 'anchor-size(height)';
  // Auto-hide when the ad scrolls out of view or is display:none.
  overlay.style.setProperty('position-visibility', 'anchors-visible');
}

function unflag(el: Element): void {
  const html = el as HTMLElement;
  html.classList?.remove(OUTLINE_CLASS);
  delete html.dataset.highlightAds;
  html.style?.removeProperty('anchor-name');
  const overlay = state.overlays.get(el);
  overlay?.remove();
  state.overlays.delete(el);
  state.fixedOverlays.delete(el);
  resizeObserver?.unobserve(el);
}

function clearAll(): void {
  for (const [el] of state.overlays) unflag(el);
  state.reportedFrames.clear();
  queueCountReport();
}

function refreshOverlays(): void {
  for (const [el, overlay] of state.overlays) {
    if (!el.isConnected) {
      unflag(el);
      continue;
    }
    // Anchored overlays track natively — nothing to reposition.
    if (overlay.dataset.anchor) continue;
    positionOverlay(el, overlay);
  }
}

function refreshFixedOverlays(): void {
  for (const el of state.fixedOverlays) {
    const overlay = state.overlays.get(el);
    if (!overlay) {
      state.fixedOverlays.delete(el);
      continue;
    }
    if (!el.isConnected) {
      unflag(el);
      continue;
    }
    positionOverlay(el, overlay);
  }
}

function refreshOverlaysIn(container: HTMLElement): void {
  refreshFixedOverlays();
  for (const [el, overlay] of state.overlays) {
    if (overlay.dataset.anchor || state.fixedOverlays.has(el)) continue;
    if (!el.isConnected) {
      unflag(el);
      continue;
    }
    if (container.contains(el)) positionOverlay(el, overlay);
  }
}

function positionOverlay(el: Element, overlay: HTMLDivElement): void {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    overlay.style.display = 'none';
    return;
  }
  overlay.style.display = 'flex';
  if (overlay.dataset.anchor) {
    // Anchored: the compositor tracks the ad — no JS coordinates needed.
    state.fixedOverlays.delete(el);
    sizeBadge(overlay, r);
    return;
  }
  if (isViewportAnchored(el)) {
    // Viewport-anchored: viewport coords, updated on scroll.
    state.fixedOverlays.add(el);
    overlay.style.position = 'fixed';
    overlay.style.left = `${r.left}px`;
    overlay.style.top = `${r.top}px`;
  } else {
    // Page content: document coords move with the page natively.
    state.fixedOverlays.delete(el);
    overlay.style.position = 'absolute';
    overlay.style.left = `${r.left + window.scrollX}px`;
    overlay.style.top = `${r.top + window.scrollY}px`;
  }
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;
  // Scale the AD lettering to the slot.
  sizeBadge(overlay, r);
}

function sizeBadge(overlay: HTMLDivElement, r: DOMRect): void {
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
      void chrome.runtime
        .sendMessage({
          type: 'AD_COUNT',
          count: state.overlays.size,
        } satisfies RuntimeMsg)
        .catch(() => {
          // Background unreachable — count is also served via GET_AD_COUNT.
        });
    } catch {
      // Same fallback for sync throws.
    }
  }, 300);
}
