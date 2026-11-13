'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
function validDomain(value) {
  return typeof value === 'string' && value.length <= 253 && !net.isIP(value)
    && value.split('.').length >= 2 && value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
}
function initialize(directory, domain) {
  if (!validDomain(domain)) throw new Error('Use a DNS domain only, without scheme, path or port');
  const connection = crypto.randomBytes(32).toString('hex');
  let ingress;
  do { ingress = crypto.randomBytes(32).toString('hex'); } while (ingress === connection);
  const contents = 'WEBHOOK_DOMAIN=' + domain.toLowerCase() + '\nRELAY_CONNECTION_KEY=' + connection + '\nWEBHOOK_TOKEN=' + ingress + '\n';
  fs.writeFileSync(path.join(directory, '.env'), contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}
function readConnectionKey(directory) {
  const content = fs.readFileSync(path.join(directory, '.env'), 'utf8');
  const entries = content.split(/\r?\n/).filter(line => line.startsWith('RELAY_CONNECTION_KEY='));
  if (entries.length !== 1 || !/^RELAY_CONNECTION_KEY=[a-fA-F0-9]{64}$/.test(entries[0])) throw new Error('Connection key missing or invalid');
  return entries[0].slice('RELAY_CONNECTION_KEY='.length);
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === 'init' && args[1] === '--domain') args.splice(1, 1);
    const [command, domain, ...extra] = args;
    if (command === 'init' && domain && !extra.length) {
      initialize(__dirname, domain);
      process.stdout.write('Created .env. Keep it private; no keys were printed.\n');
    } else if (command === 'show-connection' && !domain) {
      process.stdout.write(readConnectionKey(__dirname) + '\n');
    } else throw new Error('Invalid command');
  } catch (error) {
    process.stderr.write(error && error.code === 'EEXIST' ? '.env already exists; refusing to replace its keys.\n' : 'Initialization failed. Usage: node init.cjs init YOUR_DOMAIN | node init.cjs show-connection\n');
    process.exitCode = 1;
  }
}
module.exports = { initialize, readConnectionKey, validDomain };
