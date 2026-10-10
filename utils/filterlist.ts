// Bundled pattern fallback for offline use (background runs full EasyList).
// Covers URL matching, ad-script creators, and sticky frames.

export type AdReason =
  | 'MatchedBlockingRule'
  | 'CreatedByAdScript'
  | 'ParentIsAd'
  | 'DemoParam'
  | 'AdMarker'
  | 'AdLabel'
  | 'AdSlotSize';

export const DEMO_PARAM = 'ad_filterlist_demo_param=1';

// Condensed heuristic subset; bundled so detection works offline.
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
  'taboola.com',
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
  // Manual testing hook documented by Chrome: any URL carrying this query
  // param is treated as ad-related.
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

// True when the current frame URL carries the demo param.
export function currentFrameHasDemoParam(href: string): boolean {
  try {
    return href.includes(DEMO_PARAM);
  } catch {
    return false;
  }
}
