import { loadIdentity, updateIdentity, saveIdentity, isPaired } from './store.js';
import { generateKeyPair, deriveSharedKey, safetyNumber } from './crypto.js';
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
import { lockIdentityWithPin, unlockIdentityWithPin, needsUnlock } from './applock.js';
import { setUpRecovery, recoverFromEmail } from './auth-recovery.js';
import { listenStreak } from './streak.js';
import { listenGame, startNewGame, makeMove } from './game-tictactoe.js';

const root = document.getElementById('app');
let identity = null;
let sharedKey = null;
let activeTab = 'home';
let todaySegment = 'checkin';
let unsubscribers = [];
let lastKnownUid = null;
let lastHiddenAt = null;

function clearListeners() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

function memberUidsOf(identity) {
  return [lastKnownUid, identity.partnerUid].sort();
}

// ---------------- Boot ----------------
async function boot() {
  try {
    const user = await ensureSignedIn();
    lastKnownUid = user.uid;
    tryEnableOfflinePersistence();

    identity = await loadIdentity();

    if (!identity || !identity.displayName) {
      return renderEntryChoice();
    }

    if (needsUnlock(identity)) {
      return renderLockScreen();
    }

    return continueAfterUnlock();
  } catch (err) {
    renderFatalError(err);
  }
}

function continueAfterUnlock() {
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
      <p>If testing locally, run <code style="display:inline;padding:2px 6px;">python3 -m http.server</code> rather than opening index.html directly.</p>
      <code>${escapeHTML(err?.message || String(err))}</code>
    </div>
  `;
}

// ---------------- Entry: new here, or recovering an existing account ----------------
function renderEntryChoice() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Welcome to Ondelune</h1>
      <p style="color:var(--text-dim); font-size:14.5px; max-width:320px;">
        A quiet, private space for the two of you. Everything here is encrypted before it ever leaves your phone.
      </p>
      <button class="btn-primary" id="new-here-btn" style="width:100%;">I'm new here</button>
      <button class="btn-secondary" id="recover-btn" style="width:100%;">I already have an account</button>
    </div>
  `;
  document.getElementById('new-here-btn').onclick = () => renderNameStep();
  document.getElementById('recover-btn').onclick = () => renderRecoverStep();
}

function renderRecoverStep() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Recover your account</h1>
      <p style="color:var(--text-dim); font-size:14.5px;">Enter the email and password you set up recovery with.</p>
      <div class="card" style="width:100%;">
        <input type="text" id="recover-email" placeholder="Email" style="margin-bottom:8px;" />
        <input type="text" id="recover-password" placeholder="Password" />
      </div>
      <button class="btn-primary" id="recover-submit" style="width:100%;">Recover</button>
      <div id="recover-error" class="error-text"></div>
      <button class="btn-secondary" id="back-btn" style="width:100%;">Back</button>
    </div>
  `;
  document.getElementById('back-btn').onclick = () => renderEntryChoice();
  document.getElementById('recover-submit').onclick = async () => {
    const email = document.getElementById('recover-email').value.trim();
    const password = document.getElementById('recover-password').value;
    if (!email || !password) return;
    try {
      const recovered = await recoverFromEmail(email, password);
      identity = await saveIdentity({ ...recovered, recoveryEmail: email, pending: null });
      continueAfterUnlock();
    } catch (e) {
      document.getElementById('recover-error').textContent = e.message;
    }
  };
}

// ---------------- Onboarding: name → recovery choice → PIN choice ----------------
function renderNameStep() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>What should we call you?</h1>
      <div class="card" style="width:100%;">
        <input type="text" id="name-input" placeholder="Your name" maxlength="30" />
      </div>
      <button class="btn-primary" id="continue-btn" style="width:100%;">Continue</button>
    </div>
  `;
  document.getElementById('continue-btn').onclick = async () => {
    const name = document.getElementById('name-input').value.trim();
    if (!name) return;
    const kp = generateKeyPair();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    identity = { displayName: name, timezone, publicKey: kp.publicKey, secretKey: kp.secretKey };
    renderRecoveryChoice();
  };
}

function renderRecoveryChoice() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Don't lose your place</h1>
      <p style="color:var(--text-dim); font-size:14.5px; max-width:320px;">
        By default your identity lives only on this device — if you lose the phone, it's gone for good.
        Setting up recovery lets you restore everything on a new device with just an email and password.
      </p>
      <div class="card" style="width:100%;">
        <input type="text" id="recovery-email" placeholder="Email" style="margin-bottom:8px;" />
        <input type="text" id="recovery-password" placeholder="Choose a password" />
      </div>
      <button class="btn-primary" id="setup-recovery-btn" style="width:100%;">Set up recovery (recommended)</button>
      <button class="btn-secondary" id="skip-recovery-btn" style="width:100%;">Skip — stay anonymous</button>
      <div id="recovery-error" class="error-text"></div>
    </div>
  `;
  document.getElementById('setup-recovery-btn').onclick = async () => {
    const email = document.getElementById('recovery-email').value.trim();
    const password = document.getElementById('recovery-password').value;
    if (!email || password.length < 6) {
      document.getElementById('recovery-error').textContent = 'Enter an email and a password of at least 6 characters.';
      return;
    }
    try {
      await setUpRecovery(email, password, identity);
      identity.recoveryEmail = email;
      renderPinChoice();
    } catch (e) {
      document.getElementById('recovery-error').textContent = e.message;
    }
  };
  document.getElementById('skip-recovery-btn').onclick = () => renderPinChoice();
}

function renderPinChoice() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Lock the app locally?</h1>
      <p style="color:var(--text-dim); font-size:14.5px; max-width:320px;">
        A PIN encrypts your key right here on this device, so if someone else picks up your unlocked phone, they still can't get in.
      </p>
      <div class="card" style="width:100%;">
        <input type="text" inputmode="numeric" pattern="[0-9]*" id="pin-input" placeholder="Choose a 4–6 digit PIN" maxlength="6" />
      </div>
      <button class="btn-primary" id="set-pin-btn" style="width:100%;">Set PIN (recommended)</button>
      <button class="btn-secondary" id="skip-pin-btn" style="width:100%;">Skip for now</button>
      <div id="pin-error" class="error-text"></div>
    </div>
  `;
  document.getElementById('set-pin-btn').onclick = async () => {
    const pin = document.getElementById('pin-input').value.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      document.getElementById('pin-error').textContent = 'PIN must be 4–6 digits.';
      return;
    }
    const locked = await lockIdentityWithPin(identity, pin);
    await saveIdentity(locked);
    identity = { ...locked, secretKey: identity.secretKey }; // keep plaintext key in memory for this session
    finishOnboarding();
  };
  document.getElementById('skip-pin-btn').onclick = async () => {
    identity = await saveIdentity({ ...identity, pinEnabled: false });
    finishOnboarding();
  };
}

function finishOnboarding() {
  const urlPairingId = getPairingIdFromUrl();
  if (urlPairingId) {
    renderJoinScreen(urlPairingId);
  } else {
    renderPairingHub();
  }
}

// ---------------- Lock screen (PIN re-entry) ----------------
function renderLockScreen() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Welcome back</h1>
      <p style="color:var(--text-dim); font-size:14.5px;">Enter your PIN to continue.</p>
      <div class="card" style="width:100%;">
        <input type="text" inputmode="numeric" pattern="[0-9]*" id="unlock-pin" placeholder="PIN" maxlength="6" autofocus />
      </div>
      <button class="btn-primary" id="unlock-btn" style="width:100%;">Unlock</button>
      <div id="unlock-error" class="error-text"></div>
    </div>
  `;
  const tryUnlock = async () => {
    const pin = document.getElementById('unlock-pin').value.trim();
    try {
      const unlocked = await unlockIdentityWithPin(identity, pin);
      identity.secretKey = unlocked.secretKey;
      continueAfterUnlock();
    } catch (e) {
      document.getElementById('unlock-error').textContent = 'Wrong PIN — try again.';
    }
  };
  document.getElementById('unlock-btn').onclick = tryUnlock;
  document.getElementById('unlock-pin').onkeydown = (e) => {
    if (e.key === 'Enter') tryUnlock();
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
      partnerUid: data.joinerUid,
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
        partnerUid: result.creatorUid,
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
      <div style="display:flex; justify-content:space-between; align-items:flex-start;">
        <div>
          <div class="eyebrow">Ondelune</div>
          <h1 style="margin-bottom:16px;">Evening, ${escapeHTML(identity.displayName)}</h1>
        </div>
        <button class="btn-icon" id="settings-btn" aria-label="Settings">${iconSettings()}</button>
      </div>
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
      <div class="card streak-card">
        <div class="streak-dot"></div>
        <div>
          <div class="stat-number" id="streak-value" style="font-size:22px;">–</div>
          <div class="stat-caption">day streak — showing up for each other</div>
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

  document.getElementById('settings-btn').onclick = () => renderSettings();

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

  if (identity.partnerUid) {
    const unsubStreak = listenStreak(identity.roomId, memberUidsOf(identity), (streak) => {
      const el = document.getElementById('streak-value');
      if (el) el.textContent = streak;
    });
    unsubscribers.push(unsubStreak);
  }
}

// ---------------- Settings ----------------
function renderSettings() {
  clearListeners();
  root.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Ondelune</div>
      <h1 style="margin-bottom:16px;">Settings</h1>

      <div class="card">
        <div class="eyebrow">Security</div>
        <p style="font-size:13.5px; color:var(--text-dim); margin: 4px 0 10px;">
          Every message, photo, and entry is end-to-end encrypted with a key that never leaves your device.
          Below is a short fingerprint of this pairing — read it aloud to each other once to confirm it wasn't intercepted.
        </p>
        <div class="pairing-link-box" id="safety-number">Computing…</div>
      </div>

      <div class="card">
        <div class="eyebrow">App lock</div>
        <p style="font-size:13.5px; color:var(--text-dim); margin: 4px 0 10px;">
          ${identity.pinEnabled ? 'A PIN is protecting this device.' : 'No PIN set — anyone with your unlocked phone can open this app.'}
        </p>
        <button class="btn-secondary" id="toggle-pin-btn">${identity.pinEnabled ? 'Change PIN' : 'Set a PIN'}</button>
      </div>

      <div class="card">
        <div class="eyebrow">Recovery</div>
        <p style="font-size:13.5px; color:var(--text-dim); margin: 4px 0 10px;">
          ${identity.recoveryEmail ? `Recovery is set up for ${escapeHTML(identity.recoveryEmail)}.` : "You're anonymous — losing this device means losing access permanently, with no way to recover."}
        </p>
        ${identity.recoveryEmail ? '' : '<button class="btn-secondary" id="setup-recovery-later-btn">Set up recovery</button>'}
      </div>

      <div class="card">
        <div class="eyebrow">Photo privacy</div>
        <p style="font-size:13.5px; color:var(--text-dim);">
          View-once photos in Thread delete themselves after your partner opens them once. The app also blurs
          images the instant it's backgrounded, so they can't appear in your phone's recent-apps preview.
          No website can block an actual screenshot — that protection only exists in native apps.
        </p>
      </div>

      <button class="btn-secondary" id="back-home-btn">Back to Home</button>
    </div>
  `;

  document.getElementById('back-home-btn').onclick = () => renderMain();
  document.getElementById('toggle-pin-btn').onclick = () => renderPinChoiceFromSettings();

  const recoveryBtn = document.getElementById('setup-recovery-later-btn');
  if (recoveryBtn) recoveryBtn.onclick = () => renderRecoverySetupFromSettings();

  if (identity.partnerPublicKey) {
    safetyNumber(identity.publicKey, identity.partnerPublicKey).then((code) => {
      const el = document.getElementById('safety-number');
      if (el) el.textContent = code;
    });
  }
}

function renderPinChoiceFromSettings() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Set a PIN</h1>
      <div class="card" style="width:100%;">
        <input type="text" inputmode="numeric" pattern="[0-9]*" id="pin-input" placeholder="4–6 digit PIN" maxlength="6" />
      </div>
      <button class="btn-primary" id="save-pin-btn" style="width:100%;">Save</button>
      <div id="pin-error" class="error-text"></div>
      <button class="btn-secondary" id="cancel-btn" style="width:100%;">Cancel</button>
    </div>
  `;
  document.getElementById('cancel-btn').onclick = () => renderSettings();
  document.getElementById('save-pin-btn').onclick = async () => {
    const pin = document.getElementById('pin-input').value.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      document.getElementById('pin-error').textContent = 'PIN must be 4–6 digits.';
      return;
    }
    const plaintextSecretKey = identity.secretKey;
    const locked = await lockIdentityWithPin(identity, pin); // locked never contains a plaintext secretKey
    identity = await saveIdentity(locked);
    identity.secretKey = plaintextSecretKey; // kept in memory for this session only, never persisted
    renderSettings();
  };
}

function renderRecoverySetupFromSettings() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Set up recovery</h1>
      <div class="card" style="width:100%;">
        <input type="text" id="recovery-email" placeholder="Email" style="margin-bottom:8px;" />
        <input type="text" id="recovery-password" placeholder="Choose a password" />
      </div>
      <button class="btn-primary" id="save-recovery-btn" style="width:100%;">Save</button>
      <div id="recovery-error" class="error-text"></div>
      <button class="btn-secondary" id="cancel-btn" style="width:100%;">Cancel</button>
    </div>
  `;
  document.getElementById('cancel-btn').onclick = () => renderSettings();
  document.getElementById('save-recovery-btn').onclick = async () => {
    const email = document.getElementById('recovery-email').value.trim();
    const password = document.getElementById('recovery-password').value;
    if (!email || password.length < 6) {
      document.getElementById('recovery-error').textContent = 'Enter an email and a password of at least 6 characters.';
      return;
    }
    try {
      await setUpRecovery(email, password, identity);
      identity = await updateIdentity({ recoveryEmail: email });
      renderSettings();
    } catch (e) {
      document.getElementById('recovery-error').textContent = e.message;
    }
  };
}

// ---------------- Thread ----------------
function renderThread(slot) {
  slot.innerHTML = `
    <div class="screen" style="display:flex; flex-direction:column; min-height:calc(100vh - 96px);">
      <div class="eyebrow">Just the two of you</div>
      <h2 style="margin-bottom:12px;">Thread</h2>
      <div class="thread-list" id="thread-list" style="flex:1; overflow-y:auto;"></div>
      <div class="composer">
        <label class="btn-icon" style="cursor:pointer;">
          ${iconPhoto()}
          <input type="file" accept="image/*" id="photo-attach" style="display:none;" />
        </label>
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
      .map((m, idx) => {
        const mine = m.senderUid === lastKnownUid;
        if (m.type === 'photo') {
          return `<div class="bubble ${mine ? 'me' : 'them'} photo-bubble" data-idx="${idx}">
            <img src="${m.image}" class="thread-photo ${m.viewOnce && !mine ? 'blurred' : ''}" data-idx="${idx}" />
            ${m.viewOnce ? '<div class="view-once-tag">View once</div>' : ''}
          </div>`;
        }
        return `<div class="bubble ${mine ? 'me' : 'them'}">${escapeHTML(m.text)}</div>`;
      })
      .join('');
    listEl.scrollTop = listEl.scrollHeight;

    listEl.querySelectorAll('.thread-photo.blurred').forEach((img) => {
      img.onclick = () => {
        const idx = Number(img.dataset.idx);
        const message = messages[idx];
        img.classList.remove('blurred');
        img.parentElement.querySelector('.view-once-tag')?.remove();
        setTimeout(() => {
          RoomData.deleteThreadMessage(identity.roomId, message.id);
        }, 6000);
      };
    });
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

  document.getElementById('photo-attach').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const viewOnce = confirm('Send as view-once? It will disappear once opened.\n\nOK = view-once, Cancel = normal photo');
    const compressed = await fileToCompressedBase64(file);
    await RoomData.sendThreadPhoto(identity.roomId, sharedKey, compressed, viewOnce);
    e.target.value = '';
  };
}

// ---------------- Today (Check-in + Play) ----------------
const MOODS = ['😊', '😌', '😴', '😔', '😤', '🥰'];

function renderToday(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">How today felt</div>
      <h2 style="margin-bottom:14px;">Today</h2>
      <div class="segmented">
        <button data-seg="checkin" class="${todaySegment === 'checkin' ? 'active' : ''}">Check-in</button>
        <button data-seg="play" class="${todaySegment === 'play' ? 'active' : ''}">Play</button>
      </div>
      <div id="today-content"></div>
    </div>
  `;
  document.querySelectorAll('.segmented button').forEach((btn) => {
    btn.onclick = () => {
      todaySegment = btn.dataset.seg;
      renderToday(slot);
    };
  });
  if (todaySegment === 'checkin') renderCheckin();
  else renderPlay();
}

function renderCheckin() {
  const content = document.getElementById('today-content');
  content.innerHTML = `
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
    const partnerMoodEl = document.getElementById('partner-mood');
    if (partnerMoodEl) partnerMoodEl.textContent = theirs ? theirs.mood : 'Not shared yet';
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
    if (!grid) return;
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

function renderPlay() {
  const content = document.getElementById('today-content');
  content.innerHTML = `
    <div class="card" style="text-align:center;">
      <div class="eyebrow">Tic-tac-toe</div>
      <div id="game-status" style="margin: 8px 0 14px; font-size:14px; color:var(--text-dim);">Loading…</div>
      <div class="game-board" id="game-board"></div>
      <button class="btn-secondary" id="new-game-btn" style="margin-top:14px;">New game</button>
    </div>
  `;

  if (!identity.partnerUid) {
    document.getElementById('game-status').textContent = 'Pair with your partner first.';
    return;
  }
  const members = memberUidsOf(identity);

  document.getElementById('new-game-btn').onclick = () => {
    startNewGame(identity.roomId, sharedKey, members);
  };

  const unsub = listenGame(identity.roomId, sharedKey, (state) => {
    const boardEl = document.getElementById('game-board');
    const statusEl = document.getElementById('game-status');
    if (!boardEl || !statusEl) return;
    if (!state) {
      statusEl.textContent = 'No game yet — start one.';
      boardEl.innerHTML = '';
      return;
    }
    const myMark = lastKnownUid === state.xUid ? 'X' : 'O';
    if (state.winner === 'draw') statusEl.textContent = "It's a draw.";
    else if (state.winner) statusEl.textContent = state.winner === myMark ? 'You won 🤍' : 'They won this one';
    else statusEl.textContent = state.turnUid === lastKnownUid ? 'Your move' : `Waiting on ${escapeHTML(identity.partnerName || 'them')}`;

    boardEl.innerHTML = state.board
      .map((cell, i) => `<div class="game-cell" data-idx="${i}">${cell || ''}</div>`)
      .join('');
    boardEl.querySelectorAll('.game-cell').forEach((cellEl) => {
      cellEl.onclick = () => makeMove(identity.roomId, sharedKey, state, Number(cellEl.dataset.idx));
    });
  });
  unsubscribers.push(unsub);
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
function iconSettings() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="20" height="20"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1 1.55V21a2 2 0 01-4 0v-.09a1.7 1.7 0 00-1-1.55 1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.7 1.7 0 00.34-1.87 1.7 1.7 0 00-1.55-1H3a2 2 0 010-4h.09a1.7 1.7 0 001.55-1 1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06a1.7 1.7 0 001.87.34H9a1.7 1.7 0 001-1.55V3a2 2 0 014 0v.09a1.7 1.7 0 001 1.55 1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06a1.7 1.7 0 00-.34 1.87V9a1.7 1.7 0 001.55 1H21a2 2 0 010 4h-.09a1.7 1.7 0 00-1.55 1z"/></svg>';
}
function iconPhoto() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" width="20" height="20"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.5"/><path d="M8 5l1.5-2h5L16 5"/></svg>';
}

// ---------------- Photo privacy: blur on background, auto-lock on return ----------------
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('privacy-blur', document.hidden);
  if (document.hidden) {
    lastHiddenAt = Date.now();
  } else if (identity?.pinEnabled && lastHiddenAt && Date.now() - lastHiddenAt > 15000) {
    identity.secretKey = undefined;
    sharedKey = null;
    renderLockScreen();
  }
});
window.addEventListener('blur', () => document.body.classList.add('privacy-blur'));
window.addEventListener('focus', () => document.body.classList.remove('privacy-blur'));

// Catch anything that slips through so the app never just goes blank.
window.addEventListener('error', (e) => {
  if (root.innerHTML.trim() === '') {
    renderFatalError(e.error || new Error(e.message));
  }
});
window.addEventListener('unhandledrejection', (e) => {
  if (root.innerHTML.trim() === '') {
    renderFatalError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)));
  }
});

boot();