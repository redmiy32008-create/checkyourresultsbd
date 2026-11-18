'use strict';
/**
 * checkyourresultsbd.com – tiny dependency-free Node server (Node 18+).
 *
 *   node server.js            -> http://localhost:3000
 *
 * What it does
 *   GET  /api/captcha  -> opens a session with the official result portal and returns
 *                         its security question (e.g. "7 + 5") for the STUDENT to answer.
 *   POST /api/result   -> submits the student's details + their answer to the official
 *                         portal and returns the parsed result as JSON.
 *   everything else    -> serves index.html (and a favicon / robots.txt).
 *
 * Nothing about a student (roll, registration, result) is stored or logged.
 *
 * IMPORTANT: the official portal's field names and page layout can change. Everything
 * you may need to adjust lives in the CONFIG block below.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------------------ CONFIG */
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const OFFICIAL_BASE = (process.env.OFFICIAL_BASE || 'https://www.educationboardresults.gov.bd').replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';          // set to 1 behind nginx / Cloudflare
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 20;

// Our exam keys -> the values the official form expects.
const EXAMS = { ssc: 'ssc', ssc_voc: 'ssc_voc', hsc: 'hsc', hsc_voc: 'hsc_voc' };
const BOARDS = new Set(['barisal', 'chittagong', 'comilla', 'dhaka', 'dinajpur', 'jessore',
  'mymensingh', 'rajshahi', 'sylhet', 'madrasah', 'tec', 'dibs']);
// Official form field names.
const FIELD = { exam: 'exam', year: 'year', board: 'board', roll: 'roll', reg: 'reg', captcha: 'value_s', submit: 'button2' };
const DEFAULT_FORM_ACTION = '/result.php';
const CAPTCHA_FIELD_REGEX = /name\s*=\s*["']?value_s/i;
/* -------------------------------------------------------------------------- */

const UA = 'Mozilla/5.0 (compatible; CheckYourResultsBD/1.0; +https://checkyourresultsbd.com)';
const INDEX_FILE = path.join(__dirname, 'index.html');

/* ------------------------------------------------------------ html helpers */
function cp(n) { try { return String.fromCodePoint(n); } catch (_) { return ''; } }
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => cp(Number(n)))
    .replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&amp;/gi, '&');
}
function stripTags(s) {
  return decodeEntities(String(s).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function attr(tag, name) {
  const m = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
  return m ? decodeEntities(m[1] !== undefined ? m[1] : m[2]) : null;
}

/** Reads the portal home page: security question, hidden inputs and form action. */
function parseHome(html) {
  const idx = html.search(CAPTCHA_FIELD_REGEX);
  if (idx < 0) return null;

  // The question is plain text just before the answer box, e.g. "7 + 5 =".
  const before = stripTags(html.slice(Math.max(0, idx - 800), idx));
  const found = [...before.matchAll(/(\d{1,2})\s*\+\s*(\d{1,2})/g)].pop();
  if (!found) return null;

  const formStart = html.lastIndexOf('<form', idx);
  const formEndTag = html.indexOf('</form', idx);
  const formHtml = formStart >= 0 ? html.slice(formStart, formEndTag > 0 ? formEndTag : undefined) : html;

  const hidden = {};
  for (const m of formHtml.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if ((attr(tag, 'type') || '').toLowerCase() !== 'hidden') continue;
    const name = attr(tag, 'name');
    if (name) hidden[name] = attr(tag, 'value') || '';
  }

  let action = OFFICIAL_BASE + DEFAULT_FORM_ACTION;
  if (formStart >= 0) {
    const open = html.slice(formStart, html.indexOf('>', formStart) + 1);
    const a = attr(open, 'action');
    if (a) {
      try {
        const u = new URL(a, OFFICIAL_BASE + '/');
        if (u.origin === new URL(OFFICIAL_BASE).origin) action = u.toString(); // never post anywhere else
      } catch (_) { /* keep default */ }
    }
  }
  return { question: `${found[1]} + ${found[2]}`, hidden, action };
}

/** Turns the portal's result HTML into { info, grades, gpa } or an error code. */
function parseResult(html) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const info = [];
  const grades = [];
  // innermost rows only (the portal nests tables)
  for (const tr of body.matchAll(/<tr\b(?:(?!<tr\b)[\s\S])*?<\/tr>/gi)) {
    const cells = [...tr[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]));
    if (!cells.some(Boolean)) continue;
    const label = (s) => s.replace(/\s*:\s*$/, '').trim();

    if (cells.length === 3 && /^\d{2,4}$/.test(cells[0]) && cells[1] && cells[2]) {
      grades.push({ code: cells[0], subject: cells[1], grade: cells[2] });
    } else if (cells.length === 2 && cells[0] && cells[1]) {
      info.push({ label: label(cells[0]), value: cells[1] });
    } else if (cells.length === 4) {
      if (cells[0] && cells[1]) info.push({ label: label(cells[0]), value: cells[1] });
      if (cells[2] && cells[3]) info.push({ label: label(cells[2]), value: cells[3] });
    }
  }

  if (info.length >= 3) {
    let gpa = '';
    for (const i of info) {
      const m = /(?:^|\b)(?:c?gpa)\s*[=:]?\s*(\d(?:\.\d{1,2})?)/i.exec(`${i.label} ${i.value}`) ||
                (/^c?gpa$/i.test(i.label) && /(\d(?:\.\d{1,2})?)/.exec(i.value));
      if (m) { gpa = m[1]; break; }
    }
    return { ok: true, info: info.slice(0, 40), grades: grades.slice(0, 40), gpa };
  }

  const text = stripTags(body).toLowerCase();
  if (/(captcha|security|verification|sum|answer)/.test(text) && /(wrong|invalid|incorrect|not match|mismatch|failed)/.test(text)) {
    return { ok: false, status: 422, code: 'BAD_CAPTCHA', error: 'The answer to the security question was wrong. Please answer the new question.' };
  }
  if (/(not\s+(?:been\s+)?found|no result|not (?:yet\s+)?published|does not exist|no record|invalid roll|invalid registration|result not)/.test(text)) {
    return { ok: false, status: 404, code: 'NOT_FOUND', error: 'No result found for these details. Check your exam, year, board, roll and registration number — or the result may not be published yet.' };
  }
  return { ok: false, status: 502, code: 'UNAVAILABLE', error: "We couldn't read the board's reply right now. Please try again, or use the official portal." };
}

/* ---------------------------------------------------------------- upstream */
function parseSetCookies(res, jar) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const pair = c.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}
async function upstream(url, { method = 'GET', jar, body, referer } = {}) {
    const headers = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', 
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 
        'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
        'Referer': 'http://www.educationboardresults.gov.bd/'
    };
    if (jar && Object.keys(jar).length) headers.Cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (referer) headers.Referer = referer;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers.Origin = new URL(OFFICIAL_BASE).origin; }
    const res = await fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (jar) parseSetCookies(res, jar);
    const text = (await res.text()).slice(0, 2_000_000);
    return { status: res.status, text };
}
/* ---------------------------------------------------------------- sessions */
const sessions = new Map();
const SESSION_TTL = 5 * 60 * 1000;
const MAX_SESSIONS = 5000;
setInterval(() => { const now = Date.now(); for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k); }, 60 * 1000).unref();

/* ------------------------------------------------------------- rate limits */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_LIMIT_PER_MIN;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60000) hits.delete(k); }, 60 * 1000).unref();
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xf) return xf;
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ----------------------------------------------------------------- helpers */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type }, SEC_HEADERS, extra || {}));
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', { 'Cache-Control': 'no-store' });
}
function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0e7ff"/><stop offset=".5" stop-color="#a78bfa"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><path d="M32 4C22 18 12 28 12 40a20 20 0 0 0 40 0C52 28 42 18 32 4Z" fill="url(#g)"/></svg>';

/* ------------------------------------------------------------------ routes */
async function handleCaptcha(req, res) {
  try {
    const jar = {};
    const home = await upstream(OFFICIAL_BASE + '/', { jar });
    const parsed = home.status === 200 ? parseHome(home.text) : null;
    if (!parsed) {
      return json(res, 502, { ok: false, code: 'UNAVAILABLE', error: "We couldn't reach the board's result system right now. Please try again in a moment, or use the official portal." });
    }
    if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { jar, hidden: parsed.hidden, action: parsed.action, exp: Date.now() + SESSION_TTL });
    json(res, 200, { ok: true, token, question: parsed.question });
  } catch (_) {
    json(res, 502, { ok: false, code: 'UNAVAILABLE', error: "We couldn't reach the board's result system right now. Please try again in a moment, or use the official portal." });
  }
}

async function handleResult(req, res) {
  let b;
  try { b = await readJson(req); } catch (_) { return json(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Invalid request.' }); }

  const exam = String(b.exam || ''), board = String(b.board || ''), year = String(b.year || '');
  const roll = String(b.roll || ''), reg = String(b.reg || ''), answer = String(b.answer || ''), token = String(b.token || '');
  const maxYear = new Date().getFullYear();
  if (!Object.prototype.hasOwnProperty.call(EXAMS, exam) || !BOARDS.has(board) ||
      !/^\d{4}$/.test(year) || Number(year) < 2000 || Number(year) > maxYear ||
      !/^\d{3,10}$/.test(roll) || !/^\d{4,12}$/.test(reg) || !/^\d{1,3}$/.test(answer) || !/^[a-f0-9]{32}$/.test(token)) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'Please check the details you entered and try again.' });
  }

  const s = sessions.get(token);
  sessions.delete(token); // single use
  if (!s || s.exp < Date.now()) {
    return json(res, 410, { ok: false, code: 'SESSION_EXPIRED', error: 'The security question expired. We loaded a new one — please answer it and try again.' });
  }

  try {
    const params = new URLSearchParams(Object.assign({}, s.hidden, {
      [FIELD.exam]: EXAMS[exam], [FIELD.year]: year, [FIELD.board]: board,
      [FIELD.roll]: roll, [FIELD.reg]: reg, [FIELD.captcha]: answer, [FIELD.submit]: 'Submit'
    }));
    const r = await upstream(s.action, { method: 'POST', jar: s.jar, body: params.toString(), referer: OFFICIAL_BASE + '/' });
    const out = parseResult(r.text);
    if (out.ok) return json(res, 200, out);
    json(res, out.status, { ok: false, code: out.code, error: out.error });
  } catch (_) {
    json(res, 502, { ok: false, code: 'UNAVAILABLE', error: "We couldn't reach the board's result system right now. Please try again in a moment, or use the official portal." });
  }
}

function createServer() {
  const indexHtml = fs.readFileSync(INDEX_FILE);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;

      if (p === '/api/captcha' || p === '/api/result') {
        if (limited(clientIp(req))) return json(res, 429, { ok: false, code: 'RATE_LIMITED', error: 'Too many requests. Please wait a minute and try again.' });
        if (p === '/api/captcha' && req.method === 'GET') return await handleCaptcha(req, res);
        if (p === '/api/result' && req.method === 'POST') return await handleResult(req, res);
        return json(res, 405, { ok: false, code: 'METHOD', error: 'Method not allowed.' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
      if (p === '/' || p === '/index.html') return send(res, 200, indexHtml, 'text/html; charset=utf-8', { 'Cache-Control': 'no-cache' });
      if (p === '/favicon.svg') return send(res, 200, FAVICON, 'image/svg+xml', { 'Cache-Control': 'public, max-age=86400' });
      if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\nDisallow: /api/\n', 'text/plain; charset=utf-8');
      if (p === '/health') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    } catch (_) {
      if (!res.headersSent) json(res, 500, { ok: false, code: 'ERROR', error: 'Something went wrong. Please try again.' });
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => console.log(`CheckYourResultsBD running on http://${HOST}:${PORT}  (official source: ${OFFICIAL_BASE})`));
  process.on('unhandledRejection', (e) => console.error('unhandledRejection', e && e.message));
} else {
  module.exports = { parseHome, parseResult, createServer };
}
