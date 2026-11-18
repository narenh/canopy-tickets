// Signing a Wallet pass: a detached PKCS#7 (CMS SignedData) signature over
// manifest.json, made with the Pass Type ID certificate, with Apple's WWDR
// intermediate in the certificate set and a signing time. That's the
// `signature` file in every .pkpass.
//
// Node's crypto can sign but can't build CMS structures, so pkijs and
// asn1js do that part and WebCrypto does the RSA. Ported from the door-pass
// server (canopy-passserver, src/sign.ts), which Wallet accepts.

const asn1js = require('asn1js');
const pkijs = require('pkijs');
const { webcrypto } = require('crypto');

pkijs.setEngine('node', new pkijs.CryptoEngine({ name: 'node', crypto: webcrypto }));

const OID_DATA = '1.2.840.113549.1.7.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';

// DER bodies of every PEM block with this label (e.g. "CERTIFICATE").
function pemBlocks(pem, label) {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`, 'g');
  return Array.from(String(pem || '').matchAll(re), (m) => new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')));
}

// A PKCS#1 RSAPrivateKey wrapped as PKCS#8, which WebCrypto imports.
function pkcs1ToPkcs8(pkcs1) {
  const info = new asn1js.Sequence({
    value: [
      new asn1js.Integer({ value: 0 }),
      new asn1js.Sequence({ value: [new asn1js.ObjectIdentifier({ value: OID_RSA_ENCRYPTION }), new asn1js.Null()] }),
      new asn1js.OctetString({ valueHex: pkcs1 })
    ]
  });
  return new Uint8Array(info.toBER());
}

async function importKey(pem) {
  let der = pemBlocks(pem, 'PRIVATE KEY')[0];
  if (!der) {
    const rsa = pemBlocks(pem, 'RSA PRIVATE KEY')[0];
    if (!rsa) throw new Error('the pass key has no unencrypted PRIVATE KEY or RSA PRIVATE KEY block');
    der = pkcs1ToPkcs8(rsa);
  }
  return webcrypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function loadSigner({ certPem, keyPem, wwdrPem }) {
  const certs = pemBlocks(certPem, 'CERTIFICATE').map((der) => pkijs.Certificate.fromBER(der));
  if (!certs.length) throw new Error('the pass certificate has no CERTIFICATE block');
  const wwdr = pemBlocks(wwdrPem, 'CERTIFICATE').map((der) => pkijs.Certificate.fromBER(der));
  if (!wwdr.length) throw new Error("Apple's WWDR certificate has no CERTIFICATE block");
  return { cert: certs[0], chain: [...certs.slice(1), ...wwdr], key: await importKey(keyPem) };
}

// DER SET OF wants its members sorted by their encodings.
function derSorted(attrs) {
  return attrs
    .map((a) => ({ a, der: Buffer.from(a.toSchema().toBER()) }))
    .sort((x, y) => Buffer.compare(x.der, y.der))
    .map((e) => e.a);
}

async function signDetached(content, signer, now = new Date()) {
  const digest = await webcrypto.subtle.digest('SHA-256', content);
  const signedAttrs = derSorted([
    new pkijs.Attribute({ type: OID_CONTENT_TYPE, values: [new asn1js.ObjectIdentifier({ value: OID_DATA })] }),
    // UTCTime has whole seconds.
    new pkijs.Attribute({ type: OID_SIGNING_TIME, values: [new asn1js.UTCTime({ valueDate: new Date(Math.floor(now.getTime() / 1000) * 1000) })] }),
    new pkijs.Attribute({ type: OID_MESSAGE_DIGEST, values: [new asn1js.OctetString({ valueHex: digest })] })
  ]);
  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID_DATA }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: signer.cert.issuer, serialNumber: signer.cert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: signedAttrs })
      })
    ],
    certificates: [signer.cert, ...signer.chain]
  });
  await signedData.sign(signer.key, 0, 'SHA-256', content);
  const info = new pkijs.ContentInfo({ contentType: OID_SIGNED_DATA, content: signedData.toSchema(true) });
  return Buffer.from(info.toSchema().toBER());
}

module.exports = { loadSigner, signDetached, pemBlocks };
