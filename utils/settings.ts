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
}

export const DEFAULT_SETTINGS: HighlightSettings = {
  enabled: true,
  color: 'red',
};

const KEY = 'highlightAdsSettings';

export async function getSettings(): Promise<HighlightSettings> {
  try {
    const raw = await chrome.storage.local.get(KEY);
    const stored = raw?.[KEY] as Partial<HighlightSettings> | undefined;
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setSettings(
  patch: Partial<HighlightSettings>,
): Promise<HighlightSettings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

import type {
  ClassifyRequest,
  ClassifyResult,
} from './easylist';

export type RuntimeMsg =
  | { type: 'SETTINGS_CHANGED'; settings: HighlightSettings }
  | { type: 'AD_COUNT'; count: number; tabUrl?: string }
  | { type: 'GET_AD_COUNT' }
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
