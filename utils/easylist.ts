// EasyList constants and the content↔background classify protocol.
// Full matching runs in the background via @ghostery/adblocker.

export const EASYLIST_URL = 'https://easylist.to/easylist/easylist.txt';
export const EASYLIST_CACHE_KEY = 'highlightAdsEasyList';
// Matches EasyList's own expiry guidance ("Expires: 4 days").
export const EASYLIST_TTL_MS = 4 * 24 * 60 * 60 * 1000;
// Safety cap per classify batch.
export const MAX_BATCH_URLS = 200;

// Request types we classify, using the engine's webRequest vocabulary.
export type AdRequestType =
  | 'sub_frame'
  | 'script'
  | 'image'
  | 'media'
  | 'object'
  | 'other';

export interface ClassifyRequest {
  url: string;
  sourceUrl: string;
  reqType: AdRequestType;
}

export interface ClassifyResult {
  url: string;
  // True when a network rule (non-exception) matched.
  isAd: boolean;
  // Raw filter line that matched, if any (truncated).
  filter?: string;
}

export interface EngineStatus {
  ready: boolean;
  // ISO timestamp of the loaded list, if known.
  updatedAt?: string;
  // Number of network rules loaded, if known.
  ruleCount?: number;
}

// Element tag → request type.
export function requestTypeForTag(tag: string): AdRequestType {
  switch (tag) {
    case 'IFRAME':
      return 'sub_frame';
    case 'SCRIPT':
      return 'script';
    case 'IMG':
      return 'image';
    case 'VIDEO':
      return 'media';
    case 'EMBED':
    case 'OBJECT':
      return 'object';
    default:
      return 'other';
  }
}
