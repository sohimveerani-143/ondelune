# Ondelune — setup guide

A quiet, private, end-to-end encrypted space for two. Everything is encrypted
on your device before it's ever sent anywhere — Firebase only ever stores unreadable ciphertext.

## What you need
- A free Google account (for Firebase)
- Node.js installed (just for the deploy step)
- 15–20 minutes

---

## Step 1 — Create a Firebase project
1. Go to https://console.firebase.google.com
2. **Add project** → any name (e.g. "ondelune") → Analytics can be skipped → **Create project**

## Step 2 — Register a Web App
1. Click the **</> (Web)** icon on the project overview page
2. Nickname it (e.g. "ondelune-web") → **Register app**
3. Copy the `firebaseConfig` object shown
4. Paste your values into `js/firebase-config.js`, replacing the placeholders:
   ```js
   export const firebaseConfig = {
     apiKey: "...",
     authDomain: "...",
     projectId: "...",
     storageBucket: "...",
     messagingSenderId: "...",
     appId: "..."
   };
   ```

## Step 3 — Enable Anonymous Authentication
1. **Build → Authentication → Get started**
2. Under **Sign-in method**, enable **Anonymous** → Save

## Step 4 — Create the Firestore Database
1. **Build → Firestore Database → Create database**
2. **Start in production mode**
3. Pick any nearby region → **Enable**

## Step 5 — Apply the security rules
1. In Firestore, open the **Rules** tab
2. Replace the contents with everything in `firestore.rules` from this project
3. **Publish**

## Step 6 — Test it locally *before* deploying (important!)
Don't open `index.html` by double-clicking it — browsers block the module
scripts this app needs when loaded as a local file (`file://`), and that's
exactly what causes a blank page. Instead, serve it over a real local address:

```bash
cd ondelune
python3 -m http.server 8000
```

Then open **http://localhost:8000** in your browser. If your Firebase config
is filled in correctly, you should see the "Welcome to Ondelune" screen — not
a blank one. If something's still wrong, the app will now show a visible error
explaining what happened instead of a blank screen.

## Step 7 — Deploy to Firebase Hosting (free)
```bash
npm install -g firebase-tools
firebase login
firebase init hosting
```

When prompted:
- **Use an existing project** → the one you created
- **Public directory** → type `.`
- **Configure as a single-page app?** → No
- **Set up automatic builds with GitHub?** → No
- If asked to overwrite `index.html` → **No**

Then:
```bash
firebase deploy --only hosting,firestore:rules
```

You'll get a live URL like `https://ondelune-xxxx.web.app`.

## Step 8 — Pair up
1. Open the URL, enter your name, tap **Create pairing link**
2. Send the link to your partner (WhatsApp, SMS, anything)
3. She opens it, enters her name, taps **Connect**
4. You're paired — permanently. There's no menu to unpair or add someone else;
   that's intentional.

## Install as an app
On both phones: open the site → **Add to Home Screen** (Chrome: menu → Add to
Home Screen; Safari: Share → Add to Home Screen).

---

## How the encryption works
- Each device generates its own keypair on first launch. The private key **never leaves the device**.
- Pairing exchanges public keys through Firestore (safe to share — that's the point of public-key crypto).
- Both devices independently derive the same shared secret (X25519 key exchange via `tweetnacl`, the same primitive family used in Signal).
- Every message, mood, event, list item, and photo is encrypted with that shared key **before** it touches Firestore. The server only ever holds ciphertext + a nonce.
- Firestore security rules additionally restrict all reads/writes to exactly the two paired accounts.

## What changed from the previous version
- Rebuilt from scratch with a calmer, more restrained visual identity — muted sage and dusty-ember tones instead of a single bright accent, Instrument Serif + Manrope typography, and a "two moons linked by a thread" as the one signature visual (each moon glows and breathes gently — the aesthetic risk taken here, kept quiet everywhere else).
- Fixed the root cause of the blank-page issue: removed a top-level `await` in the Firebase setup (unsupported in some older mobile browsers) and added a visible error screen so failures explain themselves instead of showing nothing.
- Added a local-testing step (Step 6) so config or environment issues surface before you deploy.

## Costs
Firebase's free "Spark" plan comfortably covers two people's daily use.

## Extending later
- Push notifications for new messages (Firebase Cloud Messaging)
- A true home-screen widget (would need a native wrapper, e.g. Capacitor)
- Voice notes (same encrypt-before-upload pattern as photos)
