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
import { generateKeyPair, deriveSharedKey, boxKeyFromB64 } from './crypto.js';
import {
  pairingLinkFor,
  getPairingIdFromUrl,
  createPairing,
  listenForJoin,
  finalizeRoomAsCreator,
  joinPairing,
} from './pairing.js';
import * as RoomData from './room-data.js';
import * as Ludo from './ludo.js';
import * as LudoRules from './ludo-rules.js';
import { fileToCompressedBase64 } from './image-utils.js';
import {
  app as firebaseApp,
  ensureSignedIn,
  currentUserOrNull,
  tryEnableOfflinePersistence,
  signOutOfAccount,
} from './firebase.js';
import { lockIdentityWithPin, unlockIdentityWithPin, needsUnlock } from './applock.js';
import { setUpRecovery, recoverFromEmail, refreshBackup } from './auth-recovery.js';
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
  markSeenNow,
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
    // Identity first, because whether we may create an account at all depends
    // on whether this device already belongs to a room.
    identity = await loadIdentity();
    seenCounts = await loadSeen();

    // A Ludo link is answered before anything else. Whoever opened it may be a
    // complete stranger to this app — they must not be walked through pairing,
    // and a paired user must not be dumped on the home screen instead of the
    // game they just tapped.
    const ludoInvite = Ludo.ludoInviteFromUrl();

    // currentUserOrNull waits for Firebase to finish restoring the saved
    // session, so a null here genuinely means "no session", not "not yet".
    let user = await currentUserOrNull();

    if (ludoInvite && (!identity || !identity.displayName)) {
      await ensureSignedIn();
      lastKnownUid = (await currentUserOrNull()).uid;
      tryEnableOfflinePersistence();
      return renderLudoGuest(ludoInvite);
    }

    if (!user && identity?.roomId) {
      // Signing in anonymously at this point would mint a NEW account and lock
      // this device out of its own room — history intact on screen, every write
      // refused by the server. Whatever went wrong, creating an account is
      // never the right repair, so stop and explain instead.
      return renderSessionLostScreen();
    }
    if (!user) user = await ensureSignedIn();
    lastKnownUid = user.uid;
    tryEnableOfflinePersistence();

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
    // Someone already set up opening a Ludo link goes straight to the table.
    const ludoInvite = Ludo.ludoInviteFromUrl();
    if (ludoInvite) {
      return renderLudo({ ...ludoInvite, key: boxKeyFromB64(ludoInvite.keyB64) });
    }
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

// Shown when this device is paired but has no Firebase session at all — the
// browser cleared its storage, or an old build swapped the account out. The one
// thing this screen must never do is quietly make a new account, which is what
// used to happen and what left the app writing into a room it no longer belonged to.
function renderSessionLostScreen() {
  clearListeners();
  const hasRecovery = !!identity?.recoveryEmail;
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Signed out</h1>
      <p class="lede">
        Everything on this device — your keys, your history, your person — is still here and still yours.
        The sign-in to the server is what went missing, and nothing can save until it's back.
      </p>
      <div class="card">
        <p class="body-dim">
          ${
            hasRecovery
              ? `Sign back in as <strong>${escapeHTML(identity.recoveryEmail)}</strong> and everything reconnects exactly as it was.`
              : 'Recovery was never set up on this device, so there is no password to sign back in with. Your partner can re-admit this device from theirs — open Settings → Connection check on their phone.'
          }
        </p>
      </div>
      ${hasRecovery ? '<button class="btn-primary" id="lost-recover-btn">Sign in with recovery</button>' : ''}
      <button class="btn-secondary" id="lost-readmit-btn">My partner will re-admit me</button>
      <div id="lost-error" class="error-text"></div>
    </div>
  `;
  const recoverBtn = document.getElementById('lost-recover-btn');
  if (recoverBtn) recoverBtn.onclick = () => renderRecoverStep();
  document.getElementById('lost-readmit-btn').onclick = async () => {
    // Needs *an* account to have a uid to hand over. Safe here only because the
    // user has explicitly chosen the re-admit path over recovery.
    try {
      const u = await ensureSignedIn();
      lastKnownUid = u.uid;
      renderReadmitCode();
    } catch (e) {
      document.getElementById('lost-error').textContent = e?.message || 'Could not reach the server.';
    }
  };
}

// Side one of the repair: the locked-out device shows the account id it now has.
// Nothing secret is on this screen — a uid grants nothing on its own, and the
// partner still has to accept it on their device.
function renderReadmitCode() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Read this to them</h1>
      <p class="lede">
        On their phone: <strong>Settings → Connection check → Re-admit a device</strong>.
        They type in this code and you're back — nothing is lost.
      </p>
      <div class="card">
        <div class="eyebrow">This device's code</div>
        <div class="readmit-code" id="readmit-code">${escapeHTML(lastKnownUid || '')}</div>
        <button class="btn-secondary compact" id="copy-code-btn" style="margin-top:10px;">Copy</button>
      </div>
      <div class="card">
        <p class="body-dim" id="readmit-status">Waiting for them to accept…</p>
      </div>
      <button class="btn-secondary" id="readmit-back">Back</button>
    </div>
  `;
  document.getElementById('readmit-back').onclick = () => renderSessionLostScreen();
  document.getElementById('copy-code-btn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(lastKnownUid || '');
      toast('Code copied');
    } catch (e) {
      toast('Select the code and copy it manually');
    }
  };

  // Polled, not listened to: a non-member's listener is refused outright, so
  // there is no snapshot to wait on until the moment membership actually lands.
  const poll = setInterval(async () => {
    if (!identity?.roomId) return;
    const ok = await RoomData.amIAMember(identity.roomId);
    if (!ok) return;
    clearInterval(poll);
    const statusEl = document.getElementById('readmit-status');
    if (statusEl) statusEl.textContent = 'Accepted — reconnecting…';
    await healPartnerUid();
    identity = await updateIdentity({ myUid: lastKnownUid });
    continueAfterUnlock();
  }, 3000);
  unsubscribers.push(() => clearInterval(poll));
}

// Side two: the healthy device accepts. Guarded by a typed confirmation because
// this hands an account full access to everything in the room.
function renderReadmitEnter() {
  clearListeners();
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="readmit-back" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Repair</div>
          <h2>Re-admit a device</h2>
        </div>
      </div>
      <div class="card">
        <p class="body-dim">
          Only do this if ${escapeHTML(identity?.partnerName || 'your partner')} is asking you to, and you are sure it is them.
          It gives the account below full access to everything in your room.
        </p>
      </div>
      <div class="card">
        <input type="text" id="readmit-input" placeholder="Paste their code" autocomplete="off" spellcheck="false" />
      </div>
      <button class="btn-primary" id="readmit-submit">Re-admit</button>
      <div id="readmit-error" class="error-text"></div>
    </div>
  `;
  attachNav();
  document.getElementById('readmit-back').onclick = () => renderConnectionCheck();
  const btn = document.getElementById('readmit-submit');
  btn.onclick = async () => {
    const freshUid = document.getElementById('readmit-input').value.trim();
    const errEl = document.getElementById('readmit-error');
    errEl.textContent = '';
    if (freshUid.length < 20) {
      errEl.textContent = 'That does not look like a full code. Ask them to copy it again.';
      return;
    }
    if (freshUid === lastKnownUid) {
      errEl.textContent = 'That is this device’s own code, not theirs.';
      return;
    }
    if (!confirm(`Give this account access to everything in your room?\n\n${freshUid}\n\nOnly continue if ${identity?.partnerName || 'your partner'} just read it out to you.`)) return;
    btn.disabled = true;
    btn.textContent = 'Re-admitting…';
    try {
      await RoomData.readmitMember(identity.roomId, identity.partnerUid, freshUid);
      identity = await updateIdentity({ partnerUid: freshUid });
      await refreshRecoveryBackup();
      membershipBroken = false;
      toast('Done — their device should reconnect in a moment');
      renderConnectionCheck();
    } catch (e) {
      errEl.textContent = e?.message || 'Could not update the room.';
      btn.disabled = false;
      btn.textContent = 'Re-admit';
    }
  };
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
      // Merge over whatever is already here rather than replacing wholesale —
      // a backup written by an older version may be missing newer fields, and
      // a blind overwrite would drop anything this device already knew.
      const existing = (await loadIdentity()) || {};
      const merged = { ...existing, ...recovered, recoveryEmail: email, pending: null };
      // Never let a null from an old backup overwrite a real local value.
      for (const k of Object.keys(recovered)) {
        if (recovered[k] == null && existing[k] != null) merged[k] = existing[k];
      }
      lastKnownUid = (await ensureSignedIn()).uid;
      merged.myUid = lastKnownUid;
      identity = await saveIdentity(merged);
      await healPartnerUid();
      // A backup taken before pairing carries no room. If this device already
      // knew one, that knowledge is now the better copy — write it back.
      await refreshRecoveryBackup();
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
      const backupKey = await setUpRecovery(email, password, identity);
      identity.recoveryEmail = email;
      identity.backupKey = backupKey;
      identity.myUid = lastKnownUid;
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
        myUid: lastKnownUid,
        pending: null,
      });
      done = true;
      clearListeners();
      sharedKey = deriveSharedKey(identity.partnerPublicKey, identity.secretKey);
      // The room and partner only exist as of this line. Any backup written
      // before now describes an unpaired device, so it has to be rewritten.
      await refreshRecoveryBackup();
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
        myUid: result.myUid,
        pending: null,
      });
      sharedKey = deriveSharedKey(identity.partnerPublicKey, identity.secretKey);
      history.replaceState(null, '', window.location.pathname);
      // As above: this is the first moment there is a room to back up.
      await refreshRecoveryBackup();
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

// Verifies once, on open, that this device is still one of the room's two
// members. If it isn't, every single write will be refused by the server — and
// without this check the only symptom is a generic error on each action, which
// is exactly how "the other person can't send anything" presents. Better to say
// so plainly, once, than to let them discover it one failure at a time.
let membershipBroken = false;

// The room already knows both accounts, so a missing partnerUid can simply be
// read back off it — no re-pairing, no data loss. This matters because early
// recovery backups omitted partnerUid entirely, leaving otherwise-healthy
// devices half-broken: history visible, but presence, badges, streak, avatars
// and the game all silently dead.
// Keeps the cloud backup in step with what this device actually knows. Silent
// and best-effort on purpose — it runs after pairing and after a membership
// repair, and neither of those should fail because a backup write did.
async function refreshRecoveryBackup() {
  try {
    return await refreshBackup(identity);
  } catch (e) {
    return false;
  }
}

async function healPartnerUid() {
  if (!identity?.roomId || !lastKnownUid || identity.partnerUid) return false;
  try {
    const { doc: fbDoc, getDoc: fbGetDoc, db: fbDb } = await import('./firebase.js');
    const snap = await fbGetDoc(fbDoc(fbDb, 'rooms', identity.roomId));
    if (!snap.exists()) return false;
    const members = snap.data().memberUids || [];
    const partner = members.find((u) => u && u !== lastKnownUid);
    if (!partner) return false;
    identity = await updateIdentity({ partnerUid: partner });
    return true;
  } catch (e) {
    return false;
  }
}

async function verifyRoomMembership() {
  if (!identity?.roomId || !lastKnownUid) return;
  await healPartnerUid();
  const warn = () => {
    membershipBroken = true;
    toast('This device is signed in to a different account than the one you paired with, so nothing it sends can save.', {
      duration: 14000,
      action: { label: 'What to do', onClick: () => renderConnectionCheck() },
    });
  };
  try {
    const { doc: fbDoc, getDoc: fbGetDoc, db: fbDb } = await import('./firebase.js');
    const snap = await fbGetDoc(fbDoc(fbDb, 'rooms', identity.roomId));
    if (!snap.exists()) return; // reported in full by the connection check
    const members = snap.data().memberUids || [];
    if (members.includes(lastKnownUid)) {
      membershipBroken = false;
      return;
    }
    warn();
  } catch (e) {
    // A refused READ is itself the answer: the rules only allow members to read
    // the room, so permission-denied here proves this account isn't one. Being
    // silent about it was what made the failure look like a mystery.
    if (e?.code === 'permission-denied') warn();
  }
}

function setUpGlobalListeners() {
  if (!identity?.roomId || !sharedKey) return;

  if (presenceEnabled()) startHeartbeat(identity.roomId);
  registerForPush();
  verifyRoomMembership();

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

// Rain, shown only when one of you is low. Fixed set so it doesn't reshuffle on
// every repaint; staggered delays and varied lengths keep it from looking like
// a marching grid.
const RAINDROPS = (() => {
  let seed = 31;
  const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  return Array.from({ length: 34 }, () => ({
    x: Math.round(rand() * 430) - 15,
    len: (rand() * 7 + 5).toFixed(1),
    d: (rand() * 1.1).toFixed(2),
    dur: (rand() * 0.5 + 0.85).toFixed(2),
    o: (rand() * 0.28 + 0.16).toFixed(2),
  }));
})();

function rainLayerSVG() {
  return `<g class="hero-rain">${RAINDROPS.map(
    (r) =>
      `<line x1="${r.x}" y1="-12" x2="${r.x - 3}" y2="${-12 + Number(r.len)}"
         stroke="#cdd6e8" stroke-width="0.8" stroke-linecap="round" opacity="${r.o}"
         style="animation-delay:${r.d}s; animation-duration:${r.dur}s"/>`
  ).join('')}</g>`;
}

// A single silhouette. Rotating the whole group (rather than the body alone)
// keeps the head attached when someone leans, which the old version didn't.
// Sizes are deliberately larger than the first pass — small enough to stay a
// silhouette on the horizon, big enough to actually read as two people.
// A standing person drawn as one continuous silhouette path: shoulders, a torso
// that tapers to the waist, hips, and two legs with a gap between them.
//
// The previous version was an ellipse with a circle balanced on it, which read
// exactly like an egg — and it "leaned" by rotating the entire shape about a
// point below the feet, so the whole body swung sideways like a metronome
// instead of bending. Here the feet stay planted and `lean` displaces only the
// hips, shoulders and head, which is what leaning on someone actually looks
// like. `lean` is roughly -1..1; positive leans right.
// Two people sitting on the sand, seen from behind, watching the water.
//
// Deliberately NOT anatomical. Realistic proportions read as stiff and clinical
// at this size; cute reads as warm, which is the whole point of the app. So the
// head is oversized (~35% of the seated height), every form is rounded, and
// there isn't a straight line anywhere. Cross-legged knees poke out at the base.
function figureSVG({ cx, ground = 206, lean = 0, gender = 'unspecified' }) {
  const FILL = '#080610';
  const RIM = 'rgba(243,217,168,0.40)';

  const baseW = gender === 'man' ? 13.6 : 12.4; // half-width where they meet the sand
  const shoulderW = baseW * 0.64;
  const bodyH = 24;
  const headR = 7.4;

  // Leaning tips the head most, shoulders a little, and lets the head settle
  // downward — a head coming to rest on a shoulder, not sliding sideways.
  const hx = lean * 5.4;
  const sx = lean * 1.9;
  const headDrop = Math.abs(lean) * 2.4;

  const shoulderY = ground - bodyH;
  const headY = shoulderY - headR + 2.6 + headDrop;

  // One soft bell shape: hips wide on the sand, narrowing to rounded shoulders.
  const body = [
    `M${cx - baseW},${ground}`,
    `C${cx - baseW - 0.6},${ground - bodyH * 0.48} ${cx - shoulderW - 1.6 + sx},${ground - bodyH * 0.83} ${
      cx - shoulderW + sx
    },${shoulderY}`,
    `Q${cx + sx},${shoulderY - 3.4} ${cx + shoulderW + sx},${shoulderY}`,
    `C${cx + shoulderW + 1.6 + sx},${ground - bodyH * 0.83} ${cx + baseW + 0.6},${ground - bodyH * 0.48} ${
      cx + baseW
    },${ground}`,
    'Z',
  ].join(' ');

  // Long hair: a rounded fall behind the head, following the lean.
  const hair =
    gender === 'woman'
      ? `<path d="M${cx + hx - headR - 1.2},${headY + 0.5}
           q-1.4,8 1.8,10.8 q3.4,1.6 6.8,0 q3.2,-2.8 1.8,-10.8 z" fill="${FILL}"/>`
      : '';

  const knees = `
    <ellipse cx="${cx - baseW + 2.2}" cy="${ground - 2.6}" rx="4.2" ry="3.1" fill="${FILL}"/>
    <ellipse cx="${cx + baseW - 2.2}" cy="${ground - 2.6}" rx="4.2" ry="3.1" fill="${FILL}"/>`;

  return `<g class="hero-figure">
    ${hair}
    ${knees}
    <path d="${body}" fill="${FILL}"/>
    <circle cx="${cx + hx}" cy="${headY}" r="${headR}" fill="${FILL}"/>
    <path d="${body}" fill="none" stroke="${RIM}" stroke-width="0.65" stroke-linejoin="round"/>
    <circle cx="${cx + hx}" cy="${headY}" r="${headR}" fill="none" stroke="${RIM}" stroke-width="0.65"/>
  </g>`;
}

function figuresGroupSVG(moodState, genders = {}) {
  // Left figure = you, right = partner, by convention.
  const me = genders.mine || 'unspecified';
  const them = genders.theirs || 'unspecified';

  // Distance carries as much meaning as posture here: the pair stand apart when
  // things are steady and close the gap when one of you needs the other. Sat
  // right of centre so they read against the lighter water beside the moon's
  // reflection rather than getting lost in the dark middle of it.
  if (moodState === 'meLow') {
    // You tip your head onto them; they sit steady and let you.
    return figureSVG({ cx: 206, lean: 0.9, gender: me }) + figureSVG({ cx: 234, lean: 0, gender: them });
  }
  if (moodState === 'themLow') {
    return figureSVG({ cx: 206, lean: 0, gender: me }) + figureSVG({ cx: 234, lean: -0.9, gender: them });
  }
  if (moodState === 'bothLow') {
    // Both tip inward until their heads meet.
    return figureSVG({ cx: 208, lean: 0.62, gender: me }) + figureSVG({ cx: 232, lean: -0.62, gender: them });
  }
  return figureSVG({ cx: 198, lean: 0, gender: me }) + figureSVG({ cx: 242, lean: 0, gender: them });
}

function heroCaptionFor(moodState) {
  if (moodState === 'meLow') return 'Lean on them a little today.';
  if (moodState === 'themLow') return 'They could use you close today.';
  if (moodState === 'bothLow') return 'A quiet day. You have each other.';
  return 'Two shores, one sky.';
}

// Pulls a palette toward overcast: cooler, flatter, less light in it. Used so a
// low day actually *feels* different at a glance, before you read a word.
function cooled(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  const grey = (r + g + b) / 3;
  r = Math.round(r + (grey - r) * amount) - Math.round(6 * amount);
  g = Math.round(g + (grey - g) * amount);
  b = Math.round(b + (grey - b) * amount) + Math.round(10 * amount);
  const cl = (v) => Math.max(0, Math.min(255, v));
  return `#${((1 << 24) + (cl(r) << 16) + (cl(g) << 8) + cl(b)).toString(16).slice(1)}`;
}

function heroSceneSVG(moodState = 'calm', genders = {}) {
  const base = skyPaletteFor(new Date().getHours());
  const isLow = moodState !== 'calm';
  const heavy = moodState === 'bothLow';

  // When one of you is low the sky clouds over; when both are, it rains harder
  // and the moon all but disappears behind the weather.
  const p = isLow
    ? {
        ...base,
        top: cooled(base.top, heavy ? 0.6 : 0.4),
        mid: cooled(base.mid, heavy ? 0.6 : 0.4),
        bot: cooled(base.bot, heavy ? 0.72 : 0.5),
        star: base.star * (heavy ? 0.12 : 0.35),
      }
    : base;

  const stars = STARS.map(
    (s) =>
      `<circle class="hero-star" cx="${s.x}" cy="${s.y}" r="${s.r}" fill="#fdf3dd" style="animation-delay:${s.d}s"/>`
  ).join('');

  return `
  <svg viewBox="0 0 400 220" preserveAspectRatio="xMidYMid slice" data-mood="${moodState}" data-sky="${
    p.name
  }" class="${isLow ? 'is-overcast' : ''} ${heavy ? 'is-downpour' : ''}">
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

    <g class="hero-cloud hero-cloud-a" opacity="${isLow ? 0.3 : 0.16}">
      <ellipse cx="90" cy="52" rx="42" ry="9" fill="#f7ede0"/>
      <ellipse cx="120" cy="49" rx="28" ry="7" fill="#f7ede0"/>
    </g>
    <g class="hero-cloud hero-cloud-b" opacity="${isLow ? 0.22 : 0.11}">
      <ellipse cx="300" cy="86" rx="52" ry="8" fill="#f7ede0"/>
    </g>

    <circle cx="200" cy="58" r="52" fill="url(#moonGlow)" class="hero-halo" opacity="${
      heavy ? 0.22 : isLow ? 0.5 : 1
    }"/>
    <g class="hero-moon" opacity="${heavy ? 0.4 : isLow ? 0.72 : 1}">
      <circle cx="200" cy="58" r="22" fill="#f5e0b8"/>
      <circle cx="192" cy="52" r="3.4" fill="#e6cda1" opacity="0.55"/>
      <circle cx="206" cy="64" r="2.6" fill="#e6cda1" opacity="0.45"/>
      <circle cx="203" cy="49" r="1.8" fill="#e6cda1" opacity="0.4"/>
    </g>
    ${
      isLow
        ? `<g class="hero-stormcloud" opacity="${heavy ? 0.5 : 0.34}">
             <ellipse cx="196" cy="50" rx="58" ry="13" fill="#b9c2d6"/>
             <ellipse cx="232" cy="45" rx="34" ry="10" fill="#b9c2d6"/>
             <ellipse cx="166" cy="46" rx="28" ry="9" fill="#b9c2d6"/>
           </g>`
        : ''
    }

    <rect x="0" y="150" width="400" height="70" fill="url(#sea)"/>
    <g clip-path="url(#seaClip)">
      <polygon points="186,150 214,150 232,220 168,220" fill="url(#glimmer)" class="hero-reflection"/>
      <path class="hero-wave hero-wave-1" d="M-40,164 Q10,160 60,164 T160,164 T260,164 T360,164 T460,164 V172 H-40 Z" fill="#0f0b20" opacity="0.28"/>
      <path class="hero-wave hero-wave-2" d="M-40,180 Q20,175 80,180 T200,180 T320,180 T440,180 V190 H-40 Z" fill="#0d0918" opacity="0.34"/>
      <path class="hero-wave hero-wave-3" d="M-40,198 Q30,193 100,198 T240,198 T380,198 T520,198 V214 H-40 Z" fill="#0b0715" opacity="0.4"/>
    </g>

    <path d="M0,150 Q40,146 80,150 T160,150 T240,150 T320,150 T400,150 V156 Q360,152 320,156 T240,156 T160,156 T80,156 T0,156 Z" fill="${p.top}" opacity="0.55"/>

    <!-- Foreground shore. They're sitting on something now, which the standing
         version never needed and the seated one very much does. -->
    <path d="M-10,212 Q60,203 140,207 T290,205 T410,209 V222 H-10 Z" fill="#0a0714"/>
    <path d="M-10,212 Q60,203 140,207 T290,205 T410,209" fill="none"
          stroke="rgba(243,217,168,0.13)" stroke-width="0.9"/>

    <g class="hero-figures">${figuresGroupSVG(moodState, genders)}</g>
    ${isLow ? rainLayerSVG() : ''}
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
            <div class="clock-presence" id="partner-presence"></div>
          </div>
        </div>

        <div class="bento-tile span-2 tone-mood" id="home-mood-tile">
          <div class="tile-head">${iconToday()}<span class="tile-name">Their mood</span></div>
          <div class="mood-face" id="home-partner-mood">–</div>
          <div class="mood-nudge-line" id="home-mood-note"></div>
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

  // Partner presence on Home — a persisted last-seen, not just "we happen to be
  // online together right now". Re-rendered on a timer so "12m ago" keeps up
  // without needing a new write from their side.
  if (identity.partnerUid) {
    let lastPresence = null;
    const paintPresence = () => {
      const el = document.getElementById('partner-presence');
      if (!el) return;
      if (!lastPresence) return void (el.textContent = '');
      if (lastPresence.typing) el.innerHTML = '<span class="status-typing">typing…</span>';
      else if (lastPresence.online) el.innerHTML = '<span class="status-online">● online now</span>';
      else if (lastPresence.lastSeen) el.textContent = `last seen ${relativeTime(lastPresence.lastSeen)}`;
      else el.textContent = 'not seen yet';
    };
    unsubscribers.push(
      listenPartnerPresence(identity.roomId, identity.partnerUid, (p) => {
        lastPresence = p;
        paintPresence();
      })
    );
    const presenceTick = setInterval(paintPresence, 30000);
    unsubscribers.push(() => clearInterval(presenceTick));
  }

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
      const noteEl = document.getElementById('home-mood-note');
      if (moodEl) moodEl.textContent = theirs ? theirs.mood : '–';
      if (tile) applyMoodTint(tile, theirs ? theirs.mood : null);

      // If they're having a hard day, this tile should catch you the moment you
      // open Home — that's the whole point of them sharing it. Warm and quiet,
      // not an alarm: a soft halo and one line telling you what would help.
      if (tile && noteEl) {
        tile.classList.toggle('needs-you', !!theirLow);
        noteEl.textContent = theirLow ? 'Reach out.' : '';
      }

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
    let presence = null;
    const paintStatus = () => {
      const statusEl = document.getElementById('chat-status');
      const typingRow = document.getElementById('typing-row');
      if (!statusEl || !typingRow) return;
      if (!presence) {
        statusEl.innerHTML = '&nbsp;';
        typingRow.hidden = true;
        return;
      }
      typingRow.hidden = !presence.typing;
      if (presence.typing) statusEl.innerHTML = '<span class="status-typing">typing…</span>';
      else if (presence.online) statusEl.innerHTML = '<span class="status-online">● online</span>';
      else if (presence.lastSeen) statusEl.textContent = `last seen ${relativeTime(presence.lastSeen)}`;
      else statusEl.innerHTML = '&nbsp;';
    };
    unsubscribers.push(
      listenPartnerPresence(identity.roomId, identity.partnerUid, (p) => {
        presence = p;
        paintStatus();
        if (p.typing && atBottom) listEl.scrollTop = listEl.scrollHeight;
      })
    );
    // "last seen 4m ago" has to keep counting on its own — their side stops
    // writing the moment they leave, so no new snapshot is ever coming.
    const statusTick = setInterval(paintStatus, 30000);
    unsubscribers.push(() => clearInterval(statusTick));
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
      // Say what actually went wrong. "Check your connection" on a
      // permission-denied sent people chasing their wifi for no reason.
      toast(sendFailureMessage(e), {
        duration: 9000,
        action: { label: 'Diagnose', onClick: () => renderConnectionCheck() },
      });
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

// ---------------- List ----------------
// One tab, two lists that behave differently: Daily resets every morning and is
// worth seeing a history of, Someday is finished once and stays finished. The
// mode is remembered for the session so switching tabs doesn't bounce you back.
let listMode = 'daily';

function renderBucketList(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">Things to do together</div>
      <h2 class="screen-title">List</h2>
      <div class="segmented" id="list-mode">
        <button class="segment ${listMode === 'daily' ? 'active' : ''}" data-mode="daily">Daily</button>
        <button class="segment ${listMode === 'someday' ? 'active' : ''}" data-mode="someday">Someday</button>
      </div>
      <div id="list-body"></div>
    </div>
  `;
  slot.querySelectorAll('.segment').forEach((btn) => {
    btn.onclick = () => {
      if (listMode === btn.dataset.mode) return;
      listMode = btn.dataset.mode;
      renderTab('list');
    };
  });
  const body = document.getElementById('list-body');
  if (listMode === 'daily') renderDailyList(body);
  else renderSomedayList(body);
}

// Last seven days, today last — far enough back to catch up on a day you
// missed, short enough to stay on one screen without scrolling.
function recentDateKeys(count = 7) {
  const keys = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    keys.push(RoomData.dateKeyOf(d));
  }
  return keys;
}

// Deliberately not the existing dayLabel(): that one returns "Yesterday" and
// "Mon, Aug 3", which are far too wide for a chip in a seven-across strip.
function dayChipLabel(key) {
  if (key === RoomData.dateKeyOf()) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === RoomData.dateKeyOf(yesterday)) return 'Yest';
  return new Date(`${key}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
}

function renderDailyList(host) {
  const todayKey = RoomData.dateKeyOf();
  let selectedDate = todayKey;
  let tasks = [];
  let doneMap = {};
  let doneUnsub = null;

  host.innerHTML = `
    <div class="card">
      <div class="inline-add">
        <input type="text" id="daily-input" placeholder="Something every day…" />
        <button class="btn-primary compact" id="add-daily">Add</button>
      </div>
    </div>
    <div class="chip-row" id="date-strip"></div>
    <div id="daily-body"></div>
  `;

  const add = async () => {
    const el = document.getElementById('daily-input');
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
    try {
      await RoomData.addDailyTask(identity.roomId, sharedKey, text);
    } catch (e) {
      toast("Couldn't add that");
    }
  };
  document.getElementById('add-daily').onclick = add;
  document.getElementById('daily-input').onkeydown = (e) => {
    if (e.key === 'Enter') add();
  };

  const stripEl = document.getElementById('date-strip');
  const bodyEl = document.getElementById('daily-body');
  renderLoading(bodyEl, 'list', 3);

  const paintStrip = () => {
    stripEl.innerHTML = recentDateKeys()
      .map(
        (k) => `<button class="chip ${k === selectedDate ? 'active' : ''}" data-key="${k}">
          ${dayChipLabel(k)} <span class="chip-count">${k.slice(8)}</span>
        </button>`
      )
      .join('');
    stripEl.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        selectedDate = chip.dataset.key;
        paintStrip();
        watchDay();
      };
    });
  };

  const paintBody = () => {
    if (tasks.length === 0) {
      bodyEl.innerHTML = `<div class="empty-state"><div class="empty-emoji">🌅</div>No daily tasks yet — add one above</div>`;
      return;
    }
    const doneCount = tasks.filter((t) => doneMap[t.id]).length;
    const isToday = selectedDate === todayKey;
    bodyEl.innerHTML = `
      <div class="card">
        <div class="list-progress">
          <div class="progress-track"><div class="progress-fill" style="width:${Math.round(
            (doneCount / tasks.length) * 100
          )}%"></div></div>
          <div class="stat-caption">${doneCount} of ${tasks.length} done${isToday ? ' today' : ` on ${selectedDate}`}</div>
        </div>
        ${tasks
          .map((t, idx) => {
            const mark = doneMap[t.id];
            const who = mark ? (mark.by === lastKnownUid ? 'You' : identity.partnerName || 'Them') : '';
            return `
            <div class="list-row tappable" data-id="${t.id}" style="animation-delay:${idx * 25}ms">
              <div class="checkbox ${mark ? 'done' : ''}">${mark ? '✓' : ''}</div>
              <div class="grow ${mark ? 'done-text' : ''}">${escapeHTML(t.text)}</div>
              ${mark ? `<span class="row-meta">${escapeHTML(who)}</span>` : ''}
              <button class="btn-icon subtle daily-remove" data-id="${t.id}" aria-label="Remove">×</button>
            </div>`;
          })
          .join('')}
      </div>`;

    bodyEl.querySelectorAll('.list-row').forEach((row) => {
      row.onclick = async (e) => {
        if (e.target.closest('.daily-remove')) return;
        try {
          await RoomData.toggleDailyDone(identity.roomId, sharedKey, selectedDate, row.dataset.id);
        } catch (err) {
          toast("Couldn't save that");
        }
      };
    });
    bodyEl.querySelectorAll('.daily-remove').forEach((btn) => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const task = tasks.find((t) => t.id === btn.dataset.id);
        if (!confirm(`Stop tracking “${task?.text || 'this'}” every day?`)) return;
        try {
          await RoomData.deleteDailyTask(identity.roomId, btn.dataset.id);
        } catch (err) {
          toast("Couldn't remove that");
        }
      };
    });
  };

  // Only one day is ever listened to at a time — switching days swaps the
  // listener rather than adding another.
  const watchDay = () => {
    if (doneUnsub) doneUnsub();
    doneMap = {};
    doneUnsub = RoomData.listenDailyDone(identity.roomId, sharedKey, selectedDate, (done) => {
      doneMap = done;
      paintBody();
    });
  };

  unsubscribers.push(
    RoomData.listenDailyTasks(identity.roomId, sharedKey, (list) => {
      tasks = list;
      paintBody();
    })
  );
  unsubscribers.push(() => {
    if (doneUnsub) doneUnsub();
  });

  paintStrip();
  watchDay();
}

function renderSomedayList(host) {
  host.innerHTML = `
    <div class="card">
      <div class="inline-add">
        <input type="text" id="item-input" placeholder="Add something…" />
        <button class="btn-primary compact" id="add-item">Add</button>
      </div>
    </div>
    <div id="item-list"></div>
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
              <button class="btn-icon subtle item-remove" data-idx="${idx}" aria-label="Delete">×</button>
            </div>`
            )
            .join('')}
        </div>`;
      listEl.querySelectorAll('.list-row').forEach((row) => {
        const item = items[Number(row.dataset.idx)];
        row.onclick = (e) => {
          if (e.target.closest('.item-remove')) return;
          RoomData.toggleBucketItem(identity.roomId, sharedKey, item.id, item.text, item.done);
        };
      });
      listEl.querySelectorAll('.item-remove').forEach((btn) => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const item = items[Number(btn.dataset.idx)];
          if (!confirm(`Delete “${item.text}” from your list?`)) return;
          try {
            await RoomData.deleteBucketItem(identity.roomId, item.id);
          } catch (err) {
            toast("Couldn't delete that");
          }
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
          ['tile-ludo', iconLudo(), 'Ludo', 'Four seats, bots welcome'],
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
  document.getElementById('tile-ludo').onclick = () => renderLudoEntry();
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
        // Draw the mark now rather than waiting for the write to come back.
        // The move is decided the instant it is tapped, and the round trip is
        // the entire reason the board felt slow — a border colour changing is
        // not the feedback a tap needs. If the write fails, paint() puts the
        // board back exactly as the server sees it.
        cell.classList.add('placing', 'filled', 'locked');
        cell.innerHTML = `<span>${markFor(lastKnownUid)}</span>`;
        boardEl.querySelectorAll('.game-cell').forEach((c) => {
          c.disabled = true;
          c.classList.add('locked');
        });
        try {
          await Game.makeMove(identity.roomId, sharedKey, state, i);
        } catch (e) {
          toast("Couldn't make that move");
          paint();
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

// ---------------- Ludo ----------------
// Everything below draws a single screen that never scrolls: a thin line of
// text on top, a square board that takes whatever space is left, and the dice
// underneath. On a short phone the board shrinks; it is never cut off, and
// nothing is ever hidden below a fold.
const LUDO_YARD_ORIGIN = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] };

function ludoYardSlots(seat) {
  const [r, c] = LUDO_YARD_ORIGIN[seat];
  return [
    [r + 1.5, c + 1.5],
    [r + 1.5, c + 3.5],
    [r + 3.5, c + 1.5],
    [r + 3.5, c + 3.5],
  ];
}

// Where token `index` of `seat` physically sits, in grid coordinates.
function ludoTokenCell(seat, progress, index) {
  if (progress === LudoRules.YARD) return ludoYardSlots(seat)[index];
  if (progress === LudoRules.FINISHED) {
    // Fan the finished tokens out around the centre so four of them don't
    // stack into what looks like one.
    const spread = [[6.6, 7], [7, 6.6], [7.4, 7], [7, 7.4]];
    return spread[index];
  }
  return LudoRules.cellFor(seat, progress);
}

function ludoBoardHTML() {
  const cells = [];
  const kind = {};
  LudoRules.RING.forEach((c, i) => {
    kind[`${c[0]},${c[1]}`] = LudoRules.SAFE_INDICES.has(i) ? 'track safe' : 'track';
  });
  for (const seat of LudoRules.SEATS) {
    for (const c of LudoRules.HOME_COLUMNS[seat]) kind[`${c[0]},${c[1]}`] = `home ${seat}`;
    const startCell = LudoRules.RING[LudoRules.START_INDEX[seat]];
    kind[`${startCell[0]},${startCell[1]}`] = `track start ${seat}`;
  }
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      const k = kind[`${r},${c}`];
      cells.push(`<div class="lc ${k || 'blank'}"></div>`);
    }
  }
  const yards = LudoRules.SEATS.map((seat) => {
    const [r, c] = LUDO_YARD_ORIGIN[seat];
    return `<div class="lyard ${seat}" style="left:${(c / 15) * 100}%;top:${(r / 15) * 100}%"></div>`;
  }).join('');
  return `<div class="ludo-grid">${yards}${cells.join('')}<div class="lcentre"></div></div>`;
}

function ludoStatusLine(state, presence, mySeat) {
  if (!state) return 'Loading…';
  if (state.status === 'finished') {
    const who = Ludo.seatLabel(state, state.winner, presence);
    return state.winner === mySeat ? 'You won 🎉' : `${who.name} won`;
  }
  if (state.status === 'abandoned') {
    return state.abandonedReason === 'not-enough-players'
      ? 'Ended — a game needs two real players'
      : 'Ended';
  }
  const seat = state.turn;
  if (!seat) return 'Waiting…';
  const who = Ludo.seatLabel(state, seat, presence);
  if (seat === mySeat && !who.bot) return 'Your Turn';
  return `${who.name}'s Turn`;
}

// The drifting sky that sits behind every Ludo screen: a moon, a scatter of
// stars, and a few hearts rising. Pure CSS with no JS loop, so it costs nothing
// on a phone and stops entirely under prefers-reduced-motion.
function ludoSkyHTML() {
  const stars = Array.from({ length: 18 }, (_, i) => {
    const left = (i * 37) % 100;
    const top = (i * 53) % 62;
    return `<i class="lstar" style="left:${left}%;top:${top}%;animation-delay:${(i % 7) * 0.6}s"></i>`;
  }).join('');
  const hearts = Array.from({ length: 6 }, (_, i) => {
    const left = 8 + ((i * 31) % 84);
    return `<i class="lheart" style="left:${left}%;animation-delay:${i * 2.6}s">♥</i>`;
  }).join('');
  return `<div class="ludo-sky" aria-hidden="true"><span class="lmoon"></span>${stars}${hearts}</div>`;
}

// A real pipped die rather than a printed number. Smaller than the mockup's,
// as asked — the board is the thing worth looking at.
const DIE_PIPS = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function ludoDieHTML(value) {
  const on = new Set(DIE_PIPS[value] || []);
  const pips = Array.from({ length: 9 }, (_, i) => `<i class="${on.has(i) ? 'on' : ''}"></i>`).join('');
  return `<span class="ldie-face">${pips}</span>`;
}

function ludoInitial(name) {
  return (String(name || '?').trim()[0] || '?').toUpperCase();
}

// How far this seat has actually got, as one number. Finished tokens count the
// full distance so the score only ever climbs.
function ludoProgress(state, seat) {
  return (state.tokens[seat] || []).reduce((sum, p) => sum + (p > 0 ? p : 0), 0);
}

// The header. Two players get the mockup's "You vs Them"; three or four get the
// same cards laid out in a row, because a vs in the middle stops meaning
// anything once there are more than two of you.
function ludoPlayersHTML(state, presence, mySeat) {
  const seated = LudoRules.SEATS.filter((s) => state.seats[s]?.occupied);
  const card = (seat) => {
    const label = Ludo.seatLabel(state, seat, presence);
    const isTurn = state.turn === seat && state.status === 'playing';
    const home = LudoRules.tokensHome(state, seat);
    const pips = Array.from(
      { length: 4 },
      (_, i) => `<i class="${i < home ? 'home' : ''}"></i>`
    ).join('');
    return `
      <div class="lplayer ${seat} ${isTurn ? 'turn' : ''} ${seat === mySeat ? 'me' : ''}">
        <span class="lavatar ${seat}">${escapeHTML(ludoInitial(label.name))}${
      label.bot ? '<b class="lbot">🤖</b>' : ''
    }</span>
        <span class="lplayer-text">
          <span class="lname">${escapeHTML(seat === mySeat && !label.bot ? 'You' : label.name)}</span>
          <span class="lpips">${pips}</span>
        </span>
        <span class="lscore">★ ${ludoProgress(state, seat)}</span>
      </div>`;
  };
  if (seated.length === 2) {
    // Keep whoever is reading the screen on the left, as the mockup does.
    const ordered = mySeat && seated.includes(mySeat) ? [mySeat, seated.find((s) => s !== mySeat)] : seated;
    return `<div class="ludo-players duo">${card(ordered[0])}<span class="lvs">vs</span>${card(
      ordered[1]
    )}</div>`;
  }
  return `<div class="ludo-players">${seated.map(card).join('')}</div>`;
}

function ludoReactionsHTML() {
  return `<div class="ludo-reacts">${Ludo.REACTIONS.map(
    (e) => `<button class="lreact" data-react="${e}" aria-label="React ${e}">${e}</button>`
  ).join('')}</div>`;
}

const LUDO_HOWTO = [
  ['🎲', 'Roll the die', 'Tap the die on your turn and move one piece by that many squares.'],
  ['♟️', 'Get your pieces out', 'Roll a 6 to move a piece from your yard onto its starting square.'],
  ['🔄', 'Move around the board', 'Travel clockwise all the way round, then up your own colour’s column.'],
  ['❤️', 'Reach home', 'Land on someone to send them back. First to bring all four pieces home wins.'],
];

function renderLudo(invite) {
  clearListeners();
  markSectionsSeen(['game']);
  onSubScreen = true;

  let gameId = invite?.gameId || null;
  let key = invite?.key || null;
  let keyB64 = invite?.keyB64 || null;
  let state = null;
  let presence = {};
  let mySeat = null;
  let botTimer = null;
  let shortHandedSince = null;
  let left = false;
  let overlay = null; // 'pause' | 'howto' — the win screen comes from state
  let seenReactionAt = 0;
  let celebrated = false;
  // The board is built once and then updated in place. Rebuilding it wholesale
  // threw away and recreated 225 cells and every piece on each repaint, which
  // (a) cost real time on every presence heartbeat and (b) meant the CSS
  // transition on .ltoken could never run — a brand-new element has nothing to
  // animate from, so pieces jumped instead of sliding.
  let boardShell = false;
  let tokenEls = {};
  let rollAnim = null;
  // The last state the server actually confirmed, kept apart from `state` so an
  // optimistic move that gets refused has something truthful to fall back to.
  let serverState = null;

  const myName = identity?.displayName || 'You';

  root.innerHTML = `<div class="ludo-screen" id="ludo-root"></div>`;
  const host = document.getElementById('ludo-root');

  const leave = async () => {
    left = true;
    if (rollAnim) clearInterval(rollAnim);
    rollAnim = null;
    if (gameId) await Ludo.clearPresence(gameId);
    clearListeners();
    onSubScreen = false;
    history.replaceState(null, '', window.location.pathname);
    // A guest has no room to go back to, and must never be dropped into the
    // paired app's navigation.
    if (isPaired(identity)) renderMain();
    else renderGuestFarewell();
  };

  // ---- lobby ----
  const paintLobby = () => {
    const link = keyB64 ? Ludo.ludoLinkFor(gameId, keyB64) : '';
    const liveHumans = Ludo.liveHumanSeats(state, presence).length;
    const ready = Ludo.canStart(state, presence);
    host.innerHTML = `
      ${ludoSkyHTML()}
      <div class="ludo-head">
        <button class="btn-icon" id="ludo-back" aria-label="Back">${iconChevronLeft()}</button>
        <div class="grow"></div>
        <button class="btn-icon" id="ludo-howto" aria-label="How to play">?</button>
      </div>
      <div class="ludo-hero">
        <h1 class="ludo-wordmark">Ludo</h1>
        <p class="ludo-tagline">A little fun, just for us.</p>
      </div>
      <div class="ludo-lobby">
        ${LudoRules.SEATS.map((seat) => {
          const info = state.seats[seat];
          const label = Ludo.seatLabel(state, seat, presence);
          const isHost = state.hostUid === lastKnownUid;
          return `
          <div class="lseat ${seat} ${info.occupied ? '' : 'empty'}">
            <span class="lavatar ${seat} small">${
              info.occupied ? escapeHTML(ludoInitial(label.name)) : '+'
            }</span>
            <span class="grow">${escapeHTML(info.occupied ? label.name : 'Open seat')}${
              info.uid === lastKnownUid ? ' · you' : ''
            }${info.kind === 'ai' ? ' · bot' : ''}</span>
            ${
              isHost && info.kind !== 'human'
                ? `<button class="btn-secondary compact" data-ai="${seat}">${
                    info.kind === 'ai' ? 'Remove' : 'Add bot'
                  }</button>`
                : ''
            }
          </div>`;
        }).join('')}
      </div>
      <div class="ludo-foot">
        <p class="body-dim ludo-note">
          ${
            ready
              ? 'Ready when you are.'
              : `Two real players are needed to start — ${liveHumans} here so far. Send the link, or fill a seat with a bot.`
          }
        </p>
        <button class="btn-primary ludo-cta" id="ludo-start" ${ready ? '' : 'disabled'}>Start Game</button>
        <button class="btn-secondary" id="ludo-copy">Invite someone</button>
      </div>`;
    document.getElementById('ludo-back').onclick = leave;
    document.getElementById('ludo-howto').onclick = () => {
      overlay = 'howto';
      paintOverlay();
    };
    document.getElementById('ludo-copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(link);
        toast('Link copied — send it to anyone');
      } catch (e) {
        toast('Could not copy the link');
      }
    };
    document.getElementById('ludo-start').onclick = async () => {
      if (!Ludo.canStart(state, presence)) return;
      await Ludo.startGame(gameId, key);
    };
    host.querySelectorAll('[data-ai]').forEach((btn) => {
      btn.onclick = async () => {
        const seat = btn.dataset.ai;
        await Ludo.setSeatToAi(gameId, key, seat, state.seats[seat]?.kind !== 'ai');
      };
    });
  };

  // ---- board ----
  // Built once. Everything after that is an in-place update of the few things
  // that actually change, which is what lets pieces slide rather than jump.
  const buildBoardShell = () => {
    host.innerHTML = `
      ${ludoSkyHTML()}
      <div class="ludo-head">
        <button class="btn-icon" id="ludo-back" aria-label="Back">${iconChevronLeft()}</button>
        <div class="grow"></div>
        <button class="btn-icon" id="ludo-pause" aria-label="Pause">⋯</button>
      </div>
      <div id="lud-players"></div>
      <div id="lud-alert"></div>
      <div class="ludo-boardwrap">
        <div class="ludo-board">
          ${ludoBoardHTML()}
          <div class="ludo-tokens" id="lud-tokens"></div>
        </div>
      </div>
      <div class="ludo-turnline" id="lud-turnline"></div>
      <div class="ludo-foot" id="lud-foot"></div>`;
    document.getElementById('ludo-back').onclick = leave;
    document.getElementById('ludo-pause').onclick = () => {
      overlay = 'pause';
      paintOverlay();
    };
    tokenEls = {};
    boardShell = true;
  };

  // Tapping the die can't know its own result — the value is drawn inside the
  // transaction — so tumble the face until the real one lands. This is covering
  // a real round trip, not decoration: without it the die sits dead for as long
  // as the network takes.
  const startRollAnim = () => {
    const btn = document.getElementById('lud-die');
    if (!btn) return;
    btn.classList.add('rolling');
    let face = 0;
    clearInterval(rollAnim);
    rollAnim = setInterval(() => {
      face = (face % 6) + 1;
      btn.innerHTML = ludoDieHTML(face);
    }, 90);
  };
  const stopRollAnim = () => {
    if (rollAnim) clearInterval(rollAnim);
    rollAnim = null;
  };

  const onTokenTap = (tokenIndex) => {
    if (state.roll == null) return;
    // Apply the move locally and show it immediately. applyMove is pure, so the
    // result is exactly what the server will compute from the same inputs.
    // Note the send goes out BEFORE `state` is reassigned: the transaction is
    // guarded on the move count it was issued against, and handing it the
    // optimistic count would make it reject itself every time.
    const optimistic = LudoRules.applyMove(state, mySeat, tokenIndex, state.roll);
    const sent = Ludo.moveToken(gameId, key, state, mySeat, tokenIndex);
    if (optimistic) {
      state = optimistic;
      paintBoard();
    }
    sent
      .then((result) => {
        // A null result means the guard refused it — usually because someone
        // else got there first. Their snapshot normally corrects us, but if
        // nothing else changed there is none coming, and the optimistic move
        // would sit on screen as a move that never happened.
        if (result || !serverState) return;
        state = serverState;
        paintBoard();
      })
      .catch(() => {
        toast("Couldn't make that move");
        if (serverState) {
          state = serverState;
          paintBoard();
        }
      });
  };

  const updateTokens = (movable) => {
    const wrap = document.getElementById('lud-tokens');
    if (!wrap) return;
    const seen = new Set();
    for (const seat of LudoRules.SEATS) {
      if (!state.seats[seat]?.occupied) continue;
      (state.tokens[seat] || []).forEach((progress, i) => {
        const cell = ludoTokenCell(seat, progress, i);
        if (!cell) return;
        const id = `${seat}-${i}`;
        seen.add(id);
        let el = tokenEls[id];
        if (!el) {
          el = document.createElement('button');
          el.className = `ltoken ${seat}`;
          el.setAttribute('aria-label', `${seat} piece ${i + 1}`);
          wrap.appendChild(el);
          tokenEls[id] = el;
        }
        el.style.left = `${((cell[1] + 0.5) / 15) * 100}%`;
        el.style.top = `${((cell[0] + 0.5) / 15) * 100}%`;
        const canMove = seat === mySeat && movable.has(i);
        el.classList.toggle('movable', canMove);
        el.disabled = !canMove;
        el.onclick = canMove ? () => onTokenTap(i) : null;
      });
    }
    for (const id of Object.keys(tokenEls)) {
      if (seen.has(id)) continue;
      tokenEls[id].remove();
      delete tokenEls[id];
    }
  };

  const paintBoard = () => {
    if (!boardShell) buildBoardShell();

    const myTurn = state.turn === mySeat && state.status === 'playing' && !Ludo.seatIsBot(state, mySeat, presence);
    const moves = myTurn && state.roll != null ? LudoRules.legalMoves(state, mySeat, state.roll) : [];
    const movable = new Set(moves.map((m) => m.token));
    const finished = state.status === 'finished' || state.status === 'abandoned';

    document.getElementById('lud-players').innerHTML = ludoPlayersHTML(state, presence, mySeat);

    // Whose seat has quietly become a bot, said out loud rather than swapped in
    // behind your back.
    const takenOver = LudoRules.SEATS.filter((s) => Ludo.seatLabel(state, s, presence).takenOver).map(
      (s) => `${state.seats[s].name || 'Someone'} dropped out — a bot is playing ${s} now`
    );
    document.getElementById('lud-alert').innerHTML = takenOver.length
      ? `<div class="ludo-alert">${takenOver.map(escapeHTML).join(' · ')}</div>`
      : '';

    updateTokens(movable);

    const turnEl = document.getElementById('lud-turnline');
    turnEl.classList.toggle('mine', myTurn);
    turnEl.innerHTML = `<span class="lsparkle">✦</span><span>${escapeHTML(
      ludoStatusLine(state, presence, mySeat)
    )}</span><span class="lsparkle">✦</span>`;

    if (state.roll != null) stopRollAnim();
    const foot = document.getElementById('lud-foot');
    foot.innerHTML = finished
      ? `<button class="btn-primary ludo-cta" id="ludo-again">Back to the table</button>`
      : `<button class="ludo-die ${myTurn && state.roll == null ? 'ready' : ''}" id="lud-die" ${
          myTurn && state.roll == null ? '' : 'disabled'
        } aria-label="Roll the die">${state.roll != null ? ludoDieHTML(state.roll) : ludoDieHTML(6)}</button>
         <p class="body-dim ludo-note">${escapeHTML(
           myTurn
             ? state.roll == null
               ? 'Tap the die'
               : moves.length
               ? 'Pick a piece'
               : 'Nothing to move'
             : 'Waiting for their move'
         )}</p>
         ${ludoReactionsHTML()}`;

    const rollBtn = document.getElementById('lud-die');
    if (rollBtn) {
      rollBtn.onclick = () => {
        rollBtn.disabled = true;
        startRollAnim();
        Ludo.rollFor(gameId, key, state, mySeat).catch(() => {
          stopRollAnim();
          paintBoard();
        });
      };
    }
    const againBtn = document.getElementById('ludo-again');
    if (againBtn) againBtn.onclick = leave;
    foot.querySelectorAll('.lreact').forEach((el) => {
      el.onclick = () => {
        if (!mySeat) return;
        Ludo.sendReaction(gameId, key, mySeat, el.dataset.react);
      };
    });
  };

  // ---- overlays ----
  // Drawn on top of whatever screen is underneath rather than replacing it, so
  // dismissing a menu never costs a repaint of the board or loses its position.
  // Scoped to `.menu` on purpose: the win screen is also a .ludo-overlay, and a
  // bare selector here would quietly delete it on the next repaint.
  const paintOverlay = () => {
    const existing = host.querySelector('.ludo-overlay.menu');
    if (existing) existing.remove();
    if (!overlay) return;

    const sheet =
      overlay === 'howto'
        ? `<div class="ludo-sheet howto">
             <h2 class="ludo-sheet-title">♡ How to Play Ludo ♡</h2>
             ${LUDO_HOWTO.map(
               ([icon, title, body]) => `
               <div class="lhow">
                 <span class="lhow-icon">${icon}</span>
                 <span>
                   <b>${escapeHTML(title)}</b>
                   <span class="body-dim">${escapeHTML(body)}</span>
                 </span>
               </div>`
             ).join('')}
             <p class="ludo-signoff">Have fun together! 💜</p>
             <button class="btn-secondary" data-close="1">Close</button>
           </div>`
        : `<div class="ludo-sheet">
             <h2 class="ludo-sheet-title">♡ Game Paused ♡</h2>
             <button class="lmenu" data-act="resume">▶ Resume Game</button>
             <button class="lmenu" data-act="howto">? How to Play</button>
             <button class="lmenu danger" data-act="leave">⤶ Leave Game</button>
             <button class="btn-secondary" data-close="1">Cancel</button>
           </div>`;

    const el = document.createElement('div');
    el.className = 'ludo-overlay menu';
    el.innerHTML = sheet;
    host.appendChild(el);

    el.querySelectorAll('[data-close]').forEach((b) => {
      b.onclick = () => {
        overlay = null;
        paintOverlay();
      };
    });
    el.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const act = b.dataset.act;
        if (act === 'resume') {
          overlay = null;
          paintOverlay();
        } else if (act === 'howto') {
          overlay = 'howto';
          paintOverlay();
        } else if (act === 'leave') {
          leave();
        }
      };
    });
  };

  // The win screen. Shown once, over the final board, so the last move stays
  // visible behind it.
  const paintWin = () => {
    const who = Ludo.seatLabel(state, state.winner, presence);
    const mine = state.winner === mySeat;
    const scores = LudoRules.SEATS.filter((s) => state.seats[s]?.occupied)
      .map((s) => {
        const l = Ludo.seatLabel(state, s, presence);
        return `<div class="lwin-score ${s === state.winner ? 'won' : ''}">
            <span class="lavatar ${s} small">${escapeHTML(ludoInitial(l.name))}</span>
            <span class="lwin-name">${escapeHTML(s === mySeat && !l.bot ? 'You' : l.name)}</span>
            <b>${ludoProgress(state, s)}</b>
          </div>`;
      })
      .join('<span class="lvs">vs</span>');

    const el = document.createElement('div');
    el.className = 'ludo-overlay win';
    el.innerHTML = `
      <div class="lfireworks" aria-hidden="true">${Array.from(
        { length: 14 },
        (_, i) => `<i style="left:${(i * 29) % 96}%;animation-delay:${(i % 6) * 0.35}s"></i>`
      ).join('')}</div>
      <div class="ludo-sheet win">
        <h2 class="lwin-title">${escapeHTML(mine ? 'You win!' : `${who.name} wins!`)} 🎉</h2>
        <p class="ludo-tagline">What a game.</p>
        <div class="lwin-scores">${scores}</div>
        <button class="btn-primary ludo-cta" data-act="again">Back to the table</button>
      </div>`;
    host.appendChild(el);
    el.querySelector('[data-act="again"]').onclick = leave;
  };

  const paint = () => {
    if (!state) {
      host.innerHTML = `<div class="ludo-head"><button class="btn-icon" id="ludo-back">${iconChevronLeft()}</button><div class="grow ludo-status">Loading…</div></div>`;
      document.getElementById('ludo-back').onclick = leave;
      return;
    }
    if (state.status === 'lobby') {
      // The lobby replaces the whole screen, so the board shell it wiped has to
      // be rebuilt next time rather than updated into a DOM that no longer exists.
      celebrated = false;
      boardShell = false;
      tokenEls = {};
      paintLobby();
    } else if (state.status === 'finished' && celebrated) {
      // The board and the celebration are already on screen and a finished game
      // cannot change again. Repainting would restart the fireworks every time
      // a presence heartbeat lands, five seconds apart, forever.
      return;
    } else {
      paintBoard();
    }
    paintOverlay();
    if (state.status === 'finished' && state.winner && !celebrated) {
      paintWin();
      celebrated = true;
    }
    flushReaction();
  };

  // A reaction someone else sent floats up once and is gone. Keyed on its
  // timestamp so a repaint for any other reason never replays it.
  const flushReaction = () => {
    const r = state?.lastReaction;
    if (!r || !r.at || r.at <= seenReactionAt) return;
    const first = seenReactionAt === 0;
    seenReactionAt = r.at;
    // Don't replay a backlog of reactions on the first paint after opening.
    if (first || Date.now() - r.at > 12000) return;
    const el = document.createElement('div');
    el.className = 'lfloat';
    el.textContent = r.emoji;
    el.style.left = `${18 + Math.random() * 64}%`;
    host.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  };

  // A turn belonging to a bot — or to someone who has gone quiet — is played by
  // whichever human client gets there first. No host to depend on, and the
  // moveCount guard makes a tie harmless.
  const driveBots = () => {
    // Always cancel and re-decide. An earlier version bailed out whenever a
    // timer was already pending, which meant a timer armed for a turn that had
    // since moved on would fire, find the game changed, and quietly do nothing —
    // leaving the bot's actual turn with nobody scheduled to play it, and the
    // board frozen until a human happened to reload.
    if (botTimer) {
      clearTimeout(botTimer);
      botTimer = null;
    }
    if (left || !state || state.status !== 'playing' || !state.turn || !mySeat) return;
    if (!Ludo.seatIsBot(state, state.turn, presence)) return;
    const seat = state.turn;
    const at = state.moveCount || 0;
    botTimer = setTimeout(async () => {
      botTimer = null;
      if (left || !state || state.turn !== seat || (state.moveCount || 0) !== at) return;
      // Re-checked at firing time, not just when scheduled: someone whose phone
      // woke up in the last second is back, and their turn is theirs again.
      if (!Ludo.seatIsBot(state, seat, presence)) return;
      await Ludo.playBotTurn(gameId, key, state, seat);
    }, Ludo.AI_THINK_MS);
  };

  // My own turn with a roll and nothing legal to do with it passes itself on,
  // so nobody sits looking at a board wondering what they are meant to tap.
  const autoPass = () => {
    if (!state || state.status !== 'playing' || state.turn !== mySeat || state.roll == null) return;
    if (Ludo.seatIsBot(state, mySeat, presence)) return;
    if (LudoRules.legalMoves(state, mySeat, state.roll).length > 0) return;
    const at = state.moveCount || 0;
    setTimeout(() => {
      if (left || !state || state.turn !== mySeat || state.roll == null) return;
      if ((state.moveCount || 0) !== at) return;
      Ludo.passTurn(gameId, key, state, mySeat);
    }, 900);
  };

  // The floor the user asked for: below two real players the game stops rather
  // than quietly turning into one person against three bots.
  const enforceTwoHumans = () => {
    if (!state || state.status !== 'playing') {
      shortHandedSince = null;
      return;
    }
    if (Ludo.liveHumanSeats(state, presence).length >= 2) {
      shortHandedSince = null;
      return;
    }
    if (!shortHandedSince) shortHandedSince = Date.now();
    else if (Date.now() - shortHandedSince > 45000) {
      shortHandedSince = null;
      Ludo.abandonGame(gameId, key, 'not-enough-players');
    }
  };

  const attach = () => {
    unsubscribers.push(
      Ludo.listenGame(
        gameId,
        key,
        (next) => {
          if (!next) {
            host.innerHTML = `<div class="ludo-head"><button class="btn-icon" id="ludo-back">${iconChevronLeft()}</button><div class="grow ludo-status">That game could not be opened.</div></div>`;
            document.getElementById('ludo-back').onclick = leave;
            return;
          }
          state = next;
          serverState = next;
          mySeat = LudoRules.SEATS.find((s) => state.seats[s]?.uid === lastKnownUid) || null;
          paint();
          driveBots();
          autoPass();
        },
        () => toast("Lost the game connection")
      )
    );
    unsubscribers.push(Ludo.listenPresence(gameId, (map) => {
      presence = map;
      if (state) paint();
      driveBots();
      enforceTwoHumans();
    }));

    Ludo.heartbeat(gameId);
    const beat = setInterval(() => {
      Ludo.heartbeat(gameId);
      // Presence is time-based, so the screen has to re-evaluate on a clock as
      // well as on a snapshot — nothing arrives to tell you someone went quiet.
      if (state) paint();
      driveBots();
      enforceTwoHumans();
    }, Ludo.HEARTBEAT_MS);
    unsubscribers.push(() => clearInterval(beat));
    unsubscribers.push(() => {
      if (botTimer) clearTimeout(botTimer);
      botTimer = null;
    });
  };

  (async () => {
    try {
      if (!gameId) {
        const created = await Ludo.createGame({ hostName: myName });
        gameId = created.gameId;
        key = created.key;
        keyB64 = created.keyB64;
        // Drop the invite into the room too, so your person just sees a Join
        // button instead of having to be sent a link like a stranger.
        if (identity?.roomId && sharedKey) {
          await RoomData.setLudoInvite(identity.roomId, sharedKey, { gameId, keyB64, by: myName });
        }
      } else {
        const joined = await Ludo.claimSeat(gameId, key, myName);
        state = joined.state;
        mySeat = joined.seat;
      }
      attach();
    } catch (e) {
      host.innerHTML = `
        <div class="ludo-head"><button class="btn-icon" id="ludo-back">${iconChevronLeft()}</button>
        <div class="grow ludo-status">${escapeHTML(e?.message || 'Could not open that game.')}</div></div>`;
      document.getElementById('ludo-back').onclick = leave;
    }
  })();
}

// The Ludo tile lands here: either pick up the game already going, or start one.
function renderLudoEntry() {
  clearListeners();
  onSubScreen = true;
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="ludo-entry-back" aria-label="Back">${iconChevronLeft()}</button>
        <div><div class="eyebrow">Four seats</div><h2>Ludo</h2></div>
      </div>
      <div class="card">
        <p class="body-dim">
          You and ${escapeHTML(identity?.partnerName || 'your person')}, plus two more —
          send a link to anyone, or fill the seats with bots. It takes two real players to start.
        </p>
      </div>
      <div id="ludo-open"></div>
      <button class="btn-primary" id="ludo-new">Start a new game</button>
    </div>`;
  attachNav();
  document.getElementById('ludo-entry-back').onclick = () => renderMain();
  document.getElementById('ludo-new').onclick = () => renderLudo(null);

  const openEl = document.getElementById('ludo-open');
  if (!identity?.roomId || !sharedKey) return;
  unsubscribers.push(
    RoomData.listenLudoInvite(identity.roomId, sharedKey, (invite) => {
      if (!invite?.gameId) {
        openEl.innerHTML = '';
        return;
      }
      openEl.innerHTML = `
        <div class="card">
          <div class="eyebrow">A game is open</div>
          <p class="body-dim">Started by ${escapeHTML(invite.by || 'them')}.</p>
          <button class="btn-secondary compact" id="ludo-join" style="margin-top:10px;">Join</button>
        </div>`;
      document.getElementById('ludo-join').onclick = () =>
        renderLudo({ gameId: invite.gameId, keyB64: invite.keyB64, key: boxKeyFromB64(invite.keyB64) });
    })
  );
}

// Where a guest lands when they leave. They have no room, no tabs and nothing
// else in this app — so the screen says so, warmly, and stops.
function renderGuestFarewell() {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>Thanks for playing</h1>
      <p class="lede">That's the end of the game. Ask for a new link whenever you fancy another.</p>
    </div>`;
}

// A guest arriving on a Ludo link is not part of the room and must never be
// walked through pairing. Name, seat, play — that is the whole of it.
function renderLudoGuest(invite) {
  clearListeners();
  root.innerHTML = `
    <div class="screen center-col">
      <div class="mark"></div>
      <h1>You've been invited</h1>
      <p class="lede">A game of Ludo. Pick a name and take a seat.</p>
      <div class="card">
        <input type="text" id="guest-name" placeholder="Your name" maxlength="20" />
      </div>
      <button class="btn-primary" id="guest-join">Take a seat</button>
      <div id="guest-error" class="error-text"></div>
    </div>`;
  const btn = document.getElementById('guest-join');
  btn.onclick = async () => {
    const name = document.getElementById('guest-name').value.trim();
    if (!name) return;
    btn.disabled = true;
    btn.textContent = 'Joining…';
    try {
      const user = await ensureSignedIn();
      lastKnownUid = user.uid;
      identity = { ...(identity || {}), displayName: name };
      renderLudo({ ...invite, key: boxKeyFromB64(invite.keyB64) });
    } catch (e) {
      document.getElementById('guest-error').textContent = e?.message || 'Could not join.';
      btn.disabled = false;
      btn.textContent = 'Take a seat';
    }
  };
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
        <div class="btn-row" style="margin-top:10px;">
          <button class="btn-secondary" id="refresh-app-btn">Reload a fresh copy</button>
          <button class="btn-secondary" id="connection-check-btn">Connection check</button>
        </div>
        <button class="btn-secondary" id="repair-pair-btn" style="margin-top:10px;">Reconnect to your partner</button>
        <p class="fine-print">
          Reconnecting keeps your keys, so it lands you back in the <strong>same room with all your history</strong> —
          it only re-links the two accounts. Whoever's app still works should be the one to <strong>open</strong> the
          link; the person having trouble should be the one to create it.
        </p>
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

  document.getElementById('connection-check-btn').onclick = () => renderConnectionCheck();

  document.getElementById('repair-pair-btn').onclick = async () => {
    const ok = await confirmModal({
      title: 'Reconnect to your partner?',
      body:
        'Your keys stay exactly as they are, so this puts you back in the same room with all your messages, ' +
        'letters and photos intact. Nothing is deleted. Whoever can still use the app normally should be the ' +
        'one to open the link.',
      confirmLabel: 'Reconnect',
    });
    if (!ok) return;
    clearListeners();
    clearGlobalListeners();
    // Keep the keypair — that's what preserves the room id and the history.
    // Only the pending-link slot is cleared so a fresh link can be made.
    identity = await updateIdentity({ pending: null });
    renderPairingHub();
  };

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

// ---------------- Connection check ----------------
// Walks the exact chain a write depends on and reports where it breaks. Built
// because "it shows an error" is unactionable: the same toast covered offline,
// a dead listener, and this device not being a member of the room — which are
// three completely different problems with three different fixes.
// The single most common real failure, and its actual fix. Recovery sign-in
// restores the ORIGINAL account id (Firebase links rather than replaces), so it
// puts this device back inside the room — re-pairing is only the last resort.
const WRONG_ACCOUNT_VERDICT =
  'This device is signed in to a different account than the one that was paired. ' +
  'That happens after logging out, clearing browser data, or using a different browser. ' +
  'Everything it tries to save is refused by the server. ' +
  'If recovery was set up, signing back in with that email and password restores the original account and fixes this immediately. ' +
  'If not, the two of you will need to pair again.';

function renderConnectionCheck() {
  clearListeners();
  root.innerHTML = `
    <div class="screen">
      <div class="page-head">
        <button class="btn-icon" id="diag-back" aria-label="Back">${iconChevronLeft()}</button>
        <div>
          <div class="eyebrow">Diagnostics</div>
          <h2>Connection check</h2>
        </div>
      </div>
      <div class="card">
        <p class="body-dim">Checking everything a message needs in order to send.</p>
      </div>
      <div id="diag-results"></div>
      <div id="diag-verdict"></div>
    </div>
  `;
  attachNav();
  document.getElementById('diag-back').onclick = () => renderSettings();

  const resultsEl = document.getElementById('diag-results');
  const rows = [];
  const paint = () => {
    resultsEl.innerHTML = `<div class="card">${rows
      .map(
        (r) => `<div class="diag-row ${r.state}">
          <span class="diag-mark">${r.state === 'pass' ? '✓' : r.state === 'fail' ? '✗' : '…'}</span>
          <div class="grow">
            <div class="diag-label">${escapeHTML(r.label)}</div>
            ${r.detail ? `<div class="row-meta">${escapeHTML(r.detail)}</div>` : ''}
          </div>
        </div>`
      )
      .join('')}</div>`;
  };
  const add = (label) => {
    const row = { label, state: 'run', detail: '' };
    rows.push(row);
    paint();
    return row;
  };

  (async () => {
    let verdict = null;

    // 1. auth
    const rAuth = add('Signed in');
    let uid = null;
    try {
      const u = await ensureSignedIn();
      uid = u.uid;
      rAuth.state = 'pass';
      rAuth.detail = `Account ${uid.slice(0, 8)}…`;
    } catch (e) {
      rAuth.state = 'fail';
      rAuth.detail = e?.code || e?.message || 'could not sign in';
      verdict = 'This device could not sign in to Firebase at all. Check the connection and reopen the app.';
    }
    paint();

    // 2. local pairing data — try to repair a missing partnerUid before judging
    const rLocal = add('Paired on this device');
    if (identity?.roomId && !identity?.partnerUid) await healPartnerUid();
    if (identity?.roomId && identity?.partnerUid && identity?.secretKey) {
      rLocal.state = 'pass';
      rLocal.detail = `Room ${identity.roomId.slice(0, 8)}… · partner ${identity.partnerUid.slice(0, 8)}…`;
    } else {
      rLocal.state = 'fail';
      if (!identity?.roomId) {
        rLocal.detail = 'no room stored';
        verdict = verdict || 'This device has never completed pairing. Use “Pair again” in Settings.';
      } else if (!identity?.secretKey) {
        rLocal.detail = 'private key locked — unlock with your PIN';
        verdict = verdict || 'Your private key is locked. Reopen the app and enter your PIN.';
      } else {
        // Room is known but the partner's account id isn't, and it couldn't be
        // read back off the room — which means the room isn't readable either.
        rLocal.detail = "partner's account id unknown on this device";
        verdict = verdict || WRONG_ACCOUNT_VERDICT;
      }
    }
    paint();

    // 3. room document + membership — the usual culprit
    const rRoom = add('Room recognises this device');
    if (uid && identity?.roomId) {
      try {
        const { doc: fbDoc, getDoc: fbGetDoc, db: fbDb } = await import('./firebase.js');
        const snap = await fbGetDoc(fbDoc(fbDb, 'rooms', identity.roomId));
        if (!snap.exists()) {
          rRoom.state = 'fail';
          rRoom.detail = 'the room record does not exist';
          verdict =
            verdict ||
            'The shared room record is missing. This happens when only one side finished pairing. You will need to pair again.';
        } else {
          const members = snap.data().memberUids || [];
          const meIn = members.includes(uid);
          const themIn = members.includes(identity.partnerUid);
          if (meIn && themIn) {
            rRoom.state = 'pass';
            rRoom.detail = 'both accounts listed';
          } else {
            rRoom.state = 'fail';
            // Show the actual ids side by side. "Wrong account" is impossible to
            // act on until you can see that the room expects one id and this
            // device is presenting another.
            const expected = members.map((m) => `${String(m).slice(0, 8)}…`).join(', ') || 'nobody';
            rRoom.detail = meIn
              ? `room lists ${expected} — your partner's account is not among them`
              : `room lists ${expected}, this device is ${uid.slice(0, 8)}…`;
            verdict =
              verdict ||
              (meIn
                ? "Your partner's account is missing from the room, so everything they send is refused. On their device: if they set up recovery, signing back in with that email restores their original account. Otherwise you'll both need to pair again."
                : WRONG_ACCOUNT_VERDICT);
          }
        }
      } catch (e) {
        rRoom.state = 'fail';
        if (e?.code === 'permission-denied') {
          // Only members may read the room, so a refusal here is itself proof.
          rRoom.detail = 'refused — this account is not a member of the room';
          verdict = verdict || WRONG_ACCOUNT_VERDICT;
        } else {
          rRoom.detail = e?.code || e?.message || 'could not read the room';
          verdict = verdict || 'The room record could not be read from this device.';
        }
      }
    } else {
      rRoom.state = 'fail';
      rRoom.detail = 'skipped — not paired';
    }
    paint();

    // 4. read
    const rRead = add('Can read your messages');
    if (identity?.roomId && sharedKey) {
      try {
        const { collection: fbCol, query: fbQuery, orderBy: fbOrder, limit: fbLim, getDocs: fbGetDocs, db: fbDb } =
          await import('./firebase.js');
        await fbGetDocs(fbQuery(fbCol(fbDb, 'rooms', identity.roomId, 'thread'), fbOrder('createdAt', 'desc'), fbLim(1)));
        rRead.state = 'pass';
      } catch (e) {
        rRead.state = 'fail';
        rRead.detail = e?.code || e?.message || 'read refused';
      }
    } else {
      rRead.state = 'fail';
      rRead.detail = 'skipped';
    }
    paint();

    // 5. write — the actual thing that's failing, tested harmlessly
    const rWrite = add('Can save to your room');
    if (identity?.roomId && uid) {
      try {
        const { doc: fbDoc, setDoc: fbSetDoc, deleteDoc: fbDeleteDoc, db: fbDb } = await import('./firebase.js');
        const probe = fbDoc(fbDb, 'rooms', identity.roomId, 'diagnostics', uid);
        await fbSetDoc(probe, { at: Date.now() });
        await fbDeleteDoc(probe).catch(() => {});
        rWrite.state = 'pass';
      } catch (e) {
        rWrite.state = 'fail';
        rWrite.detail = e?.code || e?.message || 'write refused';
        if (e?.code === 'permission-denied') verdict = verdict || WRONG_ACCOUNT_VERDICT;
      }
    } else {
      rWrite.state = 'fail';
      rWrite.detail = 'skipped';
    }
    paint();

    const allPass = rows.every((r) => r.state === 'pass');
    const wrongAccount = verdict === WRONG_ACCOUNT_VERDICT;
    document.getElementById('diag-verdict').innerHTML = `
      <div class="card ${allPass ? '' : 'diag-verdict-bad'}">
        <div class="eyebrow">${allPass ? 'All good' : 'What this means'}</div>
        <p class="body-dim">${
          allPass
            ? 'Everything this device needs is working. If a message still fails, it will be a passing network problem and it will send itself once you are back online.'
            : escapeHTML(verdict || 'Something in the chain above failed. The first ✗ is the one to fix.')
        }</p>
        ${
          wrongAccount && identity?.recoveryEmail
            ? '<button class="btn-primary" id="diag-recover-btn" style="margin-top:12px;">Sign in with recovery</button>'
            : ''
        }
        ${
          wrongAccount && !identity?.recoveryEmail
            ? '<button class="btn-primary" id="diag-code-btn" style="margin-top:12px;">Get my code for them</button>'
            : ''
        }
      </div>
      <div class="card">
        <div class="eyebrow">On the healthy device</div>
        <p class="body-dim">
          If it is your partner who is locked out, they will read you a code. This is where you enter it.
        </p>
        <button class="btn-secondary compact" id="diag-readmit-btn" style="margin-top:10px;">Re-admit a device</button>
      </div>`;
    const recoverBtn = document.getElementById('diag-recover-btn');
    if (recoverBtn) recoverBtn.onclick = () => renderRecoverStep();
    const codeBtn = document.getElementById('diag-code-btn');
    if (codeBtn) codeBtn.onclick = () => renderReadmitCode();
    document.getElementById('diag-readmit-btn').onclick = () => renderReadmitEnter();
  })();
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
      const backupKey = await setUpRecovery(email, password, identity);
      identity = await updateIdentity({ recoveryEmail: email, backupKey, myUid: lastKnownUid });
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

// Turns a Firestore error into something that tells the user what to do next.
// `permission-denied` in this app almost always means this device's account is
// no longer one of the room's two members — a completely different problem from
// being offline, and one no amount of retrying will fix.
function sendFailureMessage(e) {
  const code = e?.code || '';
  if (code === 'permission-denied') {
    return "This device isn't recognised as part of your room, so nothing can be saved. Tap Diagnose.";
  }
  if (code === 'unavailable' || !navigator.onLine) {
    return "You're offline — it'll send by itself once you're back.";
  }
  if (code === 'unauthenticated') return 'Signed out unexpectedly. Reopen the app to sign back in.';
  if (code === 'resource-exhausted') return 'That was too large to send.';
  return `Didn't send${code ? ` (${escapeHTML(code)})` : ''}. Tap Diagnose.`;
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
// A die rather than a grid, so the two games are told apart at a glance in the
// More tab instead of sharing one icon.
function iconLudo() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none"/></svg>';
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
      // Record the moment of leaving — this is what the partner sees as
      // "last seen", and it's far more accurate than the last heartbeat tick.
      markSeenNow(identity.roomId);
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

// `pagehide` is the most reliable "the app is going away" signal on mobile —
// far more dependable than `beforeunload`, which phones frequently skip. This is
// the last chance to record when you were actually here.
window.addEventListener('pagehide', () => {
  if (identity?.roomId && presenceEnabled()) markSeenNow(identity.roomId);
});

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
RoomData.setDataErrorHandler(({ label, error }) => {
  // Offline is already explained by the banner; don't pile on.
  if (!navigator.onLine) return;
  const now = Date.now();
  if (now - dataErrorToastAt < 6000) return; // one message, not one per listener
  dataErrorToastAt = now;

  // A refused read is not a loading hiccup and "Retry" will never fix it — it
  // means this account isn't a member of the room. Say that instead.
  if (error?.code === 'permission-denied' || membershipBroken) {
    toast('This device is signed in to a different account than the one you paired with.', {
      duration: 14000,
      action: { label: 'What to do', onClick: () => renderConnectionCheck() },
    });
    return;
  }
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
