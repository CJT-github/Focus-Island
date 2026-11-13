'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const LIMITS = Object.freeze({ body: 16384, headers: 8192, queue: 200, batch: 20, ttlMs: 86400000, rate: 60, rateMs: 60000 });
const hex64 = /^[a-fA-F0-9]{64}$/;
const deliveryPattern = /^[a-f0-9]{64}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function secretEqual(expected, actual) {
  const supplied = typeof actual === 'string' && hex64.test(actual) ? actual : ' '.repeat(64);
  return crypto.timingSafeEqual(Buffer.from(expected, 'ascii'), Buffer.from(supplied, 'ascii'));
}
function keysOnly(value, allowed) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new HttpError(400, 'invalid JSON fields');
}
function stringField(value, key, maximum, multiline = false) {
  if (!owns(value, key)) return '';
  const text = value[key];
  if (typeof text !== 'string' || !text.isWellFormed() || Array.from(text).length > maximum
      || Array.from(text).some(character => {
        const point = character.codePointAt(0);
        const invalid = point < 32 || (point >= 127 && point <= 159) || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069);
        return invalid && !(multiline && '\r\n\t'.includes(character));
      })) throw new HttpError(400, 'invalid notification text');
  return text.trim();
}
function decodeNotification(value, now) {
  let input = value;
  if (plainObject(input) && owns(input, 'msg_type')) {
    keysOnly(input, ['msg_type', 'content', 'id', 'app']);
    keysOnly(input.content, ['text']);
    if (input.msg_type !== 'text' || typeof input.content.text !== 'string' || !input.content.text.trim()) throw new HttpError(400, 'text content required');
    input = { type: 'posted', title: '新消息', body: input.content.text,
      ...(owns(input, 'id') ? { id: input.id } : {}), ...(owns(input, 'app') ? { app: input.app } : {}) };
  }
  keysOnly(input, ['type', 'id', 'app', 'title', 'body']);
  const type = owns(input, 'type') ? input.type : 'posted';
  if (type !== 'posted' && type !== 'removed') throw new HttpError(400, 'unsupported notification type');
  let id;
  if (owns(input, 'id')) {
    stringField(input, 'id', 256);
    if (!input.id.trim() || Buffer.byteLength(input.id) > 256) throw new HttpError(400, 'invalid notification id');
    id = input.id;
  } else {
    if (type === 'removed') throw new HttpError(400, 'removal id required');
    id = 'relay-' + now + '-' + crypto.randomBytes(8).toString('hex');
  }
  const app = stringField(input, 'app', 80) || 'Webhook';
  const title = stringField(input, 'title', 256);
  const body = stringField(input, 'body', 2048, true);
  if (type === 'posted' && !title && !body) throw new HttpError(400, 'title or body required');
  return { type, source: 'webhook', id, app, title, body, time: now };
}
function validateHeaders(req) {
  if (req.rawHeaders.length / 2 > 48) throw new HttpError(413, 'headers too large');
  const counts = new Map();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index].toLowerCase();
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  for (const name of ['authorization', 'content-type', 'content-length', 'host']) {
    if ((counts.get(name) || 0) > 1) throw new HttpError(400, 'duplicate request header');
  }
  if (!req.headers.host || req.headers.origin !== undefined || req.headers.upgrade !== undefined || req.headers.trailer !== undefined) throw new HttpError(400, 'unsupported request headers');
  if (req.headers.expect !== undefined) throw new HttpError(400, 'unsupported expectation');
}
function readJson(req) {
  const type = req.headers['content-type'];
  if (typeof type !== 'string') throw new HttpError(415, 'JSON content type required');
  const [mime, ...parameters] = type.split(';');
  if (mime.trim().toLowerCase() !== 'application/json' || parameters.some(value => value.trim().toLowerCase() !== 'charset=utf-8')) throw new HttpError(415, 'UTF-8 JSON required');
  if (req.headers['content-encoding'] !== undefined) throw new HttpError(415, 'compressed bodies are not supported');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > LIMITS.body)) throw new HttpError(413, 'body too large');
  return new Promise((resolve, reject) => {
    let total = 0;
    let chunks = [];
    let complete = false;
    const finish = (error, value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('aborted', onAborted);
      req.removeListener('error', onError);
      chunks = [];
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      total += chunk.length;
      if (total > LIMITS.body) { req.pause(); finish(new HttpError(413, 'body too large')); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (!req.complete) { finish(new HttpError(400, 'incomplete request')); return; }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
        finish(null, JSON.parse(text));
      } catch { finish(new HttpError(400, 'invalid notification JSON')); }
    };
    const onAborted = () => finish(new HttpError(400, 'incomplete request'));
    const onError = () => finish(new HttpError(400, 'invalid request'));
    const timer = setTimeout(() => { req.pause(); finish(new HttpError(408, 'request timeout')); }, 3000);
    timer.unref();
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
  });
}
function respond(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Connection': 'close' };
  if (status === 401) headers['WWW-Authenticate'] = 'Bearer';
  if (status === 429) headers['Retry-After'] = '60';
  res.writeHead(status, headers);
  res.end(body);
}
function createRelayServer({ connectionKey, webhookToken, now = Date.now } = {}) {
  if (!hex64.test(connectionKey || '') || !hex64.test(webhookToken || '') || connectionKey === webhookToken) {
    throw new Error('Configure two different 64-character hexadecimal keys');
  }
  const queue = new Map();
  let rateStarted = now();
  let rateCount = 0;
  let active = 0;
  const expire = () => {
    const cutoff = now() - LIMITS.ttlMs;
    for (const [id, entry] of queue) if (entry.notification.time <= cutoff) queue.delete(id);
  };
  const authenticate = req => {
    const value = req.headers.authorization;
    if (typeof value !== 'string' || value.length !== 71 || value.slice(0, 7).toLowerCase() !== 'bearer ' || !secretEqual(connectionKey, value.slice(7))) throw new HttpError(401, 'authentication required');
  };
  const server = http.createServer({
    maxHeaderSize: LIMITS.headers, insecureHTTPParser: false,
    headersTimeout: 3000, requestTimeout: 5000, connectionsCheckingInterval: 250,
    keepAliveTimeout: 1000, rejectNonStandardBodyWrites: true,
  }, (req, res) => {
    req.on('error', () => {});
    if (++active > 64) { --active; respond(res, 503, { ok: false, error: 'service busy' }); return; }
    let finished = false;
    const release = () => { if (!finished) { finished = true; --active; } };
    res.once('finish', release);
    res.once('close', release);
    (async () => {
      validateHeaders(req);
      expire();
      const path = req.url;
      if (req.method === 'GET' && path === '/healthz') {
        respond(res, 200, { ok: true }); return;
      }
      if (req.method === 'POST' && typeof path === 'string' && path.startsWith('/api/webhook/')) {
        if (!secretEqual(webhookToken, path.slice('/api/webhook/'.length))) throw new HttpError(401, 'authentication required');
        if (req.headers.authorization !== undefined) throw new HttpError(400, 'use the dedicated webhook URL');
        const current = now();
        if (current < rateStarted || current - rateStarted >= LIMITS.rateMs) { rateStarted = current; rateCount = 0; }
        if (++rateCount > LIMITS.rate) throw new HttpError(429, 'rate limit exceeded');
        const notification = decodeNotification(await readJson(req), now());
        expire();
        if (queue.size >= LIMITS.queue) throw new HttpError(429, 'notification queue full');
        const deliveryId = crypto.randomBytes(32).toString('hex');
        queue.set(deliveryId, { deliveryId, notification });
        respond(res, 202, { ok: true, code: 0, msg: 'success', id: notification.id }); return;
      }
      if ((req.method === 'GET' && (path === '/api/relay/info' || path === '/api/relay/messages')) || (req.method === 'POST' && path === '/api/relay/ack')) {
        authenticate(req);
        if (req.method === 'GET') {
          if (req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] || 0) !== 0) throw new HttpError(400, 'GET body is not supported');
          if (path === '/api/relay/info') respond(res, 200, { protocol: 1, webhookToken });
          else respond(res, 200, { messages: Array.from(queue.values()).slice(0, LIMITS.batch) });
          return;
        }
        const body = await readJson(req);
        keysOnly(body, ['ids']);
        if (!Array.isArray(body.ids) || body.ids.length > LIMITS.queue || body.ids.some(id => typeof id !== 'string' || !deliveryPattern.test(id))) throw new HttpError(400, 'invalid acknowledgement ids');
        let acked = 0;
        for (const id of new Set(body.ids)) if (queue.delete(id)) ++acked;
        respond(res, 200, { ok: true, acked }); return;
      }
      throw new HttpError(404, 'not found');
    })().catch(error => {
      respond(res, error instanceof HttpError ? error.status : 500, { ok: false, error: error instanceof HttpError ? error.message : 'internal error' });
    });
  });
  server.maxConnections = 64;
  // Inspect every header within the parser byte cap; reject rather than truncate.
  server.maxHeadersCount = 0;
  server.maxRequestsPerSocket = 16;
  server.setTimeout(6000, socket => socket.destroy());
  server.on('checkContinue', (req, res) => respond(res, 400, { ok: false, error: 'unsupported expectation' }));
  server.on('checkExpectation', (req, res) => respond(res, 400, { ok: false, error: 'unsupported expectation' }));
  server.on('upgrade', (req, socket) => socket.destroy());
  server.on('connect', (req, socket) => socket.destroy());
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  const cleanup = setInterval(expire, 60000);
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); queue.clear(); });
  return server;
}
if (require.main === module) {
  try {
    const server = createRelayServer({ connectionKey: process.env.RELAY_CONNECTION_KEY, webhookToken: process.env.WEBHOOK_TOKEN });
    server.on('error', () => { process.stderr.write('Relay listener failed\n'); process.exitCode = 1; });
    server.listen(17893, '0.0.0.0', () => process.stdout.write('Relay listening on port 17893\n'));
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close();
      server.closeAllConnections();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch { process.stderr.write('Relay configuration invalid: set two different 64-character hexadecimal keys\n'); process.exitCode = 1; }
}
module.exports = { createRelayServer, decodeNotification, LIMITS };
