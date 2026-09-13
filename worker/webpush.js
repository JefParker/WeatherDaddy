// Web Push for Cloudflare Workers, on WebCrypto alone — no Node crypto,
// no dependency. Two RFCs:
//
//   RFC 8291  Message Encryption for Web Push: ECDH (P-256) with the
//             subscription's public key, HKDF, and one AES-128-GCM
//             record in the `aes128gcm` content coding (RFC 8188).
//   RFC 8292  VAPID: an ES256-signed JWT in the Authorization header
//             that identifies this server to the push service.
//
// tools/webpush-test.mjs checks encryptPayload() against the worked
// example in RFC 8291 Appendix A byte for byte, so the crypto here is
// pinned to the spec rather than to "it seemed to work once".

const enc = new TextEncoder();

export function b64uToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// HKDF-SHA256 extract+expand in one WebCrypto call.
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8
  );
  return new Uint8Array(bits);
}

// Push services cap the encrypted body at 4 KiB; with one record of
// rs = 4096 the plaintext must leave room for the delimiter byte and
// the 16-byte GCM tag. Kept well under so a UTF-8 body can't creep over.
const RECORD_SIZE = 4096;
export const MAX_PLAINTEXT = RECORD_SIZE - 1 - 16 - 86;

// Encrypt `plaintext` (Uint8Array) for a PushSubscription's keys.
// Returns the complete aes128gcm body: header (salt, rs, keyid = the
// ephemeral public key) followed by the single ciphertext record.
//
// `overrides` is for the test vector only — a fixed salt and local key
// pair make the output deterministic. Production callers pass nothing.
export async function encryptPayload(plaintext, keys, overrides = {}) {
  const uaPublic   = b64uToBytes(keys.p256dh);
  const authSecret = b64uToBytes(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('p256dh must be a 65-byte uncompressed P-256 point');
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes');
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`payload too large (${plaintext.length} > ${MAX_PLAINTEXT})`);

  const local = overrides.localKeyPair ||
    await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256)
  );

  // RFC 8291 §3.3-3.4: IKM = HKDF(auth_secret, ecdh_secret, key_info, 32)
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, localPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // RFC 8188 §2.2: content-encryption key and nonce from a fresh salt.
  const salt  = overrides.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek   = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // One record: plaintext, then the 0x02 "last record" delimiter, no
  // extra padding. Record sequence number 0, so the nonce is used as-is.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record)
  );

  // aes128gcm header: salt(16) | rs(4, big-endian) | idlen(1) | keyid
  const header = new Uint8Array(16 + 4 + 1 + localPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = localPublic.length;
  header.set(localPublic, 21);
  return concat(header, ciphertext);
}

// Imported signing keys are cached per isolate: importKey is the slow
// part of signing and the key never changes between invocations.
const signingKeys = new Map();

async function vapidSigningKey(publicKey, privateKey) {
  let key = signingKeys.get(privateKey);
  if (key) return key;
  const pub = b64uToBytes(publicKey);
  if (pub.length !== 65) throw new Error('VAPID_PUBLIC_KEY must be a 65-byte uncompressed P-256 point');
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64u(pub.subarray(1, 33)),
    y: bytesToB64u(pub.subarray(33, 65)),
    d: privateKey,
  };
  key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  signingKeys.set(privateKey, key);
  return key;
}

// RFC 8292 §2-3: `vapid t=<JWT>, k=<public key>`. The audience is the
// push service origin, and a JWT may not live longer than 24 hours.
export async function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, ttlSec = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    sub: subject,
  })));
  const input = `${header}.${claims}`;
  const key = await vapidSigningKey(publicKey, privateKey);
  // WebCrypto ECDSA emits the raw r||s concatenation JWS wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)));
  return `vapid t=${input}.${bytesToB64u(sig)}, k=${publicKey}`;
}

// Deliver one push. `subscription` is { endpoint, p256dh, auth };
// `payload` is any JSON-serialisable value. Resolves to
//   { ok, status, gone }  — `gone` means the subscription is dead
//                          (404/410) and the caller should delete it.
// Never throws on an HTTP failure; throws only on a malformed input.
export async function sendPush(subscription, payload, vapid, { ttl = 6 * 3600, urgency = 'normal', topic } = {}) {
  const body = await encryptPayload(
    enc.encode(JSON.stringify(payload)),
    { p256dh: subscription.p256dh, auth: subscription.auth }
  );
  const headers = {
    'Authorization': await vapidAuthorization(subscription.endpoint, vapid),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    'TTL': String(ttl),
    'Urgency': urgency,
  };
  // A topic lets the push service collapse queued messages with the
  // same topic — a morning briefing should replace an undelivered one,
  // not stack behind it.
  if (topic) headers['Topic'] = topic;

  let res;
  try {
    res = await fetch(subscription.endpoint, { method: 'POST', headers, body });
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err && err.message };
  }
  const gone = res.status === 404 || res.status === 410;
  let error;
  if (!res.ok) {
    try { error = (await res.text()).slice(0, 200); } catch (_) {}
  }
  return { ok: res.ok, status: res.status, gone, error };
}
