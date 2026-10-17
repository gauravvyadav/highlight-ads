// Shared settings + message protocol (chrome.storage only).

export type HighlightColorId =
  | 'red'
  | 'orange'
  | 'amber'
  | 'green'
  | 'blue'
  | 'purple';

export interface HighlightColor {
  id: HighlightColorId;
  label: string;
  hex: string;
}

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  { id: 'red', label: 'Red', hex: '#e8112d' },
  { id: 'orange', label: 'Orange', hex: '#f97316' },
  { id: 'amber', label: 'Amber', hex: '#d9a400' },
  { id: 'green', label: 'Green', hex: '#16a34a' },
  { id: 'blue', label: 'Blue', hex: '#2563eb' },
  { id: 'purple', label: 'Purple', hex: '#9333ea' },
];

export function colorHex(id: HighlightColorId | undefined): string {
  return HIGHLIGHT_COLORS.find((c) => c.id === id)?.hex ?? '#e8112d';
}

export interface HighlightSettings {
  enabled: boolean;
  color: HighlightColorId;
  excludedSites: string[];
}

export const DEFAULT_SETTINGS: HighlightSettings = {
  enabled: true,
  color: 'red',
  excludedSites: [],
};

export const SETTINGS_KEY = 'highlightAdsSettings';
export const ENGINE_META_KEY = 'highlightAdsEngineMeta';
const KEY = SETTINGS_KEY;

export function normalizeHost(urlOrHost: string): string {
  if (!urlOrHost) return '';
  const trimmed = urlOrHost.trim().toLowerCase();
  try {
    const url = trimmed.includes('://')
      ? new URL(trimmed)
      : new URL(`http://${trimmed}`);
    let host = url.hostname.toLowerCase();
    if (host.startsWith('www.')) {
      host = host.slice(4);
    }
    return host;
  } catch {
    const noProto = trimmed.replace(/^https?:\/\//, '');
    const firstPart = noProto.split('/')[0] ?? '';
    const hostOnly = firstPart.split(':')[0] ?? '';
    return hostOnly.replace(/^www\./, '');
  }
}

export function isWebUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSiteExcluded(
  urlOrHost: string,
  excludedSites: string[] | undefined,
): boolean {
  if (!excludedSites || excludedSites.length === 0) return false;
  const target = normalizeHost(urlOrHost);
  if (!target) return false;

  return excludedSites.some((site) => {
    const norm = normalizeHost(site);
    if (!norm) return false;
    return target === norm || target.endsWith(`.${norm}`);
  });
}

export async function getSettings(): Promise<HighlightSettings> {
  try {
    const raw = await chrome.storage.local.get(KEY);
    const stored = raw?.[KEY] as Partial<HighlightSettings> | undefined;
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      excludedSites: Array.isArray(stored?.excludedSites)
        ? stored.excludedSites.map(normalizeHost).filter(Boolean)
        : DEFAULT_SETTINGS.excludedSites,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(
  patch: Partial<HighlightSettings>,
): Promise<HighlightSettings> {
  const current = await getSettings();
  const next: HighlightSettings = {
    ...current,
    ...patch,
  };
  if (patch.excludedSites) {
    next.excludedSites = Array.from(
      new Set(patch.excludedSites.map(normalizeHost).filter(Boolean)),
    );
  }
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function addExcludedSite(
  site: string,
): Promise<HighlightSettings> {
  const norm = normalizeHost(site);
  if (!norm) return getSettings();
  const current = await getSettings();
  const list = current.excludedSites || [];
  if (list.includes(norm)) return current;
  return setSettings({ excludedSites: [...list, norm] });
}

export async function removeExcludedSite(
  site: string,
): Promise<HighlightSettings> {
  const norm = normalizeHost(site);
  const current = await getSettings();
  const list = current.excludedSites || [];
  const next = list.filter((s) => normalizeHost(s) !== norm);
  return setSettings({ excludedSites: next });
}

import type {
  ClassifyRequest,
  ClassifyResult,
} from './easylist';

export type RuntimeMsg =
  | { type: 'SETTINGS_CHANGED'; settings: HighlightSettings }
  | { type: 'AD_COUNT'; count: number; tabUrl?: string }
  | { type: 'GET_AD_COUNT'; tabId?: number }
  | { type: 'CLASSIFY_URLS'; requests: ClassifyRequest[] }
  | { type: 'GET_ENGINE_STATUS' }
  | { type: 'UPDATE_LIST' };

export interface ClassifyResponse {
  ready: boolean;
  results: ClassifyResult[];
}

export interface UpdateListResponse {
  ok: boolean;
  updatedAt?: string;
  ruleCount?: number;
  error?: string;
}
