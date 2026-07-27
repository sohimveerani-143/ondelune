# Push notifications — one-time setup

The code for real, closed-app push is already in the project. It stays dormant
until these three steps are done. Nothing else in the app depends on them, so
it's safe to ship before finishing this — you just keep the local-only
notifications until it's live.

Everything below happens **once**, on your machine, against your Firebase
project (`tether-7228f`).

---

## 1. Turn on the Blaze plan

Cloud Functions require the pay-as-you-go **Blaze** plan. For two people it will
almost certainly cost nothing (the free allowances are enormous), but a card is
required.

Firebase Console → ⚙️ → **Usage and billing** → **Modify plan** → Blaze.

## 2. Add the Web Push (VAPID) key

Firebase Console → ⚙️ → **Project settings** → **Cloud Messaging** tab →
**Web configuration** → **Web Push certificates**.

- If there's no key pair, click **Generate key pair**.
- Copy the **Key pair** value (a long `B…` string).

Paste it into [`public/js/firebase-config.js`](public/js/firebase-config.js):

```js
export const vapidKey = "PASTE_THE_KEY_PAIR_VALUE_HERE";
```

That key is public — it's fine to commit.

## 3. Deploy the function (and the rules)

From the project root, once:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules,hosting
```

`firebase deploy --only functions` alone is enough after the first time you've
also shipped hosting; the combined command above just keeps everything in sync.

---

## How to confirm it works

You need **two genuinely separate devices** (or one phone + one desktop),
paired as usual, with notifications enabled in Settings on both.

1. On phone A, open Tidelight once (this registers its push token), then
   **fully close it** — swipe it away from recents.
2. On device B, send a message.
3. Phone A should get a notification within a few seconds, reading
   **“Tidelight — New message 🌙”**.

If it doesn't:

- **Nothing arrives:** check `firebase functions:log` for send errors, and
  confirm phone A actually has a token doc at
  `rooms/<roomId>/push/<uidA>` in Firestore.
- **“unconfigured” in the app:** the VAPID key in `firebase-config.js` is still
  empty, or the browser didn't pick up the change (use Settings → *Reload a
  fresh copy*).
- **iPhone:** web push only works when the app has been **added to the Home
  Screen** (Share → Add to Home Screen) and opened from there, on iOS 16.4+.

---

## What the server can and can't see

The function reads only: which two accounts share a room (already needed for
security rules) and the recipient's push token. It **cannot** read a single
message — those are encrypted with a key that never leaves your phones. That's
why every push says the same content-free line (“New message”, “thinking of
you”) instead of a preview. The real preview is shown only by the app itself,
after decrypting on-device. End-to-end encryption is fully intact.
