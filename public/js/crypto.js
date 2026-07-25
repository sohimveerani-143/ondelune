// crypto.js — all encryption happens here, client-side only.
import nacl from 'https://esm.sh/tweetnacl@1.0.3';
import naclutil from 'https://esm.sh/tweetnacl-util@0.15.1';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclutil;

export function generateKeyPair() {
  const kp = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
}

export function deriveSharedKey(theirPublicKeyB64, mySecretKeyB64) {
  const theirPub = decodeBase64(theirPublicKeyB64);
  const mySecret = decodeBase64(mySecretKeyB64);
  return nacl.box.before(theirPub, mySecret);
}

export function encryptText(plainText, sharedKey) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const messageUint8 = decodeUTF8(plainText);
  const box = nacl.secretbox(messageUint8, nonce, sharedKey);
  return { ciphertext: encodeBase64(box), nonce: encodeBase64(nonce) };
}

export function decryptText(ciphertextB64, nonceB64, sharedKey) {
  const box = decodeBase64(ciphertextB64);
  const nonce = decodeBase64(nonceB64);
  const opened = nacl.secretbox.open(box, nonce, sharedKey);
  if (!opened) throw new Error('Decryption failed — wrong key or tampered data');
  return encodeUTF8(opened);
}

export function encryptJSON(obj, sharedKey) {
  return encryptText(JSON.stringify(obj), sharedKey);
}

export function decryptJSON(ciphertextB64, nonceB64, sharedKey) {
  return JSON.parse(decryptText(ciphertextB64, nonceB64, sharedKey));
}

export function encryptBytes(bytes, sharedKey) {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(bytes, nonce, sharedKey);
  return { ciphertext: encodeBase64(box), nonce: encodeBase64(nonce) };
}

export function decryptBytes(ciphertextB64, nonceB64, sharedKey) {
  const box = decodeBase64(ciphertextB64);
  const nonce = decodeBase64(nonceB64);
  const opened = nacl.secretbox.open(box, nonce, sharedKey);
  if (!opened) throw new Error('Decryption failed');
  return opened;
}

export function randomToken(numBytes = 8) {
  return Array.from(nacl.randomBytes(numBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function computeRoomId(pubA, pubB) {
  const sorted = [pubA, pubB].sort().join('|');
  const enc = new TextEncoder().encode(sorted);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------- Passphrase-based encryption ----------------
// Used for (1) locking the private key at rest behind a PIN, and (2) encrypting
// a cloud backup of the private key behind a recovery password.
async function deriveAesKeyFromSecret(secretString, saltBytes, iterations = 150000) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(secretString),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptWithPassphrase(plainObj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKeyFromSecret(passphrase, salt);
  const data = new TextEncoder().encode(JSON.stringify(plainObj));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return {
    ciphertext: encodeBase64(new Uint8Array(cipherBuf)),
    salt: encodeBase64(salt),
    iv: encodeBase64(iv),
  };
}

export async function decryptWithPassphrase({ ciphertext, salt, iv }, passphrase) {
  const key = await deriveAesKeyFromSecret(passphrase, decodeBase64(salt));
  const cipherBuf = decodeBase64(ciphertext);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64(iv) },
    key,
    cipherBuf
  );
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// A short, human-comparable fingerprint of both public keys — read aloud once
// to confirm the pairing wasn't intercepted.
export async function safetyNumber(pubA, pubB) {
  const sorted = [pubA, pubB].sort().join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16).toUpperCase().match(/.{1,4}/g).join(' ');
}