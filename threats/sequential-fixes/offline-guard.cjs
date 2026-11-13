const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const dgram = require('node:dgram');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { fileURLToPath } = require('node:url');

const blocked = () => { throw new Error('POST_FIX_REVIEW_NETWORK_BLOCKED'); };
net.Socket.prototype.connect = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
dgram.createSocket = blocked;
globalThis.fetch = async () => blocked();

function assertSafeRead(value) {
  if (typeof value === 'number') return;
  const name = value instanceof URL ? fileURLToPath(value) : String(value);
  if (/(^|\/)\.env(?:\.[^/]*)?$/.test(name)
      || /(^|\/)(?:id_rsa|id_ed25519|wallet\.json|keypair\.json|credentials\.json)$/.test(name)
      || /\.(?:pem|key)$/.test(name)) {
    throw new Error('POST_FIX_REVIEW_CREDENTIAL_FILE_READ_BLOCKED');
  }
}
for (const method of ['readFileSync', 'readFile', 'createReadStream']) {
  const original = fs[method];
  fs[method] = function (name, ...args) {
    assertSafeRead(name);
    return original.call(this, name, ...args);
  };
}
const originalRead = fsp.readFile;
fsp.readFile = async function (name, ...args) {
  assertSafeRead(name);
  return originalRead.call(this, name, ...args);
};
require('node:module').syncBuiltinESMExports();
