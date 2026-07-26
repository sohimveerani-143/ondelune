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

// ---------- modal form ----------
// Replaces window.prompt(), which renders a passphrase in plain sight, can't be
// styled, and is suppressed entirely in some installed-PWA contexts.
// Resolves to an object of field values, or null if dismissed.
export function promptModal({ title, note, fields, submitLabel = 'Save' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = `
      <div class="sheet">
        <div class="sheet-grabber"></div>
        <div class="sheet-title">${title}</div>
        <div class="sheet-form">
          ${note ? `<p class="fine-print" style="margin:0 0 4px;">${note}</p>` : ''}
          ${fields
            .map(
              (f) => `
            ${f.label ? `<div class="eyebrow" style="margin:4px 0 0;">${f.label}</div>` : ''}
            <input
              type="${f.type || 'text'}"
              id="pm-${f.name}"
              placeholder="${f.placeholder || ''}"
              value="${String(f.value ?? '').replace(/"/g, '&quot;')}"
              ${f.type === 'password' ? 'autocomplete="off"' : ''}
              ${f.inputmode ? `inputmode="${f.inputmode}"` : ''}
            />`
            )
            .join('')}
          <div class="modal-error" id="pm-error"></div>
          <button class="btn-primary" id="pm-submit">${submitLabel}</button>
          <button class="btn-ghost" data-cancel>Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    setTimeout(() => wrap.classList.add('open'), 0);

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 200);
      resolve(value);
    };

    wrap.onclick = (e) => {
      if (e.target === wrap || e.target.hasAttribute('data-cancel')) finish(null);
    };

    const submit = () => {
      const values = {};
      for (const f of fields) {
        const el = wrap.querySelector(`#pm-${f.name}`);
        values[f.name] = el.value;
        if (f.required && !el.value.trim()) {
          wrap.querySelector('#pm-error').textContent = `${f.label || 'This'} is required.`;
          el.focus();
          return;
        }
        if (f.minLength && el.value.length < f.minLength) {
          wrap.querySelector('#pm-error').textContent = `Needs at least ${f.minLength} characters.`;
          el.focus();
          return;
        }
      }
      finish(values);
    };

    wrap.querySelector('#pm-submit').onclick = submit;
    wrap.querySelectorAll('.sheet-form input').forEach((el) => {
      el.onkeydown = (e) => {
        if (e.key === 'Enter') submit();
      };
    });
    const first = wrap.querySelector('.sheet-form input');
    if (first) first.focus();
  });
}

// A styled replacement for window.confirm() on the flows where a native dialog
// looks jarring. Resolves true/false.
export function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-backdrop';
    wrap.innerHTML = `
      <div class="sheet">
        <div class="sheet-grabber"></div>
        <div class="sheet-title">${title}</div>
        <div class="sheet-form">
          ${body ? `<p class="body-dim" style="margin:0 0 6px;">${body}</p>` : ''}
          <button class="${danger ? 'btn-danger' : 'btn-primary'}" id="cm-yes">${confirmLabel}</button>
          <button class="btn-ghost" data-cancel>Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    setTimeout(() => wrap.classList.add('open'), 0);

    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 200);
      resolve(v);
    };
    wrap.onclick = (e) => {
      if (e.target === wrap || e.target.hasAttribute('data-cancel')) finish(false);
    };
    wrap.querySelector('#cm-yes').onclick = () => finish(true);
  });
}

// ---------- lightbox ----------
// Full-screen photo viewer with pinch-zoom, drag-to-pan and double-tap zoom.
// Written against raw touch events rather than a library: it's ~60 lines, and
// pulling in a gesture dependency for this would undo the buildless setup.
export function openLightbox(src) {
  const wrap = document.createElement('div');
  wrap.className = 'lightbox';
  wrap.innerHTML = `
    <button class="lightbox-close" aria-label="Close">&times;</button>
    <div class="lightbox-stage"><img class="lightbox-img" alt="" /></div>
    <div class="lightbox-hint">Pinch or double-tap to zoom</div>`;
  document.body.appendChild(wrap);
  const img = wrap.querySelector('.lightbox-img');
  img.src = src;
  // setTimeout rather than rAF — see the note in app.js openSheet(); rAF is
  // suspended on non-compositing pages, which would leave this fully transparent.
  setTimeout(() => wrap.classList.add('open'), 0);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let startDist = 0;
  let startScale = 1;
  let startX = 0;
  let startY = 0;
  let panning = false;
  let lastTap = 0;

  const apply = () => {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const clamp = () => {
    if (scale <= 1) {
      scale = 1;
      tx = 0;
      ty = 0;
      return;
    }
    // Keep the image from being dragged entirely off screen.
    const maxX = (img.clientWidth * (scale - 1)) / 2;
    const maxY = (img.clientHeight * (scale - 1)) / 2;
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  };
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

  wrap.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 2) {
        startDist = dist(e.touches);
        startScale = scale;
        panning = false;
      } else if (e.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 300) {
          scale = scale > 1 ? 1 : 2.4;
          tx = 0;
          ty = 0;
          clamp();
          apply();
          lastTap = 0;
          return;
        }
        lastTap = now;
        panning = scale > 1;
        startX = e.touches[0].clientX - tx;
        startY = e.touches[0].clientY - ty;
      }
    },
    { passive: true }
  );

  wrap.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        scale = Math.max(1, Math.min(4, (startScale * dist(e.touches)) / (startDist || 1)));
        clamp();
        apply();
      } else if (panning && e.touches.length === 1) {
        e.preventDefault();
        tx = e.touches[0].clientX - startX;
        ty = e.touches[0].clientY - startY;
        clamp();
        apply();
      }
    },
    { passive: false }
  );

  wrap.addEventListener('touchend', () => { panning = scale > 1; }, { passive: true });

  // Desktop affordance so this is testable and usable with a mouse too.
  img.addEventListener('dblclick', () => {
    scale = scale > 1 ? 1 : 2.4;
    tx = 0;
    ty = 0;
    clamp();
    apply();
  });

  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 200);
  };
  wrap.querySelector('.lightbox-close').onclick = close;
  wrap.onclick = (e) => {
    if (e.target === wrap || e.target.classList.contains('lightbox-stage')) close();
  };
  return close;
}

// ---------- milestones ----------
// Upcoming "together since" moments: the next yearly anniversary plus the next
// round day-count. Returns whichever lands first.
export function nextMilestone(togetherSinceISO) {
  if (!togetherSinceISO) return null;
  const start = new Date(togetherSinceISO);
  if (isNaN(start)) return null;
  const now = Date.now();
  const days = Math.floor((now - start.getTime()) / 86400000);
  const candidates = [];

  const years = now >= start.getTime() ? new Date(start) : null;
  if (years) {
    years.setFullYear(start.getFullYear() + Math.floor(days / 365.25) + 1);
    const n = Math.round((years.getTime() - start.getTime()) / 86400000 / 365.25);
    candidates.push({ at: years.getTime(), label: `${n} year${n === 1 ? '' : 's'} together` });
  }

  const step = days < 500 ? 100 : days < 2000 ? 500 : 1000;
  const nextDayCount = (Math.floor(days / step) + 1) * step;
  candidates.push({
    at: start.getTime() + nextDayCount * 86400000,
    label: `${nextDayCount.toLocaleString()} days together`,
  });

  candidates.sort((a, b) => a.at - b.at);
  const pick = candidates[0];
  return { ...pick, daysAway: Math.ceil((pick.at - now) / 86400000) };
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
