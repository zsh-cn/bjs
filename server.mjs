#!/usr/bin/env node
/* ------------------------------------------------------------------
   BJS · 国家授时中心 NTP 代理 + 静态站点
   ------------------------------------------------------------------
   零依赖。启动：
     node server.mjs
     → http://127.0.0.1:8787

   浏览器不能直接发送 UDP 数据包，因此由本服务以 SNTP 协议访问
   公共 NTP 服务器，再把校准后的时间通过 /api/time 提供给页面。
------------------------------------------------------------------- */

import http from 'node:http';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';

const NTP_HOSTS = (process.env.NTP_HOSTS ||
  'ntp.ntsc.ac.cn,ntp1.nim.ac.cn,ntp.cnnic.cn,ntp.aliyun.com,ntp.tencent.com')
  .split(',')
  .map(function (host) { return host.trim(); })
  .filter(Boolean);
const NTP_TIMEOUT = Number(process.env.NTP_TIMEOUT) || 2500;
const CACHE_MS = 60 * 1000;
const NTP_EPOCH_OFFSET = 2208988800;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

/* ---------------- SNTP ---------------- */

function readNtpTime(buffer, offset) {
  const seconds = buffer.readUInt32BE(offset);
  const fraction = buffer.readUInt32BE(offset + 4);
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction / 4294967296) * 1000;
}

function queryNtp(host) {
  return new Promise(function (resolvePromise, reject) {
    const socket = dgram.createSocket('udp4');
    const packet = Buffer.alloc(48);
    packet[0] = 0x1b; // LI = 0, VN = 3, Mode = 3 (client)

    const t1 = Date.now();
    packet.writeUInt32BE((Math.floor(t1 / 1000) + NTP_EPOCH_OFFSET) >>> 0, 40);
    packet.writeUInt32BE(Math.floor(((t1 % 1000) / 1000) * 4294967296) >>> 0, 44);

    let finished = false;
    let timer;

    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(); } catch (e) { /* ignore */ }
      if (error) reject(error);
      else resolvePromise(value);
    }

    timer = setTimeout(function () {
      finish(new Error('NTP 请求超时'));
    }, NTP_TIMEOUT);

    socket.once('error', function (error) {
      finish(error);
    });

    socket.once('message', function (message, rinfo) {
      const t4 = Date.now();
      const perfAt = performance.now();

      try {
        if (message.length < 48) throw new Error('NTP 响应长度异常');

        const leap = message[0] >> 6;
        const mode = message[0] & 0x07;
        const stratum = message[1];

        if (mode !== 4) throw new Error('NTP 响应模式异常');
        if (leap === 3) throw new Error('授时服务器尚未同步');
        if (stratum === 0) {
          const ref = message.toString('ascii', 12, 16).replace(/\0/g, '');
          throw new Error('授时服务器拒绝服务' + (ref ? '（' + ref + '）' : ''));
        }

        const t2 = readNtpTime(message, 32);
        const t3 = readNtpTime(message, 40);
        if (!(t2 > 0) || !(t3 > 0)) throw new Error('NTP 时间戳无效');

        const offset = ((t2 - t1) + (t3 - t4)) / 2;
        const delay = (t4 - t1) - (t3 - t2);

        finish(null, {
          host: host,
          ip: rinfo.address,
          offset: offset,
          delay: delay,
          stratum: stratum,
          leap: leap,
          trueTime: t4 + offset,
          perfAt: perfAt
        });
      } catch (error) {
        finish(error);
      }
    });

    socket.send(packet, 123, host, function (error) {
      if (error) finish(error);
    });
  });
}

async function collectSample() {
  const errors = [];

  for (const host of NTP_HOSTS) {
    try {
      const sample = await queryNtp(host);
      if (sample.delay >= 0 && Math.abs(sample.offset) < 86400000) {
        sample.attempts = 1;
        return sample;
      }
      errors.push(host + '：样本异常');
    } catch (error) {
      errors.push(host + '：' + error.message);
    }
  }

  const error = new Error('所有 NTP 服务器均不可用');
  error.causes = errors;
  throw error;
}

let cache = null;
let pending = null;

function refreshSample() {
  if (!pending) {
    pending = collectSample()
      .then(function (sample) {
        cache = sample;
        return sample;
      })
      .finally(function () {
        pending = null;
      });
  }
  return pending;
}

function getSample() {
  if (cache) {
    // 过期后先返回缓存，同时后台刷新，避免每次同步都等待 NTP。
    if (performance.now() - cache.perfAt > CACHE_MS) {
      refreshSample().catch(function () { /* 保留旧样本 */ });
    }
    return Promise.resolve(cache);
  }
  return refreshSample();
}

/* ---------------- HTTP ---------------- */

function sendJson(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {}));
  res.end(body);
}

async function handleTime(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
    return;
  }

  const started = performance.now();

  try {
    const sample = await getSample();
    const generatedAt = performance.now();
    const now = sample.trueTime + (generatedAt - sample.perfAt);
    const processingMs = generatedAt - started;

    sendJson(res, 200, {
      ok: true,
      server: sample.host,
      ip: sample.ip,
      time: Math.round(now),
      processingMs: Math.round(processingMs * 1000) / 1000,
      offsetMs: Math.round(sample.offset * 1000) / 1000,
      rttMs: Math.round(sample.delay * 1000) / 1000,
      stratum: sample.stratum,
      leap: sample.leap,
      sampledAt: new Date(sample.trueTime).toISOString()
    });
  } catch (error) {
    sendJson(res, 502, {
      ok: false,
      error: error.message,
      causes: error.causes || []
    });
  }
}

function notFound(res) {
  const body = '<!doctype html><meta charset="utf-8"><title>404</title>' +
    '<style>body{font:14px/1.6 system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b0b0e;color:#f2f1ec}a{color:#ff6554}</style>' +
    '<p>404 · <a href="/">返回 BJS</a></p>';
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';
  if (pathname.indexOf('\0') !== -1) {
    notFound(res);
    return;
  }

  const filePath = resolve(ROOT, '.' + pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  // 只暴露站点文件，server.mjs、README 等不会被下载。
  const rel = relative(ROOT, filePath);
  const isPublic = rel === 'index.html' || rel === 'favicon.svg' ||
    rel.startsWith('css' + sep) || rel.startsWith('js' + sep) || rel.startsWith('assets' + sep);
  if (!isPublic || rel.startsWith('..')) {
    notFound(res);
    return;
  }

  let data;
  try {
    data = await readFile(filePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR') {
      notFound(res);
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Internal Server Error');
    }
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const noCache = ['.html', '.css', '.js', '.mjs', '.json'].includes(ext);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': noCache ? 'no-cache' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer(function (req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (url.pathname === '/api/time') {
    handleTime(req, res);
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, ntp: NTP_HOSTS, cached: Boolean(cache) });
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  serveStatic(req, res, pathname);
});

server.on('error', function (error) {
  if (error.code === 'EADDRINUSE') {
    console.error('\n端口 ' + PORT + ' 已被占用，可用 PORT=8788 node server.mjs 更换端口。\n');
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, function () {
  const displayHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log('');
  console.log('  BJS · 北京时间');
  console.log('  → http://' + displayHost + ':' + PORT);
  console.log('  NTP: ' + NTP_HOSTS.join(', '));
  console.log('');

  getSample().catch(function (error) {
    console.warn('  NTP 预热失败：' + error.message);
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, function () {
    server.close(function () { process.exit(0); });
  });
}
