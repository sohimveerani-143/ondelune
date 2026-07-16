// crypto.js — all encryption happens here, client-side only.
// The server (Firestore) never sees plaintext and never sees keys.
import nacl from 'https://esm.sh/tweetnacl@1.0.3';
import naclutil from 'https://esm.sh/tweetnacl-util@0.15.1';

const { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } = naclutil;

// Generate a fresh identity keypair. secretKey NEVER leaves this device.
export function generateKeyPair() {
  const kp = nacl.box.keyPair();
  return {
    publicKey: encodeBase64(kp.publicKey),
    secretKey: encodeBase64(kp.secretKey),
  };
}

// Derive the shared symmetric key from my secret key + partner's public key.
// (X25519 ECDH under the hood — nacl.box.before returns a key usable with secretbox.)
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

// Deterministic room id both devices can compute independently once paired.
export async function computeRoomId(pubA, pubB) {
  const sorted = [pubA, pubB].sort().join('|');
  const enc = new TextEncoder().encode(sorted);
  const digest = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}