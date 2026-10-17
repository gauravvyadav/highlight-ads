import './style.css';
import {
  DEFAULT_SETTINGS,
  ENGINE_META_KEY,
  SETTINGS_KEY,
  addExcludedSite,
  getSettings,
  isSiteExcluded,
  isWebUrl,
  normalizeHost,
  removeExcludedSite,
  setSettings,
  type HighlightColorId,
  type HighlightSettings,
  type RuntimeMsg,
  type UpdateListResponse,
} from '@/utils/settings';
import type { EngineStatus } from '@/utils/easylist';

const PAUSE_SVG =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2" y="1" width="2.5" height="10" /><rect x="7.5" y="1" width="2.5" height="10" /></svg>';
const RESUME_SVG =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><polygon points="2.5,1 10.5,6 2.5,11" /></svg>';

const appEl = document.querySelector<HTMLElement>('#app')!;
const enabledEl = document.querySelector<HTMLInputElement>('#enabled')!;
const siteChip = document.querySelector<HTMLElement>('#site-chip')!;
const siteExcludeBtn = document.querySelector<HTMLButtonElement>('#site-exclude-btn')!;
const siteBtnIcon = document.querySelector<HTMLElement>('#site-btn-icon')!;
const siteBtnText = document.querySelector<HTMLElement>('#site-btn-text')!;
const countEl = document.querySelector<HTMLElement>('#count')!;
const updateBtn = document.querySelector<HTMLButtonElement>('#update-list')!;
const listDate = document.querySelector<HTMLElement>('#list-date')!;
const listRules = document.querySelector<HTMLElement>('#list-rules')!;
const stateChip = document.querySelector<HTMLElement>('#state-chip')!;

let currentTabId: number | undefined;
let currentTabUrl: string | undefined;
let currentHost = '';

function paintChip(on: boolean): void {
  stateChip.textContent = on ? 'ON' : 'OFF';
  stateChip.classList.toggle('off', !on);
  stateChip.classList.remove('warn');
}

const swatchBtns = [
  ...document.querySelectorAll<HTMLButtonElement>('#swatches .swatch'),
];

function paintSwatches(current: HighlightColorId): void {
  for (const btn of swatchBtns) {
    btn.classList.toggle('selected', btn.dataset.color === current);
  }
}

function bindSwatches(): void {
  for (const btn of swatchBtns) {
    btn.addEventListener('click', () => {
      const color = btn.dataset.color as HighlightColorId;
      void setSettings({ color }).then(() => paintSwatches(color));
    });
  }
}

async function refreshCount(
  tabId?: number,
  currentSettings?: HighlightSettings,
): Promise<void> {
  const settings = currentSettings ?? (await getSettings());
  if (
    !settings.enabled ||
    (currentHost && isSiteExcluded(currentHost, settings.excludedSites)) ||
    !isWebUrl(currentTabUrl)
  ) {
    countEl.textContent = '0';
    return;
  }

  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'GET_AD_COUNT',
      tabId: tabId ?? currentTabId,
    } satisfies RuntimeMsg)) as { count?: number; isExcluded?: boolean } | undefined;
    if (res?.isExcluded) {
      countEl.textContent = '0';
    } else if (typeof res?.count === 'number') {
      countEl.textContent = String(res.count);
    }
  } catch {
    // Keep existing count on error
  }
}

function paintListStatus(status: EngineStatus | undefined): void {
  if (!status || (!status.updatedAt && !status.ready)) {
    listDate.textContent = 'LOADING…';
    listRules.textContent = '—';
  } else {
    listDate.textContent = status.updatedAt
      ? new Date(status.updatedAt).toLocaleDateString()
      : 'UNKNOWN';
    listRules.textContent = status.ruleCount
      ? status.ruleCount.toLocaleString()
      : '—';
  }
  document.querySelector('#list-dot')?.classList.toggle(
    'ok',
    status?.ready === true,
  );
}

async function refreshListStatus(): Promise<void> {
  try {
    const status = (await chrome.runtime.sendMessage({
      type: 'GET_ENGINE_STATUS',
    } satisfies RuntimeMsg)) as EngineStatus | undefined;
    if (status) {
      paintListStatus(status);
    }
  } catch {
    // Keep cached status
  }
}

function renderSiteSection(settings: HighlightSettings): void {
  const isWeb = isWebUrl(currentTabUrl);
  if (!isWeb || !currentHost) {
    appEl.classList.remove('site-is-excluded');
    siteChip.textContent = 'N/A';
    siteChip.className = 'chip off';
    siteExcludeBtn.disabled = true;
    siteExcludeBtn.classList.remove('site-btn-paused');
    siteBtnIcon.innerHTML = '';
    siteBtnText.textContent = 'PAUSE UNAVAILABLE';
    paintChip(settings.enabled);
    return;
  }

  siteChip.textContent = currentHost;
  siteChip.title = currentHost;

  const excluded = isSiteExcluded(currentHost, settings.excludedSites);
  if (excluded) {
    appEl.classList.add('site-is-excluded');
    siteChip.className = 'chip off';
    siteExcludeBtn.disabled = false;
    siteExcludeBtn.classList.add('site-btn-paused');
    siteBtnIcon.innerHTML = RESUME_SVG;
    siteBtnText.textContent = 'RESUME ON THIS SITE';
    siteExcludeBtn.title = `Resume ad highlighting on ${currentHost}`;
    stateChip.textContent = 'PAUSED';
    stateChip.className = 'chip off';
  } else {
    appEl.classList.remove('site-is-excluded');
    siteChip.className = settings.enabled ? 'chip' : 'chip off';
    siteExcludeBtn.disabled = !settings.enabled;
    siteExcludeBtn.classList.remove('site-btn-paused');
    siteBtnIcon.innerHTML = PAUSE_SVG;
    siteBtnText.textContent = 'PAUSE ON THIS SITE';
    siteExcludeBtn.title = `Pause ad highlighting on ${currentHost}`;
    paintChip(settings.enabled);
  }
}

async function init(): Promise<void> {
  bindSwatches();

  // Run tab query and storage load concurrently in parallel
  const [tabs, storageData] = await Promise.all([
    chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []),
    chrome.storage.local
      .get([SETTINGS_KEY, ENGINE_META_KEY])
      .catch(() => ({}) as Record<string, unknown>),
  ]);

  const activeTab = tabs[0];
  currentTabId = activeTab?.id;
  currentTabUrl = activeTab?.url;
  currentHost = currentTabUrl ? normalizeHost(currentTabUrl) : '';

  const store = storageData as Record<string, unknown>;
  const rawSettings = store[SETTINGS_KEY] as Partial<HighlightSettings> | undefined;
  const settings: HighlightSettings = {
    ...DEFAULT_SETTINGS,
    ...rawSettings,
    excludedSites: Array.isArray(rawSettings?.excludedSites)
      ? rawSettings.excludedSites.map(normalizeHost).filter(Boolean)
      : DEFAULT_SETTINGS.excludedSites,
  };

  const cachedMeta = store[ENGINE_META_KEY] as Omit<EngineStatus, 'ready'> | undefined;

  // 1. Immediately paint settings & site UI (Frame 1)
  enabledEl.checked = settings.enabled;
  renderSiteSection(settings);
  paintSwatches(settings.color);

  // 2. Immediately paint cached list status
  if (cachedMeta?.updatedAt) {
    paintListStatus({ ready: true, ...cachedMeta });
  }

  // 3. Immediately paint count from badge or exclusion rules
  if (
    !settings.enabled ||
    (currentHost && isSiteExcluded(currentHost, settings.excludedSites)) ||
    !isWebUrl(currentTabUrl)
  ) {
    countEl.textContent = '0';
  } else if (currentTabId !== undefined) {
    const badgeText = await chrome.action.getBadgeText({ tabId: currentTabId }).catch(() => '');
    if (badgeText && /^\d+$/.test(badgeText)) {
      countEl.textContent = badgeText;
    } else {
      countEl.textContent = '0';
    }
  }

  // 4. Asynchronously refresh both count and engine status in the background
  void Promise.all([
    refreshCount(currentTabId, settings),
    refreshListStatus(),
  ]);

  enabledEl.addEventListener('change', async () => {
    const next = await setSettings({ enabled: enabledEl.checked });
    renderSiteSection(next);
    await refreshCount(currentTabId, next);
  });

  siteExcludeBtn.addEventListener('click', async () => {
    if (!currentHost || !isWebUrl(currentTabUrl)) return;
    siteExcludeBtn.disabled = true;

    try {
      const current = await getSettings();
      const isCurrentlyExcluded = isSiteExcluded(
        currentHost,
        current.excludedSites,
      );

      let next: HighlightSettings;
      if (isCurrentlyExcluded) {
        next = await removeExcludedSite(currentHost);
      } else {
        next = await addExcludedSite(currentHost);
      }

      renderSiteSection(next);
      await refreshCount(currentTabId, next);
    } finally {
      siteExcludeBtn.disabled = false;
    }
  });

  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = 'UPDATING…';
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'UPDATE_LIST',
      } satisfies RuntimeMsg)) as UpdateListResponse | undefined;
      if (res?.ok) {
        updateBtn.textContent = 'UPDATED!';
        await refreshListStatus();
        window.setTimeout(() => {
          updateBtn.textContent = 'UPDATE LIST NOW';
          updateBtn.disabled = false;
        }, 1500);
      } else {
        updateBtn.textContent = 'UPDATE FAILED';
        window.setTimeout(() => {
          updateBtn.textContent = 'UPDATE LIST NOW';
          updateBtn.disabled = false;
        }, 2000);
      }
    } catch {
      updateBtn.textContent = 'UPDATE FAILED';
      window.setTimeout(() => {
        updateBtn.textContent = 'UPDATE LIST NOW';
        updateBtn.disabled = false;
      }, 2000);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.highlightAdsSettings?.newValue) return;
    const updated = changes.highlightAdsSettings.newValue as HighlightSettings;
    enabledEl.checked = updated.enabled;
    renderSiteSection(updated);
    paintSwatches(updated.color);
    void refreshCount(currentTabId, updated);
  });
}

void init();
