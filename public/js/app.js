import { loadIdentity, updateIdentity, saveIdentity, clearIdentity, isPaired } from './store.js';
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
import { ensureSignedIn, tryEnableOfflinePersistence, signOutOfAccount } from './firebase.js';
import { lockIdentityWithPin, unlockIdentityWithPin, needsUnlock } from './applock.js';
import { setUpRecovery, recoverFromEmail } from './auth-recovery.js';
import { listenStreak } from './streak.js';
import { renderLoading, toast, countdownParts, pad2, relativeTime } from './ui.js';
import {
  startHeartbeat,
  stopHeartbeat,
  signalTyping,
  clearTyping,
  listenPartnerPresence,
} from './presence.js';
import {
  notificationsSupported,
  notificationPermission,
  requestNotificationPermission,
  showNotification,
  previewFor,
} from './notify.js';

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
    renderRecoveryChoice();
  };
  document.getElementById('continue-btn').onclick = go;
  document.getElementById('name-input').onkeydown = (e) => {
    if (e.key === 'Enter') go();
  };
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
  root.innerHTML = `<div id="screen-slot"></div>${navHTML()}`;
  bindNav();
  setUpGlobalListeners();
  renderTab(activeTab);
}

function setUpGlobalListeners() {
  if (!identity?.roomId || !sharedKey) return;

  if (presenceEnabled()) startHeartbeat(identity.roomId);

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

function bindNav() {
  document.querySelectorAll('.nav button').forEach((btn) => {
    btn.onclick = () => {
      if (activeTab === btn.dataset.tab) return;
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
  if (!slot) return;
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

function figuresGroupSVG(moodState) {
  // Left figure = you, right = partner, by convention.
  const body = (cx, cy, rot) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="9" ry="15" fill="#0d0a1a" ${
      rot ? `transform="rotate(${rot} ${cx} ${cy})"` : ''
    }/>`;
  const head = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="5.6" fill="#0d0a1a"/>`;

  if (moodState === 'meLow') {
    return body(191, 197, 10) + head(196, 181) + body(208, 196, 0) + head(208, 177);
  }
  if (moodState === 'themLow') {
    return body(188, 196, 0) + head(188, 177) + body(205, 197, -10) + head(200, 181);
  }
  if (moodState === 'bothLow') {
    return body(193, 197, 7) + head(197, 182) + body(203, 197, -7) + head(199, 182);
  }
  return body(186, 196, 0) + head(186, 177) + body(210, 196, 0) + head(210, 177);
}

function heroCaptionFor(moodState) {
  if (moodState === 'meLow') return 'Lean on them a little today.';
  if (moodState === 'themLow') return 'They could use you close today.';
  if (moodState === 'bothLow') return 'A quiet day. You have each other.';
  return 'Two shores, one sky.';
}

function heroSceneSVG(moodState = 'calm') {
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
    <g class="hero-figures">${figuresGroupSVG(moodState)}</g>
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
        <button class="btn-icon" id="settings-btn" aria-label="Settings">${iconSettings()}</button>
      </header>
      <input type="file" accept="image/*" id="avatar-input" hidden />

      <div class="hero-scene" id="hero-scene">
        ${heroSceneSVG()}
        <div class="hero-caption" id="hero-caption"></div>
      </div>

      <div class="bento">
        <div class="bento-tile span-4 countdown-tile" id="countdown-tile">
          <div class="eyebrow" id="countdown-caption">Next shared moment</div>
          <div class="countdown-title" id="countdown-title">Nothing planned yet</div>
          <div class="countdown-clock" id="countdown-clock"></div>
        </div>

        <div class="bento-tile span-2 tile-center">
          <div class="stat-number" id="days-together">–</div>
          <div class="stat-caption">days together</div>
        </div>

        <div class="bento-tile span-2 tile-center">
          <div class="stat-number" id="streak-value">–</div>
          <div class="stat-caption">day streak</div>
        </div>

        <div class="bento-tile span-4 clock-tile">
          <div class="clock-side">
            <div class="eyebrow">You</div>
            <div class="clock-time" id="my-time">--:--</div>
            <div class="clock-meta" id="my-meta"></div>
          </div>
          <div class="clock-divider"></div>
          <div class="clock-side right">
            <div class="eyebrow">${escapeHTML(identity.partnerName || 'Them')}</div>
            <div class="clock-time" id="partner-time">--:--</div>
            <div class="clock-meta" id="partner-meta"></div>
          </div>
        </div>

        <div class="bento-tile span-2 tile-center">
          <div class="eyebrow">Their mood</div>
          <div class="mood-face" id="home-partner-mood">–</div>
        </div>

        <div class="bento-tile span-2">
          <div class="eyebrow">Together since</div>
          <input type="date" id="together-since-input" />
        </div>
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

  const stopType = typeCaption(document.getElementById('hero-caption'), heroCaptionFor('calm'));
  if (stopType) unsubscribers.push(stopType);

  if (identity.partnerUid) {
    unsubscribers.push(
      RoomData.listenProfiles(identity.roomId, sharedKey, [lastKnownUid, identity.partnerUid], (uid, avatar) => {
        const targetId = uid === lastKnownUid ? 'avatar-mine' : 'avatar-theirs';
        const el = document.getElementById(targetId);
        const src = safeMediaSrc(avatar, 'image');
        if (!el || !src) return;
        el.style.backgroundImage = `url("${src}")`;
        el.textContent = '';
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

  const input = document.getElementById('together-since-input');
  input.onchange = () => {
    RoomData.setTogetherSince(identity.roomId, sharedKey, input.value);
    toast('Saved');
  };

  unsubscribers.push(
    RoomData.listenRoomSettings(identity.roomId, sharedKey, (settings) => {
      if (!settings.togetherSince) return;
      const el = document.getElementById('together-since-input');
      const daysEl = document.getElementById('days-together');
      if (!el || !daysEl) return;
      el.value = settings.togetherSince;
      const days = Math.floor((Date.now() - new Date(settings.togetherSince)) / 86400000);
      daysEl.textContent = days >= 0 ? days.toLocaleString() : '–';
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
  let lastMoodState = null;
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

      const moodEl = document.getElementById('home-partner-mood');
      if (moodEl) moodEl.textContent = theirs ? theirs.mood : '–';

      if (moodState === lastMoodState) return;
      lastMoodState = moodState;
      const heroEl = document.getElementById('hero-scene');
      if (!heroEl) return;
      heroEl.innerHTML = heroSceneSVG(moodState) + `<div class="hero-caption" id="hero-caption"></div>`;
      const stop = typeCaption(document.getElementById('hero-caption'), heroCaptionFor(moodState));
      if (stop) unsubscribers.push(stop);
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
  requestAnimationFrame(() => wrap.classList.add('open'));
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
        <div class="chat-lock" title="End-to-end encrypted">${iconLock()}</div>
      </header>

      <div class="thread-list" id="thread-list"></div>

      <div class="typing-row" id="typing-row" hidden>
        <div class="typing-bubble"><span></span><span></span><span></span></div>
      </div>

      <button class="scroll-down" id="scroll-down" hidden aria-label="Jump to latest">${iconChevronDown()}</button>

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

  let firstPaint = true;
  unsubscribers.push(
    RoomData.listenThread(identity.roomId, sharedKey, (messages) => {
      if (messages.length === 0) {
        listEl.innerHTML = `<div class="empty-state">
          <div class="empty-emoji">🌙</div>
          Nothing here yet. Say hello.
        </div>`;
        return;
      }

      const wasAtBottom = atBottom || firstPaint;
      listEl.innerHTML = messages.map((m, idx) => bubbleHTML(m, idx, messages)).join('');

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

      if (wasAtBottom) {
        listEl.scrollTop = listEl.scrollHeight;
        scrollBtn.hidden = true;
      } else {
        scrollBtn.hidden = false;
      }
      firstPaint = false;
    })
  );

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
      onClick: () => {
        if (confirm('Delete this for both of you? This removes it completely — nothing stays behind.')) {
          RoomData.deleteThreadMessage(identity.roomId, message.id).catch(() => toast("Couldn't delete"));
        }
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
    input.value = '';
    autoGrow();
    syncActionButton();
    if (presenceEnabled()) clearTyping(identity.roomId);
    try {
      await RoomData.sendThreadMessage(identity.roomId, sharedKey, text);
    } catch (e) {
      toast("Message didn't send — check your connection");
      input.value = text;
      autoGrow();
      syncActionButton();
    }
  };

  input.oninput = () => {
    autoGrow();
    syncActionButton();
    if (presenceEnabled() && input.value.trim()) signalTyping(identity.roomId);
  };
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
    if (!file) return;
    const viewOnce = confirm('Send as view-once? It will disappear once opened.\n\nOK = view-once, Cancel = normal photo');
    try {
      const compressed = await fileToCompressedBase64(file);
      await RoomData.sendThreadPhoto(identity.roomId, sharedKey, compressed, viewOnce);
    } catch (err) {
      toast("Couldn't send that photo");
    }
    e.target.value = '';
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

  const typeClass = m.type === 'photo' ? 'photo-bubble' : m.type === 'voice' ? 'voice-bubble' : '';
  return `${divider}
    <div class="msg-row ${mine ? 'mine' : 'theirs'} ${m.pending ? 'is-pending' : ''}">
      <div class="bubble ${mine ? 'me' : 'them'} ${typeClass} ${pos}" data-idx="${idx}">
        ${inner}${reactionChip}
      </div>
      ${meta}
    </div>`;
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
const MOODS = [
  { emoji: '😄', label: 'Great' },
  { emoji: '🙂', label: 'Good' },
  { emoji: '😐', label: 'Okay' },
  { emoji: '😔', label: 'Low' },
  { emoji: '😢', label: 'Really low' },
];
const LOW_MOODS = ['😔', '😢'];

function renderToday(slot) {
  slot.innerHTML = `
    <div class="screen">
      <div class="eyebrow">How today felt</div>
      <h2 class="screen-title">Today</h2>
      <div class="card">
        <div class="eyebrow">Your mood</div>
        <div class="mood-picker" id="mood-picker">
          ${MOODS.map(
            (m) => `<button class="mood-option" data-mood="${m.emoji}">
              <span class="mood-emoji">${m.emoji}</span>
              <span class="mood-label">${m.label}</span>
            </button>`
          ).join('')}
        </div>
      </div>
      <div class="card">
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
      const rowsFor = (arr, dim) =>
        arr
          .map(
            (e, i) => `
        <div class="list-row ${dim ? 'dim' : ''}" style="animation-delay:${i * 30}ms">
          <div class="date-chip">
            <span class="date-chip-day">${new Date(e.dateTime).getDate()}</span>
            <span class="date-chip-mon">${new Date(e.dateTime).toLocaleDateString([], { month: 'short' })}</span>
          </div>
          <div class="grow">
            <div>${escapeHTML(e.title)}</div>
            <div class="row-meta">${new Date(e.dateTime).toLocaleString([], {
              weekday: 'short', hour: '2-digit', minute: '2-digit',
            })}</div>
          </div>
        </div>`
          )
          .join('');
      listEl.innerHTML =
        (upcoming.length ? `<div class="card">${rowsFor(upcoming, false)}</div>` : '') +
        (past.length
          ? `<div class="eyebrow" style="margin-top:4px;">Past</div><div class="card">${rowsFor(past, true)}</div>`
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
  document.getElementById('tile-memories').onclick = () => renderMemories();
  document.getElementById('tile-settings').onclick = () => renderSettings();
}

// ---------------- Expenses (with categories) ----------------
function renderExpenseTracker() {
  clearListeners();
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

      <div class="card balance-card" id="expense-summary"></div>

      <div class="card">
        <input type="text" id="expense-desc" placeholder="What was it for?" />
        <div class="field-row" style="margin-top:8px;">
          <input type="number" id="expense-amount" inputmode="decimal" placeholder="Amount" />
          <select id="expense-category">
            ${RoomData.EXPENSE_CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <select id="expense-paidby" style="margin-top:8px;">
          <option value="${lastKnownUid}">I paid</option>
          <option value="${identity.partnerUid || ''}">${escapeHTML(identity.partnerName || 'They')} paid</option>
        </select>
        <button class="btn-primary" id="add-expense-btn" style="margin-top:10px;">Add expense</button>
      </div>

      <div class="chip-row" id="category-chips"></div>
      <div id="expense-list"></div>
    </div>
  `;
  document.getElementById('back-more-btn').onclick = () => renderMain();
  document.getElementById('add-expense-btn').onclick = async () => {
    const description = document.getElementById('expense-desc').value.trim();
    const amount = parseFloat(document.getElementById('expense-amount').value);
    const paidBy = document.getElementById('expense-paidby').value;
    const category = document.getElementById('expense-category').value;
    if (!description || !amount) return;
    try {
      await RoomData.addExpense(identity.roomId, sharedKey, { description, amount, paidBy, category });
      document.getElementById('expense-desc').value = '';
      document.getElementById('expense-amount').value = '';
      toast('Expense added');
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

    // The balance is always computed across EVERYTHING, not the filtered view —
    // a filter is for reading, it should never change what you owe.
    const totalMine = allExpenses.filter((e) => e.paidBy === lastKnownUid).reduce((s, e) => s + e.amount, 0);
    const totalTheirs = allExpenses.filter((e) => e.paidBy === identity.partnerUid).reduce((s, e) => s + e.amount, 0);
    const diff = totalMine - totalTheirs;
    let summaryText;
    let cls = 'even';
    if (Math.abs(diff) < 0.01) summaryText = "You're even.";
    else if (diff > 0) {
      summaryText = `${escapeHTML(identity.partnerName || 'They')} owes you ${(diff / 2).toFixed(2)}`;
      cls = 'positive';
    } else {
      summaryText = `You owe ${escapeHTML(identity.partnerName || 'them')} ${(Math.abs(diff) / 2).toFixed(2)}`;
      cls = 'negative';
    }
    summaryEl.innerHTML = `
      <div class="eyebrow">Balance</div>
      <div class="balance-value ${cls}">${summaryText}</div>
      <div class="balance-split">
        <span>You paid <strong>${totalMine.toFixed(2)}</strong></span>
        <span>${escapeHTML(identity.partnerName || 'They')} paid <strong>${totalTheirs.toFixed(2)}</strong></span>
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
      .map(
        (e, i) => `
      <div class="money-row" data-id="${e.id}" style="animation-delay:${i * 25}ms">
        <div class="grow">
          <div>${escapeHTML(e.description)}</div>
          <div class="row-meta">${
            e.paidBy === lastKnownUid ? 'You paid' : `${escapeHTML(identity.partnerName || 'They')} paid`
          } · ${escapeHTML(e.category)} · ${escapeHTML(relativeTime(e.createdAt))}</div>
        </div>
        <div class="money-amount">${e.amount.toFixed(2)}</div>
      </div>`
      )
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
        <input type="text" id="goal-label" placeholder="e.g. Flight to see her" style="margin-top:10px;" />
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

  function editGoal(goal) {
    if (!goal) return;
    const label = prompt('Goal name', goal.label);
    if (label === null) return;
    const target = prompt('Target amount', String(goal.target));
    if (target === null) return;
    RoomData.updateSavingsGoal(identity.roomId, sharedKey, goal.id, {
      label: label.trim() || goal.label,
      target: parseFloat(target) || goal.target,
    }).catch(() => toast("Couldn't update that goal"));
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
  document.getElementById('back-more-btn').onclick = () => renderMain();
  document.getElementById('add-letter-btn').onclick = async () => {
    const text = document.getElementById('letter-text').value.trim();
    const unlockDate = document.getElementById('letter-unlock').value;
    if (!text || !unlockDate) return;
    try {
      await RoomData.addLetter(identity.roomId, sharedKey, {
        text,
        unlockAt: new Date(unlockDate).toISOString(),
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
          Honest limit: these are local notifications. They arrive while Tidelight is open or still running in
          the background — but if the app is fully closed or your phone clears it from memory, nothing will
          come through until you open it again. Delivery to a closed app needs a server to send the push, which
          this app deliberately doesn't have.
        </p>
        ${
          perm === 'default'
            ? '<button class="btn-secondary" id="enable-notify-btn" style="margin-top:10px;">Turn on notifications</button>'
            : ''
        }
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

  const recoveryBtn = document.getElementById('setup-recovery-later-btn');
  if (recoveryBtn) recoveryBtn.onclick = () => renderRecoverySetupFromSettings();
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
  document.getElementById('back-settings-btn').onclick = () => renderSettings();
}

async function handleLogout() {
  const confirmed = identity.recoveryEmail
    ? confirm('Log out of Tidelight on this device? You can sign back in with your recovery email and password.')
    : confirm(
        "You haven't set up recovery. Logging out now will PERMANENTLY delete access to your account and paired room on this device — there is no way to undo this.\n\nAre you absolutely sure you want to log out?"
      );
  if (!confirmed) return;

  clearListeners();
  clearGlobalListeners();
  await clearIdentity();
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
function iconChevronDown() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" width="18" height="18"><path d="M5 9l7 7 7-7"/></svg>';
}

// ---------------- Privacy: blur on background, auto-lock on return ----------------
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('privacy-blur', document.hidden);
  if (document.hidden) {
    lastHiddenAt = Date.now();
    if (identity?.roomId && presenceEnabled()) clearTyping(identity.roomId);
  } else if (identity?.pinEnabled && lastHiddenAt && Date.now() - lastHiddenAt > 15000) {
    identity.secretKey = undefined;
    sharedKey = null;
    clearGlobalListeners();
    renderLockScreen();
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

boot();
