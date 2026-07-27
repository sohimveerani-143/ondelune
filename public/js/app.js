import {
  loadIdentity,
  updateIdentity,
  saveIdentity,
  clearIdentity,
  isPaired,
  loadSeen,
  setSeen,
  clearSeen,
} from './store.js';
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
import { app as firebaseApp, ensureSignedIn, tryEnableOfflinePersistence, signOutOfAccount } from './firebase.js';
import { lockIdentityWithPin, unlockIdentityWithPin, needsUnlock } from './applock.js';
import { setUpRecovery, recoverFromEmail } from './auth-recovery.js';
import { listenStreak } from './streak.js';
import {
  renderLoading,
  toast,
  countdownParts,
  pad2,
  relativeTime,
  openLightbox,
  nextMilestone,
  promptModal,
  confirmModal,
} from './ui.js';
import { encryptWithPassphrase, decryptWithPassphrase } from './crypto.js';
import {
  startHeartbeat,
  stopHeartbeat,
  signalTyping,
  clearTyping,
  listenPartnerPresence,
  startGamePresence,
  stopGamePresence,
} from './presence.js';
import * as Game from './game-tictactoe.js';
import {
  notificationsSupported,
  notificationPermission,
  requestNotificationPermission,
  showNotification,
  previewFor,
  initPush,
  pushConfigured,
} from './notify.js';
import { vapidKey } from './firebase-config.js';

const root = document.getElementById('app');
let identity = null;
let sharedKey = null;
let activeTab = 'home';
let unsubscribers = [];
let globalUnsubscribers = [];
let lastKnownUid = null;
let lastHiddenAt = null;
let notifyPrimed = false;
let lastNotifiedId = null;
let markers = {};
let seenCounts = {};

// Which sections roll up into which bottom-nav tab.
const TAB_SECTIONS = {
  thread: ['thread'],
  today: ['today'],
  calendar: ['calendar'],
  list: ['list'],
  more: ['journal', 'letters', 'memories', 'expenses', 'savings', 'game'],
};

// Unread = things THEY added that this device hasn't acknowledged. Your own
// writes bump your own counter, which is never consulted here.
function unreadFor(section) {
  if (!identity?.partnerUid) return 0;
  const theirs = markers[section]?.counts?.[identity.partnerUid] || 0;
  return Math.max(0, theirs - (seenCounts[section] || 0));
}

function unreadForTab(tab) {
  return (TAB_SECTIONS[tab] || []).reduce((sum, s) => sum + unreadFor(s), 0);
}

async function markSectionsSeen(sections) {
  if (!identity?.partnerUid) return;
  let changed = false;
  for (const section of sections) {
    const theirs = markers[section]?.counts?.[identity.partnerUid] || 0;
    if ((seenCounts[section] || 0) !== theirs) {
      seenCounts = await setSeen(section, theirs);
      changed = true;
    }
  }
  if (changed) paintBadges();
}

function badgeHTML(count) {
  if (!count) return '';
  return `<span class="badge">${count > 9 ? '9+' : count}</span>`;
}

function paintBadges() {
  document.querySelectorAll('.nav button').forEach((btn) => {
    const tab = btn.dataset.tab;
    const count = unreadForTab(tab);
    let dot = btn.querySelector('.badge');
    if (!count) {
      if (dot) dot.remove();
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'badge';
      btn.appendChild(dot);
    }
    dot.textContent = count > 9 ? '9+' : String(count);
  });

  // Individual tiles on the More screen, when it's the visible screen.
  const tileMap = {
    'tile-journal': 'journal',
    'tile-letters': 'letters',
    'tile-memories': 'memories',
    'tile-expense': 'expenses',
    'tile-savings': 'savings',
    'tile-game': 'game',
  };
  Object.entries(tileMap).forEach(([id, section]) => {
    const tile = document.getElementById(id);
    if (!tile) return;
    const count = unreadFor(section);
    let dot = tile.querySelector('.badge');
    if (!count) {
      if (dot) dot.remove();
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      dot.className = 'badge tile-badge';
      tile.appendChild(dot);
    }
    dot.textContent = count > 9 ? '9+' : String(count);
  });
}

function clearListeners() {
  unsubscribers.forEach((u) => {
    try {
      u();
    } catch (e) {
      /* a listener that already tore itself down is fine */
    }
  });
  unsubscribers = [];
}

function clearGlobalListeners() {
  globalUnsubscribers.forEach((u) => {
    try {
      u();
    } catch (e) {
      /* ignore */
    }
  });
  globalUnsubscribers = [];
  stopHeartbeat();
}

function memberUidsOf(identity) {
  return [lastKnownUid, identity.partnerUid].sort();
}

function presenceEnabled() {
  return identity?.presenceEnabled !== false; // opt-out, defaults on
}

// ---------------- Boot ----------------
async function boot() {
  try {
    const user = await ensureSignedIn();
    lastKnownUid = user.uid;
    tryEnableOfflinePersistence();

    identity = await loadIdentity();
    seenCounts = await loadSeen();

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

  // Honours the manifest shortcuts (#tab=thread etc.) so a long-press on the
  // installed icon lands where it says it will.
  const tabMatch = window.location.hash.match(/tab=([a-z]+)/);
  if (tabMatch && TAB_SECTIONS[tabMatch[1]]) {
    activeTab = tabMatch[1];
    history.replaceState(null, '', window.location.pathname);
  }

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
          : 'An unexpected error stopped the app from starting.'
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
      <h1 class="wordmark">Tidelight</h1>
      <p class="tagline">Our space. Our time. Always together.</p>
      <p class="lede">
        A quiet, private space for the two of you. Everything here is encrypted before it ever leaves your phone.
      </p>
      <button class="btn-primary" id="new-here-btn">I'm new here</button>
      <button class="btn-secondary" id="recover-btn">I already have an account</button>
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
      <p class="lede">Enter the email and password you set up recovery with.</p>
      <div class="card">
        <input type="email" id="recover-email" placeholder="Email" autocomplete="email" />
        <input type="password" id="recover-password" placeholder="Password" autocomplete="current-password" style="margin-top:8px;" />
      </div>
      <button class="btn-primary" id="recover-submit">Recover</button>
      <div id="recover-error" class="error-text"></div>
      <button class="btn-secondary" id="back-btn">Back</button>
    </div>
  `;
  document.getElementById('back-btn').onclick = () => renderEntryChoice();
  const btn = document.getElementById('recover-submit');
  btn.onclick = async () => {
    const email = document.getElementById('recover-email').value.trim();
    const password = document.getElementById('recover-password').value;
    if (!email || !password) return;
    btn.disabled = true;
    btn.textContent = 'Recovering…';
    try {
      const recovered = await recoverFromEmail(email, password);
      identity = await saveIdentity({ ...recovered, recoveryEmail: email, pending: null });
      continueAfterUnlock();
    } catch (e) {
      document.getElementById('recover-error').textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Recover';
    }
  };
}

// ---------------- Onboarding ----------------
function renderNameStep() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>What should we call you?</h1>
      <div class="card">
        <input type="text" id="name-input" placeholder="Your name" maxlength="30" />
      </div>
      <button class="btn-primary" id="continue-btn">Continue</button>
    </div>
  `;
  const go = () => {
    const name = document.getElementById('name-input').value.trim();
    if (!name) return;
    const kp = generateKeyPair();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    identity = { displayName: name, timezone, publicKey: kp.publicKey, secretKey: kp.secretKey };
    renderGenderStep();
  };
  document.getElementById('continue-btn').onclick = go;
  document.getElementById('name-input').onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
}

const GENDERS = [
  { id: 'woman', label: 'Woman' },
  { id: 'man', label: 'Man' },
  { id: 'nonbinary', label: 'Non-binary' },
  { id: 'unspecified', label: 'Rather not say' },
];

function renderGenderStep() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>How should we draw you?</h1>
      <p class="lede">
        This only shapes the little figure of you standing on the shore on the Home screen.
        It's shared with your person and nobody else.
      </p>
      <div class="choice-list" id="gender-list">
        ${GENDERS.map(
          (g) => `<button class="choice" data-gender="${g.id}">${g.label}</button>`
        ).join('')}
      </div>
    </div>
  `;
  document.querySelectorAll('.choice').forEach((btn) => {
    btn.onclick = () => {
      identity.gender = btn.dataset.gender;
      renderRecoveryChoice();
    };
  });
}

function renderRecoveryChoice() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Don't lose your place</h1>
      <p class="lede">
        By default your identity lives only on this device — if you lose the phone, it's gone for good.
        Setting up recovery lets you restore everything on a new device with just an email and password.
      </p>
      <div class="card">
        <input type="email" id="recovery-email" placeholder="Email" autocomplete="email" />
        <input type="password" id="recovery-password" placeholder="Choose a password" autocomplete="new-password" style="margin-top:8px;" />
      </div>
      <button class="btn-primary" id="setup-recovery-btn">Set up recovery (recommended)</button>
      <button class="btn-secondary" id="skip-recovery-btn">Skip — stay anonymous</button>
      <div id="recovery-error" class="error-text"></div>
    </div>
  `;
  const btn = document.getElementById('setup-recovery-btn');
  btn.onclick = async () => {
    const email = document.getElementById('recovery-email').value.trim();
    const password = document.getElementById('recovery-password').value;
    if (!email || password.length < 6) {
      document.getElementById('recovery-error').textContent =
        'Enter an email and a password of at least 6 characters.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Setting up…';
    try {
      await setUpRecovery(email, password, identity);
      identity.recoveryEmail = email;
      renderPinChoice();
    } catch (e) {
      document.getElementById('recovery-error').textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Set up recovery (recommended)';
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
      <p class="lede">
        A PIN encrypts your key right here on this device, so if someone else picks up your unlocked phone, they still can't get in.
      </p>
      <div class="card">
        <input type="password" inputmode="numeric" pattern="[0-9]*" id="pin-input" placeholder="Choose a 4–6 digit PIN" maxlength="6" />
      </div>
      <button class="btn-primary" id="set-pin-btn">Set PIN (recommended)</button>
      <button class="btn-secondary" id="skip-pin-btn">Skip for now</button>
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
    identity = { ...locked, secretKey: identity.secretKey };
    finishOnboarding();
  };
  document.getElementById('skip-pin-btn').onclick = async () => {
    identity = await saveIdentity({ ...identity, pinEnabled: false });
    finishOnboarding();
  };
}

function finishOnboarding() {
  const urlPairingId = getPairingIdFromUrl();
  if (urlPairingId) renderJoinScreen(urlPairingId);
  else renderPairingHub();
}

// ---------------- Lock screen ----------------
function renderLockScreen() {
  clearListeners();
  clearGlobalListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Welcome back</h1>
      <p class="lede">Enter your PIN to continue.</p>
      <div class="card">
        <input type="password" inputmode="numeric" pattern="[0-9]*" id="unlock-pin" placeholder="PIN" maxlength="6" autofocus />
      </div>
      <button class="btn-primary" id="unlock-btn">Unlock</button>
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
      const err = document.getElementById('unlock-error');
      err.textContent = 'Wrong PIN — try again.';
      document.querySelector('.card').classList.add('shake');
      setTimeout(() => document.querySelector('.card')?.classList.remove('shake'), 450);
    }
  };
  document.getElementById('unlock-btn').onclick = tryUnlock;
  document.getElementById('unlock-pin').onkeydown = (e) => {
    if (e.key === 'Enter') tryUnlock();
  };
}

// ---------------- Pairing ----------------
function renderPairingHub() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Pair with them</h1>
      <p class="lede">
        Make a one-time link and send it however you like. Once they open it, you're quietly connected — for good.
      </p>
      <button class="btn-primary" id="generate-btn">Create pairing link</button>
      <div id="hub-error" class="error-text"></div>
      <button class="btn-ghost" id="have-code-btn">I was given a code</button>
    </div>
  `;
  const btn = document.getElementById('generate-btn');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Creating…';
    document.getElementById('hub-error').textContent = '';
    try {
      const pairingId = await createPairing({
        publicKey: identity.publicKey,
        displayName: identity.displayName,
        timezone: identity.timezone,
      });
      identity = await updateIdentity({ pending: { pairingId } });
      renderWaitingScreen(pairingId);
    } catch (err) {
      // Previously this was an unguarded async onclick — a failure here vanished silently.
      console.error('createPairing failed:', err);
      document.getElementById('hub-error').textContent = `Couldn't create a link: ${err?.message || err}`;
      btn.disabled = false;
      btn.textContent = 'Create pairing link';
    }
  };
  document.getElementById('have-code-btn').onclick = () => renderCodeEntry();
}

// Group the id into readable blocks so it can be typed or read aloud over a call.
function formatCode(id) {
  return String(id).replace(/(.{4})/g, '$1 ').trim();
}

// Fallback path for when a messaging app mangles or strips the link's #fragment —
// which is the most common way a perfectly valid pairing appears "invalid".
function renderCodeEntry() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Enter their code</h1>
      <p class="lede">
        If the link didn't work, ask them to read out the code shown under their link. Spaces don't matter.
      </p>
      <div class="card">
        <input type="text" id="code-input" placeholder="e.g. a1b2 c3d4 e5f6 7890" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </div>
      <button class="btn-primary" id="code-connect">Connect</button>
      <div id="code-error" class="error-text"></div>
      <button class="btn-secondary" id="code-back">Back</button>
    </div>
  `;
  document.getElementById('code-back').onclick = () => renderPairingHub();
  document.getElementById('code-connect').onclick = () => {
    const raw = document.getElementById('code-input').value.replace(/[^a-f0-9]/gi, '').toLowerCase();
    if (!raw) {
      document.getElementById('code-error').textContent = 'Enter the code they gave you.';
      return;
    }
    renderJoinScreen(raw);
  };
}

function renderWaitingScreen(pairingId) {
  clearListeners();
  const link = pairingLinkFor(pairingId);
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark pulse"></div>
      <h1>Waiting for them</h1>
      <p class="lede">Send this link to your person. It only ever works once.</p>
      <div class="pairing-link-box">${escapeHTML(link)}</div>
      <div class="btn-row">
        <button class="btn-secondary" id="copy-btn">Copy link</button>
        <button class="btn-primary" id="share-btn">Share</button>
      </div>
      <div class="card code-card">
        <div class="eyebrow">Or read them this code</div>
        <div class="pair-code">${escapeHTML(formatCode(pairingId))}</div>
        <p class="fine-print">
          Some chat apps break long links. If theirs didn't work, they can tap
          “I was given a code” on their own Pair screen and type this in.
        </p>
      </div>
      <div id="pair-error" class="error-text"></div>
      <button class="btn-ghost" id="cancel-pair-btn">Cancel &amp; start over</button>
    </div>
  `;
  document.getElementById('copy-btn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      document.getElementById('copy-btn').textContent = 'Copied ✓';
    } catch (e) {
      showPairError('Copy failed — long-press the link above to copy it manually.');
    }
  };
  document.getElementById('share-btn').onclick = async () => {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join me on Tidelight', url: link });
      } catch (e) {
        /* cancelled */
      }
    } else {
      try {
        await navigator.clipboard.writeText(link);
        document.getElementById('share-btn').textContent = 'Link copied ✓';
      } catch (e) {
        showPairError('Sharing isn’t supported here — copy the link instead.');
      }
    }
  };
  document.getElementById('cancel-pair-btn').onclick = async () => {
    if (!confirm('Cancel this pairing link and start over? The link you already sent will stop working.')) return;
    clearListeners();
    identity = await updateIdentity({ pending: null });
    renderPairingHub();
  };

  function showPairError(html) {
    const el = document.getElementById('pair-error');
    if (el) el.innerHTML = html;
  }

  let finalizing = false;
  let done = false;

  async function finalize(data) {
    if (done || finalizing) return;
    finalizing = true;
    showPairError('');
    try {
      if (data.creatorUid === data.joinerUid) {
        throw new Error('This link was opened on the same account that created it. Open it on their device instead.');
      }
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
      done = true;
      clearListeners();
      sharedKey = deriveSharedKey(identity.partnerPublicKey, identity.secretKey);
      renderMain();
    } catch (err) {
      console.error('Pairing finalize failed:', err);
      finalizing = false;
      showPairError(
        `They joined, but finishing the connection failed: ${escapeHTML(err?.message || 'unknown error')} ` +
          `<button id="pair-retry-btn" class="btn-secondary" style="margin-top:8px;">Try again</button>`
      );
      const retry = document.getElementById('pair-retry-btn');
      if (retry) retry.onclick = () => finalize(data);
    }
  }

  const unsub = listenForJoin(
    pairingId,
    (data) => finalize(data),
    (err) => {
      console.error('Pairing listener error:', err);
      showPairError(
        `Lost the connection while waiting: ${escapeHTML(err?.message || 'network error')}. ` +
          `It’ll keep retrying — or reopen the app if it stays stuck.`
      );
    }
  );
  unsubscribers.push(unsub);
}

function renderJoinScreen(pairingId) {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Join them</h1>
      <p class="lede">You're about to connect — quietly, and only the two of you will ever be able to read what's shared here.</p>
      <button class="btn-primary" id="join-btn">Connect</button>
      <div id="join-error" class="error-text"></div>
      <button class="btn-ghost" id="join-code-btn">Type a code instead</button>
    </div>
  `;
  document.getElementById('join-code-btn').onclick = () => renderCodeEntry();
  const joinBtn = document.getElementById('join-btn');
  joinBtn.onclick = async () => {
    joinBtn.disabled = true;
    joinBtn.textContent = 'Connecting…';
    document.getElementById('join-error').innerHTML = '';
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
      // Show the exact code we looked up, so a mangled link is instantly obvious
      // by comparing it against what the other person sees on their screen.
      const isMissing = /invalid/i.test(e.message || '');
      document.getElementById('join-error').innerHTML =
        escapeHTML(e.message) +
        (isMissing
          ? `<div class="fine-print" style="margin-top:8px;">Looked for code <strong>${escapeHTML(
              formatCode(pairingId)
            )}</strong>. Check it matches the code on their screen exactly — some chat apps cut long links short.</div>`
          : '');
      joinBtn.disabled = false;
      joinBtn.textContent = 'Connect';
    }
  };
}

// ---------------- Main shell ----------------
function renderMain() {
  clearListeners();
  clearGlobalListeners();
  onSubScreen = false;
  root.innerHTML = `<div id="screen-slot"></div>${navHTML()}`;
  bindNav();
  setUpGlobalListeners();
  renderTab(activeTab);
}

// Registers this device for closed-app push and stores its token so the Cloud
// Function can reach it. No-ops cleanly if push isn't configured or permitted.
function registerForPush() {
  if (!identity?.roomId) return;
  if (notificationPermission() !== 'granted') return;
  initPush(firebaseApp, vapidKey, (token) => RoomData.setPushToken(identity.roomId, token)).catch(() => {});
}

function setUpGlobalListeners() {
  if (!identity?.roomId || !sharedKey) return;

  if (presenceEnabled()) startHeartbeat(identity.roomId);
  registerForPush();

  // Publish gender into the encrypted room profile once, so the partner's hero
  // scene can draw you. Guarded by a local flag to avoid a write per app open.
  if (identity.gender && !identity.genderPublished) {
    RoomData.setMyGender(identity.roomId, sharedKey, identity.gender)
      .then(() => updateIdentity({ genderPublished: true }).then((i) => (identity = i)))
      .catch(() => {
        /* retried on next open */
      });
  }

  // App-wide new-message watcher: powers notifications and the in-app toast no
  // matter which tab you're on. Only ever holds the single newest message.
  notifyPrimed = false;
  const unsub = RoomData.listenLatestMessage(identity.roomId, sharedKey, (message) => {
    if (!message) {
      notifyPrimed = true;
      return;
    }
    if (!notifyPrimed) {
      // First snapshot is existing history, not an arrival — don't announce it.
      notifyPrimed = true;
      lastNotifiedId = message.id;
      return;
    }
    if (message.id === lastNotifiedId) return;
    lastNotifiedId = message.id;
    if (message.senderUid === lastKnownUid) return;

    const { title, body } = previewFor(message, identity.partnerName);
    const lookingAtChat = activeTab === 'thread' && !document.hidden;
    if (!lookingAtChat) {
      showNotification(title, body);
      if (!document.hidden) {
        toast(`<strong>${escapeHTML(title)}</strong> · ${escapeHTML(body)}`, {
          action: {
            label: 'Open',
            onClick: () => {
              activeTab = 'thread';
              renderMain();
            },
          },
        });
      }
    }
  });
  globalUnsubscribers.push(unsub);

  // Nudges get their own watcher so a wordless ping still lands as a
  // notification, and blooms on screen if you're already looking.
  let nudgePrimed = false;
  let lastNudgeId = null;
  const unsubNudge = RoomData.listenLatestNudge(identity.roomId, sharedKey, (nudge) => {
    if (!nudge) {
      nudgePrimed = true;
      return;
    }
    if (!nudgePrimed) {
      nudgePrimed = true;
      lastNudgeId = nudge.id;
      return;
    }
    if (nudge.id === lastNudgeId) return;
    lastNudgeId = nudge.id;
    if (nudge.senderUid === lastKnownUid) return;

    const n = RoomData.nudgeById(nudge.nudgeId);
    const who = identity.partnerName || 'They';
    if (document.hidden) {
      showNotification(who, `${n.emoji} ${n.label}`);
    } else {
      bloomNudge(n.emoji);
      toast(`${n.emoji} <strong>${escapeHTML(who)}</strong> · ${escapeHTML(n.label)}`);
    }
  });
  globalUnsubscribers.push(unsubNudge);
  showMissedNudges();

  // One listener over ~10 tiny counter docs powers every badge in the app.
  const unsubMarkers = RoomData.listenMarkers(identity.roomId, (m) => {
    markers = m;
    paintBadges();
    // The tab you're already looking at shouldn't accumulate a badge — but the
    // 'more' menu is excluded for the same reason as in renderTab().
    if (activeTab !== 'more') markSectionsSeen(TAB_SECTIONS[activeTab] || []);
  });
  globalUnsubscribers.push(unsubMarkers);
}

// Short note that sits on their Home screen. Capped length on purpose — it's a
// line to come back to, not another inbox.
function openNoteEditor(current) {
  const wrap = document.createElement('div');
  wrap.id = 'sheet';
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet">
      <div class="sheet-grabber"></div>
      <div class="sheet-title">A note on their Home screen</div>
      <div class="sheet-form">
        <textarea id="note-input" rows="3" maxlength="${RoomData.NOTE_MAX}" placeholder="Something small to find later…">${escapeHTML(
          current || ''
        )}</textarea>
        <div class="char-count"><span id="note-count">0</span>/${RoomData.NOTE_MAX}</div>
        <button class="btn-primary" id="note-save">Save</button>
        ${current ? '<button class="btn-ghost" id="note-clear">Remove the note</button>' : ''}
        <button class="btn-ghost" data-cancel>Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  setTimeout(() => wrap.classList.add('open'), 0);

  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 200);
  };
  wrap.onclick = (e) => {
    if (e.target === wrap || e.target.hasAttribute('data-cancel')) close();
  };

  const input = wrap.querySelector('#note-input');
  const count = wrap.querySelector('#note-count');
  // maxlength only constrains typing — a paste can exceed it in some browsers,
  // so clamp here as well. (room-data.js also slices, so an over-long note can
  // never reach Firestore regardless of what the UI does.)
  const sync = () => {
    if (input.value.length > RoomData.NOTE_MAX) input.value = input.value.slice(0, RoomData.NOTE_MAX);
    count.textContent = input.value.length;
    count.classList.toggle('at-limit', input.value.length >= RoomData.NOTE_MAX);
  };
  input.oninput = sync;
  sync();
  input.focus();

  wrap.querySelector('#note-save').onclick = async () => {
    const text = input.value.trim();
    close();
    try {
      if (!text) await RoomData.clearMyNote(identity.roomId);
      else await RoomData.setMyNote(identity.roomId, sharedKey, text);
      toast(text ? 'They’ll see it on their Home screen' : 'Note removed');
    } catch (e) {
      toast("Couldn't save that note");
    }
  };
  const clearBtn = wrap.querySelector('#note-clear');
  if (clearBtn)
    clearBtn.onclick = async () => {
      close();
      try {
        await RoomData.clearMyNote(identity.roomId);
        toast('Note removed');
      } catch (e) {
        toast("Couldn't remove that note");
      }
    };
}

// Nudges that landed while the app was closed. Shown once, grouped by kind,
// with how many and when — a nudge means nothing without its timing, and five
// separate notifications would be worse than one honest summary.
async function showMissedNudges() {
  if (!identity?.partnerUid || !sharedKey) return;

  // First run on this device: set a baseline and show nothing, so we don't dump
  // the entire history at someone who just installed.
  const since = seenCounts.__nudgeSeenAt;
  if (!since) {
    seenCounts = await setSeen('__nudgeSeenAt', Date.now());
    return;
  }

  const missed = await RoomData.fetchNudgesSince(identity.roomId, sharedKey, since, identity.partnerUid);
  if (missed.length === 0) {
    // Deliberately does NOT advance the marker. A nudge written moments ago may
    // still have an unresolved serverTimestamp and read as null here; moving the
    // marker to "now" would silently swallow it before it ever surfaced.
    return;
  }
  seenCounts = await setSeen('__nudgeSeenAt', missed[missed.length - 1].createdAt.getTime());

  const groups = new Map();
  for (const n of missed) {
    const g = groups.get(n.nudgeId) || { kind: RoomData.nudgeById(n.nudgeId), times: [] };
    g.times.push(n.createdAt);
    groups.set(n.nudgeId, g);
  }

  const who = escapeHTML(identity.partnerName || 'They');
  const rows = [...groups.values()]
    .map((g) => {
      const last = g.times[g.times.length - 1];
      const when = last.toLocaleString([], {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      const times = g.times.length === 1 ? 'once' : `${g.times.length} times`;
      const all =
        g.times.length > 1
          ? `<div class="nudge-times">${g.times
              .map((t) => escapeHTML(t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))
              .join(' · ')}</div>`
          : '';
      return `<div class="nudge-row">
        <span class="nudge-row-emoji">${g.kind.emoji}</span>
        <div class="grow">
          <div class="nudge-row-label">${escapeHTML(g.kind.label)}</div>
          <div class="row-meta">${times} · last ${escapeHTML(when)}</div>
          ${all}
        </div>
      </div>`;
    })
    .join('');

  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet">
      <div class="sheet-grabber"></div>
      <div class="sheet-title">${who} reached out while you were away</div>
      <div class="sheet-form">
        <div class="nudge-summary">${rows}</div>
        <button class="btn-primary" id="nudge-reply">Open chat</button>
        <button class="btn-ghost" data-cancel>Close</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  setTimeout(() => wrap.classList.add('open'), 0);
  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 200);
  };
  wrap.onclick = (e) => {
    if (e.target === wrap || e.target.hasAttribute('data-cancel')) close();
  };
  wrap.querySelector('#nudge-reply').onclick = () => {
    close();
    activeTab = 'thread';
    renderMain();
  };
}

// A brief full-screen bloom when a nudge arrives — the whole point is that it
// feels like being tapped on the shoulder, not like another notification row.
function bloomNudge(emoji) {
  const el = document.createElement('div');
  el.className = 'nudge-bloom';
  el.textContent = emoji;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

function navHTML() {
  const tabs = [
    { id: 'home', label: 'Home', icon: iconHome() },
    { id: 'thread', label: 'Chat', icon: iconThread() },
    { id: 'today', label: 'Today', icon: iconToday() },
    { id: 'calendar', label: 'Calendar', icon: iconCalendar() },
    { id: 'list', label: 'List', icon: iconList() },
    { id: 'more', label: 'More', icon: iconMore() },
  ];
  return `<nav class="nav">${tabs
    .map(
      (t) =>
        `<button data-tab="${t.id}" class="${t.id === activeTab ? 'active' : ''}" aria-label="${t.label}">${
          t.icon
        }<span>${t.label}</span></button>`
    )
    .join('')}</nav>`;
}

// Sub-screens (Expenses, Journal, the game…) replace the whole root, so they
// need the nav re-attached or you'd be stranded until you found Back.
let onSubScreen = false;

// Called by a sub-screen right after it writes its own markup.
function attachNav() {
  onSubScreen = true;
  root.insertAdjacentHTML('beforeend', navHTML());
  bindNav();
}

function bindNav() {
  document.querySelectorAll('.nav button').forEach((btn) => {
    btn.onclick = () => {
      // Re-render when tapping the current tab from a sub-screen — otherwise the
      // early-return would make the nav look dead from inside Expenses etc.
      if (activeTab === btn.dataset.tab && !onSubScreen) return;
      onSubScreen = false;
      activeTab = btn.dataset.tab;
      document.querySelectorAll('.nav button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderTab(activeTab);
    };
  });
}

function renderTab(tab) {
  clearListeners();
  // 'more' is only a menu — its badge is a roll-up of the screens behind it, so
  // opening the menu must NOT mark those as read. Each sub-screen clears its own
  // section when actually opened, which is what keeps the per-tile badges useful.
  if (tab !== 'more') markSectionsSeen(TAB_SECTIONS[tab] || []);
  const slot = document.getElementById('screen-slot');
  // Coming from a sub-screen, which replaced the whole root: rebuild the shell
  // first, otherwise the nav would appear to do nothing.
  if (!slot) return renderMain();
  setTimeout(paintBadges, 0);
  if (tab === 'home') return renderHome(slot);
  if (tab === 'thread') return renderThread(slot);
  if (tab === 'today') return renderToday(slot);
  if (tab === 'calendar') return renderCalendar(slot);
  if (tab === 'list') return renderBucketList(slot);
  if (tab === 'more') return renderMore(slot);
}

// ---------------- Cinematic hero scene ----------------
// Time-of-day palettes keep the moonlit identity while still shifting through
// the day — the two of you are in different timezones, so the sky moving matters.
function skyPaletteFor(hour) {
  if (hour >= 5 && hour < 8) return { name: 'dawn', top: '#221a3d', mid: '#5d3d63', bot: '#e6a17f', star: 0.35 };
  if (hour >= 8 && hour < 17) return { name: 'day', top: '#2c3a5e', mid: '#4d6485', bot: '#c2ae9f', star: 0.06 };
  if (hour >= 17 && hour < 20) return { name: 'dusk', top: '#1e1838', mid: '#4b2c56', bot: '#e8916f', star: 0.45 };
  return { name: 'night', top: '#120e24', mid: '#281e43', bot: '#5f4258', star: 1 };
}

// Fixed star field — generated once, not per render, so the sky doesn't "jump"
// every time a mood update re-renders the scene.
const STARS = (() => {
  let seed = 7;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: 26 }, () => ({
    x: Math.round(rand() * 400),
    y: Math.round(rand() * 120),
    r: (rand() * 1.1 + 0.5).toFixed(2),
    d: (rand() * 4).toFixed(2),
  }));
})();

// A single silhouette. Rotating the whole group (rather than the body alone)
// keeps the head attached when someone leans, which the old version didn't.
// Sizes are deliberately larger than the first pass — small enough to stay a
// silhouette on the horizon, big enough to actually read as two people.
function figureSVG({ cx, lean = 0, gender = 'unspecified' }) {
  const FILL = '#0d0a1a';
  const cyBody = 192;
  const cyHead = 163;
  const bodyRx = gender === 'man' ? 15.5 : 14;
  const bodyRy = 25;
  const headR = 9;

  // Long hair reads as a distinct silhouette without resorting to caricature.
  const hair =
    gender === 'woman'
      ? `<ellipse cx="${cx}" cy="${cyHead + 5}" rx="${headR + 2.4}" ry="${headR + 2}" fill="${FILL}"/>`
      : '';
  // A slight flare at the hem, again silhouette-only.
  const skirt =
    gender === 'woman'
      ? `<path d="M${cx - bodyRx - 2},${cyBody + 20} Q${cx},${cyBody + 8} ${cx + bodyRx + 2},${
          cyBody + 20
        } Z" fill="${FILL}"/>`
      : '';

  const rot = lean ? ` transform="rotate(${lean} ${cx} ${cyBody + 20})"` : '';
  return `<g${rot}>
    ${skirt}
    <ellipse cx="${cx}" cy="${cyBody}" rx="${bodyRx}" ry="${bodyRy}" fill="${FILL}"/>
    ${hair}
    <circle cx="${cx}" cy="${cyHead}" r="${headR}" fill="${FILL}"/>
  </g>`;
}

function figuresGroupSVG(moodState, genders = {}) {
  // Left figure = you, right = partner, by convention.
  const me = genders.mine || 'unspecified';
  const them = genders.theirs || 'unspecified';

  // Sat right of centre so the pair reads against the lighter water beside the
  // moon's reflection rather than getting lost in the dark middle of it.
  if (moodState === 'meLow') {
    // You lean into them; they stand steady and close.
    return figureSVG({ cx: 206, lean: 13, gender: me }) + figureSVG({ cx: 236, lean: 0, gender: them });
  }
  if (moodState === 'themLow') {
    return figureSVG({ cx: 206, lean: 0, gender: me }) + figureSVG({ cx: 236, lean: -13, gender: them });
  }
  if (moodState === 'bothLow') {
    // Both tip toward each other, shoulders nearly touching.
    return figureSVG({ cx: 211, lean: 9, gender: me }) + figureSVG({ cx: 233, lean: -9, gender: them });
  }
  return figureSVG({ cx: 198, lean: 0, gender: me }) + figureSVG({ cx: 246, lean: 0, gender: them });
}

function heroCaptionFor(moodState) {
  if (moodState === 'meLow') return 'Lean on them a little today.';
  if (moodState === 'themLow') return 'They could use you close today.';
  if (moodState === 'bothLow') return 'A quiet day. You have each other.';
  return 'Two shores, one sky.';
}

function heroSceneSVG(moodState = 'calm', genders = {}) {
  const p = skyPaletteFor(new Date().getHours());
  const stars = STARS.map(
    (s) =>
      `<circle class="hero-star" cx="${s.x}" cy="${s.y}" r="${s.r}" fill="#fdf3dd" style="animation-delay:${s.d}s"/>`
  ).join('');

  return `
  <svg viewBox="0 0 400 220" preserveAspectRatio="xMidYMid slice" data-mood="${moodState}" data-sky="${p.name}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${p.top}"/>
        <stop offset="58%" stop-color="${p.mid}"/>
        <stop offset="100%" stop-color="${p.bot}"/>
      </linearGradient>
      <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${p.mid}"/>
        <stop offset="100%" stop-color="${p.top}"/>
      </linearGradient>
      <radialGradient id="moonGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#fdf1d3" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="#f3d9a8" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="glimmer" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f3d9a8" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="#f3d9a8" stop-opacity="0"/>
      </linearGradient>
      <clipPath id="seaClip"><rect x="0" y="150" width="400" height="70"/></clipPath>
    </defs>

    <rect x="0" y="0" width="400" height="150" fill="url(#sky)"/>
    <g style="opacity:${p.star}">${stars}</g>
    <g class="hero-shooting"><circle cx="0" cy="0" r="1.5" fill="#fff6e2"/><rect x="-16" y="-0.4" width="16" height="0.8" fill="#fff6e2" opacity="0.5"/></g>

    <g class="hero-cloud hero-cloud-a" opacity="0.16">
      <ellipse cx="90" cy="52" rx="42" ry="9" fill="#f7ede0"/>
      <ellipse cx="120" cy="49" rx="28" ry="7" fill="#f7ede0"/>
    </g>
    <g class="hero-cloud hero-cloud-b" opacity="0.11">
      <ellipse cx="300" cy="86" rx="52" ry="8" fill="#f7ede0"/>
    </g>

    <circle cx="200" cy="58" r="52" fill="url(#moonGlow)" class="hero-halo"/>
    <g class="hero-moon">
      <circle cx="200" cy="58" r="22" fill="#f5e0b8"/>
      <circle cx="192" cy="52" r="3.4" fill="#e6cda1" opacity="0.55"/>
      <circle cx="206" cy="64" r="2.6" fill="#e6cda1" opacity="0.45"/>
      <circle cx="203" cy="49" r="1.8" fill="#e6cda1" opacity="0.4"/>
    </g>

    <rect x="0" y="150" width="400" height="70" fill="url(#sea)"/>
    <g clip-path="url(#seaClip)">
      <polygon points="186,150 214,150 232,220 168,220" fill="url(#glimmer)" class="hero-reflection"/>
      <path class="hero-wave hero-wave-1" d="M-40,164 Q10,160 60,164 T160,164 T260,164 T360,164 T460,164 V172 H-40 Z" fill="#0f0b20" opacity="0.28"/>
      <path class="hero-wave hero-wave-2" d="M-40,180 Q20,175 80,180 T200,180 T320,180 T440,180 V190 H-40 Z" fill="#0d0918" opacity="0.34"/>
      <path class="hero-wave hero-wave-3" d="M-40,198 Q30,193 100,198 T240,198 T380,198 T520,198 V214 H-40 Z" fill="#0b0715" opacity="0.4"/>
    </g>

    <path d="M0,150 Q40,146 80,150 T160,150 T240,150 T320,150 T400,150 V156 Q360,152 320,156 T240,156 T160,156 T80,156 T0,156 Z" fill="${p.top}" opacity="0.55"/>
    <g class="hero-figures">${figuresGroupSVG(moodState, genders)}</g>
  </svg>`;
}

// Gentle typewriter for the hero caption — the one place a little theatre suits.
function typeCaption(el, text) {
  if (!el) return null;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = text;
    return null;
  }
  el.textContent = '';
  let i = 0;
  const timer = setInterval(() => {
    el.textContent = text.slice(0, ++i);
    if (i >= text.length) clearInterval(timer);
  }, 34);
  return () => clearInterval(timer);
}

// ---------------- Home (bento) ----------------
function renderHome(slot) {
  slot.innerHTML = `
    <div class="screen">
      <header class="home-head">
        <div class="avatar-stack">
          <div class="avatar-circle mine" id="avatar-mine" title="Tap to change your photo">${escapeHTML(
            (identity.displayName || '?')[0]
          )}</div>
          <div class="avatar-circle theirs" id="avatar-theirs">${escapeHTML(
            (identity.partnerName || '?')[0]
          )}</div>
        </div>
        <div class="home-greet">
          <div class="eyebrow">Tidelight</div>
          <h1>${greetingFor(identity.displayName)}</h1>
        </div>
        <div class="head-actions">
          <button class="btn-icon" id="note-edit-btn" aria-label="Leave a note on their Home screen" title="Leave a note for them">${iconPencil()}</button>
          <button class="btn-icon" id="settings-btn" aria-label="Settings">${iconSettings()}</button>
        </div>
      </header>
      <input type="file" accept="image/*" id="avatar-input" hidden />

      <div class="hero-scene" id="hero-scene">
        ${heroSceneSVG()}
        <div class="hero-caption" id="hero-caption"></div>
      </div>

      <div class="bento">
        <div class="bento-tile span-4 tone-note" id="note-tile">
          <div class="tile-head">${iconNote()}<span class="tile-name">A note from ${escapeHTML(
            identity.partnerName || 'them'
          )}</span></div>
          <div class="note-body" id="note-body">–</div>
        </div>

        <div class="bento-tile span-4 tone-milestone milestone-tile" id="milestone-tile" hidden></div>

        <div class="bento-tile span-4 tone-countdown" id="countdown-tile">
          <div class="tile-head">${iconCalendar()}<span class="tile-name">Next shared moment</span></div>
          <div class="countdown-title" id="countdown-title">Nothing planned yet</div>
          <div class="countdown-clock" id="countdown-clock"></div>
        </div>

        <div class="bento-tile span-2 tone-days">
          <div class="tile-head">${iconHeartSmall()}<span class="tile-name">Together</span></div>
          <div class="stat-number" id="days-together">–</div>
          <div class="stat-caption">days</div>
        </div>

        <div class="bento-tile span-2 tone-streak">
          <div class="tile-head">${iconFlameSmall()}<span class="tile-name">Streak</span></div>
          <div class="stat-number" id="streak-value">–</div>
          <div class="stat-caption">days in a row</div>
        </div>

        <div class="bento-tile span-4 tone-clock clock-tile">
          <div class="clock-side">
            <div class="tile-head">${iconClockSmall()}<span class="tile-name">Your time</span></div>
            <div class="clock-time" id="my-time">--:--</div>
            <div class="clock-meta" id="my-meta"></div>
          </div>
          <div class="clock-divider"></div>
          <div class="clock-side right">
            <div class="tile-name" style="justify-content:flex-end;">${escapeHTML(
              identity.partnerName || 'Them'
            )}</div>
            <div class="clock-time" id="partner-time">--:--</div>
            <div class="clock-meta" id="partner-meta"></div>
          </div>
        </div>

        <div class="bento-tile span-2 tone-mood" id="home-mood-tile">
          <div class="tile-head">${iconToday()}<span class="tile-name">Their mood</span></div>
          <div class="mood-face" id="home-partner-mood">–</div>
        </div>

        <button class="bento-tile span-2 tone-nudge nudge-tile" id="nudge-btn">
          <div class="tile-head">${iconNudge()}<span class="tile-name">Nudge</span></div>
          <div class="nudge-emoji">💭</div>
          <div class="stat-caption">Tap to send</div>
        </button>
      </div>
    </div>
  `;

  document.getElementById('settings-btn').onclick = () => renderSettings();
  document.getElementById('avatar-mine').onclick = () => document.getElementById('avatar-input').click();
  document.getElementById('avatar-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const compressed = await fileToCompressedBase64(file, { maxDim: 300, quality: 0.75 });
      await RoomData.setMyAvatar(identity.roomId, sharedKey, compressed);
      toast('Photo updated');
    } catch (err) {
      toast("Couldn't update that photo");
    }
    e.target.value = '';
  };

  // Hero state lives here so mood changes and gender changes can each repaint
  // it without clobbering the other's contribution.
  const heroGenders = { mine: identity.gender || 'unspecified', theirs: 'unspecified' };
  let heroMoodState = 'calm';

  function repaintHero(retype) {
    const heroEl = document.getElementById('hero-scene');
    if (!heroEl) return;
    heroEl.innerHTML =
      heroSceneSVG(heroMoodState, heroGenders) + `<div class="hero-caption" id="hero-caption"></div>`;
    const caption = document.getElementById('hero-caption');
    if (retype) {
      const stop = typeCaption(caption, heroCaptionFor(heroMoodState));
      if (stop) unsubscribers.push(stop);
    } else {
      caption.textContent = heroCaptionFor(heroMoodState);
    }
  }
  repaintHero(true);

  if (identity.partnerUid) {
    unsubscribers.push(
      RoomData.listenProfiles(identity.roomId, sharedKey, [lastKnownUid, identity.partnerUid], (uid, profile) => {
        const isMine = uid === lastKnownUid;
        const el = document.getElementById(isMine ? 'avatar-mine' : 'avatar-theirs');
        const src = safeMediaSrc(profile.avatar, 'image');
        if (el && src) {
          el.style.backgroundImage = `url("${src}")`;
          el.textContent = '';
        }
        // Their gender arrives over the encrypted profile, so an already-paired
        // couple picks this up without redoing the pairing handshake.
        const key = isMine ? 'mine' : 'theirs';
        const next = profile.gender || (isMine ? identity.gender : null) || 'unspecified';
        if (heroGenders[key] !== next) {
          heroGenders[key] = next;
          repaintHero(true);
        }
      })
    );
  }

  // Dual clocks, with a day/night hint so you can tell at a glance whether
  // it's a decent hour to call.
  function tick() {
    const now = new Date();
    const fmt = (tz) =>
      tz ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '--:--';
    const hourIn = (tz) => {
      if (!tz) return null;
      return Number(now.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: tz }));
    };
    const dayNight = (h) => {
      if (h === null) return '';
      if (h >= 6 && h < 12) return '🌤 morning';
      if (h >= 12 && h < 17) return '☀️ afternoon';
      if (h >= 17 && h < 21) return '🌆 evening';
      return '🌙 night';
    };
    const myEl = document.getElementById('my-time');
    if (!myEl) return;
    myEl.textContent = fmt(identity.timezone);
    document.getElementById('my-meta').textContent = dayNight(hourIn(identity.timezone));
    document.getElementById('partner-time').textContent = fmt(identity.partnerTimezone);
    document.getElementById('partner-meta').textContent = dayNight(hourIn(identity.partnerTimezone));
  }
  tick();
  const clockInterval = setInterval(tick, 20000);
  unsubscribers.push(() => clearInterval(clockInterval));

  // --- Home note: theirs is shown, yours is editable ---
  if (identity.partnerUid) {
    unsubscribers.push(
      RoomData.listenNote(identity.roomId, sharedKey, identity.partnerUid, (note) => {
        const body = document.getElementById('note-body');
        const tile = document.getElementById('note-tile');
        if (!body) return;
        if (note && note.text) {
          body.textContent = note.text;
          body.classList.remove('empty');
          tile?.classList.add('has-note');
        } else {
          body.textContent = `Nothing from ${identity.partnerName || 'them'} yet.`;
          body.classList.add('empty');
          tile?.classList.remove('has-note');
        }
      })
    );
  }
  // Your own note is written from the header icon; the tile shows only theirs.
  let myNote = '';
  unsubscribers.push(
    RoomData.listenNote(identity.roomId, sharedKey, lastKnownUid, (note) => {
      myNote = note?.text || '';
      const btn = document.getElementById('note-edit-btn');
      if (btn) {
        btn.classList.toggle('has-note', !!myNote);
        btn.title = myNote ? 'Edit the note on their Home screen' : 'Leave a note for them';
      }
    })
  );
  document.getElementById('note-edit-btn').onclick = () => openNoteEditor(myNote);

  document.getElementById('nudge-btn').onclick = () => {
    openSheet('Send a nudge', [
      ...RoomData.NUDGES.map((n) => ({
        label: `${n.emoji}  ${n.label}`,
        onClick: () => {
          // Bloom immediately — this is the sender's own confirmation and
          // shouldn't wait on a network round-trip. If the write fails, say so.
          bloomNudge(n.emoji);
          RoomData.sendNudge(identity.roomId, sharedKey, n.id)
            .then(() => toast('Sent'))
            .catch(() => toast("Couldn't send that nudge — check your connection"));
        },
      })),
    ]);
  };

  unsubscribers.push(
    RoomData.listenRoomSettings(identity.roomId, sharedKey, (settings) => {
      const daysEl = document.getElementById('days-together');
      if (!daysEl) return;
      if (!settings.togetherSince) {
        daysEl.textContent = '–';
        return;
      }
      const days = Math.floor((Date.now() - new Date(settings.togetherSince)) / 86400000);
      daysEl.textContent = days >= 0 ? days.toLocaleString() : '–';

      const ms = nextMilestone(settings.togetherSince);
      const tile = document.getElementById('milestone-tile');
      if (tile && ms) {
        tile.hidden = false;
        tile.innerHTML = `
          <div class="eyebrow">Coming up</div>
          <div class="milestone-row">
            <span class="milestone-label">${escapeHTML(ms.label)}</span>
            <span class="milestone-away">${
              ms.daysAway <= 0 ? 'today' : ms.daysAway === 1 ? 'tomorrow' : `in ${ms.daysAway} days`
            }</span>
          </div>`;
      } else if (tile) {
        tile.hidden = true;
      }
    })
  );

  // Live countdown down to the second.
  let nextEvent = null;
  function paintCountdown() {
    const titleEl = document.getElementById('countdown-title');
    const clockEl = document.getElementById('countdown-clock');
    if (!titleEl || !clockEl) return;
    if (!nextEvent) {
      titleEl.textContent = 'Nothing planned yet';
      clockEl.innerHTML = `<span class="countdown-hint">Add something in Calendar</span>`;
      return;
    }
    const c = countdownParts(new Date(nextEvent.dateTime).getTime());
    titleEl.textContent = nextEvent.title;
    clockEl.innerHTML = `
      <div class="cd-unit"><span class="cd-num">${c.days}</span><span class="cd-lbl">days</span></div>
      <div class="cd-sep">:</div>
      <div class="cd-unit"><span class="cd-num">${pad2(c.hours)}</span><span class="cd-lbl">hrs</span></div>
      <div class="cd-sep">:</div>
      <div class="cd-unit"><span class="cd-num">${pad2(c.minutes)}</span><span class="cd-lbl">min</span></div>
      <div class="cd-sep">:</div>
      <div class="cd-unit"><span class="cd-num tick">${pad2(c.seconds)}</span><span class="cd-lbl">sec</span></div>`;
  }
  unsubscribers.push(
    RoomData.listenCalendar(identity.roomId, sharedKey, (events) => {
      nextEvent =
        events
          .filter((e) => new Date(e.dateTime).getTime() > Date.now())
          .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime))[0] || null;
      paintCountdown();
    })
  );
  paintCountdown();
  const cdInterval = setInterval(paintCountdown, 1000);
  unsubscribers.push(() => clearInterval(cdInterval));

  if (identity.partnerUid) {
    unsubscribers.push(
      listenStreak(identity.roomId, memberUidsOf(identity), (streak) => {
        const el = document.getElementById('streak-value');
        if (el) el.innerHTML = streak > 0 ? `${streak} <span class="flame">🔥</span>` : '0';
      })
    );
  }

  // Mood-reactive hero — re-renders the scene and re-types the caption.
  unsubscribers.push(
    RoomData.listenMood(identity.roomId, sharedKey, (entries) => {
      const todayKey = new Date().toISOString().slice(0, 10);
      const mine = entries.find((e) => e.date === todayKey && e.senderUid === lastKnownUid);
      const theirs = entries.find((e) => e.date === todayKey && e.senderUid !== lastKnownUid);
      const myLow = mine && LOW_MOODS.includes(mine.mood);
      const theirLow = theirs && LOW_MOODS.includes(theirs.mood);
      let moodState = 'calm';
      if (myLow && theirLow) moodState = 'bothLow';
      else if (myLow) moodState = 'meLow';
      else if (theirLow) moodState = 'themLow';

      const tile = document.getElementById('home-mood-tile');
      const moodEl = document.getElementById('home-partner-mood');
      if (moodEl) moodEl.textContent = theirs ? theirs.mood : '–';
      if (tile) applyMoodTint(tile, theirs ? theirs.mood : null);

      if (moodState === heroMoodState) return;
      heroMoodState = moodState;
      repaintHero(true);
    })
  );
}

// ---------------- Chat ----------------
let mediaRecorder = null;
let recordedChunks = [];
let recordingStartedAt = null;

// Long-press opens actions, double-tap hearts it — the gestures people already
// know from WhatsApp and Instagram, so no permanent button clutter on bubbles.
function attachBubbleGestures(el, { onLongPress, onDoubleTap }) {
  let timer = null;
  let moved = false;
  let lastTap = 0;
  const start = () => {
    moved = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!moved) {
        el.classList.add('bubble-held');
        setTimeout(() => el.classList.remove('bubble-held'), 200);
        onLongPress();
      }
    }, 480);
  };
  const cancel = () => clearTimeout(timer);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', () => { moved = true; cancel(); }, { passive: true });
  el.addEventListener('touchend', cancel);
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 330) {
      lastTap = 0;
      onDoubleTap();
    } else {
      lastTap = now;
    }
  });
}

function openSheet(title, actions) {
  const existing = document.getElementById('sheet');
  if (existing) existing.remove();
  const wrap = document.createElement('div');
  wrap.id = 'sheet';
  wrap.className = 'sheet-backdrop';
  wrap.innerHTML = `
    <div class="sheet">
      <div class="sheet-grabber"></div>
      ${title ? `<div class="sheet-title">${title}</div>` : ''}
      ${actions
        .map(
          (a, i) =>
            `<button class="sheet-action ${a.danger ? 'danger' : ''}" data-i="${i}">${a.icon || ''}<span>${
              a.label
            }</span></button>`
        )
        .join('')}
      <button class="sheet-action cancel" data-cancel>Cancel</button>
    </div>`;
  document.body.appendChild(wrap);
  // setTimeout, not requestAnimationFrame: rAF is suspended while the page
  // isn't compositing, which would leave the sheet mounted but permanently
  // transformed off-screen. A 0ms timeout still lets the transition run.
  setTimeout(() => wrap.classList.add('open'), 0);
  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 200);
  };
  wrap.onclick = (e) => {
    if (e.target === wrap || e.target.hasAttribute('data-cancel')) close();
  };
  wrap.querySelectorAll('.sheet-action[data-i]').forEach((btn) => {
    btn.onclick = () => {
      close();
      actions[Number(btn.dataset.i)].onClick();
    };
  });
  return close;
}

function renderThread(slot) {
  slot.innerHTML = `
    <div class="chat-shell">
      <header class="chat-header">
        <div class="chat-avatar" id="chat-avatar">${escapeHTML((identity.partnerName || '?')[0])}</div>
        <div class="chat-head-text">
          <div class="chat-name">${escapeHTML(identity.partnerName || 'Them')}</div>
          <div class="chat-status" id="chat-status">&nbsp;</div>
        </div>
        <button class="btn-icon" id="search-btn" aria-label="Search messages">${iconSearch()}</button>
        <div class="chat-lock" title="End-to-end encrypted">${iconLock()}</div>
      </header>

      <div class="search-bar" id="search-bar" hidden>
        <input type="text" id="search-input" placeholder="Search messages…" autocomplete="off" />
        <button class="btn-ghost" id="search-close">Cancel</button>
      </div>

      <div class="thread-list" id="thread-list"></div>

      <div class="typing-row" id="typing-row" hidden>
        <div class="typing-bubble"><span></span><span></span><span></span></div>
      </div>

      <button class="scroll-down" id="scroll-down" hidden aria-label="Jump to latest">${iconChevronDown()}</button>

      <div class="reply-bar" id="reply-bar" hidden>
        <div class="reply-bar-body">
          <div class="reply-bar-who" id="reply-bar-who"></div>
          <div class="reply-bar-text" id="reply-bar-text"></div>
        </div>
        <button class="btn-icon" id="reply-cancel" aria-label="Cancel reply">&times;</button>
      </div>

      <div class="composer">
        <label class="composer-attach" aria-label="Send a photo">
          ${iconPlus()}
          <input type="file" accept="image/*" id="photo-attach" hidden />
        </label>
        <div class="composer-field">
          <textarea id="thread-input" rows="1" placeholder="Message…"></textarea>
        </div>
        <button class="composer-send" id="composer-action" aria-label="Record voice note">${iconMic()}</button>
      </div>
    </div>
  `;

  const listEl = document.getElementById('thread-list');
  const input = document.getElementById('thread-input');
  const actionBtn = document.getElementById('composer-action');
  const scrollBtn = document.getElementById('scroll-down');
  renderLoading(listEl, 'thread', 4);

  let atBottom = true;
  listEl.addEventListener(
    'scroll',
    () => {
      atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 90;
      scrollBtn.hidden = atBottom;
    },
    { passive: true }
  );
  scrollBtn.onclick = () => {
    listEl.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' });
  };

  // Partner presence → header status + typing bubble.
  if (identity.partnerUid) {
    unsubscribers.push(
      listenPartnerPresence(identity.roomId, identity.partnerUid, (p) => {
        const statusEl = document.getElementById('chat-status');
        const typingRow = document.getElementById('typing-row');
        if (!statusEl || !typingRow) return;
        typingRow.hidden = !p.typing;
        if (p.typing) statusEl.innerHTML = '<span class="status-typing">typing…</span>';
        else if (p.online) statusEl.innerHTML = '<span class="status-online">● online</span>';
        else if (p.lastSeen) statusEl.textContent = `last seen ${relativeTime(p.lastSeen)}`;
        else statusEl.innerHTML = '&nbsp;';
        if (p.typing && atBottom) listEl.scrollTop = listEl.scrollHeight;
      })
    );
    unsubscribers.push(
      RoomData.listenProfiles(identity.roomId, sharedKey, [identity.partnerUid], (uid, avatar) => {
        const el = document.getElementById('chat-avatar');
        const src = safeMediaSrc(avatar, 'image');
        if (!el || !src) return;
        el.style.backgroundImage = `url("${src}")`;
        el.textContent = '';
      })
    );
  }

  // --- pagination + search + reply state ---
  const PAGE = 60;
  let threadLimit = PAGE;
  let threadUnsub = null;
  let allMessages = [];
  let reachedStart = false;
  let searchTerm = '';
  let replyingTo = null;
  let firstPaint = true;
  let pendingScrollAnchor = null;
  let lastPaintSignature = null;

  const searchBar = document.getElementById('search-bar');
  const searchInput = document.getElementById('search-input');
  const replyBar = document.getElementById('reply-bar');

  document.getElementById('search-btn').onclick = () => {
    searchBar.hidden = !searchBar.hidden;
    if (!searchBar.hidden) searchInput.focus();
    else {
      searchTerm = '';
      searchInput.value = '';
      paintThread();
    }
  };
  document.getElementById('search-close').onclick = () => {
    searchBar.hidden = true;
    searchTerm = '';
    searchInput.value = '';
    paintThread();
  };
  searchInput.oninput = () => {
    searchTerm = searchInput.value.trim().toLowerCase();
    paintThread();
  };

  document.getElementById('reply-cancel').onclick = () => setReplyTarget(null);

  function setReplyTarget(message) {
    replyingTo = message;
    if (!message) {
      replyBar.hidden = true;
      return;
    }
    replyBar.hidden = false;
    document.getElementById('reply-bar-who').textContent =
      message.senderUid === lastKnownUid ? 'Replying to yourself' : `Replying to ${identity.partnerName || 'them'}`;
    document.getElementById('reply-bar-text').textContent = snippetOf(message);
    document.getElementById('thread-input').focus();
  }

  function subscribeThread() {
    if (threadUnsub) threadUnsub();
    threadUnsub = RoomData.listenThread(
      identity.roomId,
      sharedKey,
      (messages, meta) => {
        allMessages = messages;
        reachedStart = meta.reachedStart;
        paintThread();
      },
      threadLimit
    );
    unsubscribers.push(() => threadUnsub && threadUnsub());
  }

  function paintThread() {
    const messages = allMessages;
    if (messages.length === 0) {
      listEl.innerHTML = `<div class="empty-state">
        <div class="empty-emoji">🌙</div>
        Nothing here yet. Say hello.
      </div>`;
      return;
    }

    // Search mode renders a flat result list instead of the conversation, so the
    // conversation signature no longer describes what's on screen — clear it or
    // returning from search would be skipped as a no-op.
    if (searchTerm) {
      lastPaintSignature = null;
      const hits = messages
        .map((m, idx) => ({ m, idx }))
        .filter(({ m }) => m.type === 'text' && String(m.text || '').toLowerCase().includes(searchTerm));
      if (hits.length === 0) {
        listEl.innerHTML = `<div class="empty-state small">No messages match “${escapeHTML(searchTerm)}”</div>`;
        return;
      }
      listEl.innerHTML =
        `<div class="search-count">${hits.length} result${hits.length === 1 ? '' : 's'}</div>` +
        hits
          .map(
            ({ m, idx }) => `
        <button class="search-hit" data-jump="${idx}">
          <div class="search-hit-who">${
            m.senderUid === lastKnownUid ? 'You' : escapeHTML(identity.partnerName || 'Them')
          } · ${escapeHTML(dayLabel(m.createdAt))}</div>
          <div class="search-hit-text">${highlight(m.text, searchTerm)}</div>
        </button>`
          )
          .join('');
      listEl.querySelectorAll('.search-hit').forEach((btn) => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.jump);
          searchBar.hidden = true;
          searchTerm = '';
          searchInput.value = '';
          paintThread();
          // Done synchronously: innerHTML has already applied, and rAF is
          // suspended whenever the page isn't compositing (hidden tab), which
          // would make the jump silently do nothing.
          const target = listEl.querySelector(`.msg-row[data-idx="${idx}"]`);
          if (target) {
            target.scrollIntoView({ block: 'center' });
            target.classList.add('flash');
            setTimeout(() => target.classList.remove('flash'), 1400);
          }
        };
      });
      return;
    }

    const wasAtBottom = atBottom || firstPaint;

    // Firestore fires a snapshot for every metadata change (a local write, then
    // its server ack). Rebuilding the whole list each time is the single biggest
    // source of chat lag on a low-RAM phone, so skip the rebuild when nothing
    // visible actually changed.
    const signature =
      messages
        .map((m) => `${m.id}:${m.pending ? 1 : 0}:${Object.values(m.reactions || {}).join('')}`)
        .join('|') + `#${reachedStart ? 1 : 0}`;
    if (signature === lastPaintSignature && pendingScrollAnchor === null) return;
    lastPaintSignature = signature;

    const olderBtn = reachedStart
      ? ''
      : `<button class="load-older" id="load-older">Load earlier messages</button>`;
    listEl.innerHTML = olderBtn + messages.map((m, idx) => bubbleHTML(m, idx, messages)).join('');

    const older = document.getElementById('load-older');
    if (older)
      older.onclick = () => {
        const keepHeight = listEl.scrollHeight;
        threadLimit += PAGE;
        older.textContent = 'Loading…';
        // Hold the reading position steady once the taller list paints. A
        // timeout rather than rAF, which is suspended on non-compositing pages.
        pendingScrollAnchor = keepHeight;
        subscribeThread();
      };

      // Gestures + media handlers, bound per paint.
      listEl.querySelectorAll('.bubble').forEach((el) => {
        const idx = Number(el.dataset.idx);
        const message = messages[idx];
        if (!message) return;
        attachBubbleGestures(el, {
          onLongPress: () => openMessageActions(message),
          onDoubleTap: () => quickReact(message),
        });
      });

    listEl.querySelectorAll('.thread-photo.blurred').forEach((img) => {
      img.onclick = () => {
        const message = messages[Number(img.dataset.idx)];
        img.classList.remove('blurred');
        img.closest('.bubble')?.querySelector('.view-once-tag')?.remove();
        setTimeout(() => RoomData.deleteThreadMessage(identity.roomId, message.id), 6000);
      };
    });

    // Normal photos open full-screen with pinch-zoom. View-once photos are
    // excluded on purpose — their first tap is the reveal, and re-opening a
    // photo that's mid-countdown would muddle what "view once" means.
    listEl.querySelectorAll('.thread-photo:not(.blurred)').forEach((img) => {
      img.onclick = () => {
        const message = messages[Number(img.dataset.idx)];
        if (message?.viewOnce) return;
        const src = safeMediaSrc(message?.image, 'image');
        if (src) openLightbox(src);
      };
    });

    listEl.querySelectorAll('.voice-play-btn').forEach((btn) => {
      btn.onclick = (e) => {
        e.stopPropagation();
        const message = messages[Number(btn.dataset.idx)];
        const src = safeMediaSrc(message.audio, 'audio');
        if (!src) return;
        const audio = new Audio(src);
        btn.classList.add('playing');
        audio.onended = () => btn.classList.remove('playing');
        audio.play().catch(() => btn.classList.remove('playing'));
      };
    });

    if (pendingScrollAnchor !== null) {
      // Just loaded older messages — keep the same message under the user's
      // thumb instead of yanking them to the top or bottom.
      listEl.scrollTop = listEl.scrollHeight - pendingScrollAnchor;
      pendingScrollAnchor = null;
      scrollBtn.hidden = atBottom;
    } else if (wasAtBottom) {
      listEl.scrollTop = listEl.scrollHeight;
      scrollBtn.hidden = true;
    } else {
      scrollBtn.hidden = false;
    }
    firstPaint = false;
  }

  subscribeThread();

  function quickReact(message) {
    const reactions = { ...(message.reactions || {}) };
    reactions[lastKnownUid] = reactions[lastKnownUid] === '❤️' ? null : '❤️';
    if (!reactions[lastKnownUid]) delete reactions[lastKnownUid];
    RoomData.setReaction(identity.roomId, sharedKey, message.id, reactions).catch(() =>
      toast("Couldn't save that reaction")
    );
  }

  function openMessageActions(message) {
    const mine = message.senderUid === lastKnownUid;
    const actions = [
      {
        label: 'Reply',
        onClick: () => setReplyTarget(message),
      },
      {
        label: 'React ❤️',
        onClick: () => quickReact(message),
      },
      {
        label: 'Save as memory',
        onClick: async () => {
          await RoomData.pinMessageAsMemory(identity.roomId, sharedKey, message);
          toast('Pinned to Memories');
        },
      },
    ];
    if (message.type === 'text') {
      actions.push({
        label: 'Copy text',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(message.text || '');
            toast('Copied');
          } catch (e) {
            toast("Couldn't copy");
          }
        },
      });
    }
    actions.push({
      label: 'Delete for both of you',
      danger: true,
      onClick: async () => {
        const ok = await confirmModal({
          title: 'Delete this message?',
          body: 'It goes for both of you, permanently. Nothing stays behind on the server.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) RoomData.deleteThreadMessage(identity.roomId, message.id).catch(() => toast("Couldn't delete"));
      },
    });
    openSheet(mine ? 'Your message' : escapeHTML(identity.partnerName || 'Their message'), actions);
  }

  // --- composer ---
  const syncActionButton = () => {
    const hasText = input.value.trim().length > 0;
    actionBtn.classList.toggle('is-send', hasText);
    actionBtn.innerHTML = hasText ? iconSend() : iconMic();
    actionBtn.setAttribute('aria-label', hasText ? 'Send message' : 'Record voice note');
  };
  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  };
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    const replyPayload = replyingTo
      ? { id: replyingTo.id, snippet: snippetOf(replyingTo), senderUid: replyingTo.senderUid }
      : null;
    input.value = '';
    autoGrow();
    syncActionButton();
    setReplyTarget(null);
    if (presenceEnabled()) clearTyping(identity.roomId);
    try {
      await RoomData.sendThreadMessage(identity.roomId, sharedKey, text, replyPayload);
    } catch (e) {
      toast("Message didn't send — check your connection");
      input.value = text;
      autoGrow();
      syncActionButton();
    }
  };

  // Stop-typing is sent explicitly after a short idle, so the partner's
  // indicator disappears when you actually pause rather than lingering until
  // the window lapses (or worse, until you finally send).
  let typingIdleTimer = null;
  input.oninput = () => {
    autoGrow();
    syncActionButton();
    if (!presenceEnabled()) return;
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (input.value.trim()) {
      signalTyping(identity.roomId);
      typingIdleTimer = setTimeout(() => clearTyping(identity.roomId), 1600);
    } else {
      clearTyping(identity.roomId);
    }
  };
  unsubscribers.push(() => {
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    if (presenceEnabled()) clearTyping(identity.roomId);
  });
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };
  syncActionButton();

  actionBtn.onclick = () => {
    if (actionBtn.classList.contains('is-send')) return send();
    toggleRecording(actionBtn);
  };

  document.getElementById('photo-attach').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    // A yes/no dialog reading "OK = view-once, Cancel = normal photo" made the
    // riskier option the default-looking one. Two named choices instead.
    const send = async (viewOnce) => {
      try {
        const compressed = await fileToCompressedBase64(file);
        await RoomData.sendThreadPhoto(identity.roomId, sharedKey, compressed, viewOnce);
      } catch (err) {
        toast("Couldn't send that photo");
      }
    };
    openSheet('Send this photo', [
      { label: 'Send normally', onClick: () => send(false) },
      { label: 'Send as view-once', onClick: () => send(true) },
    ]);
  };
}

function bubbleHTML(m, idx, messages) {
  const mine = m.senderUid === lastKnownUid;
  const prev = messages[idx - 1];
  const next = messages[idx + 1];

  const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
  const divider = newDay ? `<div class="day-divider"><span>${escapeHTML(dayLabel(m.createdAt))}</span></div>` : '';

  // Group consecutive messages from the same person within 5 minutes.
  const GROUP_MS = 5 * 60 * 1000;
  const sameAsPrev =
    !newDay && prev && prev.senderUid === m.senderUid &&
    new Date(m.createdAt) - new Date(prev.createdAt) < GROUP_MS;
  const sameAsNext =
    next && next.senderUid === m.senderUid &&
    new Date(next.createdAt) - new Date(m.createdAt) < GROUP_MS &&
    new Date(next.createdAt).toDateString() === new Date(m.createdAt).toDateString();

  const pos = `${sameAsPrev ? 'grp-mid' : 'grp-first'} ${sameAsNext ? '' : 'grp-last'}`;
  const time = escapeHTML(timeLabel(m.createdAt));
  const meta = sameAsNext
    ? ''
    : `<div class="msg-meta ${mine ? 'right' : ''}">${time}${
        mine ? `<span class="msg-state">${m.pending ? '🕘' : '✓'}</span>` : ''
      }</div>`;

  const rx = Object.values(m.reactions || {}).filter(Boolean);
  const reactionChip = rx.length ? `<div class="reaction-chip">${escapeHTML(rx.join(''))}</div>` : '';

  let inner;
  if (m.type === 'photo') {
    const src = safeMediaSrc(m.image, 'image');
    inner = `
      ${src
        ? `<img src="${src}" class="thread-photo ${m.viewOnce && !mine ? 'blurred' : ''}" data-idx="${idx}" alt="" />`
        : `<div class="media-missing">⚠️ Photo unavailable</div>`}
      ${m.viewOnce ? '<div class="view-once-tag">View once</div>' : ''}`;
  } else if (m.type === 'voice') {
    inner = `
      <button class="voice-play-btn" data-idx="${idx}" aria-label="Play voice note">${iconPlay()}</button>
      <div class="voice-wave">${Array.from({ length: 14 })
        .map((_, i) => `<i style="height:${6 + ((i * 5) % 14)}px"></i>`)
        .join('')}</div>
      <span class="voice-dur">${Math.max(1, Number(m.audioDuration) || 0)}s</span>`;
  } else {
    inner = escapeHTML(m.text);
  }

  const quote = m.replyTo
    ? `<div class="reply-quote">
         <div class="reply-quote-who">${
           m.replyTo.senderUid === lastKnownUid ? 'You' : escapeHTML(identity.partnerName || 'Them')
         }</div>
         <div class="reply-quote-text">${escapeHTML(m.replyTo.snippet || '')}</div>
       </div>`
    : '';

  const typeClass = m.type === 'photo' ? 'photo-bubble' : m.type === 'voice' ? 'voice-bubble' : '';
  return `${divider}
    <div class="msg-row ${mine ? 'mine' : 'theirs'} ${m.pending ? 'is-pending' : ''}" data-idx="${idx}">
      <div class="bubble ${mine ? 'me' : 'them'} ${typeClass} ${pos} ${quote ? 'has-quote' : ''}" data-idx="${idx}">
        ${quote}${inner}${reactionChip}
      </div>
      ${meta}
    </div>`;
}

// One-line description of a message, used for reply quotes.
function snippetOf(m) {
  if (!m) return '';
  if (m.type === 'photo') return '📷 Photo';
  if (m.type === 'voice') return '🎤 Voice note';
  const t = String(m.text || '');
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

// Escapes first, then wraps matches — so the highlight can never inject markup.
function highlight(text, term) {
  const safe = escapeHTML(text);
  if (!term) return safe;
  const safeTerm = escapeHTML(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(`(${safeTerm})`, 'ig'), '<mark>$1</mark>');
}

async function toggleRecording(micBtn) {
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    toast("Voice recording isn't supported in this browser");
    return;
  }
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    recordingStartedAt = Date.now();
    micBtn.classList.add('mic-recording');
    toast('Recording… tap again to send');

    mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      micBtn.classList.remove('mic-recording');
      stream.getTracks().forEach((t) => t.stop());
      const durationSeconds = Math.round((Date.now() - recordingStartedAt) / 1000);
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      if (blob.size > 900 * 1024) {
        toast('That voice note is too long to send — keep it under a minute');
        return;
      }
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        await RoomData.sendThreadVoice(identity.roomId, sharedKey, base64, durationSeconds);
      } catch (e) {
        toast("Voice note didn't send");
      }
    };

    mediaRecorder.start();
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
    }, 60000);
  } catch (e) {
    toast("Couldn't access the microphone — check permissions");
  }
}

// ---------------- Today ----------------
// Colours are muted on purpose — they should read as a mood, not a traffic
// light, and still sit inside the moonlit palette.
const MOODS = [
  { emoji: '😄', label: 'Great', color: '#7fb894' },
  { emoji: '🙂', label: 'Good', color: '#93bfa8' },
  { emoji: '😐', label: 'Okay', color: '#c7b491' },
  { emoji: '😔', label: 'Low', color: '#8b9bc9' },
  { emoji: '😢', label: 'Really low', color: '#a48ac2' },
];
const LOW_MOODS = ['😔', '😢'];

function moodColor(emoji) {
  return MOODS.find((m) => m.emoji === emoji)?.color || null;
}

// Tints a container to match a mood, or clears the tint when there's no mood.
function applyMoodTint(el, emoji) {
  const color = moodColor(emoji);
  if (!color) {
    el.style.removeProperty('--mood');
    el.classList.remove('mood-tinted');
    return;
  }
  el.style.setProperty('--mood', color);
  el.classList.add('mood-tinted');
}

function renderToday(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">How today felt</div>
      <h2 class="screen-title">Today</h2>
      <div class="card" id="your-mood-card">
        <div class="eyebrow">Your mood</div>
        <div class="mood-picker" id="mood-picker">
          ${MOODS.map(
            (m) => `<button class="mood-option" data-mood="${m.emoji}" style="--mood:${m.color}">
              <span class="mood-emoji">${m.emoji}</span>
              <span class="mood-label">${m.label}</span>
            </button>`
          ).join('')}
        </div>
      </div>
      <div class="card" id="partner-mood-card">
        <div class="eyebrow">${escapeHTML(identity.partnerName || 'Their')} mood today</div>
        <div class="mood-face" id="partner-mood">–</div>
      </div>
      <div class="card">
        <div class="eyebrow">A photo from today</div>
        <label class="file-drop" id="photo-drop">
          ${iconPhoto()}<span>Choose a photo</span>
          <input type="file" accept="image/*" id="photo-input" hidden />
        </label>
        <div class="photo-grid" id="photo-grid"></div>
      </div>
    </div>
  `;

  document.querySelectorAll('.mood-option').forEach((el) => {
    el.onclick = async () => {
      el.classList.add('bump');
      setTimeout(() => el.classList.remove('bump'), 320);
      try {
        await RoomData.setTodayMood(identity.roomId, sharedKey, el.dataset.mood);
      } catch (e) {
        toast("Couldn't save your mood");
      }
    };
  });

  unsubscribers.push(
    RoomData.listenMood(identity.roomId, sharedKey, (entries) => {
      const todayKey = new Date().toISOString().slice(0, 10);
      const mine = entries.find((e) => e.date === todayKey && e.senderUid === lastKnownUid);
      const theirs = entries.find((e) => e.date === todayKey && e.senderUid !== lastKnownUid);
      document.querySelectorAll('.mood-option').forEach((el) => {
        el.classList.toggle('selected', !!mine && el.dataset.mood === mine.mood);
      });
      const partnerMoodEl = document.getElementById('partner-mood');
      if (partnerMoodEl) partnerMoodEl.textContent = theirs ? theirs.mood : 'Not shared yet';
      const partnerCard = document.getElementById('partner-mood-card');
      if (partnerCard) applyMoodTint(partnerCard, theirs ? theirs.mood : null);
      const yourCard = document.getElementById('your-mood-card');
      if (yourCard) applyMoodTint(yourCard, mine ? mine.mood : null);
    })
  );

  document.getElementById('photo-input').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const compressed = await fileToCompressedBase64(file);
      await RoomData.setTodayPhoto(identity.roomId, sharedKey, compressed);
      toast('Photo shared');
    } catch (err) {
      toast("Couldn't share that photo");
    }
    e.target.value = '';
  };

  const grid = document.getElementById('photo-grid');
  renderLoading(grid, 'photos', 2);
  unsubscribers.push(
    RoomData.listenPhotos(identity.roomId, sharedKey, (photos) => {
      if (!grid) return;
      const usable = photos.map((p) => ({ ...p, src: safeMediaSrc(p.image, 'image') })).filter((p) => p.src);
      if (usable.length === 0) {
        grid.innerHTML = `<div class="empty-state small">No photos yet</div>`;
        return;
      }
      grid.innerHTML = usable
        .map((p, i) => `<img src="${p.src}" alt="${escapeHTML(p.date || '')}" style="animation-delay:${i * 40}ms" />`)
        .join('');
    })
  );
}

// ---------------- Calendar ----------------
function renderCalendar(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Plans together</div>
      <h2 class="screen-title">Calendar</h2>
      <div class="card">
        <input type="text" id="event-title" placeholder="Event title" />
        <input type="datetime-local" id="event-time" style="margin:8px 0 10px;" />
        <button class="btn-primary" id="add-event">Add event</button>
      </div>
      <div id="event-list"></div>
    </div>
  `;
  document.getElementById('add-event').onclick = async () => {
    const title = document.getElementById('event-title').value.trim();
    const dateTime = document.getElementById('event-time').value;
    if (!title || !dateTime) return;
    try {
      await RoomData.addCalendarEvent(identity.roomId, sharedKey, {
        title,
        dateTime: new Date(dateTime).toISOString(),
      });
      document.getElementById('event-title').value = '';
      document.getElementById('event-time').value = '';
      toast('Event added');
    } catch (e) {
      toast("Couldn't add that event");
    }
  };

  const listEl = document.getElementById('event-list');
  renderLoading(listEl, 'calendar', 3);
  unsubscribers.push(
    RoomData.listenCalendar(identity.roomId, sharedKey, (events) => {
      if (events.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">📅</div>No events yet</div>`;
        return;
      }
      const now = Date.now();
      const upcoming = events.filter((e) => new Date(e.dateTime).getTime() >= now);
      const past = events.filter((e) => new Date(e.dateTime).getTime() < now).reverse();
      const rowsFor = (arr, isPast) =>
        arr
          .map((e, i) => {
            const when = new Date(e.dateTime);
            const away = Math.ceil((when - now) / 86400000);
            const relative = isPast
              ? relativeTime(when)
              : away <= 0
              ? 'today'
              : away === 1
              ? 'tomorrow'
              : `in ${away} days`;
            return `
        <div class="event-row ${isPast ? 'is-past' : 'is-upcoming'}" style="animation-delay:${i * 30}ms">
          <div class="date-chip">
            <span class="date-chip-day">${when.getDate()}</span>
            <span class="date-chip-mon">${when.toLocaleDateString([], { month: 'short' })}</span>
          </div>
          <div class="grow">
            <div class="event-title">${escapeHTML(e.title)}</div>
            <div class="row-meta">${escapeHTML(
              when.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
            )}</div>
          </div>
          <span class="event-when">${escapeHTML(relative)}</span>
        </div>`;
          })
          .join('');
      listEl.innerHTML =
        (upcoming.length
          ? `<div class="eyebrow">Coming up</div><div class="card">${rowsFor(upcoming, false)}</div>`
          : '') +
        (past.length
          ? `<div class="eyebrow" style="margin-top:4px;">Already happened</div>
             <div class="card past-card">${rowsFor(past, true)}</div>`
          : '');
    })
  );
}

// ---------------- Bucket list ----------------
function renderBucketList(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Things to do together</div>
      <h2 class="screen-title">List</h2>
      <div class="card">
        <div class="inline-add">
          <input type="text" id="item-input" placeholder="Add something…" />
          <button class="btn-primary compact" id="add-item">Add</button>
        </div>
      </div>
      <div id="item-list"></div>
    </div>
  `;
  const add = async () => {
    const el = document.getElementById('item-input');
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
    try {
      await RoomData.addBucketItem(identity.roomId, sharedKey, text);
    } catch (e) {
      toast("Couldn't add that");
    }
  };
  document.getElementById('add-item').onclick = add;
  document.getElementById('item-input').onkeydown = (e) => {
    if (e.key === 'Enter') add();
  };

  const listEl = document.getElementById('item-list');
  renderLoading(listEl, 'list', 4);
  unsubscribers.push(
    RoomData.listenBucketList(identity.roomId, sharedKey, (items) => {
      if (items.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">✨</div>Nothing yet — add your first idea</div>`;
        return;
      }
      const done = items.filter((i) => i.done).length;
      listEl.innerHTML = `
        <div class="card">
          <div class="list-progress">
            <div class="progress-track"><div class="progress-fill" style="width:${Math.round(
              (done / items.length) * 100
            )}%"></div></div>
            <div class="stat-caption">${done} of ${items.length} done</div>
          </div>
          ${items
            .map(
              (i, idx) => `
            <div class="list-row tappable" data-idx="${idx}" style="animation-delay:${idx * 25}ms">
              <div class="checkbox ${i.done ? 'done' : ''}">${i.done ? '✓' : ''}</div>
              <div class="grow ${i.done ? 'done-text' : ''}">${escapeHTML(i.text)}</div>
            </div>`
            )
            .join('')}
        </div>`;
      listEl.querySelectorAll('.list-row').forEach((row) => {
        const item = items[Number(row.dataset.idx)];
        row.onclick = () => {
          RoomData.toggleBucketItem(identity.roomId, sharedKey, item.id, item.text, item.done);
        };
      });
    })
  );
}

// ---------------- More ----------------
function renderMore(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Tidelight</div>
      <h2 class="screen-title">More</h2>
      <div class="shortcut-grid">
        ${[
          ['tile-expense', iconExpense(), 'Expenses', 'Shared spending'],
          ['tile-savings', iconSavings(), 'Savings', 'Goals you’re building toward'],
          ['tile-journal', iconJournal(), 'Journal', 'Longer thoughts, shared'],
          ['tile-letters', iconLetter(), 'Letters', 'Written now, opened later'],
          ['tile-game', iconGame(), 'Tic-Tac-Toe', 'Take a turn each'],
          ['tile-memories', iconMemory(), 'Memories', 'Pinned from Chat'],
          ['tile-settings', iconSettings(), 'Settings', 'Security &amp; account'],
        ]
          .map(
            ([id, icon, label, caption], i) => `
          <button class="shortcut-tile" id="${id}" style="animation-delay:${i * 40}ms">
            ${icon}
            <div class="shortcut-tile-label">${label}</div>
            <div class="shortcut-tile-caption">${caption}</div>
          </button>`
          )
          .join('')}
      </div>
    </div>
  `;
  document.getElementById('tile-expense').onclick = () => renderExpenseTracker();
  document.getElementById('tile-savings').onclick = () => renderSavingsTracker();
  document.getElementById('tile-journal').onclick = () => renderJournal();
  document.getElementById('tile-letters').onclick = () => renderLetters();
  document.getElementById('tile-game').onclick = () => renderGame();
  document.getElementById('tile-memories').onclick = () => renderMemories();
  document.getElementById('tile-settings').onclick = () => renderSettings();
}

// ---------------- Tic-Tac-Toe ----------------
function renderGame() {
  clearListeners();
  markSectionsSeen(['game']);
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="game-back" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Take a turn each</div>
          <h2>Tic-Tac-Toe</h2>
        </div>
      </div>

      <div class="card game-status-card">
        <div class="game-status" id="game-status">Setting up…</div>
        <div class="game-scores" id="game-scores"></div>
      </div>

      <div class="game-board" id="game-board"></div>

      <div class="game-actions" id="game-actions"></div>
      <div id="game-notice"></div>
      <p class="fine-print">
        Turn-based, so neither of you has to be here at the same time. The board is encrypted like
        everything else — only the two of you can read it.
      </p>
    </div>
  `;
  attachNav();

  let state = null;
  let partnerAway = false;
  let noticeDismissed = null; // remembers which ended-game notice was closed
  let awayTimer = null;

  const memberUids = memberUidsOf(identity);

  // Faster presence beat while the board is open, so "stepped away" is timely.
  if (presenceEnabled()) startGamePresence(identity.roomId);

  const leaveScreen = () => {
    stopGamePresence(identity.roomId);
    renderMain();
  };
  document.getElementById('game-back').onclick = leaveScreen;
  unsubscribers.push(() => {
    if (awayTimer) clearInterval(awayTimer);
    stopGamePresence(identity.roomId);
  });

  if (identity.partnerUid) {
    unsubscribers.push(
      listenPartnerPresence(identity.roomId, identity.partnerUid, (p) => {
        partnerAway = !p.inGame;
        paint();
      })
    );
    // The "away" verdict depends on elapsed time, so re-evaluate on a timer as
    // well as on snapshots — otherwise a partner who simply stops beating would
    // keep looking present.
    awayTimer = setInterval(paint, 5000);
  }

  unsubscribers.push(
    Game.listenGame(identity.roomId, sharedKey, (s) => {
      state = s;
      paint();
    })
  );

  function nameFor(uid) {
    return uid === lastKnownUid ? 'You' : identity.partnerName || 'They';
  }
  function markFor(uid) {
    if (!state) return '';
    return uid === state.xUid ? 'X' : 'O';
  }

  function paint() {
    const statusEl = document.getElementById('game-status');
    const boardEl = document.getElementById('game-board');
    const actionsEl = document.getElementById('game-actions');
    const scoresEl = document.getElementById('game-scores');
    const noticeEl = document.getElementById('game-notice');
    if (!statusEl || !boardEl) return;

    // --- no game yet ---
    if (!state) {
      statusEl.textContent = 'No game going right now.';
      scoresEl.innerHTML = '';
      boardEl.innerHTML = cellsHTML(Array(9).fill(null), null, true);
      actionsEl.innerHTML = `<button class="btn-primary" id="new-game-btn">Start a game</button>`;
      noticeEl.innerHTML = '';
      document.getElementById('new-game-btn').onclick = async () => {
        try {
          await Game.startNewGame(identity.roomId, sharedKey, memberUids);
        } catch (e) {
          toast("Couldn't start a game");
        }
      };
      return;
    }

    // --- somebody left ---
    if (state.status === 'ended') {
      const byMe = state.endedBy === lastKnownUid;
      statusEl.textContent = byMe ? 'You left the game.' : `${identity.partnerName || 'They'} left the game.`;
      boardEl.innerHTML = cellsHTML(state.board, state.winningLine, true);
      actionsEl.innerHTML = `<button class="btn-primary" id="new-game-btn">Start a new game</button>`;
      if (!byMe && noticeDismissed !== state.endedAt) {
        // The partner-facing popup the brief asked for.
        const endedState = state;
        openSheet(`${escapeHTML(identity.partnerName || 'They')} left the game`, [
          {
            label: 'Start a new game',
            onClick: () =>
              Game.startNewGame(identity.roomId, sharedKey, memberUids, { previous: endedState }).catch(() =>
                toast("Couldn't start a game")
              ),
          },
          { label: 'Back to More', onClick: () => leaveScreen() },
        ]);
        // Marked as seen immediately so tapping the backdrop doesn't re-open it.
        noticeDismissed = state.endedAt;
      }
      document.getElementById('new-game-btn').onclick = () =>
        Game.startNewGame(identity.roomId, sharedKey, memberUids, { previous: state }).catch(() =>
          toast("Couldn't start a game")
        );
      renderScores(scoresEl);
      noticeEl.innerHTML = '';
      return;
    }

    // --- finished round ---
    if (state.status === 'finished') {
      if (state.winner === 'draw') {
        statusEl.textContent = 'A draw.';
      } else {
        const winnerUid = state.winner === 'X' ? state.xUid : state.oUid;
        statusEl.textContent = winnerUid === lastKnownUid ? 'You won 🎉' : `${identity.partnerName || 'They'} won.`;
      }
      boardEl.innerHTML = cellsHTML(state.board, state.winningLine, true);
      actionsEl.innerHTML = `
        <button class="btn-primary" id="new-game-btn">Play again</button>
        <button class="btn-secondary" id="leave-btn">Leave</button>`;
      document.getElementById('new-game-btn').onclick = () =>
        Game.startNewGame(identity.roomId, sharedKey, memberUids, { previous: state }).catch(() =>
          toast("Couldn't start a game")
        );
      document.getElementById('leave-btn').onclick = () => confirmLeave();
      renderScores(scoresEl);
      noticeEl.innerHTML = '';
      return;
    }

    // --- active game ---
    const myTurn = state.turnUid === lastKnownUid;
    statusEl.innerHTML = myTurn
      ? `Your turn <span class="game-mark">${markFor(lastKnownUid)}</span>`
      : `Waiting for ${escapeHTML(identity.partnerName || 'them')} <span class="game-mark">${markFor(
          state.turnUid
        )}</span>`;
    boardEl.innerHTML = cellsHTML(state.board, null, !myTurn);
    actionsEl.innerHTML = `<button class="btn-secondary" id="leave-btn">Leave game</button>`;
    document.getElementById('leave-btn').onclick = () => confirmLeave();
    renderScores(scoresEl);

    // Paused: partner isn't on the board right now. Not an error — they can
    // come back to the same game whenever, so say exactly that.
    noticeEl.innerHTML = partnerAway
      ? `<div class="card game-paused">
           <div class="eyebrow">Paused</div>
           <p class="body-dim">
             ${escapeHTML(identity.partnerName || 'They')} stepped away, so the game is waiting.
             Their turn is saved — they can pick it up any time, and nothing is lost.
           </p>
           <button class="btn-secondary" id="paused-leave-btn" style="margin-top:10px;">Leave the game</button>
         </div>`
      : '';
    const pausedLeave = document.getElementById('paused-leave-btn');
    if (pausedLeave) pausedLeave.onclick = () => confirmLeave();

    boardEl.querySelectorAll('.game-cell').forEach((cell) => {
      cell.onclick = async () => {
        if (!myTurn) return;
        const i = Number(cell.dataset.i);
        if (state.board[i]) return;
        cell.classList.add('placing');
        try {
          await Game.makeMove(identity.roomId, sharedKey, state, i);
        } catch (e) {
          toast("Couldn't make that move");
        }
      };
    });
  }

  function renderScores(el) {
    if (!el || !state) return;
    const s = state.scores || {};
    const mine = s[lastKnownUid] || 0;
    const theirs = s[identity.partnerUid] || 0;
    const draws = s.draws || 0;
    el.innerHTML = `<span>You <strong>${mine}</strong></span>
      <span>${escapeHTML(identity.partnerName || 'They')} <strong>${theirs}</strong></span>
      <span>Draws <strong>${draws}</strong></span>
      <span class="game-round">Round ${state.round || 1}</span>`;
  }

  async function confirmLeave() {
    const ok = await confirmModal({
      title: 'Leave the game?',
      body: `It ends for both of you, and ${escapeHTML(
        identity.partnerName || 'they'
      )} will be told you left. You can start a new one any time.`,
      confirmLabel: 'Leave',
      danger: true,
    });
    if (!ok) return;
    Game.leaveGame(identity.roomId, sharedKey, state)
      .then(() => toast('Game ended'))
      .catch(() => toast("Couldn't leave cleanly"));
  }

  function cellsHTML(board, winningLine, locked) {
    return board
      .map((v, i) => {
        const win = winningLine && winningLine.includes(i);
        return `<button class="game-cell ${v ? 'filled' : ''} ${win ? 'win' : ''} ${
          locked || v ? 'locked' : ''
        }" data-i="${i}" ${locked || v ? 'disabled' : ''}>${v ? `<span>${v}</span>` : ''}</button>`;
      })
      .join('');
  }

  paint();
}

// ---------------- Expenses (with categories) ----------------
function renderExpenseTracker() {
  clearListeners();
  markSectionsSeen(['expenses']);
  let activeCategory = 'All';
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="back-more-btn" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Shared spending</div>
          <h2>Expenses</h2>
        </div>
      </div>

      <div class="card totals-card" id="expense-summary"></div>

      <div class="card">
        <input type="text" id="expense-desc" placeholder="What was it for?" />
        <div class="field-row" style="margin-top:8px;">
          <input type="number" id="expense-amount" inputmode="decimal" placeholder="Amount" />
          <select id="expense-category">
            ${RoomData.EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="eyebrow" style="margin-top:12px;">Whose spending</div>
        <select id="expense-spentby">
          <option value="${lastKnownUid}">Mine</option>
          <option value="${identity.partnerUid || ''}">${escapeHTML(identity.partnerName || 'Theirs')}</option>
        </select>
        <div class="eyebrow" style="margin-top:12px;">When</div>
        <input type="datetime-local" id="expense-at" />
        <button class="btn-primary" id="add-expense-btn" style="margin-top:10px;">Add expense</button>
        <p class="fine-print">
          You can log something for ${escapeHTML(identity.partnerName || 'them')} too — handy when they ask you
          to note it down. The date and time default to now; change them to record something from earlier.
        </p>
      </div>

      <div class="chip-row" id="category-chips"></div>
      <div id="expense-list"></div>
    </div>
  `;
  attachNav();
  document.getElementById('back-more-btn').onclick = () => renderMain();

  const atInput = document.getElementById('expense-at');
  const resetAt = () => {
    // datetime-local wants a local 'YYYY-MM-DDTHH:mm' string, not an ISO UTC one.
    const n = new Date();
    atInput.value = `${n.getFullYear()}-${pad2(n.getMonth() + 1)}-${pad2(n.getDate())}T${pad2(
      n.getHours()
    )}:${pad2(n.getMinutes())}`;
  };
  resetAt();

  document.getElementById('add-expense-btn').onclick = async () => {
    const description = document.getElementById('expense-desc').value.trim();
    const amount = parseFloat(document.getElementById('expense-amount').value);
    const spentBy = document.getElementById('expense-spentby').value;
    const category = document.getElementById('expense-category').value;
    const atRaw = atInput.value;
    if (!description || !amount) return;
    try {
      await RoomData.addExpense(identity.roomId, sharedKey, {
        description,
        amount,
        spentBy,
        category,
        at: atRaw ? new Date(atRaw).toISOString() : new Date().toISOString(),
      });
      document.getElementById('expense-desc').value = '';
      document.getElementById('expense-amount').value = '';
      resetAt();
      toast('Logged');
    } catch (e) {
      toast("Couldn't add that expense");
    }
  };

  const listEl = document.getElementById('expense-list');
  const summaryEl = document.getElementById('expense-summary');
  renderLoading(listEl, 'expenses', 4);
  summaryEl.innerHTML = `<div class="stat-caption">Counting your cash…</div>`;

  let allExpenses = [];

  function paint() {
    const shown = activeCategory === 'All' ? allExpenses : allExpenses.filter((e) => e.category === activeCategory);

    // Totals only — this tracks what each of you spent. There is deliberately no
    // "who owes whom": that's a split-the-bill idea, and this isn't that.
    const sum = (arr) => arr.reduce((s, e) => s + e.amount, 0);
    const mine = allExpenses.filter((e) => e.spentBy === lastKnownUid);
    const theirs = allExpenses.filter((e) => e.spentBy === identity.partnerUid);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const thisMonth = allExpenses.filter((e) => e.at >= startOfMonth);

    summaryEl.innerHTML = `
      <div class="eyebrow">This month</div>
      <div class="totals-headline">${sum(thisMonth).toFixed(2)}</div>
      <div class="totals-split">
        <div class="totals-part">
          <span class="totals-label">You</span>
          <span class="totals-value">${sum(mine.filter((e) => e.at >= startOfMonth)).toFixed(2)}</span>
        </div>
        <div class="totals-part">
          <span class="totals-label">${escapeHTML(identity.partnerName || 'Them')}</span>
          <span class="totals-value">${sum(theirs.filter((e) => e.at >= startOfMonth)).toFixed(2)}</span>
        </div>
      </div>
      <div class="totals-alltime">
        All time — you <strong>${sum(mine).toFixed(2)}</strong> ·
        ${escapeHTML(identity.partnerName || 'them')} <strong>${sum(theirs).toFixed(2)}</strong> ·
        together <strong>${sum(allExpenses).toFixed(2)}</strong>
      </div>`;

    const cats = ['All', ...RoomData.EXPENSE_CATEGORIES.filter((c) => allExpenses.some((e) => e.category === c))];
    const chipRow = document.getElementById('category-chips');
    chipRow.innerHTML = cats
      .map((c) => {
        const total = c === 'All' ? allExpenses.reduce((s, e) => s + e.amount, 0)
                                  : allExpenses.filter((e) => e.category === c).reduce((s, e) => s + e.amount, 0);
        return `<button class="chip ${c === activeCategory ? 'active' : ''}" data-cat="${escapeHTML(c)}">${escapeHTML(
          c
        )} <span class="chip-count">${total.toFixed(0)}</span></button>`;
      })
      .join('');
    chipRow.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        activeCategory = chip.dataset.cat;
        paint();
      };
    });

    if (shown.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">🧾</div>${
        allExpenses.length ? 'Nothing in this category' : 'No expenses logged yet'
      }</div>`;
      return;
    }
    listEl.innerHTML = `<div class="card">${shown
      .map((e, i) => {
        const whose = e.spentBy === lastKnownUid ? 'You' : escapeHTML(identity.partnerName || 'They');
        // Worth surfacing when one of you logged it for the other, so an entry
        // never looks like it appeared out of nowhere.
        const onBehalf =
          e.loggedBy && e.spentBy && e.loggedBy !== e.spentBy
            ? ` · added by ${e.loggedBy === lastKnownUid ? 'you' : escapeHTML(identity.partnerName || 'them')}`
            : '';
        return `
      <div class="money-row" data-id="${e.id}" style="animation-delay:${i * 25}ms">
        <div class="grow">
          <div>${escapeHTML(e.description)}</div>
          <div class="row-meta">
            <span class="whose-chip ${e.spentBy === lastKnownUid ? 'me' : 'them'}">${whose}</span>
            ${escapeHTML(e.category)} · ${escapeHTML(
              e.at.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
            )}${onBehalf}
          </div>
        </div>
        <div class="money-amount">${e.amount.toFixed(2)}</div>
      </div>`;
      })
      .join('')}</div>
      <p class="fine-print">Long-press an entry to remove it.</p>`;

    listEl.querySelectorAll('.money-row').forEach((row) => {
      attachBubbleGestures(row, {
        onLongPress: () =>
          openSheet('Expense', [
            {
              label: 'Delete',
              danger: true,
              onClick: () => RoomData.deleteExpense(identity.roomId, row.dataset.id),
            },
          ]),
        onDoubleTap: () => {},
      });
    });
  }

  unsubscribers.push(
    RoomData.listenExpenses(identity.roomId, sharedKey, (expenses) => {
      allExpenses = expenses;
      paint();
    })
  );
}

// ---------------- Savings (multiple goals) ----------------
function renderSavingsTracker() {
  clearListeners();
  markSectionsSeen(['savings']);
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="back-more-btn" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Saving together</div>
          <h2>Savings</h2>
        </div>
      </div>

      <div id="goals-list"></div>

      <details class="card details-card">
        <summary>New goal</summary>
        <input type="text" id="goal-label" placeholder="e.g. Flight to see ${escapeHTML(
          identity.partnerName || 'them'
        )}" style="margin-top:10px;" />
        <input type="number" id="goal-amount" inputmode="decimal" placeholder="Target amount" style="margin-top:8px;" />
        <button class="btn-primary" id="save-goal-btn" style="margin-top:10px;">Add goal</button>
      </details>

      <details class="card details-card">
        <summary>Add a contribution</summary>
        <input type="text" id="entry-label" placeholder="What's this contribution for?" style="margin-top:10px;" />
        <div class="field-row" style="margin-top:8px;">
          <input type="number" id="entry-amount" inputmode="decimal" placeholder="Amount" />
          <select id="entry-goal"></select>
        </div>
        <button class="btn-primary" id="add-entry-btn" style="margin-top:10px;">Add contribution</button>
      </details>

      <div class="eyebrow" style="margin-top:6px;">Recent contributions</div>
      <div id="savings-list"></div>
    </div>
  `;
  attachNav();
  document.getElementById('back-more-btn').onclick = () => renderMain();

  let goals = [];
  let entries = [];
  let goalsLoaded = false;
  let entriesLoaded = false;

  const goalsEl = document.getElementById('goals-list');
  const listEl = document.getElementById('savings-list');
  renderLoading(goalsEl, 'savings', 2);
  renderLoading(listEl, 'savings', 3);

  document.getElementById('save-goal-btn').onclick = async () => {
    const label = document.getElementById('goal-label').value.trim();
    const target = parseFloat(document.getElementById('goal-amount').value);
    if (!label || !target) return;
    try {
      await RoomData.addSavingsGoal(identity.roomId, sharedKey, { label, target });
      document.getElementById('goal-label').value = '';
      document.getElementById('goal-amount').value = '';
      toast('Goal added');
    } catch (e) {
      toast("Couldn't add that goal");
    }
  };

  document.getElementById('add-entry-btn').onclick = async () => {
    const label = document.getElementById('entry-label').value.trim();
    const amount = parseFloat(document.getElementById('entry-amount').value);
    const goalId = document.getElementById('entry-goal').value || null;
    if (!label || !amount) return;
    try {
      await RoomData.addSavingsEntry(identity.roomId, sharedKey, { label, amount, goalId });
      document.getElementById('entry-label').value = '';
      document.getElementById('entry-amount').value = '';
      toast('Contribution added');
    } catch (e) {
      toast("Couldn't add that contribution");
    }
  };

  function totalFor(goalId) {
    return entries.filter((e) => e.goalId === goalId).reduce((s, e) => s + e.amount, 0);
  }

  function paint() {
    if (!goalsLoaded || !entriesLoaded) return;

    const sel = document.getElementById('entry-goal');
    if (sel) {
      const prev = sel.value;
      sel.innerHTML =
        goals.map((g) => `<option value="${g.id}">${escapeHTML(g.label)}</option>`).join('') +
        `<option value="">Unassigned</option>`;
      if (prev) sel.value = prev;
    }

    if (goals.length === 0) {
      goalsEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">🎯</div>No goals yet — add one below</div>`;
    } else {
      goalsEl.innerHTML = goals
        .map((g, i) => {
          const total = totalFor(g.id);
          const pct = g.target > 0 ? Math.min(100, Math.round((total / g.target) * 100)) : 0;
          const done = g.target > 0 && total >= g.target;
          return `
          <div class="card goal-card ${done ? 'goal-done' : ''}" data-goal="${g.id}" style="animation-delay:${i * 50}ms">
            <div class="goal-head">
              <div class="goal-label">${escapeHTML(g.label)}${done ? ' <span class="goal-badge">reached</span>' : ''}</div>
              <button class="btn-icon subtle" data-goal-menu="${g.id}" aria-label="Goal options">${iconMore()}</button>
            </div>
            <div class="goal-figures"><strong>${total.toFixed(2)}</strong> <span>of ${g.target.toFixed(2)}</span></div>
            <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
            <div class="stat-caption">${pct}% there${
              g.target > total ? ` · ${(g.target - total).toFixed(2)} to go` : ''
            }</div>
          </div>`;
        })
        .join('');

      goalsEl.querySelectorAll('[data-goal-menu]').forEach((btn) => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const id = btn.dataset.goalMenu;
          const goal = goals.find((g) => g.id === id);
          openSheet(escapeHTML(goal?.label || 'Goal'), [
            {
              label: 'Rename / change target',
              onClick: () => editGoal(goal),
            },
            {
              label: 'Delete goal',
              danger: true,
              onClick: () => {
                if (
                  confirm(
                    'Delete this goal? Contributions already logged against it stay in your history, but become unassigned.'
                  )
                ) {
                  RoomData.deleteSavingsGoal(identity.roomId, id);
                }
              },
            },
          ]);
        };
      });
    }

    const unassigned = totalFor(null);
    if (unassigned > 0) {
      goalsEl.innerHTML += `<div class="card subtle-card">
        <div class="eyebrow">Unassigned</div>
        <div class="goal-figures"><strong>${unassigned.toFixed(2)}</strong> <span>not linked to a goal</span></div>
      </div>`;
    }

    if (entries.length === 0) {
      listEl.innerHTML = `<div class="empty-state small">No contributions yet</div>`;
      return;
    }
    listEl.innerHTML = `<div class="card">${entries
      .map((e, i) => {
        const goal = goals.find((g) => g.id === e.goalId);
        return `
      <div class="money-row" data-id="${e.id}" style="animation-delay:${i * 25}ms">
        <div class="grow">
          <div>${escapeHTML(e.label)}</div>
          <div class="row-meta">${
            e.contributedBy === lastKnownUid ? 'You' : escapeHTML(identity.partnerName || 'They')
          } · ${goal ? escapeHTML(goal.label) : 'Unassigned'} · ${escapeHTML(relativeTime(e.createdAt))}</div>
        </div>
        <div class="money-amount">+${e.amount.toFixed(2)}</div>
      </div>`;
      })
      .join('')}</div>
      <p class="fine-print">Long-press a contribution to remove it.</p>`;

    listEl.querySelectorAll('.money-row').forEach((row) => {
      attachBubbleGestures(row, {
        onLongPress: () =>
          openSheet('Contribution', [
            {
              label: 'Delete',
              danger: true,
              onClick: () => RoomData.deleteSavingsEntry(identity.roomId, row.dataset.id),
            },
          ]),
        onDoubleTap: () => {},
      });
    });
  }

  async function editGoal(goal) {
    if (!goal) return;
    const values = await promptModal({
      title: 'Edit goal',
      submitLabel: 'Save goal',
      fields: [
        { name: 'label', label: 'Name', value: goal.label, required: true },
        { name: 'target', label: 'Target amount', type: 'number', inputmode: 'decimal', value: goal.target },
      ],
    });
    if (!values) return;
    RoomData.updateSavingsGoal(identity.roomId, sharedKey, goal.id, {
      label: values.label.trim() || goal.label,
      target: parseFloat(values.target) || goal.target,
    })
      .then(() => toast('Goal updated'))
      .catch(() => toast("Couldn't update that goal"));
  }

  unsubscribers.push(
    RoomData.listenSavingsGoals(identity.roomId, sharedKey, (g) => {
      goals = g;
      goalsLoaded = true;
      paint();
    })
  );
  unsubscribers.push(
    RoomData.listenSavings(identity.roomId, sharedKey, (e) => {
      entries = e;
      entriesLoaded = true;
      paint();
    })
  );
}

// ---------------- Journal ----------------
function renderJournal() {
  clearListeners();
  markSectionsSeen(['journal']);
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="back-more-btn" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Longer thoughts, shared</div>
          <h2>Journal</h2>
        </div>
      </div>
      <div class="card">
        <textarea id="journal-input" rows="4" placeholder="Write something that doesn't fit in a quick message…"></textarea>
        <button class="btn-primary" id="add-journal-btn" style="margin-top:10px;">Save entry</button>
      </div>
      <div id="journal-list"></div>
    </div>
  `;
  attachNav();
  document.getElementById('back-more-btn').onclick = () => renderMain();
  document.getElementById('add-journal-btn').onclick = async () => {
    const el = document.getElementById('journal-input');
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
    try {
      await RoomData.addJournalEntry(identity.roomId, sharedKey, text);
      toast('Saved');
    } catch (e) {
      toast("Couldn't save that entry");
    }
  };

  const listEl = document.getElementById('journal-list');
  renderLoading(listEl, 'journal', 3);
  unsubscribers.push(
    RoomData.listenJournal(identity.roomId, sharedKey, (entries) => {
      if (entries.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">📖</div>No entries yet</div>`;
        return;
      }
      listEl.innerHTML = `<div class="card">${entries
        .map(
          (e, idx) => `
        <div class="journal-entry" style="animation-delay:${idx * 30}ms">
          <div>${escapeHTML(e.text)}</div>
          <div class="row-meta">
            ${e.senderUid === lastKnownUid ? 'You' : escapeHTML(identity.partnerName || 'They')} · ${escapeHTML(
            relativeTime(e.createdAt)
          )}
            ${
              e.senderUid === lastKnownUid
                ? ` · <span class="link-action journal-delete" data-idx="${idx}">delete</span>`
                : ''
            }
          </div>
        </div>`
        )
        .join('')}</div>`;
      listEl.querySelectorAll('.journal-delete').forEach((btn) => {
        btn.onclick = () => {
          const entry = entries[Number(btn.dataset.idx)];
          if (confirm('Delete this journal entry?')) RoomData.deleteJournalEntry(identity.roomId, entry.id);
        };
      });
    })
  );
}

// ---------------- Letters ----------------
function renderLetters() {
  clearListeners();
  markSectionsSeen(['letters']);
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="back-more-btn" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Written now, opened later</div>
          <h2>Letters</h2>
        </div>
      </div>
      <div class="card">
        <textarea id="letter-text" rows="4" placeholder="Write something for them to find later…"></textarea>
        <div class="eyebrow" style="margin-top:10px;">Unlocks on</div>
        <input type="date" id="letter-unlock" style="margin-bottom:10px;" />
        <button class="btn-primary" id="add-letter-btn">Seal it</button>
        <p class="fine-print">
          The date is an honor-system reveal between just the two of you — the letter itself
          stays properly encrypted either way, only the app's own screen won't show the words until then.
        </p>
      </div>
      <div id="letter-list"></div>
    </div>
  `;
  attachNav();
  document.getElementById('back-more-btn').onclick = () => renderMain();
  document.getElementById('add-letter-btn').onclick = async () => {
    const text = document.getElementById('letter-text').value.trim();
    const unlockDate = document.getElementById('letter-unlock').value;
    if (!text || !unlockDate) return;
    try {
      await RoomData.addLetter(identity.roomId, sharedKey, {
        text,
        unlockAt: localMidnightISO(unlockDate),
      });
      document.getElementById('letter-text').value = '';
      document.getElementById('letter-unlock').value = '';
      toast('Sealed');
    } catch (e) {
      toast("Couldn't seal that letter");
    }
  };

  const listEl = document.getElementById('letter-list');
  renderLoading(listEl, 'letters', 3);
  unsubscribers.push(
    RoomData.listenLetters(identity.roomId, sharedKey, (letters) => {
      if (letters.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">✉️</div>No letters yet</div>`;
        return;
      }
      listEl.innerHTML = `<div class="card">${letters
        .map((l, idx) => {
          if (!l.unlocked) {
            const c = countdownParts(new Date(l.unlockAt).getTime());
            return `<div class="letter-row locked" style="animation-delay:${idx * 30}ms">
              <div class="letter-locked">🔒 Sealed until ${new Date(l.unlockAt).toLocaleDateString()}</div>
              <div class="row-meta">${c.days > 0 ? `${c.days} days to go` : 'Opens today'}</div>
            </div>`;
          }
          return `<div class="letter-row" style="animation-delay:${idx * 30}ms">
            <div>${escapeHTML(l.text)}</div>
            <div class="row-meta">
              ${l.senderUid === lastKnownUid ? 'From you' : `From ${escapeHTML(identity.partnerName || 'them')}`}
              ${
                l.senderUid === lastKnownUid
                  ? ` · <span class="link-action letter-delete" data-idx="${idx}">delete</span>`
                  : ''
              }
            </div>
          </div>`;
        })
        .join('')}</div>`;
      listEl.querySelectorAll('.letter-delete').forEach((btn) => {
        btn.onclick = () => {
          const letter = letters[Number(btn.dataset.idx)];
          if (confirm('Delete this letter?')) RoomData.deleteLetter(identity.roomId, letter.id);
        };
      });
    })
  );
}

// ---------------- Memories ----------------
function renderMemories() {
  clearListeners();
  markSectionsSeen(['memories']);
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="back-more-btn" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Pinned from Chat</div>
          <h2>Memories</h2>
        </div>
      </div>
      <div id="memories-list"></div>
    </div>
  `;
  attachNav();
  document.getElementById('back-more-btn').onclick = () => renderMain();

  const listEl = document.getElementById('memories-list');
  renderLoading(listEl, 'memories', 3);
  unsubscribers.push(
    RoomData.listenMemories(identity.roomId, sharedKey, (memories) => {
      if (memories.length === 0) {
        listEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">📌</div>Nothing pinned yet — long-press any message in Chat</div>`;
        return;
      }
      listEl.innerHTML = memories
        .map((m, idx) => {
          let body;
          if (m.type === 'photo') {
            const src = safeMediaSrc(m.image, 'image');
            body = src
              ? `<img src="${src}" class="memory-photo" alt="" />`
              : `<div class="media-missing">⚠️ Photo unavailable</div>`;
          } else if (m.type === 'voice') {
            body = `<div>🎤 Voice note · ${Math.max(1, Number(m.audioDuration) || 0)}s</div>`;
          } else {
            body = `<div class="memory-text">${escapeHTML(m.text)}</div>`;
          }
          return `<div class="card memory-card" style="animation-delay:${idx * 40}ms">
            ${body}
            <div class="row-meta">${escapeHTML(
              m.createdAt.toLocaleDateString()
            )} · <span class="link-action memory-delete" data-idx="${idx}">unpin</span></div>
          </div>`;
        })
        .join('');
      listEl.querySelectorAll('.memory-delete').forEach((btn) => {
        btn.onclick = () => {
          const memory = memories[Number(btn.dataset.idx)];
          RoomData.deleteMemory(identity.roomId, memory.id);
        };
      });
    })
  );
}

// ---------------- Settings ----------------
function renderSettings() {
  clearListeners();
  const perm = notificationPermission();
  const notifyLabel =
    perm === 'granted' ? 'Notifications are on'
    : perm === 'denied' ? 'Blocked in your browser settings'
    : perm === 'unsupported' ? 'Not supported in this browser'
    : 'Not enabled yet';

  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="back-home-btn" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Tidelight</div>
          <h2>Settings</h2>
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">Encryption</div>
        <p class="body-dim">
          Every message, photo, and entry is end-to-end encrypted with a key that's generated on your device
          and never leaves it. Tidelight's servers only ever store unreadable ciphertext.
        </p>
      </div>

      <div class="card">
        <div class="eyebrow">Notifications</div>
        <p class="body-dim">${notifyLabel}.</p>
        <p class="fine-print">
          ${
            pushConfigured(vapidKey)
              ? 'These reach you even when Tidelight is completely closed. The push only ever says that your ' +
                'person reached out — never the message itself. The words stay encrypted on your two devices; ' +
                'the server that sends the push can\'t read them.'
              : 'Right now these are local only: they arrive while Tidelight is open or still running in the ' +
                'background, but not once it\'s fully closed. Closed-app delivery is built and ready — it just ' +
                'needs the one-time push setup finished (see PUSH-SETUP.md).'
          }
        </p>
        ${
          perm === 'default'
            ? '<button class="btn-secondary" id="enable-notify-btn" style="margin-top:10px;">Turn on notifications</button>'
            : ''
        }
      </div>

      <div class="card">
        <div class="eyebrow">Together since</div>
        <p class="body-dim">Sets the day counter and the milestones on your Home screen.</p>
        <input type="date" id="together-since-input" style="margin-top:10px;" />
      </div>

      <div class="card">
        <div class="eyebrow">How you're drawn</div>
        <p class="body-dim">
          Shapes your figure on the shore in the Home scene. Shared with your person only.
        </p>
        <div class="choice-list inline" id="gender-settings">
          ${GENDERS.map(
            (g) =>
              `<button class="choice compact ${
                (identity.gender || 'unspecified') === g.id ? 'active' : ''
              }" data-gender="${g.id}">${g.label}</button>`
          ).join('')}
        </div>
      </div>

      <div class="card">
        <div class="eyebrow">Typing &amp; online status</div>
        <p class="body-dim">${
          presenceEnabled()
            ? 'They can see when you’re online and typing.'
            : 'Your typing and online status are hidden.'
        }</p>
        <p class="fine-print">
          These two signals are stored as plain timestamps, not encrypted content — the same category as the
          message times the app already keeps. The server can see <em>when</em> you're active, never a word of
          <em>what</em> you write. Turn it off and nothing is written at all.
        </p>
        <button class="btn-secondary" id="toggle-presence-btn" style="margin-top:10px;">
          ${presenceEnabled() ? 'Turn off' : 'Turn on'}
        </button>
      </div>

      <div class="card">
        <div class="eyebrow">Network privacy</div>
        <p class="body-dim">
          Tidelight can't change your device's network settings — no website can. What genuinely helps is
          turning on <strong>DNS-over-HTTPS</strong> in your phone or browser, which stops your internet
          provider from seeing which sites you visit as plain text lookups.
        </p>
        <button class="btn-secondary" id="dns-help-btn" style="margin-top:10px;">How to turn this on</button>
      </div>

      <div class="card">
        <div class="eyebrow">App lock</div>
        <p class="body-dim">
          ${identity.pinEnabled ? 'A PIN is protecting this device.' : 'No PIN set — anyone with your unlocked phone can open this app.'}
        </p>
        <button class="btn-secondary" id="toggle-pin-btn" style="margin-top:10px;">${
          identity.pinEnabled ? 'Change PIN' : 'Set a PIN'
        }</button>
      </div>

      <div class="card">
        <div class="eyebrow">Recovery</div>
        <p class="body-dim">
          ${
            identity.recoveryEmail
              ? `Recovery is set up for ${escapeHTML(identity.recoveryEmail)}.`
              : "You're anonymous — losing this device means losing access permanently, with no way to recover."
          }
        </p>
        ${identity.recoveryEmail ? '' : '<button class="btn-secondary" id="setup-recovery-later-btn" style="margin-top:10px;">Set up recovery</button>'}
      </div>

      <div class="card">
        <div class="eyebrow">Photo &amp; message privacy</div>
        <p class="body-dim">
          View-once photos in Chat delete themselves after your partner opens them once. Any message or
          photo either of you deletes is removed from the database entirely — nothing lingers. The app also
          blurs images the instant it's backgrounded, so they can't appear in your phone's recent-apps preview.
          No website can block an actual screenshot — that protection only exists in native apps.
        </p>
      </div>

      <div class="card">
        <div class="eyebrow">Archive</div>
        <p class="body-dim">
          Save a copy of everything — messages, letters, journal, lists, money — as a single file you keep yourself.
        </p>
        <p class="fine-print">
          The file is encrypted with a passphrase you choose, using the same PBKDF2 + AES-GCM as the rest of the app,
          so it's safe to store in cloud backup or email it to yourself. Nobody without that passphrase can read it —
          including you, so don't lose it. Open it again with "Open an archive" below.
        </p>
        <div class="btn-row" style="margin-top:10px;">
          <button class="btn-secondary" id="export-btn">Export</button>
          <button class="btn-secondary" id="open-archive-btn">Open</button>
        </div>
        <input type="file" accept=".json,.tidelight,application/json" id="archive-input" hidden />
      </div>

      <div class="card">
        <div class="eyebrow">Trouble loading?</div>
        <p class="body-dim">
          If screens sit blank, a photo won't save, or something looks half-broken, this device is probably
          holding an old copy of the app.
        </p>
        <p class="fine-print">
          This clears that cached copy and reloads. It touches nothing else — your messages, keys and
          history are untouched, and you stay signed in.
        </p>
        <button class="btn-secondary" id="refresh-app-btn" style="margin-top:10px;">Reload a fresh copy</button>
      </div>

      <div class="card">
        <div class="eyebrow">Log out</div>
        <p class="body-dim">
          ${
            identity.recoveryEmail
              ? 'You can safely log out — sign back in anytime with your recovery email and password to restore everything.'
              : "You haven't set up recovery. Logging out now means permanently losing access to your account and paired room — there is no way back in."
          }
        </p>
        <button class="btn-danger" id="logout-btn" style="margin-top:10px;">Log out</button>
      </div>
    </div>
  `;
  attachNav();

  document.getElementById('back-home-btn').onclick = () => renderMain();
  document.getElementById('toggle-pin-btn').onclick = () => renderPinChoiceFromSettings();
  document.getElementById('logout-btn').onclick = () => handleLogout();
  document.getElementById('dns-help-btn').onclick = () => renderDnsHelp();

  const notifyBtn = document.getElementById('enable-notify-btn');
  if (notifyBtn)
    notifyBtn.onclick = async () => {
      const result = await requestNotificationPermission();
      if (result === 'granted') {
        showNotification('Tidelight', 'Notifications are on. This is what they’ll look like.');
        toast('Notifications enabled');
        // Now that permission exists, register this device for closed-app push.
        registerForPush();
      } else if (result === 'denied') {
        toast('Blocked — you can re-enable them in browser settings');
      }
      renderSettings();
    };

  document.getElementById('toggle-presence-btn').onclick = async () => {
    const next = !presenceEnabled();
    identity = await updateIdentity({ presenceEnabled: next });
    if (next) startHeartbeat(identity.roomId);
    else {
      stopHeartbeat();
      clearTyping(identity.roomId);
    }
    renderSettings();
  };

  const sinceInput = document.getElementById('together-since-input');
  unsubscribers.push(
    RoomData.listenRoomSettings(identity.roomId, sharedKey, (settings) => {
      if (settings.togetherSince && document.activeElement !== sinceInput) {
        sinceInput.value = settings.togetherSince;
      }
    })
  );
  sinceInput.onchange = async () => {
    if (!sinceInput.value) return;
    try {
      await RoomData.setTogetherSince(identity.roomId, sharedKey, sinceInput.value);
      toast('Saved');
    } catch (e) {
      toast("Couldn't save that date");
    }
  };

  document.querySelectorAll('#gender-settings .choice').forEach((btn) => {
    btn.onclick = async () => {
      const gender = btn.dataset.gender;
      identity = await updateIdentity({ gender, genderPublished: false });
      try {
        await RoomData.setMyGender(identity.roomId, sharedKey, gender);
        identity = await updateIdentity({ genderPublished: true });
        toast('Updated');
      } catch (e) {
        toast("Saved here, but couldn't share it yet");
      }
      renderSettings();
    };
  });

  document.getElementById('refresh-app-btn').onclick = async () => {
    const btn = document.getElementById('refresh-app-btn');
    btn.disabled = true;
    btn.textContent = 'Clearing…';
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) {
      /* reload anyway — a failed clear is still worth a fresh load */
    }
    // Cache-busted so the reload can't be answered from memory cache either.
    window.location.replace(window.location.pathname + '?fresh=' + Date.now());
  };

  document.getElementById('export-btn').onclick = () => handleExportArchive();
  document.getElementById('open-archive-btn').onclick = () =>
    document.getElementById('archive-input').click();
  document.getElementById('archive-input').onchange = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) handleOpenArchive(file);
  };

  const recoveryBtn = document.getElementById('setup-recovery-later-btn');
  if (recoveryBtn) recoveryBtn.onclick = () => renderRecoverySetupFromSettings();
}

async function handleExportArchive() {
  const values = await promptModal({
    title: 'Protect this archive',
    note:
      'There is no way to recover this passphrase. If you lose it, the file is unreadable forever — including by us.',
    submitLabel: 'Export',
    fields: [
      {
        name: 'passphrase',
        label: 'Passphrase',
        type: 'password',
        placeholder: 'At least 8 characters',
        required: true,
        minLength: 8,
      },
    ],
  });
  if (!values) return;
  const passphrase = values.passphrase;
  const btn = document.getElementById('export-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Packing…';
  }
  try {
    const archive = await RoomData.buildRoomArchive(identity.roomId, sharedKey);
    // Encrypted before it ever becomes a Blob — plaintext never reaches disk.
    const sealed = await encryptWithPassphrase(archive, passphrase);
    const payload = JSON.stringify({ format: 'tidelight-archive-encrypted', version: 1, ...sealed });
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tidelight-archive-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    const c = archive.counts;
    toast(`Archived ${c.messages} messages, ${c.letters} letters, ${c.journal} journal entries`);
  } catch (e) {
    console.error('Export failed:', e);
    toast("Couldn't build the archive");
  }
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Export';
  }
}

async function handleOpenArchive(file) {
  const values = await promptModal({
    title: 'Open archive',
    submitLabel: 'Open',
    fields: [{ name: 'passphrase', label: 'Passphrase', type: 'password', required: true }],
  });
  if (!values) return;
  const passphrase = values.passphrase;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (parsed.format !== 'tidelight-archive-encrypted') {
      throw new Error("That doesn't look like a Tidelight archive.");
    }
    const archive = await decryptWithPassphrase(parsed, passphrase);
    renderArchiveViewer(archive);
  } catch (e) {
    const wrongPass = /operation-specific reason|decrypt|OperationError/i.test(e?.message || '') || e?.name === 'OperationError';
    toast(wrongPass ? 'Wrong passphrase, or the file is damaged' : e.message || "Couldn't open that archive");
  }
}

function renderArchiveViewer(archive) {
  clearListeners();
  const c = archive.counts || {};
  const section = (title, items, render) =>
    !items || items.length === 0
      ? ''
      : `<div class="eyebrow" style="margin-top:14px;">${title}</div>
         <div class="card">${items.map(render).join('')}</div>`;

  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="archive-back" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Archive</div>
          <h2>${escapeHTML(new Date(archive.exportedAt).toLocaleDateString())}</h2>
        </div>
      </div>
      <div class="card">
        <p class="body-dim">
          Read-only view of an exported archive. Nothing here is connected to your live room —
          closing this screen discards it.
        </p>
        <div class="archive-counts">
          ${Object.entries(c)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `<span><strong>${n}</strong> ${escapeHTML(k)}</span>`)
            .join('')}
        </div>
      </div>

      ${section('Messages', (archive.thread || []).filter((m) => m.type === 'text' || !m.type), (m) =>
        `<div class="journal-entry"><div>${escapeHTML(m.text || '')}</div>
         <div class="row-meta">${m.senderUid === lastKnownUid ? 'You' : escapeHTML(identity.partnerName || 'Them')}${
          m.createdAt ? ' · ' + escapeHTML(new Date(m.createdAt).toLocaleString()) : ''
        }</div></div>`
      )}
      ${section('Letters', archive.letters, (l) =>
        `<div class="letter-row"><div>${escapeHTML(l.text || '')}</div></div>`
      )}
      ${section('Journal', archive.journal, (j) =>
        `<div class="journal-entry"><div>${escapeHTML(j.text || '')}</div>
         <div class="row-meta">${j.createdAt ? escapeHTML(new Date(j.createdAt).toLocaleDateString()) : ''}</div></div>`
      )}
      ${section('List', archive.bucketlist, (i) =>
        `<div class="list-row"><div class="checkbox ${i.done ? 'done' : ''}">${i.done ? '✓' : ''}</div>
         <div class="grow ${i.done ? 'done-text' : ''}">${escapeHTML(i.text || '')}</div></div>`
      )}
      ${section('Events', archive.calendar, (e) =>
        `<div class="list-row"><div class="grow">${escapeHTML(e.title || '')}
         <div class="row-meta">${e.dateTime ? escapeHTML(new Date(e.dateTime).toLocaleString()) : ''}</div></div></div>`
      )}
      ${section('Expenses', archive.expenses, (e) =>
        `<div class="money-row"><div class="grow">${escapeHTML(e.description || '')}
         <div class="row-meta">${escapeHTML(e.category || 'General')}</div></div>
         <div class="money-amount">${Number(e.amount || 0).toFixed(2)}</div></div>`
      )}
      ${section('Savings', archive.savings, (s) =>
        `<div class="money-row"><div class="grow">${escapeHTML(s.label || '')}</div>
         <div class="money-amount">+${Number(s.amount || 0).toFixed(2)}</div></div>`
      )}
    </div>`;
  attachNav();
  document.getElementById('archive-back').onclick = () => renderSettings();
}

function renderDnsHelp() {
  clearListeners();
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="back-settings-btn" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Network privacy</div>
          <h2>DNS-over-HTTPS</h2>
        </div>
      </div>
      <div class="card">
        <div class="eyebrow">Android</div>
        <p class="body-dim">
          Settings → Network &amp; internet → Private DNS → choose "Private DNS provider hostname" →
          enter <strong>dns.google</strong> or <strong>1dot1dot1dot1.cloudflare-dns.com</strong>.
        </p>
      </div>
      <div class="card">
        <div class="eyebrow">Chrome browser</div>
        <p class="body-dim">
          Settings → Privacy and security → Security → "Use secure DNS" → pick a provider from the list.
        </p>
      </div>
      <div class="card">
        <div class="eyebrow">What this does — and doesn't do</div>
        <p class="body-dim">
          It stops your local network or ISP from seeing plain-text records of which domains you look up.
          It does not hide the destination IP address itself from a sufficiently resourced network operator,
          and it doesn't change what Tidelight already protects with encryption. Think of it as one more
          honest layer, not a cloak of invisibility.
        </p>
      </div>
    </div>
  `;
  attachNav();
  document.getElementById('back-settings-btn').onclick = () => renderSettings();
}

async function handleLogout() {
  const confirmed = identity.recoveryEmail
    ? confirm('Log out of Tidelight on this device? You can sign back in with your recovery email and password.')
    : confirm(
        "You haven't set up recovery. Logging out now will PERMANENTLY delete access to your account and paired room on this device — there is no way to undo this.\n\nAre you absolutely sure you want to log out?"
      );
  if (!confirmed) return;

  // Stop pushing to a device that's signing out. Best-effort and before the
  // room id is gone from local identity.
  if (identity?.roomId) await RoomData.clearPushToken(identity.roomId);

  clearListeners();
  clearGlobalListeners();
  await clearIdentity();
  await clearSeen();
  try {
    await signOutOfAccount();
  } catch (e) {
    /* local identity already wiped — reload regardless */
  }
  window.location.reload();
}

function renderPinChoiceFromSettings() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Set a PIN</h1>
      <div class="card">
        <input type="password" inputmode="numeric" pattern="[0-9]*" id="pin-input" placeholder="4–6 digit PIN" maxlength="6" />
      </div>
      <button class="btn-primary" id="save-pin-btn">Save</button>
      <div id="pin-error" class="error-text"></div>
      <button class="btn-secondary" id="cancel-btn">Cancel</button>
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
    const locked = await lockIdentityWithPin(identity, pin);
    identity = await saveIdentity(locked);
    identity.secretKey = plaintextSecretKey; // memory only, never persisted
    toast('PIN saved');
    renderSettings();
  };
}

function renderRecoverySetupFromSettings() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Set up recovery</h1>
      <div class="card">
        <input type="email" id="recovery-email" placeholder="Email" autocomplete="email" />
        <input type="password" id="recovery-password" placeholder="Choose a password" autocomplete="new-password" style="margin-top:8px;" />
      </div>
      <button class="btn-primary" id="save-recovery-btn">Save</button>
      <div id="recovery-error" class="error-text"></div>
      <button class="btn-secondary" id="cancel-btn">Cancel</button>
    </div>
  `;
  document.getElementById('cancel-btn').onclick = () => renderSettings();
  const btn = document.getElementById('save-recovery-btn');
  btn.onclick = async () => {
    const email = document.getElementById('recovery-email').value.trim();
    const password = document.getElementById('recovery-password').value;
    if (!email || password.length < 6) {
      document.getElementById('recovery-error').textContent =
        'Enter an email and a password of at least 6 characters.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await setUpRecovery(email, password, identity);
      identity = await updateIdentity({ recoveryEmail: email });
      toast('Recovery is set up');
      renderSettings();
    } catch (e) {
      document.getElementById('recovery-error').textContent = e.message;
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  };
}

// ---------------- Utilities ----------------
function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Defense-in-depth: content is E2E-encrypted between two trusted people, but we
// still never trust a decrypted blob to be a well-formed data: URL.
function safeMediaSrc(value, kind = 'image') {
  const s = String(value ?? '');
  const re =
    kind === 'audio'
      ? /^data:audio\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i
      : /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i;
  return re.test(s) ? s : '';
}

// `new Date('2026-07-27')` is parsed as UTC midnight, which in Karachi is 5am
// and in Kolkata 5:30am — so "opens on the 27th" was opening late. Building the
// date part-by-part gives midnight in the writer's OWN timezone, which is what
// "right when the day starts" means to the person picking the date.
function localMidnightISO(yyyyMmDd) {
  const [y, m, d] = String(yyyyMmDd).split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function dayLabel(date) {
  const d = new Date(date);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeLabel(date) {
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function greetingFor(name) {
  const h = new Date().getHours();
  const part =
    h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night';
  return `${part}, ${escapeHTML(name)}`;
}

// ---------------- Icons ----------------
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
function iconMore() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>';
}
function iconExpense() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.2c0 3 6 1.4 6 4.3 0 1.3-1.3 2.5-3 2.5s-3-1.1-3-2.5"/></svg>';
}
function iconSavings() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 12a8 8 0 1116 0 8 8 0 01-16 0z"/><path d="M12 8v4l3 2"/></svg>';
}
function iconJournal() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 4h9a2 2 0 012 2v14l-4-2-4 2-4-2-2 2V6a2 2 0 012-2z"/><path d="M9 9h6M9 13h4"/></svg>';
}
function iconMic() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" width="20" height="20"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/></svg>';
}
function iconSend() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" width="19" height="19"><path d="M3.4 20.4l17.5-8.4a.7.7 0 000-1.3L3.4 2.3a.7.7 0 00-1 .8L4.6 10l9.4 2-9.4 2-2.2 6.9a.7.7 0 001 .8z"/></svg>';
}
function iconPlus() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" width="20" height="20"><path d="M12 5v14M5 12h14"/></svg>';
}
function iconPlay() {
  return '<svg viewBox="0 0 24 24" fill="currentColor" width="13" height="13"><path d="M7 5l12 7-12 7z"/></svg>';
}
function iconLetter() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>';
}
function iconMemory() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 21s-7-4.4-9.5-8.8C.7 8.4 2.6 5 6 5c2 0 3.3 1 4 2 0.7-1 2-2 4-2 3.4 0 5.3 3.4 3.5 7.2C19 16.6 12 21 12 21z"/></svg>';
}
function iconLock() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" width="14" height="14"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>';
}
function iconChevronLeft() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" width="20" height="20"><path d="M15 5l-7 7 7 7"/></svg>';
}
function iconNote() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 5h16v10l-4 4H4z"/><path d="M8 10h8M8 14h4"/></svg>';
}
function iconPencil() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="13" height="13"><path d="M4 20h4L20 8l-4-4L4 16z"/></svg>';
}
function iconHeartSmall() {
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20s-6.5-4-8.5-8C1.8 8.6 3.6 5.5 6.8 5.5c1.8 0 3 .9 3.7 1.8.7-.9 1.9-1.8 3.7-1.8 3.2 0 5 3.1 3.3 6.5-2 4-8.5 8-8.5 8z"/></svg>';
}
function iconFlameSmall() {
  return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c2 4-1 5-1 7a3 3 0 006 0c0 5-3 7-5 7s-6-2-6-7c0-4 4-5 6-7z"/></svg>';
}
function iconClockSmall() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
}
function iconNudge() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M18 8a6 6 0 10-12 0c0 4-2 5-2 5h16s-2-1-2-5z"/><path d="M10.5 21a2 2 0 003 0"/></svg>';
}
function iconGame() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>';
}
function iconSearch() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" width="19" height="19"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>';
}
function iconChevronDown() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" width="18" height="18"><path d="M5 9l7 7 7-7"/></svg>';
}

// ---------------- Connection state ----------------
// Firestore queues writes while offline and flushes them on reconnect, so this
// is reassurance rather than an error: it tells you why a message is sitting on
// "sending" without implying anything was lost.
function paintOfflineBanner() {
  const existing = document.getElementById('offline-banner');
  if (navigator.onLine) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const el = document.createElement('div');
  el.id = 'offline-banner';
  el.className = 'offline-banner';
  el.setAttribute('role', 'status');
  el.textContent = 'Offline — anything you write is saved and will send when you reconnect.';
  document.body.appendChild(el);
}
window.addEventListener('online', () => {
  paintOfflineBanner();
  toast('Back online');
});
window.addEventListener('offline', paintOfflineBanner);

// ---------------- Privacy: blur on background, auto-lock on return ----------------
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('privacy-blur', document.hidden);
  if (document.hidden) {
    lastHiddenAt = Date.now();
    if (identity?.roomId && presenceEnabled()) {
      clearTyping(identity.roomId);
      // Leaving the app pauses any game immediately, rather than making the
      // partner wait out a timeout to learn you stepped away.
      stopGamePresence(identity.roomId);
    }
  } else if (identity?.pinEnabled && lastHiddenAt && Date.now() - lastHiddenAt > 15000) {
    identity.secretKey = undefined;
    sharedKey = null;
    clearGlobalListeners();
    renderLockScreen();
  }

  // Coming back to a game already on screen resumes the fast beat, which tells
  // the partner you're present again without them doing anything.
  if (!document.hidden && identity?.roomId && presenceEnabled() && document.getElementById('game-board')) {
    startGamePresence(identity.roomId);
  }
});
window.addEventListener('blur', () => document.body.classList.add('privacy-blur'));
window.addEventListener('focus', () => document.body.classList.remove('privacy-blur'));

// Catch anything that slips through so the app never just goes blank.
window.addEventListener('error', (e) => {
  if (root.innerHTML.trim() === '') renderFatalError(e.error || new Error(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  if (root.innerHTML.trim() === '') {
    renderFatalError(e.reason instanceof Error ? e.reason : new Error(String(e.reason)));
  }
});

// A data listener dying used to leave a screen stuck on its skeleton with no
// explanation. Now it says so and offers the one action that actually helps.
let dataErrorToastAt = 0;
RoomData.setDataErrorHandler(({ label }) => {
  // Offline is already explained by the banner; don't pile on.
  if (!navigator.onLine) return;
  const now = Date.now();
  if (now - dataErrorToastAt < 6000) return; // one message, not one per listener
  dataErrorToastAt = now;
  toast(`Couldn't load ${escapeHTML(label)}.`, {
    duration: 8000,
    action: {
      label: 'Retry',
      onClick: () => {
        if (isPaired(identity) && sharedKey) renderMain();
        else window.location.reload();
      },
    },
  });
});

paintOfflineBanner();
boot();
