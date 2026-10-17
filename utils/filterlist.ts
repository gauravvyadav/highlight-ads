// Offline pattern fallback (background runs full EasyList).

export type AdReason =
  | 'MatchedBlockingRule'
  | 'CreatedByAdScript'
  | 'ParentIsAd'
  | 'DemoParam'
  | 'AdMarker'
  | 'AdLabel'
  | 'AdSlotSize'
  | 'NativeAdWidget';

export const DEMO_PARAM = 'ad_filterlist_demo_param=1';

// Mirrored as AD_RE in public/had-creator-hook.js — keep in sync (list CDN hosts explicitly; substring match).
const BUNDLED_PATTERNS: string[] = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.',
  'ads.yahoo.com',
  'amazon-adsystem.com',
  'criteo.com',
  'criteo.net',
  'outbrain.com',
  'outbrainimg.com',
  'taboola.com',
  'taboolasyndication.com',
  'moatads.com',
  'adsrvr.org',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'smartadserver.com',
  'adform.net',
  'adskeeper.',
  'mgid.com',
  'revcontent.com',
  'zemanta.com',
  'sharethrough.com',
  'indexww.com',
  '2mdn.net',
  'googletagservices.com/gpt',
  '/ads/',
  '/adserver',
  '/ad_banner',
  '/banner_ad',
  'popunder',
  'popupad',
  'prebid',
  'prebid.js',
  'gpt.js',
  'fbevents.js',
  'adsbygoogle',
  'pagead2.',
];

export interface AdMatch {
  isAd: boolean;
  reason?: AdReason;
  pattern?: string;
}

// Classify a resource/frame URL. Never throws.
export function classifyUrl(rawUrl: string | null | undefined): AdMatch {
  if (!rawUrl) return { isAd: false };
  let url = rawUrl.trim();
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
    return { isAd: false };
  }
  // Chrome's manual-testing hook: URLs with this param count as ads.
  if (url.includes(DEMO_PARAM)) {
    return { isAd: true, reason: 'DemoParam', pattern: DEMO_PARAM };
  }
  const lower = url.toLowerCase();
  for (const pattern of BUNDLED_PATTERNS) {
    if (lower.includes(pattern)) {
      return { isAd: true, reason: 'MatchedBlockingRule', pattern };
    }
  }
  return { isAd: false };
}

export function currentFrameHasDemoParam(href: string): boolean {
  try {
    return href.includes(DEMO_PARAM);
  } catch {
    return false;
  }
}
