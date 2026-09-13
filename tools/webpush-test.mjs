// Pins worker/webpush.js to RFC 8291 Appendix A: encrypting the example
// plaintext with the example keys and salt must reproduce the example
// body byte for byte. Also round-trips a VAPID header through WebCrypto
// verification. No dependencies; Node 20+.
//
//     node tools/webpush-test.mjs

import { encryptPayload, vapidAuthorization, b64uToBytes, bytesToB64u } from '../worker/webpush.js';

const V = {
  plaintext:   'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  uaPublic:    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate:   'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  asPublic:    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate:   'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  auth:        'BTBZMqHH6r4Tts7J_aSIgg',
  salt:        'DGv6ra1nlYgDCS1FRnbzlw',
  expected:    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// --- RFC 8291 Appendix A -------------------------------------------------
const asPub = b64uToBytes(V.asPublic);
const jwk = {
  kty: 'EC', crv: 'P-256',
  x: bytesToB64u(asPub.subarray(1, 33)),
  y: bytesToB64u(asPub.subarray(33, 65)),
  d: V.asPrivate,
};
const localKeyPair = {
  privateKey: await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  publicKey:  await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, true, []),
};
const body = await encryptPayload(
  b64uToBytes(V.plaintext),
  { p256dh: V.uaPublic, auth: V.auth },
  { salt: b64uToBytes(V.salt), localKeyPair }
);
const got = bytesToB64u(body);
check('RFC 8291 A: ciphertext matches', got === V.expected, got === V.expected ? `${body.length} bytes` : `\n  got  ${got}\n  want ${V.expected}`);

// Decrypt it back with the receiver's private key, the way a browser does,
// to prove the example isn't the only shape that works.
{
  const uaPub = b64uToBytes(V.uaPublic);
  const uaPriv = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    x: bytesToB64u(uaPub.subarray(1, 33)), y: bytesToB64u(uaPub.subarray(33, 65)), d: V.uaPrivate,
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const fresh = await encryptPayload(new TextEncoder().encode('{"title":"hi"}'), { p256dh: V.uaPublic, auth: V.auth });
  const salt = fresh.subarray(0, 16), idlen = fresh[20], keyid = fresh.subarray(21, 21 + idlen), ct = fresh.subarray(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaPriv, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...keyid]);
  const ikm = await hk(b64uToBytes(V.auth), secret, info, 32);
  const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const rec = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  const text = new TextDecoder().decode(rec.subarray(0, rec.length - 1));
  check('fresh random-key payload decrypts', text === '{"title":"hi"}' && rec[rec.length - 1] === 2, text);
}

// --- VAPID ---------------------------------------------------------------
{
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  const privateKey = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
  const header = await vapidAuthorization(endpoint, { publicKey, privateKey, subject: 'https://weatherdaddy.app' });
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  check('VAPID header shape', !!m && m[2] === publicKey);
  const [h, c, s] = m[1].split('.');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, b64uToBytes(s), new TextEncoder().encode(`${h}.${c}`));
  const claims = JSON.parse(new TextDecoder().decode(b64uToBytes(c)));
  check('VAPID signature verifies', ok);
  check('VAPID claims', claims.aud === 'https://fcm.googleapis.com' && claims.sub === 'https://weatherdaddy.app' && claims.exp - Math.floor(Date.now() / 1000) <= 24 * 3600, JSON.stringify(claims));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall webpush checks pass');
process.exit(failures ? 1 : 0);
