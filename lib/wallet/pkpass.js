// Assembling a .pkpass: pass.json and the images, manifest.json (the SHA-1
// of each file), the signature over the manifest, all zipped.

const crypto = require('crypto');
const { signDetached } = require('./sign');
const { zip } = require('./zip');

async function buildPkpass(passJson, images, signer, now = new Date()) {
  const files = { 'pass.json': Buffer.from(JSON.stringify(passJson, null, 2)), ...images };
  const manifest = {};
  Object.keys(files).sort().forEach((name) => {
    manifest[name] = crypto.createHash('sha1').update(files[name]).digest('hex');
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const signature = await signDetached(manifestBytes, signer, now);
  return zip({ ...files, 'manifest.json': manifestBytes, signature }, now);
}

module.exports = { buildPkpass };
