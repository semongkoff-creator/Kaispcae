// Flashes the browser tab's title while it's backgrounded, alternating with
// the page's real title, so a notification keeps re-alerting the user until
// they actually come back — unlike a single native Notification() popup,
// which can be missed if they don't glance at it in time. Pure document.title
// manipulation, no permission required, works even if the user never granted
// Notification access at all.

const ORIGINAL_TITLE = document.title;
const FLASH_INTERVAL_MS = 1000;

let flashTimer: ReturnType<typeof setInterval> | null = null;

function stopOnVisible(): void {
  if (document.visibilityState === 'visible') stopTabAttentionFlash();
}

export function startTabAttentionFlash(label: string): void {
  if (document.visibilityState === 'visible' || flashTimer) return;

  let showLabel = true;
  flashTimer = setInterval(() => {
    document.title = showLabel ? label : ORIGINAL_TITLE;
    showLabel = !showLabel;
  }, FLASH_INTERVAL_MS);
  document.addEventListener('visibilitychange', stopOnVisible);
}

export function stopTabAttentionFlash(): void {
  if (flashTimer) {
    clearInterval(flashTimer);
    flashTimer = null;
  }
  document.title = ORIGINAL_TITLE;
  document.removeEventListener('visibilitychange', stopOnVisible);
}
