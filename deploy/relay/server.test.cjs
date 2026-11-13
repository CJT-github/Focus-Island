'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { createRelayServer, LIMITS } = require('./server.cjs');
const connectionKey = 'a'.repeat(64), webhookToken = 'b'.repeat(64);
async function fixture(t, options = {}) {
  const server = createRelayServer({ connectionKey, webhookToken, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  function request(path, { method = 'GET', token, body, headers = {}, chunked = false, rawBody } = {}) {
    return new Promise((resolve, reject) => {
      const bytes = rawBody || (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)));
      const prepared = { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body !== undefined || rawBody ? { 'Content-Type': 'application/json' } : {}), ...headers };
      if (bytes.length && !chunked) prepared['Content-Length'] = bytes.length;
      const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: prepared }, res => {
        let data = [];
        res.on('data', item => data.push(item));
        res.on('end', () => {
          const text = Buffer.concat(data).toString();
          resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => req.destroy(new Error('test request timeout')));
      if (chunked) { req.write(bytes.subarray(0, Math.ceil(bytes.length / 2))); req.end(bytes.subarray(Math.ceil(bytes.length / 2))); }
      else req.end(bytes);
    });
  }
  return { server, port, request,
    post: (body, options = {}) => request('/api/webhook/' + webhookToken, { method: 'POST', body, ...options }),
    poll: () => request('/api/relay/messages', { token: connectionKey }),
    ack: ids => request('/api/relay/ack', { method: 'POST', token: connectionKey, body: { ids } }) };
}
test('startup requires different keys without exposing their values', () => {
  for (const settings of [{}, { connectionKey, webhookToken: connectionKey }, { connectionKey: 'bad', webhookToken }]) {
    assert.throws(() => createRelayServer(settings), error => !error.message.includes(connectionKey) && !error.message.includes(webhookToken));
  }
});
test('management and delivery credentials cannot authorize each other', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/relay/info')).status, 401);
  assert.equal((await app.request('/api/relay/info', { token: webhookToken })).status, 401);
  const info = await app.request('/api/relay/info', { token: connectionKey });
  assert.equal(info.status, 200);
  assert.deepEqual(info.body, { protocol: 1, webhookToken });
  assert.equal(info.headers['cache-control'], 'no-store');
  assert.equal(info.headers['access-control-allow-origin'], undefined);
  const wrong = await app.request('/api/webhook/' + connectionKey, { method: 'POST', body: { title: 'x' } });
  assert.equal(wrong.status, 401);
  assert.equal((await app.post({ title: 'x' }, { token: connectionKey })).status, 400);
});
test('native and Feishu text preserve order with forced source and normalized text', async t => {
  const app = await fixture(t);
  const native = await app.post({ id: 'job', app: ' CI ', title: 'Done', body: 'one\n二' });
  const text = await app.post({ msg_type: 'text', content: { text: 'hello' }, app: 'Bot' });
  assert.equal(native.status, 202);
  assert.equal(native.body.code, 0);
  assert.equal(text.status, 202);
  const { messages } = (await app.poll()).body;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].notification.source, 'webhook');
  assert.equal(messages[0].notification.app, 'CI');
  assert.equal(messages[1].notification.title, '新消息');
  assert.equal(messages[1].notification.body, 'hello');
  assert.match(messages[0].deliveryId, /^[a-f0-9]{64}$/);
});
test('old ACK does not delete a newer update or removal with the same notification id', async t => {
  const app = await fixture(t);
  await app.post({ id: 'same', title: 'before' });
  const first = (await app.poll()).body.messages[0].deliveryId;
  await app.post({ id: 'same', title: 'after' });
  await app.post({ type: 'removed', id: 'same' });
  assert.deepEqual((await app.ack([first])).body, { ok: true, acked: 1 });
  assert.deepEqual((await app.ack([first])).body, { ok: true, acked: 0 });
  const messages = (await app.poll()).body.messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].notification.title, 'after');
  assert.equal(messages[1].notification.type, 'removed');
  assert.notEqual(messages[0].deliveryId, messages[1].deliveryId);
});
test('poll is non-destructive, capped at twenty, and ACK validates before deletion', async t => {
  const app = await fixture(t);
  for (let index = 0; index < 25; index++) await app.post({ id: String(index), title: 'queued' });
  const one = (await app.poll()).body.messages;
  assert.equal(one.length, 20);
  assert.deepEqual((await app.poll()).body.messages, one);
  const invalid = await app.request('/api/relay/ack', { method: 'POST', token: connectionKey, body: { ids: [one[0].deliveryId, 'invalid'] } });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await app.poll()).body.messages, one);
  assert.equal((await app.ack(one.map(item => item.deliveryId))).body.acked, 20);
  assert.equal((await app.poll()).body.messages.length, 5);
});
test('queue capacity rejects new events without evicting old events', async t => {
  let time = 1700000000000;
  const app = await fixture(t, { now: () => time });
  for (let index = 0; index < LIMITS.queue; index++) {
    if (index % 50 === 0) time += LIMITS.rateMs;
    assert.equal((await app.post({ id: String(index), title: 'queued' })).status, 202);
  }
  time += LIMITS.rateMs;
  const full = await app.post({ id: 'overflow', title: 'no room' });
  assert.equal(full.status, 429);
  assert.equal(full.body.error, 'notification queue full');
  assert.equal((await app.poll()).body.messages[0].notification.id, '0');
  const id = (await app.poll()).body.messages[0].deliveryId;
  await app.ack([id]);
  assert.equal((await app.post({ id: 'new', title: 'space available' })).status, 202);
});
test('TTL expires at twenty-four hours and does not expire younger entries', async t => {
  let time = 1700000000000;
  const app = await fixture(t, { now: () => time });
  await app.post({ id: 'old', title: 'x' });
  time += 1000;
  await app.post({ id: 'new', title: 'x' });
  time += LIMITS.ttlMs - 1000;
  assert.deepEqual((await app.poll()).body.messages.map(item => item.notification.id), ['new']);
});
test('per-minute authenticated ingress limit resets; bad tokens do not consume it', async t => {
  let time = 1700000000000;
  const app = await fixture(t, { now: () => time });
  for (let index = 0; index < 5; index++) assert.equal((await app.request('/api/webhook/' + 'c'.repeat(64), { method: 'POST', body: { title: 'x' } })).status, 401);
  for (let index = 0; index < LIMITS.rate; index++) assert.equal((await app.post({ title: 'x' })).status, 202);
  const limited = await app.post({ title: 'blocked' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['retry-after'], '60');
  time += LIMITS.rateMs;
  assert.equal((await app.post({ title: 'allowed' })).status, 202);
});
test('rejects command fields, wrong types, controls, bidi, oversized text and invalid UTF-8', async t => {
  const app = await fixture(t);
  for (const body of [
    {}, null, [], { title: 'x', command: 'echo x' }, { title: 'x', source: 'phone' },
    { title: 1 }, { id: null, title: 'x' }, { type: 'removed' }, { body: '\u202ex' },
    { app: 'bad\nname', body: 'x' }, { title: '\ud800' }, { body: 'x'.repeat(2049) },
    { id: '界'.repeat(86), title: 'x' }, { msg_type: 'image', content: { text: 'x' } },
    { msg_type: 'text', content: { text: '' } }, { msg_type: 'text', content: { text: 'x', command: 'x' } },
  ]) assert.equal((await app.post(body)).status, 400, JSON.stringify(body));
  assert.equal((await app.post({ body: '😀'.repeat(2048) })).status, 202);
  assert.equal((await app.post({}, { rawBody: Buffer.from([0xff]) })).status, 400);
});
test('bounded standard HTTP parser supports chunked JSON and rejects oversized or compressed bodies', async t => {
  const app = await fixture(t);
  assert.equal((await app.post({ title: 'chunked' }, { chunked: true })).status, 202);
  assert.equal((await app.post({}, { rawBody: Buffer.alloc(16385, 120) })).status, 413);
  assert.equal((await app.post({}, { rawBody: Buffer.alloc(16385, 120), chunked: true })).status, 413);
  assert.equal((await app.post({ title: 'x' }, { headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await app.post({ title: 'x' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
});
test('wrong methods, query strings and browser-origin requests cannot access the API', async t => {
  const app = await fixture(t);
  for (const path of ['/api/webhook/' + webhookToken, '/api/relay/info?key=x', '/api/webhookfoo', '/']) assert.equal((await app.request(path, { token: connectionKey })).status, 404);
  assert.equal((await app.post({ title: 'x' }, { headers: { Origin: 'https://example.com' } })).status, 400);
  assert.equal((await app.request('/api/relay/info', { token: connectionKey, headers: { Origin: 'null' } })).status, 400);
});
test('raw duplicate auth, conflicting framing and too-large headers are rejected', async t => {
  const app = await fixture(t);
  async function raw(bytes) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(app.port, '127.0.0.1', () => socket.write(bytes));
      let data = '';
      socket.on('data', chunk => data += chunk);
      socket.on('error', error => data ? resolve(data) : reject(error));
      socket.on('close', () => resolve(data));
      socket.setTimeout(8000, () => socket.destroy(new Error('test timeout')));
    });
  }
  assert.match(await raw('GET /api/relay/info HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ' + connectionKey + '\r\nAuthorization: Bearer ' + connectionKey + '\r\n\r\n'), /^HTTP\/1.1 400/);
  assert.match(await raw('POST /api/webhook/' + webhookToken + ' HTTP/1.1\r\nHost: localhost\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}'), /^HTTP\/1.1 400/);
  assert.match(await raw('GET / HTTP/1.1\r\nHost: localhost\r\nX-Fill: ' + 'x'.repeat(9000) + '\r\n\r\n'), /^HTTP\/1.1 400/);
});
test('slow body has an absolute deadline despite continuing traffic', async t => {
  const app = await fixture(t);
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const socket = net.connect(app.port, '127.0.0.1', () => {
      socket.write('POST /api/webhook/' + webhookToken + ' HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n');
    });
    let data = '';
    const drip = setInterval(() => { if (!socket.destroyed) socket.write(' '); }, 100);
    socket.on('data', chunk => data += chunk);
    socket.on('error', error => data ? resolve(data) : reject(error));
    socket.on('close', () => { clearInterval(drip); resolve(data); });
    socket.setTimeout(6000, () => socket.destroy(new Error('deadline not enforced')));
  });
  assert.match(result, /^HTTP\/1.1 408/);
  assert.ok(Date.now() - started < 5000);
});
test('new server instance starts without prior in-memory notifications', async t => {
  const first = await fixture(t);
  await first.post({ title: 'private' });
  const second = await fixture(t);
  assert.equal((await second.poll()).body.messages.length, 0);
});

test('client aborts after partial and oversized uploads do not crash the server', async t => {
  const app = await fixture(t);
  for (const size of [20, 20000]) {
    await new Promise(resolve => {
      const socket = net.connect(app.port, '127.0.0.1', () => {
        socket.write('POST /api/webhook/' + webhookToken + ' HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n' + size.toString(16) + '\r\n' + 'x'.repeat(size));
        setTimeout(() => socket.destroy(), 20);
      });
      socket.on('error', () => {});
      socket.on('close', resolve);
    });
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await app.post({ title: 'still running' })).status, 202);
  assert.equal((await app.poll()).body.messages.length, 1);
});
test('initialization generates private distinct keys and never overwrites existing configuration', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { initialize, readConnectionKey, validDomain } = require('./init.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-relay-init-'));
  const envPath = path.join(directory, '.env');
  t.after(() => { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); fs.rmdirSync(directory); });
  for (const value of ['https://example.com', 'a/b', 'x\nWEBHOOK_TOKEN=x', '-bad.example', 'example.com:443', '127.0.0.1']) assert.equal(validDomain(value), false);
  initialize(directory, 'Notify.Example.com');
  const original = fs.readFileSync(envPath, 'utf8');
  const values = Object.fromEntries(original.trim().split('\n').map(line => line.split('=')));
  assert.equal(values.WEBHOOK_DOMAIN, 'notify.example.com');
  assert.match(values.RELAY_CONNECTION_KEY, /^[a-f0-9]{64}$/);
  assert.match(values.WEBHOOK_TOKEN, /^[a-f0-9]{64}$/);
  assert.notEqual(values.RELAY_CONNECTION_KEY, values.WEBHOOK_TOKEN);
  assert.equal(readConnectionKey(directory), values.RELAY_CONNECTION_KEY);
  assert.throws(() => initialize(directory, 'other.example.com'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(envPath, 'utf8'), original);
  if (process.platform !== 'win32') assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
});

test('connection-key reader rejects malformed, duplicate and missing values', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { readConnectionKey } = require('./init.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-relay-read-'));
  const envPath = path.join(directory, '.env');
  t.after(() => { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); fs.rmdirSync(directory); });
  assert.throws(() => readConnectionKey(directory));
  for (const text of [
    '', 'WEBHOOK_DOMAIN=example.com\n',
    'RELAY_CONNECTION_KEY=' + 'a'.repeat(63) + '\n',
    'RELAY_CONNECTION_KEY=' + 'g'.repeat(64) + '\n',
    'RELAY_CONNECTION_KEY=' + 'a'.repeat(64) + ' \n',
    'RELAY_CONNECTION_KEY=' + 'a'.repeat(64) + '\nRELAY_CONNECTION_KEY=' + 'b'.repeat(64) + '\n',
    'RELAY_CONNECTION_KEY="' + 'a'.repeat(64) + '"\n',
  ]) {
    fs.writeFileSync(envPath, text);
    assert.throws(() => readConnectionKey(directory), /missing or invalid/);
  }
  fs.writeFileSync(envPath, 'WEBHOOK_DOMAIN=example.com\r\nRELAY_CONNECTION_KEY=' + 'AB'.repeat(32) + '\r\n');
  assert.equal(readConnectionKey(directory), 'AB'.repeat(32));
});
test('initialization CLI accepts --domain without printing secrets or overwriting an existing env', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-relay-cli-'));
  const script = path.join(directory, 'init.cjs'), envPath = path.join(directory, '.env');
  fs.copyFileSync(path.join(__dirname, 'init.cjs'), script);
  t.after(() => { if (fs.existsSync(envPath)) fs.unlinkSync(envPath); fs.unlinkSync(script); fs.rmdirSync(directory); });
  const first = cp.spawnSync(process.execPath, [script, 'init', '--domain', 'Notify.Example.com'], { encoding: 'utf8', windowsHide: true });
  assert.equal(first.status, 0);
  const original = fs.readFileSync(envPath, 'utf8');
  const values = Object.fromEntries(original.trim().split('\n').map(line => line.split('=')));
  assert.equal(values.WEBHOOK_DOMAIN, 'notify.example.com');
  for (const key of [values.RELAY_CONNECTION_KEY, values.WEBHOOK_TOKEN]) assert.ok(!first.stdout.includes(key) && !first.stderr.includes(key));
  const duplicate = cp.spawnSync(process.execPath, [script, 'init', '--domain', 'other.example.com'], { encoding: 'utf8', windowsHide: true });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /refusing to replace/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), original);
  const shown = cp.spawnSync(process.execPath, [script, 'show-connection'], { encoding: 'utf8', windowsHide: true });
  assert.equal(shown.status, 0);
  assert.equal(shown.stdout.trim(), values.RELAY_CONNECTION_KEY);
  assert.ok(!shown.stdout.includes(values.WEBHOOK_TOKEN));
});
