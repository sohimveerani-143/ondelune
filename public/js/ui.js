// ui.js — small shared UI primitives: loading states, toasts, and formatting.
// Deliberately dependency-free and DOM-light; this runs on an old low-RAM phone.

// Playful, on-tone loading copy so a screen is never just blank while Firestore
// does its first round-trip.
export const LOADING_COPY = {
  thread: 'Gathering your words…',
  letters: 'Checking the mailbox…',
  expenses: 'Counting your cash…',
  savings: 'Counting the coins…',
  journal: 'Turning the pages…',
  memories: 'Dusting off the album…',
  calendar: 'Checking the calendar…',
  list: 'Unfolding the list…',
  mood: 'Reading the sky…',
  photos: 'Developing the photos…',
  home: 'Setting the scene…',
};

// A calm shimmer placeholder. `lines` shapes roughly match the real content
// so the swap-in doesn't jolt the layout.
export function skeleton(lines = 3) {
  let out = '<div class="skeleton-wrap">';
  for (let i = 0; i < lines; i++) {
    const w = [92, 74, 60, 84, 68][i % 5];
    out += `<div class="skeleton-line" style="width:${w}%;"></div>`;
  }
  return out + '</div>';
}

export function renderLoading(el, key, lines = 3) {
  if (!el) return;
  el.innerHTML = `
    <div class="loading-block">
      <div class="loading-copy"><span class="loading-orb"></span>${LOADING_COPY[key] || 'Loading…'}</div>
      ${skeleton(lines)}
    </div>`;
}

// Transient bottom toast. Auto-dismisses; stacking is intentionally not
// supported — one calm message at a time.
let toastTimer = null;
export function toast(message, { duration = 3200, action } = {}) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.className = 'toast show';
  el.innerHTML = `<span>${message}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => {
      hideToast();
      action.onClick();
    };
    el.appendChild(btn);
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

export function hideToast() {
  const el = document.getElementById('toast');
  if (el) el.className = 'toast';
}

// ---------- formatting ----------
export function countdownParts(targetMs) {
  const diff = Math.max(0, targetMs - Date.now());
  return {
    total: diff,
    days: Math.floor(diff / 86400000),
    hours: Math.floor((diff % 86400000) / 3600000),
    minutes: Math.floor((diff % 3600000) / 60000),
    seconds: Math.floor((diff % 60000) / 1000),
  };
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function relativeTime(date) {
  const secs = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (secs < 45) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86400);
  if (days < 7) return `${days}d ago`;
  return new Date(date).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
