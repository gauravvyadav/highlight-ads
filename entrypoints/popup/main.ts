import './style.css';
import {
  getSettings,
  setSettings,
  type HighlightColorId,
  type RuntimeMsg,
  type UpdateListResponse,
} from '@/utils/settings';
import type { EngineStatus } from '@/utils/easylist';

const enabledEl = document.querySelector<HTMLInputElement>('#enabled')!;
const countEl = document.querySelector<HTMLElement>('#count')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const updateBtn = document.querySelector<HTMLButtonElement>('#update-list')!;
const listDate = document.querySelector<HTMLElement>('#list-date')!;
const listRules = document.querySelector<HTMLElement>('#list-rules')!;
const stateChip = document.querySelector<HTMLElement>('#state-chip')!;

function paintChip(on: boolean): void {
  stateChip.textContent = on ? 'ON' : 'OFF';
  stateChip.classList.toggle('off', !on);
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

function setStatus(msg: string): void {
  statusEl.textContent = msg;
  if (msg) window.setTimeout(() => {
    if (statusEl.textContent === msg) statusEl.textContent = '';
  }, 4000);
}

async function refreshCount(): Promise<void> {
  countEl.textContent = '…';
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'GET_AD_COUNT',
    } satisfies RuntimeMsg)) as { count?: number } | undefined;
    countEl.textContent = String(res?.count ?? 0);
  } catch {
    countEl.textContent = 'n/a';
  }
}

function paintListStatus(status: EngineStatus | undefined): void {
  if (!status?.ready) {
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
    paintListStatus(status);
  } catch {
    paintListStatus(undefined);
  }
}

async function init(): Promise<void> {
  const settings = await getSettings();
  enabledEl.checked = settings.enabled;
  paintChip(settings.enabled);
  bindSwatches();
  paintSwatches(settings.color);
  await refreshCount();
  await refreshListStatus();

  enabledEl.addEventListener('change', async () => {
    await setSettings({ enabled: enabledEl.checked });
    paintChip(enabledEl.checked);
    await refreshCount();
  });

  updateBtn.addEventListener('click', async () => {
    updateBtn.disabled = true;
    setStatus('Updating EasyList…');
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'UPDATE_LIST',
      } satisfies RuntimeMsg)) as UpdateListResponse | undefined;
      if (res?.ok) {
        setStatus('EasyList updated.');
      } else {
        setStatus(`Update failed: ${res?.error ?? 'unknown error'}`);
      }
    } catch {
      setStatus('Update failed: background unreachable.');
    } finally {
      updateBtn.disabled = false;
      await refreshListStatus();
    }
  });
}

void init();
