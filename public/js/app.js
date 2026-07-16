import { loadIdentity, updateIdentity, isPaired } from './store.js';
import { generateKeyPair, deriveSharedKey } from './crypto.js';
import {
  pairingLinkFor,
  getPairingIdFromUrl,
  createPairing,
  listenForJoin,
  finalizeRoomAsCreator,
  joinPairing,
} from './pairing.js';
import * as RoomData from './room-data.js';
import { fileToCompressedBase64 } from './image-utils.js';
import { ensureSignedIn, tryEnableOfflinePersistence } from './firebase.js';

const root = document.getElementById('app');
let identity = null;
let sharedKey = null;
let activeTab = 'home';
let unsubscribers = [];
let lastKnownUid = null;

function clearListeners() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

// ---------------- Boot ----------------
async function boot() {
  try {
    const user = await ensureSignedIn();
    lastKnownUid = user.uid;
    tryEnableOfflinePersistence(); // non-blocking, never delays startup

    identity = await loadIdentity();

    if (!identity || !identity.displayName) {
      return renderOnboarding();
    }

    const urlPairingId = getPairingIdFromUrl();

    if (isPaired(identity)) {
      sharedKey = deriveSharedKey(identity.partnerPublicKey, identity.secretKey);
      return renderMain();
    }

    if (urlPairingId) {
      return renderJoinScreen(urlPairingId);
    }

    if (identity.pending?.pairingId) {
      return renderWaitingScreen(identity.pending.pairingId);
    }

    return renderPairingHub();
  } catch (err) {
    renderFatalError(err);
  }
}

function renderFatalError(err) {
  console.error(err);
  const isConfigIssue = /firebase|api-key|invalid-api-key|project/i.test(err?.message || '');
  root.innerHTML = `
    <div class="fatal-error">
      <div class="mark" style="margin: 0 auto 16px;"></div>
      <h2>Something didn't load</h2>
      <p>${
        isConfigIssue
          ? "This usually means the Firebase details in js/firebase-config.js haven't been filled in yet, or the app is being opened as a local file instead of through a server."
          : "An unexpected error stopped the app from starting."
      }</p>
      <p>If you're testing locally, run a simple server (e.g. <code style="display:inline;padding:2px 6px;">python3 -m http.server</code>) rather than opening index.html directly — browsers block module scripts on the file:// protocol.</p>
      <code>${escapeHTML(err?.message || String(err))}</code>
    </div>
  `;
}

// ---------------- Onboarding ----------------
function renderOnboarding() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Welcome to Ondelune</h1>
      <p style="color:var(--text-dim); font-size:14.5px; max-width:320px;">
        A quiet, private space for the two of you. Everything here is encrypted before it ever leaves your phone — no one else can read it, not even the server it's stored on.
      </p>
      <div class="card" style="width:100%; margin-top:6px;">
        <div class="eyebrow">What should we call you?</div>
        <input type="text" id="name-input" placeholder="Your name" maxlength="30" />
      </div>
      <button class="btn-primary" id="continue-btn">Continue</button>
    </div>
  `;
  document.getElementById('continue-btn').onclick = async () => {
    const name = document.getElementById('name-input').value.trim();
    if (!name) return;
    const kp = generateKeyPair();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    identity = await updateIdentity({
      displayName: name,
      timezone,
      publicKey: kp.publicKey,
      secretKey: kp.secretKey,
    });
    const urlPairingId = getPairingIdFromUrl();
    if (urlPairingId) {
      renderJoinScreen(urlPairingId);
    } else {
      renderPairingHub();
    }
  };
}

// ---------------- Pairing: hub (create link) ----------------
function renderPairingHub() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Pair with them</h1>
      <p style="color:var(--text-dim); font-size:14.5px; max-width:320px;">
        Make a one-time link and send it however you like. Once they open it, you're quietly connected — for good.
      </p>
      <button class="btn-primary" id="generate-btn" style="width:100%;">Create pairing link</button>
    </div>
  `;
  document.getElementById('generate-btn').onclick = async () => {
    const pairingId = await createPairing({
      publicKey: identity.publicKey,
      displayName: identity.displayName,
      timezone: identity.timezone,
    });
    identity = await updateIdentity({ pending: { pairingId } });
    renderWaitingScreen(pairingId);
  };
}

function renderWaitingScreen(pairingId) {
  clearListeners();
  const link = pairingLinkFor(pairingId);
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Waiting for them</h1>
      <p style="color:var(--text-dim); font-size:14.5px;">Send this link to your person. It only ever works once.</p>
      <div class="pairing-link-box" id="link-box">${link}</div>
      <button class="btn-secondary" id="copy-btn">Copy link</button>
      <button class="btn-primary" id="share-btn">Share</button>
    </div>
  `;
  document.getElementById('copy-btn').onclick = async () => {
    await navigator.clipboard.writeText(link);
    document.getElementById('copy-btn').textContent = 'Copied ✓';
  };
  document.getElementById('share-btn').onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join me on Ondelune', url: link });
      } catch (e) {
        /* cancelled */
      }
    }
  };

  const unsub = listenForJoin(pairingId, async (data) => {
    const roomId = await finalizeRoomAsCreator({
      myPublicKey: identity.publicKey,
      partnerPublicKey: data.joinerPublicKey,
      myUid: data.creatorUid,
      partnerUid: data.joinerUid,
    });
    identity = await updateIdentity({
      partnerPublicKey: data.joinerPublicKey,
      partnerName: data.joinerName,
      partnerTimezone: data.joinerTimezone,
      roomId,
      pending: null,
    });
    sharedKey = deriveSharedKey(identity.partnerPublicKey, identity.secretKey);
    renderMain();
  });
  unsubscribers.push(unsub);
}

// ---------------- Pairing: join via link ----------------
function renderJoinScreen(pairingId) {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Join them</h1>
      <p style="color:var(--text-dim); font-size:14.5px;">You're about to connect — quietly, and only the two of you will ever be able to read what's shared here.</p>
      <button class="btn-primary" id="join-btn" style="width:100%;">Connect</button>
      <div id="join-error" class="error-text"></div>
    </div>
  `;
  document.getElementById('join-btn').onclick = async () => {
    try {
      const result = await joinPairing(pairingId, {
        publicKey: identity.publicKey,
        displayName: identity.displayName,
        timezone: identity.timezone,
      });
      identity = await updateIdentity({
        partnerPublicKey: result.partnerPublicKey,
        partnerName: result.partnerName,
        partnerTimezone: result.partnerTimezone,
        roomId: result.roomId,
        pending: null,
      });
      sharedKey = deriveSharedKey(identity.partnerPublicKey, identity.secretKey);
      history.replaceState(null, '', window.location.pathname);
      renderMain();
    } catch (e) {
      document.getElementById('join-error').textContent = e.message;
    }
  };
}

// ---------------- Main app shell ----------------
function renderMain() {
  clearListeners();
  root.innerHTML = `<div id="screen-slot"></div>${navHTML()}`;
  bindNav();
  renderTab(activeTab);
}

function navHTML() {
  const tabs = [
    { id: 'home', label: 'Home', icon: iconHome() },
    { id: 'thread', label: 'Thread', icon: iconThread() },
    { id: 'today', label: 'Today', icon: iconToday() },
    { id: 'calendar', label: 'Calendar', icon: iconCalendar() },
    { id: 'list', label: 'List', icon: iconList() },
  ];
  return `<div class="nav">${tabs
    .map(
      (t) =>
        `<button data-tab="${t.id}" class="${t.id === activeTab ? 'active' : ''}">${t.icon}<span>${t.label}</span></button>`
    )
    .join('')}</div>`;
}

function bindNav() {
  document.querySelectorAll('.nav button').forEach((btn) => {
    btn.onclick = () => {
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderTab(activeTab);
    };
  });
}

function renderTab(tab) {
  clearListeners();
  const slot = document.getElementById('screen-slot');
  if (tab === 'home') return renderHome(slot);
  if (tab === 'thread') return renderThread(slot);
  if (tab === 'today') return renderToday(slot);
  if (tab === 'calendar') return renderCalendar(slot);
  if (tab === 'list') return renderBucketList(slot);
}

// ---------------- Home ----------------
function renderHome(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Ondelune</div>
      <h1 style="margin-bottom:16px;">Evening, ${escapeHTML(identity.displayName)}</h1>
      <div class="moon-pair">
        <svg class="thread-svg" viewBox="0 0 300 172" preserveAspectRatio="none">
          <path class="thread-path" d="M 90 86 Q 150 40 210 86" />
        </svg>
        <div class="moon mine">
          <div class="moon-time" id="my-time">--:--</div>
          <div class="moon-label">You</div>
        </div>
        <div class="moon theirs">
          <div class="moon-time" id="partner-time">--:--</div>
          <div class="moon-label">${escapeHTML(identity.partnerName || 'Them')}</div>
        </div>
      </div>
      <div class="stat-row">
        <div class="card">
          <div class="stat-number" id="days-together">–</div>
          <div class="stat-caption">days together</div>
        </div>
        <div class="card">
          <div class="stat-number" id="countdown-value">–</div>
          <div class="stat-caption" id="countdown-caption">next moment</div>
        </div>
      </div>
      <div class="card" id="together-since-card">
        <div class="eyebrow">Together since</div>
        <input type="date" id="together-since-input" />
      </div>
    </div>
  `;

  function tick() {
    const now = new Date();
    document.getElementById('my-time').textContent = now.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: identity.timezone,
    });
    document.getElementById('partner-time').textContent = identity.partnerTimezone
      ? now.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: identity.partnerTimezone,
        })
      : '--:--';
  }
  tick();
  const clockInterval = setInterval(tick, 1000 * 15);
  unsubscribers.push(() => clearInterval(clockInterval));

  const input = document.getElementById('together-since-input');
  input.onchange = () => {
    RoomData.setTogetherSince(identity.roomId, sharedKey, input.value);
  };

  const unsubSettings = RoomData.listenRoomSettings(identity.roomId, sharedKey, (settings) => {
    if (settings.togetherSince) {
      input.value = settings.togetherSince;
      const days = Math.floor((Date.now() - new Date(settings.togetherSince)) / 86400000);
      document.getElementById('days-together').textContent = days >= 0 ? days : '–';
    }
  });
  unsubscribers.push(unsubSettings);

  const unsubCal = RoomData.listenCalendar(identity.roomId, sharedKey, (events) => {
    const upcoming = events
      .filter((e) => new Date(e.dateTime).getTime() > Date.now())
      .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime))[0];
    const valueEl = document.getElementById('countdown-value');
    const captionEl = document.getElementById('countdown-caption');
    if (upcoming) {
      const diffMs = new Date(upcoming.dateTime) - Date.now();
      const days = Math.floor(diffMs / 86400000);
      const hours = Math.floor((diffMs % 86400000) / 3600000);
      valueEl.textContent = days > 0 ? `${days}d` : `${hours}h`;
      captionEl.textContent = upcoming.title;
    } else {
      valueEl.textContent = '–';
      captionEl.textContent = 'nothing planned yet';
    }
  });
  unsubscribers.push(unsubCal);
}

// ---------------- Thread ----------------
function renderThread(slot) {
  slot.innerHTML = `
    <div class="screen" style="display:flex; flex-direction:column; min-height:calc(100vh - 96px);">
      <div class="eyebrow">Just the two of you</div>
      <h2 style="margin-bottom:12px;">Thread</h2>
      <div class="thread-list" id="thread-list" style="flex:1; overflow-y:auto;"></div>
      <div class="composer">
        <input type="text" id="thread-input" placeholder="Say something quiet..." />
        <button id="thread-send">Send</button>
      </div>
    </div>
  `;
  const listEl = document.getElementById('thread-list');
  const unsub = RoomData.listenThread(identity.roomId, sharedKey, (messages) => {
    if (messages.length === 0) {
      listEl.innerHTML = `<div class="empty-state">Nothing here yet. Say hello.</div>`;
      return;
    }
    listEl.innerHTML = messages
      .map((m) => {
        const mine = m.senderUid === lastKnownUid;
        return `<div class="bubble ${mine ? 'me' : 'them'}">${escapeHTML(m.text)}</div>`;
      })
      .join('');
    listEl.scrollTop = listEl.scrollHeight;
  });
  unsubscribers.push(unsub);

  const input = document.getElementById('thread-input');
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await RoomData.sendThreadMessage(identity.roomId, sharedKey, text);
  };
  document.getElementById('thread-send').onclick = send;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') send();
  };
}

// ---------------- Today (mood + photo) ----------------
const MOODS = ['😊', '😌', '😴', '😔', '😤', '🥰'];

function renderToday(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">How today felt</div>
      <h2 style="margin-bottom:14px;">Today</h2>
      <div class="card">
        <div class="eyebrow">Your mood</div>
        <div class="mood-picker" id="mood-picker">
          ${MOODS.map((m) => `<div class="mood-option" data-mood="${m}">${m}</div>`).join('')}
        </div>
      </div>
      <div class="card" id="partner-mood-card">
        <div class="eyebrow">${escapeHTML(identity.partnerName || 'Their')} mood today</div>
        <div style="font-size:26px;" id="partner-mood">–</div>
      </div>
      <div class="card">
        <div class="eyebrow">A photo from today</div>
        <input type="file" accept="image/*" id="photo-input" style="margin:8px 0;" />
        <div class="photo-grid" id="photo-grid"></div>
      </div>
    </div>
  `;

  document.querySelectorAll('.mood-option').forEach((el) => {
    el.onclick = async () => {
      await RoomData.setTodayMood(identity.roomId, sharedKey, el.dataset.mood);
    };
  });

  const unsubMood = RoomData.listenMood(identity.roomId, sharedKey, (entries) => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const mine = entries.find((e) => e.date === todayKey && e.senderUid === lastKnownUid);
    const theirs = entries.find((e) => e.date === todayKey && e.senderUid !== lastKnownUid);
    document.querySelectorAll('.mood-option').forEach((el) => {
      el.classList.toggle('selected', mine && el.dataset.mood === mine.mood);
    });
    document.getElementById('partner-mood').textContent = theirs ? theirs.mood : 'Not shared yet';
  });
  unsubscribers.push(unsubMood);

  document.getElementById('photo-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const compressed = await fileToCompressedBase64(file);
    await RoomData.setTodayPhoto(identity.roomId, sharedKey, compressed);
  };

  const unsubPhotos = RoomData.listenPhotos(identity.roomId, sharedKey, (photos) => {
    const grid = document.getElementById('photo-grid');
    if (photos.length === 0) {
      grid.innerHTML = `<div class="empty-state">No photos yet</div>`;
      return;
    }
    grid.innerHTML = photos
      .filter((p) => p.image)
      .map((p) => `<img src="${p.image}" alt="${p.date}" />`)
      .join('');
  });
  unsubscribers.push(unsubPhotos);
}

// ---------------- Calendar ----------------
function renderCalendar(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Plans together</div>
      <h2 style="margin-bottom:14px;">Calendar</h2>
      <div class="card">
        <input type="text" id="event-title" placeholder="Event title" style="margin-bottom:8px;" />
        <input type="datetime-local" id="event-time" style="margin-bottom:10px;" />
        <button class="btn-primary" id="add-event">Add event</button>
      </div>
      <div class="card" id="event-list"></div>
    </div>
  `;
  document.getElementById('add-event').onclick = async () => {
    const title = document.getElementById('event-title').value.trim();
    const dateTime = document.getElementById('event-time').value;
    if (!title || !dateTime) return;
    await RoomData.addCalendarEvent(identity.roomId, sharedKey, {
      title,
      dateTime: new Date(dateTime).toISOString(),
    });
    document.getElementById('event-title').value = '';
    document.getElementById('event-time').value = '';
  };

  const unsub = RoomData.listenCalendar(identity.roomId, sharedKey, (events) => {
    const listEl = document.getElementById('event-list');
    if (events.length === 0) {
      listEl.innerHTML = `<div class="empty-state">No events yet</div>`;
      return;
    }
    listEl.innerHTML = events
      .map(
        (e) => `
      <div class="list-row">
        <div>
          <div>${escapeHTML(e.title)}</div>
          <div style="font-size:12px; color:var(--text-dim);">${new Date(e.dateTime).toLocaleString()}</div>
        </div>
      </div>`
      )
      .join('');
  });
  unsubscribers.push(unsub);
}

// ---------------- Bucket list ----------------
function renderBucketList(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Things to do together</div>
      <h2 style="margin-bottom:14px;">List</h2>
      <div class="card">
        <input type="text" id="item-input" placeholder="Add something..." style="margin-bottom:8px;" />
        <button class="btn-primary" id="add-item">Add</button>
      </div>
      <div class="card" id="item-list"></div>
    </div>
  `;
  document.getElementById('add-item').onclick = async () => {
    const text = document.getElementById('item-input').value.trim();
    if (!text) return;
    document.getElementById('item-input').value = '';
    await RoomData.addBucketItem(identity.roomId, sharedKey, text);
  };

  const unsub = RoomData.listenBucketList(identity.roomId, sharedKey, (items) => {
    const listEl = document.getElementById('item-list');
    if (items.length === 0) {
      listEl.innerHTML = `<div class="empty-state">Nothing yet — add your first idea</div>`;
      return;
    }
    listEl.innerHTML = items
      .map(
        (i, idx) => `
      <div class="list-row" data-idx="${idx}">
        <div class="checkbox ${i.done ? 'done' : ''}">${i.done ? '✓' : ''}</div>
        <div class="${i.done ? 'done-text' : ''}">${escapeHTML(i.text)}</div>
      </div>`
      )
      .join('');
    listEl.querySelectorAll('.list-row').forEach((row) => {
      const item = items[Number(row.dataset.idx)];
      row.onclick = () => {
        RoomData.toggleBucketItem(identity.roomId, sharedKey, item.id, item.text, item.done);
      };
    });
  });
  unsubscribers.push(unsub);
}

// ---------------- Utilities ----------------
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function iconHome() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v9a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1v-9"/></svg>';
}
function iconThread() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M21 11.5a8.5 8.5 0 01-8.5 8.5H4l1.6-3.7A8.5 8.5 0 1121 11.5z"/></svg>';
}
function iconToday() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/></svg>';
}
function iconCalendar() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>';
}
function iconList() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/></svg>';
}

// Catch anything that slips through so the app never just goes blank.
window.addEventListener('error', (e) => {
  if (!document.getElementById('screen-slot') && !document.querySelector('.center-col')) {
    renderFatalError(e.error || new Error(e.message));
  }
});
window.addEventListener('unhandledrejection', (e) => {
  if (root.innerHTML.trim() === '') {
    renderFatalError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)));
  }
});

boot();
