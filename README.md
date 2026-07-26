# Tidelight — setup guide

A quiet, private, end-to-end encrypted space for two. Everything is encrypted
on your device before it's ever sent anywhere — Firebase only ever stores unreadable ciphertext.

**This release uses the standard Firebase Hosting layout:** everything the browser
loads lives inside `public/`, with `firebase.json` and `firestore.rules` at the root
next to it. That's what lets `firebase init hosting` auto-detect the folder correctly.

**Your real Firebase credentials are NOT included in this zip.** You'll find
`public/js/firebase-config.example.js` — copy it to `public/js/firebase-config.js`
(same folder) and fill in your project's real values, or just drop in the
`firebase-config.js` you already had from before.

---

## What's in this release
- Renamed to **Tidelight**, full warm moonlit visual identity (coral/gold on deep navy)
- **Chat** (formerly Thread) — deleting any message removes it from the database
  entirely, for both people, no exceptions
- **Honest "Sending…" status** on your own messages, using Firestore's real
  pending-write signal (not a fake instant-success animation)
- **Mood-reactive home scene** — the shore figures in the hero illustration lean
  closer together when either (or both) of you logs a "Low" or "Really low" mood
  in Today; calm and upright otherwise
- **Profile pictures** — tap your own circle on Home to set a photo; both circles
  stack vertically at the top of the screen
- **Voice notes** in Chat — tap the mic, speak, tap again to send (auto-capped at
  60 seconds to stay well under Firestore's size limit)
- **Letters** — write something now, it stays hidden until a future date you pick
- **Memories** — pin any message in Chat to save it permanently in its own space,
  independent of the original
- **Expenses**, **Savings**, and **Journal** — tucked into the **More** tab, out of
  the main navigation
- Recovery accounts (email + password, recommended) with anonymous still available
- PIN app-lock, view-once photos, auto-blur on backgrounding
- A **Network Privacy** section in Settings with real DNS-over-HTTPS setup steps
- The fingerprint/safety-number feature was removed entirely, as requested

**Deliberately not included:** the Tic-Tac-Toe game (held off per your request).

---

## What you need
- A free Google account (for Firebase)
- Node.js installed (just for the deploy step)
- 15–20 minutes

## Step 1 — Create a Firebase project
1. Go to https://console.firebase.google.com
2. **Add project** → any name (e.g. "tidelight") → Analytics can be skipped → **Create project**

## Step 2 — Register a Web App
1. Click the **</> (Web)** icon on the project overview page
2. Nickname it (e.g. "tidelight-web") → **Register app**
3. Copy the `firebaseConfig` object shown
4. In `public/js/`, copy `firebase-config.example.js` to a new file named
   `firebase-config.js`, and paste your real values in:
   ```js
   export const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "...",
     measurementId: "..."
   };
   ```

## Step 3 — Enable both auth providers
1. **Build → Authentication → Sign-in method**
2. Enable **Anonymous**
3. Also enable **Email/Password** — recovery accounts need this specifically;
   without it you'll get an `auth/operation-not-allowed` error when setting up recovery

## Step 4 — Create the Firestore Database
1. **Build → Firestore Database → Create database**
2. **Start in production mode**
3. Pick any nearby region → **Enable**

## Step 5 — Apply the security rules
1. In Firestore, open the **Rules** tab
2. Replace the contents with everything in `firestore.rules` (at the project root, not inside `public/`)
3. **Publish**

## Step 6 — Test it locally *before* deploying
Don't open `public/index.html` by double-clicking it — browsers block module
scripts loaded via `file://`, which causes a blank page. Serve it properly instead:

```bash
cd tidelight-release/public
python3 -m http.server 8000
```

Open **http://localhost:8000**. You should see the "Welcome to Tidelight" screen.
If something's wrong, the app shows a visible error explaining what happened
instead of a blank screen.

## Step 7 — Deploy to Firebase Hosting (free)
```bash
npm install -g firebase-tools
firebase login
cd tidelight-release
firebase init hosting
```

When prompted:
- **Use an existing project** → the one you created
- **What do you want to use as your public directory?** → type `public` (it should
  actually auto-detect this folder already exists and offer to use it)
- **Configure as a single-page app?** → No
- **Set up automatic builds with GitHub?** → No
- If asked to overwrite `public/index.html` → **No**

Then:
```bash
firebase deploy --only hosting,firestore:rules
```

You'll get a live URL like `https://tidelight-xxxx.web.app`.

## Step 8 — Pair up
1. Open the URL, enter your name, tap **Create pairing link**
2. Send the link to your partner
3. She opens it, enters her name, taps **Connect**
4. You're paired — permanently, by design

## Install as an app
On both phones: open the site → **Add to Home Screen**.

---

## How the encryption works
- Each device generates its own keypair on first launch. The private key **never leaves the device**.
- Pairing exchanges public keys through Firestore (safe to share — that's the point of public-key crypto).
- Both devices independently derive the same shared secret (X25519 via `tweetnacl`, the same primitive family used in Signal).
- Every message, mood, event, list item, photo, voice note, and letter is encrypted with that shared key **before** it touches Firestore. The server only ever holds ciphertext + a nonce.
- Firestore security rules additionally restrict all reads/writes to exactly the two paired accounts.
- Deleting a message calls Firestore's delete directly — the whole document (including any embedded photo/audio, since there's no separate file storage layer) is removed in one atomic operation. Nothing is soft-deleted or orphaned.

## Honest limitations, stated plainly
- **Letters' "unlock date" is an honor-system UI gate, not cryptographic time-lock encryption** — the content is properly encrypted regardless, but a truly tamper-proof time-lock is a much heavier cryptographic primitive that wasn't built here.
- **No website can block a screenshot.** View-once photos and auto-blur reduce exposure; they don't prevent it. Real screenshot blocking needs a native app wrapper.
- **DNS-over-HTTPS helps but isn't full anonymity.** It's explained honestly in Settings, with real setup steps, not a fake toggle.

## Costs
Firebase's free "Spark" plan comfortably covers two people's daily use, including
voice notes and photos, given everything is compressed client-side before upload.

## Extending later
- The Tic-Tac-Toe game (deferred, not forgotten)
- Push notifications for new messages (Firebase Cloud Messaging)
- A true home-screen widget (needs a native wrapper, e.g. Capacitor)
