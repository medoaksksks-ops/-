/**
 * ============================================================================
 * LAROZA PLAYER — SCRAPER / API / WEB UI SERVER                    v3.0.0
 * ============================================================================
 * Single-file Node.js server (Node >= 18, no required dependencies).
 *
 * What changed vs v2.2 (summary):
 *  - Follows the site's domain redirects (laroza1.lat -> laroza-tv.cfd ...) and
 *    keeps working on the new origin; optional FALLBACK_BASES mirrors.
 *  - HTTPS certificate verification is ON. No proxy rotation, no Cloudflare
 *    bypass: a challenge/403 puts the scraper in a cooldown and the API answers
 *    503 SOURCE_BLOCKED (stale cache is served when available).
 *  - New HTML tokenizer (HtmlDoc) instead of fragile whole-page regexes.
 *  - Series support (view-serie1.php): seasons + all episodes, sorted.
 *  - Search (live + local archive, Arabic normalisation, de-duplication, paging),
 *    real related suggestions (no random items), category paging.
 *  - Play page: all embed servers + primary server + publicly exposed direct
 *    sources (MP4 / HLS) with per-source status:
 *      available | unavailable | failed | unsupported
 *    No DRM handling, no decryption, no protection bypass.
 *  - Cache: TTL + stale-if-error + in-flight de-duplication; failed/partial
 *    results are never stored; atomic disk persistence.
 *  - New RTL UI: two playback modes (Laroza servers / direct), HLS.js,
 *    retry, fullscreen, mobile layout, episode navigation that keeps the mode.
 *
 * Env (all optional):
 *   PORT, HOST, BASE_URL, FALLBACK_BASES (comma list), ADOPT_REDIRECTS=0,
 *   USER_AGENT, REQUEST_DELAY_MS, CONCURRENCY, MAX_RETRIES, ADMIN_TOKEN,
 *   CORS_ORIGIN, RATE_LIMIT_PER_MIN, DATA_DIR, DEBUG=1, ALLOW_PRIVATE_HOSTS=1
 *   (tests only), AUTO_SCRAPE=1
 * ============================================================================
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');

try { require('dotenv').config(); } catch (e) { /* dotenv is optional */ }

// ============================================================================
// CONFIGURATION
// ============================================================================

const intEnv = (name, def) => {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? n : def;
};
const listEnv = (name, def) =>
  String(process.env[name] !== undefined ? process.env[name] : def)
    .split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);

const CONFIG = {
  VERSION: '3.0.0',
  BASE_URL: (process.env.BASE_URL || 'https://laroza1.lat').replace(/\/+$/, ''),
  FALLBACK_BASES: listEnv('FALLBACK_BASES', 'https://laroza-tv.cfd'),
  ADOPT_REDIRECTS: process.env.ADOPT_REDIRECTS !== '0',
  HOME_PATH: '/home.24',

  PORT: intEnv('PORT', 3030),
  HOST: process.env.HOST || '0.0.0.0',

  REQUEST_TIMEOUT: intEnv('REQUEST_TIMEOUT', 20000),
  MAX_RETRIES: intEnv('MAX_RETRIES', 2),
  RETRY_DELAY_MS: 1000,
  REQUEST_DELAY_MS: intEnv('REQUEST_DELAY_MS', 400),
  CONCURRENCY: Math.max(1, intEnv('CONCURRENCY', 2)),
  MAX_HTML_BYTES: 3 * 1024 * 1024,

  USER_AGENT: process.env.USER_AGENT || 'Mozilla/5.0 (compatible; LarozaPlayer/3.0)',
  ALLOW_PRIVATE_HOSTS: process.env.ALLOW_PRIVATE_HOSTS === '1',

  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'laroza_data'),
  MAX_CARDS: 6000,
  MAX_DETAILS: 800,

  TTL: {
    HOME: 5 * 60e3,
    LIST: 10 * 60e3,
    SEARCH: 10 * 60e3,
    SERIES: 15 * 60e3,
    VIDEO: 3 * 3600e3,
    PLAY: 3 * 3600e3,
    PARTIAL: 60e3,
    SOURCES: 10 * 60e3,
    DOWNLOADS: 30 * 60e3,
    MIN_FORCE_AGE: 60e3
  },
  STALE_WINDOW_MS: 24 * 3600e3,

  RATE_LIMIT_PER_MIN: intEnv('RATE_LIMIT_PER_MIN', 180),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || '',

  // Category keys observed on the live site (menu + footer, Nov 2026).
  CATEGORIES: {
    'arabic-movies35': { name: 'أفلام عربية', type: 'movie' },
    'all_movies_13': { name: 'أفلام أجنبية', type: 'movie' },
    'indian-movies9': { name: 'أفلام هندية', type: 'movie' },
    '6-asian-movies': { name: 'أفلام آسيوية', type: 'movie' },
    'anime-movies-7': { name: 'أفلام أنمي', type: 'movie' },
    '7-aflammdblgh': { name: 'أفلام مدبلجة', type: 'movie' },
    '8-aflam3isk': { name: 'أفلام تركية', type: 'movie' },
    'ramadan-2026': { name: 'مسلسلات رمضان 2026', type: 'series' },
    'arabic-series46': { name: 'مسلسلات عربية', type: 'series' },
    'turkish-3isk-seriess47': { name: 'مسلسلات تركية', type: 'series' },
    'turkish-3isk-seriess48': { name: 'مسلسلات تركية (2)', type: 'series' },
    'english-series10': { name: 'مسلسلات أجنبية', type: 'series' },
    '11indian-series': { name: 'مسلسلات هندية', type: 'series' },
    '6-asya': { name: 'مسلسلات آسيوية', type: 'series' },
    '6-anime-series': { name: 'أنمي وكرتون', type: 'series' },
    'tv-programs12': { name: 'برامج تلفزيونية', type: 'other' },
    'masrh-5': { name: 'مسرحيات', type: 'other' }
  },

  // Hosts whose embed pages we are willing to read (on demand only) to find
  // directly exposed media URLs. Nothing is decoded or unpacked.
  FRIENDLY_HOSTS: [
    'streamhls', 'vidmoly', 'voe.sx', 'mixdrop', 'dsvplay', 'okhd.site',
    'film77', 'vidoba', 'mp4plus', 'anafast', 'vidspeed', 'hgcloud',
    'upzur', 'vidara'
  ],
  DOWNLOAD_HOSTS: [
    'voe.sx', 'ok.ru', '1cloudfile', 'multiup', 'uploady', 'usersdrive',
    'mediafire', 'mega.nz', 'drive.google', 'mixdrop', 'upstream', 'dood'
  ]
};

// ============================================================================
// UTILITIES
// ============================================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowISO = () => new Date().toISOString();

const Logger = {
  info: (...a) => console.log(`[${nowISO()}] [INFO]`, ...a),
  warn: (...a) => console.warn(`[${nowISO()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${nowISO()}] [ERROR]`, ...a),
  ok: (...a) => console.log(`[${nowISO()}] [OK]`, ...a),
  debug: (...a) => { if (process.env.DEBUG === '1') console.log(`[${nowISO()}] [DEBUG]`, ...a); }
};

function clampInt(v, min, max, def) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const v = map[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function cleanText(t) {
  return decodeEntities(String(t || '').replace(/<[^>]*>/g, ' '))
    .replace(/[\s\u200b-\u200f\u202a-\u202e]+/g, ' ').trim();
}

/** Arabic-aware normalisation used for local search and title matching. */
function normalizeArabic(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const ID_RE = /^[A-Za-z0-9_-]{3,40}$/;
const isValidId = v => typeof v === 'string' && ID_RE.test(v);

function resolveUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.href;
  } catch (_) { return null; }
}
function getParam(href, key, base) {
  try { return new URL(href, base || 'http://x/').searchParams.get(key); } catch (_) { return null; }
}
function pathOf(href, base) {
  try { return new URL(href, base || 'http://x/').pathname; } catch (_) { return ''; }
}
function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (_) { return ''; }
}

const ORDINALS = {
  'الاول': 1, 'الأول': 1, 'الثاني': 2, 'الثانيه': 2, 'الثالث': 3, 'الرابع': 4, 'الخامس': 5,
  'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9, 'العاشر': 10
};
const EP_RE = /(?:الحلقة|الحلقه|حلقة|حلقه|episode|ep)\s*[:\-]?\s*(\d{1,4})/i;

function episodeFromText(t) {
  const m = String(t || '').match(EP_RE);
  return m ? parseInt(m[1], 10) : null;
}
function seasonFromText(t) {
  const m = String(t || '').match(/(?:الموسم|موسم|season)\s*(?:ال)?\s*(\d{1,2}|[\u0621-\u064A]+)/i);
  if (!m) return null;
  if (/^\d+$/.test(m[1])) return parseInt(m[1], 10);
  const key = m[1].replace(/ي$/, 'ي');
  return ORDINALS[key] || null;
}

/** "مسلسل X الموسم الاول الحلقة 5 مترجمة"  ->  "X" */
function stripShowTitle(title) {
  let t = cleanText(title);
  const cut = t.search(/\s(?:الموسم|موسم|الحلقة|الحلقه|حلقة)(?=\s|\d|$)/);
  if (cut > 0) t = t.slice(0, cut);
  t = t.replace(/^(?:مشاهدة\s+)?(?:مسلسل|انمي|أنمي|فيلم|برنامج|مسرحية)\s+/, '');
  t = t.replace(/\s+(?:HD|FHD|اون لاين|أون لاين|كامل|كاملة|مترجم|مترجمة|مدبلج|مدبلجة|WEB-?DL|WEB-?BL|تصوير)(?=\s|$)/gi, '');
  return t.trim();
}
const showKey = title => normalizeArabic(stripShowTitle(title));

function guessType(title, hint) {
  const t = String(title || '');
  if (EP_RE.test(t)) return 'episode';
  if (/فيلم/.test(t)) return 'movie';
  if (/مسرحية/.test(t)) return 'play';
  if (/برنامج/.test(t)) return 'show';
  return hint || 'movie';
}

// ---------- network safety --------------------------------------------------

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}
const hostCheckCache = new Map();
async function isPublicHost(hostname) {
  if (CONFIG.ALLOW_PRIVATE_HOSTS) return true;
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIP(h)) return !isPrivateIP(h);
  const hit = hostCheckCache.get(h);
  if (hit && Date.now() < hit.exp) return hit.ok;
  let ok = false;
  try {
    const addrs = await dns.lookup(h, { all: true });
    ok = addrs.length > 0 && addrs.every(a => !isPrivateIP(a.address));
  } catch (_) { ok = false; }
  hostCheckCache.set(h, { ok, exp: Date.now() + 5 * 60e3 });
  return ok;
}

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || 'ERROR'; }
}
class SourceBlockedError extends HttpError {
  constructor(message, retryAfter) { super(503, message, 'SOURCE_BLOCKED'); this.retryAfter = retryAfter || 30; }
}

async function readBody(res, maxBytes, truncate) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(Buffer.from(value));
    if (size > maxBytes) {
      try { await reader.cancel(); } catch (_) { /* ignore */ }
      if (truncate) break;
      throw new HttpError(502, 'response too large', 'TOO_LARGE');
    }
  }
  const buf = Buffer.concat(chunks);
  return truncate ? buf.subarray(0, maxBytes) : buf;
}

function decodeBody(buf, headers) {
  const ct = (headers.get && headers.get('content-type')) || '';
  const m = ct.match(/charset=([\w-]+)/i);
  const cs = m ? m[1].toLowerCase() : 'utf-8';
  try { return new TextDecoder(cs).decode(buf); } catch (_) { return buf.toString('utf8'); }
}

/**
 * One HTTP(S) request with manual redirect handling (every hop is validated),
 * timeout covering the body read, and a body size cap.
 * Certificates are always verified (no rejectUnauthorized override).
 */
async function httpRequest(rawUrl, opts = {}) {
  const {
    method = 'GET', headers = {}, timeout = CONFIG.REQUEST_TIMEOUT,
    maxBytes = CONFIG.MAX_HTML_BYTES, maxRedirects = 5,
    trustedHosts = null, truncate = false
  } = opts;
  let url = rawUrl;
  const chain = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(url); } catch (_) { throw new HttpError(400, 'bad url', 'BAD_URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'unsupported protocol', 'BAD_URL');
    const trusted = trustedHosts && trustedHosts.has(u.hostname.toLowerCase());
    if (!trusted && !(await isPublicHost(u.hostname))) throw new HttpError(400, 'blocked non-public host', 'BLOCKED_HOST');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      let res;
      try {
        res = await fetch(url, { method, headers, redirect: 'manual', signal: ctrl.signal });
      } catch (e) {
        if (e.name === 'AbortError') throw new HttpError(504, 'timeout', 'TIMEOUT');
        throw new HttpError(502, 'network error: ' + ((e.cause && e.cause.code) || e.message), 'NETWORK');
      }
      const loc = res.headers.get('location');
      if ([301, 302, 303, 307, 308].includes(res.status) && loc) {
        try { await res.body.cancel(); } catch (_) { /* ignore */ }
        url = new URL(loc, url).href;
        chain.push(url);
        continue;
      }
      let body;
      try { body = await readBody(res, maxBytes, truncate); }
      catch (e) {
        if (e instanceof HttpError) throw e;
        if (e.name === 'AbortError') throw new HttpError(504, 'timeout', 'TIMEOUT');
        throw new HttpError(502, 'network error: ' + e.message, 'NETWORK');
      }
      return { status: res.status, headers: res.headers, body, url, chain };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new HttpError(502, 'too many redirects', 'REDIRECT_LOOP');
}

// ============================================================================
// CACHE
// ============================================================================

class TTLCache {
  constructor(max = 600) { this.max = max; this.map = new Map(); }
  entry(k) { return this.map.get(k); }
  get(k) {
    const e = this.map.get(k);
    return e && Date.now() <= e.exp ? e.val : undefined;
  }
  getStale(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (Date.now() > e.exp + CONFIG.STALE_WINDOW_MS) { this.map.delete(k); return undefined; }
    return e.val;
  }
  set(k, val, ttl) {
    this.map.delete(k);
    this.map.set(k, { val, exp: Date.now() + ttl, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// ============================================================================
// HTML TOKENIZER  (no regex over whole-page semantics: tags are tokenised once,
// attributes are parsed properly, everything else works on the token list)
// ============================================================================

function parseAttrs(str) {
  const attrs = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const k = m[1].toLowerCase();
    const v = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    if (!(k in attrs)) attrs[k] = decodeEntities(v);
  }
  return attrs;
}

class HtmlDoc {
  constructor(html, baseUrl) {
    this.html = String(html || '').replace(/<!--[\s\S]*?-->/g, '');
    this.base = baseUrl || CONFIG.BASE_URL + '/';
    this.nodes = [];
    this.anchors = [];
    this.imgs = [];
    this.headings = [];
    this.scripts = [];
    this._text = null;
    this._tokenize();
    this._build();
  }

  _tokenize() {
    const html = this.html;
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const close = m[1] === '/';
      const tag = m[2].toLowerCase();
      const node = { tag, close, start: m.index, end: re.lastIndex, attrs: close ? {} : parseAttrs(m[3]) };
      this.nodes.push(node);
      if (!close && (tag === 'script' || tag === 'style')) {
        const cre = new RegExp('</' + tag + '\\b', 'ig');
        cre.lastIndex = re.lastIndex;
        const cm = cre.exec(html);
        const endText = cm ? cm.index : html.length;
        if (tag === 'script') this.scripts.push({ attrs: node.attrs, text: html.slice(re.lastIndex, endText), start: node.start });
        re.lastIndex = endText;
      }
    }
  }

  _build() {
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.close) continue;
      if (n.tag === 'a') {
        let j = i + 1;
        while (j < nodes.length && !(nodes[j].tag === 'a')) j++;
        const closing = j < nodes.length && nodes[j].close ? nodes[j] : null;
        const stop = j < nodes.length ? nodes[j].start : this.html.length;
        const innerHtml = this.html.slice(n.end, stop);
        this.anchors.push({
          href: n.attrs.href || '', title: cleanText(n.attrs.title || ''), attrs: n.attrs,
          innerHtml, text: cleanText(innerHtml),
          start: n.start, end: closing ? closing.end : n.end
        });
      } else if (n.tag === 'img') {
        this.imgs.push({ attrs: n.attrs, pos: n.start });
      } else if (/^h[1-4]$/.test(n.tag)) {
        let j = i + 1;
        while (j < nodes.length && !(nodes[j].tag === n.tag && nodes[j].close)) j++;
        const stop = j < nodes.length ? nodes[j].start : n.end;
        const innerHtml = this.html.slice(n.end, stop);
        this.headings.push({ tag: n.tag, start: n.start, innerHtml, text: cleanText(innerHtml) });
      }
    }
  }

  abs(href) { return resolveUrl(href, this.base); }
  openTags(...tags) { return this.nodes.filter(n => !n.close && (!tags.length || tags.includes(n.tag))); }
  text() { if (this._text === null) this._text = cleanText(this.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')); return this._text; }

  meta(key) {
    const k = key.toLowerCase();
    for (const n of this.nodes) {
      if (n.tag !== 'meta' || n.close) continue;
      const name = (n.attrs.property || n.attrs.name || '').toLowerCase();
      if (name === k && n.attrs.content) return cleanText(n.attrs.content);
    }
    return '';
  }
  titleTag() {
    const i = this.nodes.findIndex(n => n.tag === 'title' && !n.close);
    if (i < 0) return '';
    const j = this.nodes.findIndex((n, idx) => idx > i && n.tag === 'title' && n.close);
    return cleanText(this.html.slice(this.nodes[i].end, j > 0 ? this.nodes[j].start : this.nodes[i].end + 200));
  }
  jsonBlocks() {
    const out = [];
    for (const s of this.scripts) {
      const type = (s.attrs.type || '').toLowerCase();
      const t = s.text.trim();
      if (type.includes('json') || /^[\[{]/.test(t)) {
        try { out.push(JSON.parse(t)); } catch (_) { /* not JSON */ }
      }
    }
    return out;
  }
}

function walkJson(obj, cb, depth = 0) {
  if (depth > 8 || obj === null) return;
  if (typeof obj === 'string') { cb(obj); return; }
  if (Array.isArray(obj)) { obj.forEach(v => walkJson(v, cb, depth + 1)); return; }
  if (typeof obj === 'object') Object.values(obj).forEach(v => walkJson(v, cb, depth + 1));
}

// ---------- media URL discovery ---------------------------------------------

function classifyMedia(u) {
  try {
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith('.m3u8')) return 'hls';
    if (/\.(mp4|m4v|webm)$/.test(p)) return 'mp4';
  } catch (_) { /* ignore */ }
  return null;
}

/** Finds quoted URLs ending in .m3u8/.mp4/.webm in arbitrary text (JS/JSON). */
function extractMediaUrlsFromText(text, base) {
  const t = String(text || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/g, '&');
  const re = /(["'`])((?:https?:)?\/\/[^"'`\s<>\\]+|\/[^"'`\s<>\\]*\.(?:m3u8|mp4|webm|m4v)[^"'`\s<>\\]*)\1/gi;
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    const abs = resolveUrl(m[2], base);
    if (abs && classifyMedia(abs)) out.push(abs);
  }
  return out;
}

/** Collects publicly exposed media URLs from a parsed document. */
function collectMedia(doc) {
  const found = new Set();
  for (const n of doc.openTags('video', 'source')) {
    if (n.attrs.src) { const a = doc.abs(n.attrs.src); if (a && classifyMedia(a)) found.add(a); }
  }
  for (const s of doc.scripts) extractMediaUrlsFromText(s.text, doc.base).forEach(u => found.add(u));
  for (const block of doc.jsonBlocks()) {
    walkJson(block, str => {
      const a = resolveUrl(str, doc.base);
      if (a && classifyMedia(a)) found.add(a);
    });
  }
  return [...found].map(url => ({ url, type: classifyMedia(url) }));
}

// ============================================================================
// PAGE PARSERS
// ============================================================================

const JUNK_TITLES = new Set(['', 'شاهد الآن', 'التفاصيل', 'شاهد', 'مشاهدة الكل', '▶', 'مشاهدة', 'عرض المواسم والحلقات']);
const DURATION_RE = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;

function imgSrc(attrs) {
  for (const k of ['data-src', 'data-original', 'data-lazy-src', 'src']) {
    const v = attrs[k];
    if (v && !/^data:/i.test(v)) return v;
  }
  return '';
}
function pickImg(doc, from, to, last) {
  const list = doc.imgs.filter(i => i.pos >= from && i.pos <= to && imgSrc(i.attrs));
  if (!list.length) return null;
  const i = last ? list[list.length - 1] : list[0];
  return { src: imgSrc(i.attrs), alt: cleanText(i.attrs.alt || '') };
}

function cardKind(a, base) {
  if (!a.href) return null;
  const p = pathOf(a.href, base);
  if (/\/video\.php$/i.test(p)) { const id = getParam(a.href, 'vid', base); return id ? { kind: 'video', id } : null; }
  if (/\/view-serie\d*\.php$/i.test(p)) { const id = getParam(a.href, 'ser', base); return id ? { kind: 'series', id } : null; }
  return null;
}

/** Video / series cards in document order, merged by id. */
function extractCards(doc) {
  const items = [];
  for (const a of doc.anchors) {
    const k = cardKind(a, doc.base);
    if (k && isValidId(k.id)) items.push({ a, kind: k.kind, id: k.id });
  }
  const map = new Map();
  for (let i = 0; i < items.length; i++) {
    const { a, kind, id } = items[i];
    const prevEnd = i > 0 ? items[i - 1].a.end : 0;
    const nextStart = i + 1 < items.length ? items[i + 1].a.start : doc.html.length;
    const before = doc.html.slice(Math.max(prevEnd, a.start - 300), a.start);
    const afterEnd = Math.min(nextStart, a.end + 900);
    const after = doc.html.slice(a.end, afterEnd);

    const key = kind + ':' + id;
    let c = map.get(key);
    if (!c) {
      c = { kind, id, vid: kind === 'video' ? id : null, ser: kind === 'series' ? id : null, title: '', thumbnail: '', duration: '', rating: '', pos: a.start, url: doc.abs(a.href) };
      map.set(key, c);
    }
    if (!c.title) {
      let t = a.title || a.text;
      if (JUNK_TITLES.has(t) || /^[\d:\s]+$/.test(t)) t = '';
      if (!t) {
        const h = doc.headings.find(h => h.start > a.end && h.start < afterEnd);
        t = h ? h.text : '';
      }
      if (!t) { const im = pickImg(doc, a.start, afterEnd, false); if (im && im.alt) t = im.alt; }
      if (t) c.title = t;
    }
    if (!c.thumbnail) {
      const im = pickImg(doc, a.start, a.end, false) || pickImg(doc, a.start - 300, a.start, true) || pickImg(doc, a.end, afterEnd, false);
      if (im) c.thumbnail = doc.abs(im.src) || '';
    }
    if (!c.duration) {
      const inner = a.text.match(DURATION_RE);
      const bef = before.replace(/<[^>]*>/g, ' ').match(DURATION_RE);
      c.duration = (bef && bef[bef.length - 1]) || (inner && inner[0]) || '';
    }
    if (!c.rating) {
      const r = after.replace(/<[^>]*>/g, ' ').match(/⭐\s*([\d.]+)/);
      if (r) c.rating = r[1];
    }
  }
  const out = [];
  for (const c of map.values()) {
    if (!c.title) continue;
    if (!c.thumbnail && c.kind === 'video') c.thumbnail = doc.abs('/uploads/thumbs/' + c.id + '-1.jpg') || '';
    c.type = c.kind === 'series' ? 'series' : guessType(c.title);
    c.showTitle = stripShowTitle(c.title);
    out.push(c);
  }
  return out;
}

function extractPagination(doc, currentPage) {
  const pages = new Set();
  for (const a of doc.anchors) {
    if (!a.href || a.href === '#') continue;
    const p = parseInt(getParam(a.href, 'page', doc.base), 10);
    if (Number.isFinite(p) && p > 0) pages.add(p);
  }
  const list = [...pages].sort((x, y) => x - y);
  const maxPage = list.length ? list[list.length - 1] : currentPage;
  return { pages: list, maxPage, hasNext: list.some(p => p > currentPage) };
}

/** Home sections: headings that link to a category page or the "new" page. */
function extractSections(doc, cards) {
  const marks = [];
  for (const h of doc.headings) {
    if (h.tag === 'h1') continue;
    const m = h.innerHtml.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!m) continue;
    const p = pathOf(m[1], doc.base);
    const cat = getParam(m[1], 'cat', doc.base);
    if (/\/category\.php$/i.test(p) && cat) marks.push({ pos: h.start, title: h.text, cat });
    else if (/\/newvideos1?\.php$/i.test(p)) marks.push({ pos: h.start, title: h.text, cat: null, isNew: true });
  }
  const sections = [];
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].pos : Infinity;
    const items = cards.filter(c => c.kind === 'video' && c.pos > mk.pos && c.pos < end);
    if (items.length) sections.push({ title: mk.title, cat: mk.cat, isNew: !!mk.isNew, items });
  });
  return sections;
}

function seasonMarkers(doc) {
  const marks = [];
  const re = /id\s*=\s*["']ls-season-(\d+)["']/gi;
  let m;
  while ((m = re.exec(doc.html)) !== null) marks.push({ pos: m.index, season: parseInt(m[1], 10) });
  for (const h of doc.headings) {
    const s = /^(?:الموسم|موسم)\s*(\d+)$/.exec(h.text);
    if (s) marks.push({ pos: h.start, season: parseInt(s[1], 10) });
  }
  return marks.sort((a, b) => a.pos - b.pos);
}

function groupSeasons(episodes) {
  const by = new Map();
  for (const e of episodes) {
    if (!by.has(e.season)) by.set(e.season, []);
    by.get(e.season).push(e);
  }
  return [...by.keys()].sort((a, b) => a - b).map(s => ({ season: s, episodes: by.get(s) }));
}
function sortEpisodes(eps) {
  return eps.map((e, i) => ({ e, i })).sort((x, y) => {
    if (x.e.season !== y.e.season) return x.e.season - y.e.season;
    const a = x.e.episode, b = y.e.episode;
    if (a != null && b != null && a !== b) return a - b;
    if (a != null && b == null) return -1;
    if (a == null && b != null) return 1;
    return x.i - y.i;
  }).map(x => x.e);
}

function buildEpisodes(doc, anchors, defaultSeason) {
  const marks = seasonMarkers(doc);
  const seen = new Set();
  const eps = [];
  for (const a of anchors) {
    const id = getParam(a.href, 'vid', doc.base);
    if (!id || !isValidId(id) || seen.has(id)) continue;
    seen.add(id);
    const num = episodeFromText(a.text) != null ? episodeFromText(a.text) : episodeFromText(a.title);
    let season = seasonFromText(a.title);
    if (!season) {
      const mk = marks.filter(m => m.pos < a.start).pop();
      season = mk ? mk.season : (defaultSeason || 1);
    }
    eps.push({
      vid: id, season, episode: num,
      label: num != null ? 'الحلقة ' + num : (a.title || a.text || id),
      title: a.title || a.text || '', url: doc.abs(a.href)
    });
  }
  return sortEpisodes(eps);
}

function categoryOf(doc, afterPos) {
  for (const a of doc.anchors) {
    if (a.start < afterPos) continue;
    const cat = /\/category\.php$/i.test(pathOf(a.href, doc.base)) ? getParam(a.href, 'cat', doc.base) : null;
    if (cat) return { key: cat, name: (CONFIG.CATEGORIES[cat] && CONFIG.CATEGORIES[cat].name) || a.text };
  }
  return null;
}

function cleanPageTitle(t) {
  return cleanText(t).replace(/\s*[-|]\s*(?:فيديو\s*)?لاروزا.*$/i, '').replace(/\s*[-|]\s*laroza.*$/i, '').trim();
}

function parseVideoPage(doc, vid) {
  const h1 = doc.headings.find(h => h.tag === 'h1');
  const title = (h1 && h1.text) || cleanPageTitle(doc.meta('og:title')) || cleanPageTitle(doc.titleTag());

  let playVid = vid, duration = '';
  for (const a of doc.anchors) {
    if (/\/play\.php$/i.test(pathOf(a.href, doc.base))) {
      playVid = getParam(a.href, 'vid', doc.base) || vid;
      const d = a.text.match(DURATION_RE);
      if (d) duration = d[0];
      break;
    }
  }
  let seriesId = null, seriesTitle = '';
  for (const a of doc.anchors) {
    if (/\/view-serie\d*\.php$/i.test(pathOf(a.href, doc.base))) {
      seriesId = getParam(a.href, 'ser', doc.base);
      seriesTitle = a.title || a.text;
      break;
    }
  }
  const labelIdx = doc.html.search(/القسم\s*:?/);
  const category = categoryOf(doc, labelIdx >= 0 ? labelIdx : 0);

  const relMarker = doc.headings.find(h => /قد تود مشاهدتها/.test(h.text));
  const relPos = relMarker ? relMarker.start : -1;

  // Episode links: anchors whose visible text is only an episode number/label.
  const epAnchors = doc.anchors.filter(a => {
    if (!/\/video\.php$/i.test(pathOf(a.href, doc.base))) return false;
    if (relPos >= 0 && a.start > relPos) return false;
    return /^\s*(?:(?:الحلقة|حلقة)\s*)?\d{1,4}\s*(?:الحلقة|حلقة|حلقه)?\s*$/.test(a.text);
  });
  const season = seasonFromText(title) || 1;
  const episodes = buildEpisodes(doc, epAnchors, season);

  let prev = null, next = null;
  for (const a of doc.anchors) {
    const id = getParam(a.href, 'vid', doc.base);
    if (!id || !isValidId(id) || !/\/video\.php$/i.test(pathOf(a.href, doc.base))) continue;
    if (/الحلقة\s*التالية|الحلقه\s*التاليه/.test(a.text)) next = { vid: id, label: a.text.replace(/الحلقة\s*التالية\s*/, 'الحلقة ') };
    else if (/الحلقة\s*السابقة|الحلقه\s*السابقه/.test(a.text)) prev = { vid: id, label: a.text.replace(/الحلقة\s*السابقة\s*/, 'الحلقة ') };
  }

  const allCards = extractCards(doc);
  const relatedCards = relPos >= 0 ? allCards.filter(c => c.pos > relPos) : [];

  const yearM = title.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  return {
    vid, playVid, title,
    description: doc.meta('og:description') || doc.meta('description'),
    thumbnail: doc.meta('og:image'),
    duration, year: yearM ? yearM[1] : '',
    category, seriesId, seriesTitle, season,
    episode: episodeFromText(title),
    episodes, prev, next, relatedCards
  };
}

function parseSeriesPage(doc, ser) {
  const h1 = doc.headings.find(h => h.tag === 'h1');
  const title = (h1 && h1.text) || cleanPageTitle(doc.meta('og:title')).replace(/^مسلسل\s+/, '');
  const startMark = doc.headings.find(h => /المواسم والحلقات/.test(h.text));
  const startPos = startMark ? startMark.start : 0;
  const epAnchors = doc.anchors.filter(a =>
    a.start > startPos && /\/video\.php$/i.test(pathOf(a.href, doc.base)));
  const episodes = buildEpisodes(doc, epAnchors, 1);
  const counts = doc.text().match(/(\d+)\s*مواسم?\s*(\d+)\s*حلقة/);
  const catIdx = doc.html.indexOf('category.php');
  return {
    ser, title,
    description: doc.meta('og:description') || doc.meta('description'),
    thumbnail: doc.meta('og:image'),
    category: categoryOf(doc, Math.max(0, catIdx - 200)),
    seasonCount: counts ? parseInt(counts[1], 10) : groupSeasons(episodes).length,
    episodeCount: counts ? parseInt(counts[2], 10) : episodes.length,
    episodes, seasons: groupSeasons(episodes)
  };
}

const EMBED_ATTRS = ['data-embed-url', 'data-embed', 'data-url', 'data-src', 'data-file', 'data-link'];

function parsePlayPage(doc) {
  const servers = [];
  const seen = new Set();
  const skipTags = new Set(['img', 'source', 'video', 'link', 'script']);
  let auto = 0;
  for (const n of doc.openTags()) {
    if (skipTags.has(n.tag)) continue;
    let raw = '';
    for (const k of EMBED_ATTRS) { if (n.attrs[k] && /^(?:https?:)?\/\//i.test(n.attrs[k])) { raw = n.attrs[k]; break; } }
    if (!raw && n.tag === 'iframe' && n.attrs.src && /^(?:https?:)?\/\//i.test(n.attrs.src)) raw = n.attrs.src;
    if (!raw) continue;
    const url = doc.abs(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    auto++;
    const idAttr = parseInt(n.attrs['data-embed-id'], 10);
    servers.push({
      id: Number.isFinite(idAttr) ? idAttr : auto,
      name: 'سيرفر ' + (Number.isFinite(idAttr) ? idAttr : auto),
      url, host: hostOf(url), fromIframe: n.tag === 'iframe'
    });
  }
  servers.sort((a, b) => a.id - b.id);
  const iframe = doc.openTags('iframe').find(n => n.attrs.src);
  const currentEmbed = iframe ? doc.abs(iframe.attrs.src) : null;
  const primary = (currentEmbed && servers.find(s => s.url === currentEmbed)) || servers[0] || null;
  servers.forEach(s => { s.primary = !!primary && s.url === primary.url; delete s.fromIframe; });
  return {
    meta: { title: cleanPageTitle(doc.meta('og:title')) || cleanPageTitle(doc.titleTag()), description: doc.meta('og:description') },
    servers, currentEmbed: currentEmbed || (primary ? primary.url : null),
    directSources: collectMedia(doc)
  };
}

function parseDownloadPage(doc, siteHosts) {
  const links = [];
  const seen = new Set();
  for (const a of doc.anchors) {
    const url = a.href && doc.abs(a.href);
    if (!url) continue;
    const host = hostOf(url);
    if (!host || siteHosts.has(host) || seen.has(url)) continue;
    const known = CONFIG.DOWNLOAD_HOSTS.some(h => host.includes(h));
    if (!known && !/تحميل|download/i.test(a.text)) continue;
    seen.add(url);
    links.push({ url, host, text: a.text });
  }
  return links;
}

// ============================================================================
// SITE CLIENT  (throttled, concurrency-limited, redirect-aware, CF-respectful)
// ============================================================================

function isChallenge(status, text) {
  const strict = ['cf-browser-verification', 'challenge-platform', 'Just a moment...', 'Attention Required! | Cloudflare', 'cf-challenge'];
  if (status === 403 || status === 503) return true;
  return text.length < 30000 && strict.some(m => text.includes(m));
}

class SiteClient {
  constructor() {
    this.origin = CONFIG.BASE_URL;
    this.trusted = new Set([hostOf(CONFIG.BASE_URL), ...CONFIG.FALLBACK_BASES.map(hostOf)].filter(Boolean));
    this.cookies = new Map();
    this.active = 0;
    this.waiters = [];
    this.nextSlot = 0;
    this.blockedUntil = 0;
    this.blockCount = 0;
    this.inflight = new Map();
    this.stats = { requests: 0, errors: 0, blocks: 0, redirectsAdopted: 0 };
  }

  siteHosts() { return new Set([...this.trusted]); }

  async _acquire() {
    if (this.active < CONFIG.CONCURRENCY) { this.active++; return; }
    await new Promise(r => this.waiters.push(r));
  }
  _release() { const w = this.waiters.shift(); if (w) w(); else this.active--; }
  async _pace() {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + CONFIG.REQUEST_DELAY_MS;
    if (slot > now) await sleep(slot - now);
  }

  _headers(referer, host) {
    const h = {
      'User-Agent': CONFIG.USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ar,en;q=0.8',
      'Referer': referer || this.origin + '/'
    };
    const jar = this.cookies.get(host);
    if (jar && jar.size) h['Cookie'] = [...jar].map(([k, v]) => k + '=' + v).join('; ');
    return h;
  }
  _storeCookies(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (!list.length) return;
    const host = hostOf(res.url);
    if (!this.cookies.has(host)) this.cookies.set(host, new Map());
    for (const c of list) {
      const part = c.split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) this.cookies.get(host).set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }
  _block() {
    this.blockCount++;
    this.stats.blocks++;
    const cool = Math.min(30000 * 2 ** (this.blockCount - 1), 300000);
    this.blockedUntil = Date.now() + cool;
    Logger.warn(`Upstream blocked the request (challenge/403). Cooling down ${Math.round(cool / 1000)}s. No bypass is attempted.`);
  }

  /** GET a site path (e.g. "/video.php?vid=abc"). Identical concurrent calls are shared. */
  get(target, opts = {}) {
    if (this.inflight.has(target)) return this.inflight.get(target);
    const p = this._get(target, opts).finally(() => this.inflight.delete(target));
    this.inflight.set(target, p);
    return p;
  }

  async _get(target, opts) {
    if (Date.now() < this.blockedUntil) {
      throw new SourceBlockedError('Upstream site is rate-limiting/blocking us; cooling down', Math.ceil((this.blockedUntil - Date.now()) / 1000));
    }
    const bases = [this.origin, ...CONFIG.FALLBACK_BASES.filter(b => b !== this.origin)];
    let lastErr;
    for (let bi = 0; bi < bases.length; bi++) {
      try {
        const r = await this._attempt(bases[bi] + target, opts.referer);
        if (bi > 0 && this.origin !== bases[bi]) { Logger.warn('Switching origin to fallback', bases[bi]); this.origin = bases[bi]; }
        return r;
      } catch (e) {
        lastErr = e;
        const retryOther = e.code === 'NETWORK' || e.code === 'TIMEOUT' || e.code === 'UPSTREAM_ERROR';
        if (!retryOther) throw e;
      }
    }
    throw lastErr;
  }

  async _attempt(url, referer) {
    let lastErr;
    for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES + 1; attempt++) {
      let res;
      await this._acquire();
      try {
        await this._pace();
        this.stats.requests++;
        res = await httpRequest(url, { headers: this._headers(referer, hostOf(url)), trustedHosts: this.trusted });
      } catch (e) {
        this.stats.errors++;
        lastErr = e;
        if (attempt <= CONFIG.MAX_RETRIES && (e.code === 'NETWORK' || e.code === 'TIMEOUT')) {
          this._release();
          await sleep(CONFIG.RETRY_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        this._release();
        throw e;
      }
      this._release();

      const text = decodeBody(res.body, res.headers);
      this._storeCookies(res);
      if (isChallenge(res.status, text)) {
        this._block();
        throw new SourceBlockedError('Upstream returned a challenge/forbidden response', Math.ceil((this.blockedUntil - Date.now()) / 1000));
      }
      if (res.status === 429) {
        const ra = Math.min(parseInt(res.headers.get('retry-after') || '2', 10) || 2, 10);
        if (attempt <= CONFIG.MAX_RETRIES) { await sleep(ra * 1000); continue; }
        this._block();
        throw new SourceBlockedError('Upstream rate limit (429)', ra);
      }
      if (res.status === 404 || res.status === 410) throw new HttpError(404, 'not found upstream', 'NOT_FOUND');
      if (res.status >= 500) {
        lastErr = new HttpError(502, 'upstream status ' + res.status, 'UPSTREAM_ERROR');
        if (attempt <= CONFIG.MAX_RETRIES) { await sleep(CONFIG.RETRY_DELAY_MS * attempt); continue; }
        throw lastErr;
      }
      if (res.status >= 400) throw new HttpError(502, 'upstream status ' + res.status, 'UPSTREAM_ERROR');

      this.blockCount = 0;
      const finalOrigin = new URL(res.url).origin;
      if (finalOrigin !== this.origin && CONFIG.ADOPT_REDIRECTS && res.chain.length) {
        Logger.warn(`Site moved: ${this.origin} -> ${finalOrigin} (redirect adopted)`);
        this.origin = finalOrigin;
        this.trusted.add(hostOf(finalOrigin));
        this.stats.redirectsAdopted++;
      }
      return { html: text, url: res.url, status: res.status };
    }
    throw lastErr || new HttpError(502, 'request failed', 'UPSTREAM_ERROR');
  }
}

// ============================================================================
// DATA STORE  (cards for local search + complete video details)
// ============================================================================

class DataStore {
  constructor(dir = CONFIG.DATA_DIR) {
    this.dir = dir;
    ensureDir(dir);
    this.file = path.join(dir, 'store.json');
    this.cards = new Map();
    this.videos = new Map();
    this.series = new Map();
    this.stats = { startedAt: nowISO(), lastCrawl: null, errors: 0 };
    this.timer = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        (d.cards || []).forEach(c => this.cards.set(c.kind + ':' + c.id, c));
        (d.videos || []).forEach(v => this.videos.set(v.vid, v));
        (d.series || []).forEach(s => this.series.set(s.ser, s));
        Logger.info(`Store loaded: ${this.cards.size} cards, ${this.videos.size} videos, ${this.series.size} series`);
        return;
      }
      const legacy = path.join(this.dir, 'videos.json');
      if (fs.existsSync(legacy)) {
        const old = JSON.parse(fs.readFileSync(legacy, 'utf8'));
        let n = 0;
        for (const v of Object.values(old)) {
          if (!v || !isValidId(v.vid) || !v.title) continue;
          this.cards.set('video:' + v.vid, this._card({ kind: 'video', id: v.vid, vid: v.vid, ser: null, title: v.title, thumbnail: v.thumbnail || '', duration: v.duration || '' }));
          n++;
        }
        Logger.info(`Migrated ${n} cards from v2 videos.json (details are re-fetched: v2 records were unreliable)`);
      }
    } catch (e) {
      Logger.warn('Could not load store (starting clean):', e.message);
    }
  }

  _card(c) {
    const title = c.title;
    return {
      kind: c.kind, id: c.id, vid: c.vid || null, ser: c.ser || null, title,
      thumbnail: c.thumbnail || '', duration: c.duration || '', rating: c.rating || '',
      type: c.type || guessType(title), showTitle: c.showTitle || stripShowTitle(title),
      n: normalizeArabic(title), seenAt: Date.now()
    };
  }

  putCards(cards) {
    for (const c of cards) {
      if (!c.title || !isValidId(c.id)) continue;
      const key = c.kind + ':' + c.id;
      const prev = this.cards.get(key);
      this.cards.delete(key);
      this.cards.set(key, this._card(Object.assign({}, prev || {}, c)));
    }
    while (this.cards.size > CONFIG.MAX_CARDS) this.cards.delete(this.cards.keys().next().value);
    this._dirty();
  }

  putVideo(rec) {
    this.videos.delete(rec.vid);
    this.videos.set(rec.vid, rec);
    while (this.videos.size > CONFIG.MAX_DETAILS) this.videos.delete(this.videos.keys().next().value);
    this.putCards([{ kind: 'video', id: rec.vid, vid: rec.vid, title: rec.title, thumbnail: rec.thumbnail, duration: rec.duration }]);
    this._dirty();
  }
  getVideo(vid) { return this.videos.get(vid) || null; }
  putSeries(s) { this.series.delete(s.ser); this.series.set(s.ser, s); this._dirty(); }
  getSeries(ser) { return this.series.get(ser) || null; }
  isFresh(rec, ttl) { return !!rec && !!rec.fetchedAt && Date.now() - Date.parse(rec.fetchedAt) < ttl; }

  search(q, limit = 50) {
    const nq = normalizeArabic(q);
    if (!nq) return [];
    const tokens = nq.split(' ');
    const out = [];
    for (const c of this.cards.values()) {
      if (!tokens.every(t => c.n.includes(t))) continue;
      let score = 10;
      if (c.n === nq) score = 100;
      else if (c.n.startsWith(nq)) score = 60;
      else if (c.n.includes(' ' + nq)) score = 40;
      if (c.kind === 'series') score += 5;
      out.push({ c, score });
    }
    out.sort((a, b) => b.score - a.score || b.c.seenAt - a.c.seenAt);
    return out.slice(0, limit).map(x => x.c);
  }

  _dirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save(); }, 3000);
    if (this.timer.unref) this.timer.unref();
  }
  save() {
    try {
      const data = {
        version: 3, savedAt: nowISO(),
        cards: [...this.cards.values()],
        videos: [...this.videos.values()],
        series: [...this.series.values()]
      };
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      Logger.error('Store save failed:', e.message);
    }
  }
  exportJSON() {
    const file = path.join(this.dir, 'export-full.json');
    fs.writeFileSync(file, JSON.stringify({ exportedAt: nowISO(), cards: [...this.cards.values()], videos: [...this.videos.values()] }));
    return file;
  }
}

// ============================================================================
// SOURCE VERIFICATION  (public, undecrypted media only)
// ============================================================================

async function verifySource(src, referer) {
  const out = { url: src.url, type: src.type, origin: src.origin || 'play-page', host: hostOf(src.url), status: 'failed', reason: '', corsOpen: null, checkedAt: nowISO() };
  if (src.type !== 'hls' && src.type !== 'mp4') { out.status = 'unsupported'; out.reason = 'نوع المصدر غير مدعوم'; return out; }
  try {
    const res = await httpRequest(src.url, {
      headers: { 'User-Agent': CONFIG.USER_AGENT, 'Accept': '*/*', 'Range': 'bytes=0-4095', 'Referer': referer },
      timeout: 8000, maxBytes: src.type === 'hls' ? 131072 : 4096, truncate: true
    });
    out.corsOpen = res.headers.has('access-control-allow-origin');
    if (res.status === 401 || res.status === 403) { out.status = 'unavailable'; out.reason = 'المصدر محمي أو مرفوض (' + res.status + ')'; return out; }
    if (res.status >= 400) { out.status = 'unavailable'; out.reason = 'غير متاح (HTTP ' + res.status + ')'; return out; }
    if (src.type === 'hls') {
      const text = res.body.toString('utf8');
      if (!text.trimStart().startsWith('#EXTM3U')) { out.status = 'unavailable'; out.reason = 'الرابط لا يحتوي على قائمة HLS صالحة'; return out; }
      if (/#EXT-X-(?:SESSION-)?KEY:[^\n]*(?:METHOD=SAMPLE-AES|KEYFORMAT="?(?:com\.apple\.streamingkeydelivery|urn:uuid:|com\.microsoft\.playready))/i.test(text)) {
        out.status = 'unsupported'; out.reason = 'مصدر محمي بـ DRM (غير مدعوم)'; return out;
      }
      out.status = 'available';
      if (out.corsOpen === false) out.reason = 'قد يفشل في المتصفح بسبب قيود CORS؛ جرّب سيرفرات لاروزا عند الفشل';
      return out;
    }
    const b = res.body;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const isMp4 = b.length >= 8 && b.toString('latin1', 4, 8) === 'ftyp';
    const isWebm = b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    if (isMp4 || isWebm || ct.startsWith('video/')) { out.status = 'available'; return out; }
    out.status = 'unavailable'; out.reason = 'الرابط ليس ملف فيديو صالحاً';
    return out;
  } catch (e) {
    out.status = 'failed';
    out.reason = e.code === 'TIMEOUT' ? 'انتهت مهلة الاتصال' : e.code === 'BLOCKED_HOST' ? 'عنوان غير مسموح' : 'فشل الاتصال بالمصدر';
    return out;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return results;
}

// ============================================================================
// SCRAPER / SERVICE LAYER
// ============================================================================

class LarozaService {
  constructor(store, site) {
    this.store = store;
    this.site = site;
    this.cache = new TTLCache();
    this.pending = new Map();
    this.crawling = false;
  }

  /** Cache with TTL, in-flight de-dup, stale-if-error. Partial results get a short TTL. */
  async memo(key, ttl, producer, { force = false } = {}) {
    const entry = this.cache.entry(key);
    const fresh = this.cache.get(key);
    if (fresh !== undefined && (!force || (entry && Date.now() - entry.at < CONFIG.TTL.MIN_FORCE_AGE))) return fresh;
    if (this.pending.has(key)) return this.pending.get(key);
    const p = (async () => {
      try {
        const v = await producer();
        this.cache.set(key, v, v && v.partial ? CONFIG.TTL.PARTIAL : ttl);
        return v;
      } catch (e) {
        this.store.stats.errors++;
        const st = this.cache.getStale(key);
        if (st !== undefined && e.code !== 'NOT_FOUND') return Object.assign({}, st, { stale: true, staleReason: e.code || e.message });
        throw e;
      } finally { this.pending.delete(key); }
    })();
    this.pending.set(key, p);
    return p;
  }

  async _listPage(pathStr, page, label) {
    const r = await this.site.get(pathStr);
    const doc = new HtmlDoc(r.html, r.url);
    const cards = extractCards(doc);
    const pg = extractPagination(doc, page);
    if (!cards.length && page === 1) throw new HttpError(502, label + ': page parsed without items (site layout changed?)', 'PARSE_EMPTY');
    this.store.putCards(cards);
    return { doc, cards, pg };
  }

  async home({ force = false } = {}) {
    return this.memo('home', CONFIG.TTL.HOME, async () => {
      const { doc, cards } = await this._listPage(CONFIG.HOME_PATH, 1, 'home');
      const videos = cards.filter(c => c.kind === 'video');
      return {
        count: videos.length, videos,
        series: cards.filter(c => c.kind === 'series'),
        sections: extractSections(doc, cards),
        fetchedAt: nowISO(), origin: this.site.origin
      };
    }, { force });
  }

  async category(cat, page = 1) {
    const info = CONFIG.CATEGORIES[cat];
    if (!info) throw new HttpError(400, 'unknown category', 'BAD_REQUEST');
    return this.memo(`cat:${cat}:${page}`, CONFIG.TTL.LIST, async () => {
      const { cards, pg } = await this._listPage(`/category.php?cat=${encodeURIComponent(cat)}&page=${page}`, page, 'category');
      return { category: cat, name: info.name, type: info.type, page, count: cards.length, videos: cards, hasNext: pg.hasNext || (cards.length > 0 && pg.maxPage > page), maxPage: pg.maxPage };
    });
  }

  async newVideos(page = 1) {
    return this.memo('new:' + page, CONFIG.TTL.LIST, async () => {
      const { cards, pg } = await this._listPage('/newvideos1.php' + (page > 1 ? `?&page=${page}` : ''), page, 'new');
      return { page, count: cards.length, videos: cards, hasNext: pg.hasNext, maxPage: pg.maxPage };
    });
  }

  async topVideos() {
    return this.memo('top', CONFIG.TTL.LIST, async () => {
      const { cards } = await this._listPage('/topvideos1.php', 1, 'top');
      return { count: cards.length, videos: cards };
    });
  }

  async seriesIndex(page = 1) {
    return this.memo('seriesindex:' + page, CONFIG.TTL.LIST, async () => {
      const { cards, pg } = await this._listPage('/moslslat4.php' + (page > 1 ? `?&page=${page}` : ''), page, 'series index');
      return { page, count: cards.length, videos: cards, hasNext: pg.hasNext, maxPage: pg.maxPage };
    });
  }

  async _liveSearch(q, page) {
    const r = await this.site.get(`/search.php?keywords=${encodeURIComponent(q)}` + (page > 1 ? `&page=${page}` : ''));
    const doc = new HtmlDoc(r.html, r.url);
    const cards = extractCards(doc);
    this.store.putCards(cards);
    return { cards, pg: extractPagination(doc, page) };
  }

  async search(q, page = 1) {
    q = String(q || '').trim().slice(0, 100);
    if (!q) throw new HttpError(400, 'missing q', 'BAD_REQUEST');
    const nq = normalizeArabic(q);
    let live = null, degraded = false, warning = '';
    try {
      live = await this.memo(`search:${nq}:${page}`, CONFIG.TTL.SEARCH, async () => {
        let r = await this._liveSearch(q, page);
        if (!r.cards.length && nq && nq !== q.toLowerCase()) r = await this._liveSearch(nq, page);
        return { cards: r.cards, hasNext: r.pg.hasNext, maxPage: r.pg.maxPage };
      });
    } catch (e) {
      degraded = true;
      warning = e.code === 'SOURCE_BLOCKED' ? 'الموقع المصدر يحجب الطلبات مؤقتاً — النتائج من الأرشيف المحلي'
        : 'تعذّر البحث المباشر — النتائج من الأرشيف المحلي';
      Logger.warn('live search failed:', e.code || e.message);
    }
    const seen = new Set();
    const videos = [];
    const add = c => {
      const k = c.kind + ':' + c.id;
      if (seen.has(k)) return;
      seen.add(k); videos.push(c);
    };
    if (live) live.cards.forEach(add);
    if (page === 1) this.store.search(q, 40).forEach(c => add(Object.assign({}, c, { local: true })));
    return {
      query: q, page, count: videos.length, videos,
      hasNext: !!(live && live.hasNext), degraded, warning,
      message: videos.length ? '' : 'لا توجد نتائج مطابقة'
    };
  }

  suggest(q) {
    const seen = new Set();
    const out = [];
    for (const c of this.store.search(q, 40)) {
      const k = normalizeArabic(c.showTitle);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ title: c.showTitle || c.title, kind: c.kind, id: c.id });
      if (out.length >= 8) break;
    }
    return out;
  }

  async series(ser) {
    if (!isValidId(ser)) throw new HttpError(400, 'bad series id', 'BAD_REQUEST');
    return this.memo('series:' + ser, CONFIG.TTL.SERIES, async () => {
      const r = await this.site.get('/view-serie1.php?ser=' + encodeURIComponent(ser));
      const doc = new HtmlDoc(r.html, r.url);
      const s = parseSeriesPage(doc, ser);
      if (!s.title) throw new HttpError(502, 'series page parsed without title', 'PARSE_EMPTY');
      s.thumbnail = s.thumbnail || '';
      s.fetchedAt = nowISO();
      if (s.episodes.length) this.store.putSeries(s);
      else s.partial = true;
      return s;
    });
  }

  async play(vid, referer) {
    if (!isValidId(vid)) throw new HttpError(400, 'bad vid', 'BAD_REQUEST');
    return this.memo('play:' + vid, CONFIG.TTL.PLAY, async () => {
      const r = await this.site.get('/play.php?vid=' + encodeURIComponent(vid), { referer });
      const doc = new HtmlDoc(r.html, r.url);
      const p = parsePlayPage(doc);
      const out = { vid, meta: p.meta, servers: p.servers, embeds: p.servers, currentEmbed: p.currentEmbed, directSources: p.directSources, downloadPage: `${this.site.origin}/download.php?vid=${vid}`, fetchedAt: nowISO() };
      if (!p.servers.length) out.partial = true;
      return out;
    });
  }

  async downloads(vid) {
    if (!isValidId(vid)) throw new HttpError(400, 'bad vid', 'BAD_REQUEST');
    return this.memo('dl:' + vid, CONFIG.TTL.DOWNLOADS, async () => {
      const r = await this.site.get('/download.php?vid=' + encodeURIComponent(vid));
      const doc = new HtmlDoc(r.html, r.url);
      const downloads = parseDownloadPage(doc, this.site.siteHosts());
      const out = { vid, downloads, fetchedAt: nowISO() };
      if (!downloads.length) out.partial = true;
      return out;
    });
  }

  async video(vid, { force = false } = {}) {
    if (!isValidId(vid)) throw new HttpError(400, 'bad vid', 'BAD_REQUEST');
    if (!force) {
      const stored = this.store.getVideo(vid);
      if (stored && this.store.isFresh(stored, CONFIG.TTL.VIDEO)) return stored;
    }
    return this.memo('video:' + vid, CONFIG.TTL.VIDEO, () => this._scrapeVideo(vid), { force });
  }

  async _scrapeVideo(vid) {
    const page = await this.site.get('/video.php?vid=' + encodeURIComponent(vid));
    const doc = new HtmlDoc(page.html, page.url);
    const info = parseVideoPage(doc, vid);
    if (!info.title) throw new HttpError(502, 'video page parsed without a title', 'PARSE_EMPTY');

    const warnings = [];
    let play = null;
    try { play = await this.play(info.playVid || vid, page.url); }
    catch (e) {
      if (e instanceof SourceBlockedError) throw e;
      warnings.push('play: ' + (e.code || e.message));
    }

    let episodes = info.episodes;
    let seasons = groupSeasons(episodes);
    let seriesTitle = info.seriesTitle;
    let seriesThumb = '';
    if (info.seriesId) {
      try {
        const s = await this.series(info.seriesId);
        if (s.episodes && s.episodes.length) { episodes = s.episodes; seasons = s.seasons; seriesTitle = seriesTitle || s.title; seriesThumb = s.thumbnail; }
      } catch (e) {
        if (e instanceof SourceBlockedError) warnings.push('series: blocked');
        else warnings.push('series: ' + (e.code || e.message));
      }
    }

    // Current episode position and prev/next (site links first, list as fallback).
    const idx = episodes.findIndex(e => e.vid === vid);
    const cur = idx >= 0 ? episodes[idx] : null;
    const toNav = e => e ? { vid: e.vid, label: e.label, season: e.season } : null;
    const prev = info.prev || toNav(idx > 0 ? episodes[idx - 1] : null);
    const next = info.next || toNav(idx >= 0 && idx < episodes.length - 1 ? episodes[idx + 1] : null);

    const servers = play ? play.servers : [];
    const rec = {
      vid, playVid: info.playVid, title: info.title, description: info.description,
      thumbnail: info.thumbnail || seriesThumb || doc.abs('/uploads/thumbs/' + vid + '-1.jpg'),
      duration: info.duration, year: info.year,
      type: info.seriesId ? 'episode' : guessType(info.title),
      category: info.category,
      seriesId: info.seriesId, seriesTitle,
      season: cur ? cur.season : info.season, episode: cur ? cur.episode : info.episode,
      seasons, episodes, prev, next,
      servers, embeds: servers, currentEmbed: play ? play.currentEmbed : null,
      primaryServer: servers.find(s => s.primary) || servers[0] || null,
      directSources: play ? play.directSources : [],
      downloads: [], m3u8Probes: [],
      related: this.buildSuggestions(info, episodes),
      playUrl: `${this.site.origin}/play.php?vid=${info.playVid || vid}`,
      sourceUrl: `${this.site.origin}/video.php?vid=${vid}`,
      fetchedAt: nowISO(), scrapedAt: nowISO(), light: true, origin: this.site.origin
    };
    if (warnings.length) rec.warnings = warnings;
    if (!servers.length) { rec.partial = true; return rec; }
    this.store.putVideo(rec);
    Logger.ok(`video ${vid}: servers=${servers.length} episodes=${episodes.length}`);
    return rec;
  }

  /** Real suggestions only: site "related" list de-duplicated + local title similarity. */
  buildSuggestions(info, episodes) {
    const selfKey = showKey(info.title);
    const sameShow = new Set([selfKey]);
    if (info.seriesTitle) sameShow.add(normalizeArabic(info.seriesTitle));
    const epIds = new Set(episodes.map(e => e.vid));
    const seenId = new Set([info.vid]);
    const seenShow = new Set(sameShow);
    const out = [];
    const push = c => {
      const sk = showKey(c.title);
      const k = c.kind + ':' + c.id;
      if (seenId.has(c.id) || seenId.has(k) || epIds.has(c.id) || seenShow.has(sk)) return false;
      seenId.add(c.id); seenId.add(k); seenShow.add(sk);
      out.push(Object.assign({}, c, { pos: undefined }));
      return true;
    };
    (info.relatedCards || []).forEach(push);
    if (out.length < 8 && selfKey) {
      const toks = new Set(selfKey.split(' ').filter(t => t.length > 1));
      const scored = [];
      for (const c of this.store.cards.values()) {
        const ct = new Set(normalizeArabic(c.showTitle).split(' ').filter(t => t.length > 1));
        if (!ct.size || !toks.size) continue;
        let inter = 0;
        toks.forEach(t => { if (ct.has(t)) inter++; });
        const score = inter / (toks.size + ct.size - inter);
        if (score >= 0.34) scored.push({ c, score });
      }
      scored.sort((a, b) => b.score - a.score);
      for (const s of scored) { if (out.length >= 12) break; push(s.c); }
    }
    return out.slice(0, 12);
  }

  async probeEmbed(embedUrl) {
    const res = await httpRequest(embedUrl, {
      headers: { 'User-Agent': CONFIG.USER_AGENT, 'Accept': 'text/html,*/*;q=0.8', 'Referer': this.site.origin + '/' },
      timeout: 10000, maxBytes: 1.5 * 1024 * 1024, truncate: true
    });
    if (res.status >= 400) return [];
    const doc = new HtmlDoc(decodeBody(res.body, res.headers), res.url);
    return collectMedia(doc).map(s => Object.assign(s, { origin: 'embed:' + hostOf(embedUrl) }));
  }

  /** Direct sources (+ optional server reachability), each with a verified status. */
  async sources(vid, { probe = false, checkServers = false } = {}) {
    const rec = await this.video(vid);
    return this.memo(`sources:${vid}:${probe ? 1 : 0}:${checkServers ? 1 : 0}`, CONFIG.TTL.SOURCES, async () => {
      const referer = rec.sourceUrl || this.site.origin + '/';
      let cands = (rec.directSources || []).map(s => Object.assign({}, s, { origin: 'play-page' }));
      let probed = [];
      if (probe) {
        const friendly = (rec.servers || []).filter(s => CONFIG.FRIENDLY_HOSTS.some(h => s.host.includes(h))).slice(0, 4);
        const lists = await mapLimit(friendly, 2, async s => { try { return await this.probeEmbed(s.url); } catch (_) { return []; } });
        probed = lists.flat();
        cands = cands.concat(probed);
      }
      const seen = new Set();
      cands = cands.filter(c => !seen.has(c.url) && seen.add(c.url)).slice(0, 10);
      const sources = await mapLimit(cands, 3, c => verifySource(c, referer));
      let servers = rec.servers || [];
      if (checkServers) {
        servers = await mapLimit(servers, 3, async s => {
          try {
            const r = await httpRequest(s.url, { headers: { 'User-Agent': CONFIG.USER_AGENT, 'Referer': referer }, timeout: 8000, maxBytes: 2048, truncate: true });
            return Object.assign({}, s, { status: r.status < 400 ? 'available' : 'unavailable', http: r.status });
          } catch (e) { return Object.assign({}, s, { status: 'failed', reason: e.code }); }
        });
      }
      const out = { vid, probed: !!probe, servers, sources, checkedAt: nowISO() };
      if (rec.partial) out.partial = true;
      return out;
    });
  }

  // ---- background warm-up / crawl (low rate, bounded) -----------------------
  async crawl(limit = 20) {
    if (this.crawling) return { started: false, reason: 'already running' };
    this.crawling = true;
    (async () => {
      try {
        const home = await this.home({ force: true });
        const ids = home.videos.slice(0, limit).map(v => v.vid);
        for (const id of ids) { try { await this.video(id); } catch (e) { Logger.warn('crawl item failed', id, e.code || e.message); } }
        this.store.stats.lastCrawl = nowISO();
        this.store.save();
        Logger.ok('crawl finished');
      } catch (e) { Logger.error('crawl failed:', e.code || e.message); }
      finally { this.crawling = false; }
    })();
    return { started: true };
  }
}

// ============================================================================
// EMBEDDED FRONTEND  (no inline event handlers -> strict CSP)
// ============================================================================

const EMBEDDED_HTML = String.raw`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#0b0b0f">
  <title>لاروزا بلاير</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="header">
    <div class="container header-inner">
      <a class="logo" href="#" data-act="home"><span class="logo-icon">▶</span><span>لاروزا بلاير</span></a>
      <form class="search-box" id="searchForm" autocomplete="off" role="search">
        <input type="search" id="searchInput" placeholder="ابحث عن فيلم أو مسلسل..." maxlength="100" aria-label="بحث">
        <button type="submit">بحث</button>
        <div id="suggestBox" class="suggest hidden"></div>
      </form>
      <details class="server-config">
        <summary title="إعدادات الخادم">⚙</summary>
        <div class="server-config-body">
          <input type="text" id="apiBase" placeholder="رابط API" dir="ltr">
          <button class="btn-sm" type="button" data-act="save-api">حفظ</button>
        </div>
      </details>
    </div>
  </header>

  <main class="container" id="main">
    <section id="homeView" class="view">
      <div class="section-header"><h2>مسلسلات مختارة</h2>
        <button class="btn-outline" data-act="refresh-home" type="button">تحديث</button></div>
      <div id="homeSeries" class="hscroll"></div>
      <div id="homeSections"></div>
      <div class="section-header"><h2>التصنيفات</h2></div>
      <div id="categories" class="cats"></div>
    </section>

    <section id="listView" class="view hidden">
      <div class="section-header"><h2 id="listTitle"></h2>
        <button class="btn-outline" data-act="home" type="button">الرئيسية</button></div>
      <div id="listNotice" class="notice hidden"></div>
      <div id="listGrid" class="video-grid"></div>
      <div class="center"><button id="listMore" class="btn-primary hidden" data-act="list-more" type="button">تحميل المزيد</button></div>
    </section>

    <section id="seriesView" class="view hidden">
      <div class="section-header"><h2 id="seriesTitle"></h2>
        <button class="btn-outline" data-act="back" type="button">رجوع</button></div>
      <div id="seriesBody"></div>
    </section>

    <section id="playerView" class="view hidden">
      <div class="player-wrap">
        <div class="player-top">
          <button class="btn-outline" data-act="back" type="button">← رجوع</button>
          <h1 id="playerTitle">...</h1>
        </div>
        <div class="player-frame-wrap" id="playerFrameWrap">
          <iframe id="playerFrame" src="about:blank" allowfullscreen
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            referrerpolicy="no-referrer" title="المشغل"></iframe>
          <video id="directVideo" controls playsinline preload="metadata" class="hidden"></video>
          <div id="playerOverlay" class="player-overlay"></div>
        </div>
        <div class="toolbar">
          <div class="mode-switch" role="tablist">
            <button id="modeLaroza" class="mode-btn active" data-act="mode" data-mode="laroza" role="tab" type="button">تشغيل من سيرفرات لاروزا</button>
            <button id="modeDirect" class="mode-btn" data-act="mode" data-mode="direct" role="tab" type="button">تشغيل مباشر</button>
          </div>
          <div class="tool-actions">
            <button class="btn-sm" data-act="fullscreen" type="button">⛶ ملء الشاشة</button>
            <button class="btn-sm" data-act="reload-player" type="button">↻ إعادة تحميل</button>
          </div>
        </div>
        <div id="panelLaroza" class="panel">
          <div class="panel-title">السيرفرات</div>
          <div id="serversList" class="servers-list"></div>
        </div>
        <div id="panelDirect" class="panel hidden">
          <div class="panel-title">مصادر التشغيل المباشر <button class="btn-sm" data-act="recheck-sources" type="button">إعادة الفحص</button></div>
          <div id="directList" class="direct-list"></div>
        </div>
        <div class="meta-row" id="playerMeta"></div>
        <div class="nav-row" id="navRow"></div>
        <div class="panel" id="episodesBox" hidden>
          <div class="panel-title">الحلقات</div>
          <div id="seasonTabs" class="season-tabs"></div>
          <div id="episodesList" class="episodes-list"></div>
        </div>
        <div class="panel" id="downloadsBox">
          <div class="panel-title">روابط التحميل <button class="btn-sm" data-act="load-downloads" type="button">عرض الروابط</button></div>
          <div id="downloadsList"></div>
        </div>
        <div class="panel" id="relatedBox" hidden>
          <div class="panel-title">قد يعجبك</div>
          <div id="relatedGrid" class="video-grid small"></div>
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="container footer-inner">
      <span>Laroza Player v3.0.0</span>
      <span id="apiStatus" class="status offline">غير متصل</span>
    </div>
  </footer>
  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
  <script src="/app.js"></script>
</body>
</html>
`;

const EMBEDDED_CSS = String.raw`/* Laroza Player v3.0.0 */
:root{--bg:#0b0b0f;--surface:#12121a;--card:#1a1a24;--border:#2a2a3a;--text:#f2f2f7;--muted:#9a9aad;--accent:#e50914;--accent2:#ff6b35;--ok:#2ecc71;--warn:#f5a623;--radius:14px;--shadow:0 12px 40px rgba(0,0,0,.45)}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:radial-gradient(ellipse at top,#161622 0%,var(--bg) 55%);color:var(--text);min-height:100vh;line-height:1.5;display:flex;flex-direction:column}
a{color:inherit;text-decoration:none}
button{font-family:inherit}
.container{width:100%;max-width:1280px;margin:0 auto;padding:0 16px}
.hidden{display:none!important}
.center{text-align:center;margin:20px 0}
.header{background:rgba(10,10,15,.88);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.header-inner{display:flex;align-items:center;gap:12px;padding:10px 0}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:1.15rem;white-space:nowrap}
.logo-icon{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(229,9,20,.35)}
.search-box{flex:1;display:flex;min-width:0;max-width:520px;position:relative}
.search-box input{flex:1;min-width:0;background:var(--card);border:1px solid var(--border);border-radius:0 999px 999px 0;padding:10px 16px;color:var(--text);outline:none;font-size:1rem}
.search-box input:focus{border-color:var(--accent)}
.search-box button{background:var(--accent);border:none;color:#fff;padding:0 18px;border-radius:999px 0 0 999px;cursor:pointer;font-weight:700}
.suggest{position:absolute;top:100%;right:0;left:0;margin-top:6px;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);z-index:50}
.suggest button{display:block;width:100%;text-align:right;background:none;border:0;color:var(--text);padding:10px 14px;cursor:pointer;font-size:.92rem}
.suggest button:hover,.suggest button:focus{background:var(--card)}
.server-config{position:relative}
.server-config summary{list-style:none;cursor:pointer;width:36px;height:36px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);border-radius:10px;color:var(--muted)}
.server-config summary::-webkit-details-marker{display:none}
.server-config-body{position:absolute;left:0;top:44px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:10px;display:flex;gap:6px;box-shadow:var(--shadow);z-index:60}
.server-config-body input{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:8px;color:var(--text);width:230px;font-size:.8rem}
.btn-sm,.btn-outline,.btn-primary{border:1px solid var(--border);color:var(--text);background:transparent;padding:8px 14px;border-radius:10px;cursor:pointer;font-size:.86rem;transition:.15s}
.btn-sm:hover,.btn-outline:hover{border-color:var(--accent)}
.btn-primary{background:var(--accent);border-color:var(--accent);font-weight:700;padding:10px 26px}
main.container{padding-top:20px;padding-bottom:70px;flex:1}
.section-header{display:flex;align-items:center;justify-content:space-between;margin:10px 0 14px;gap:10px}
.section-header h2{font-size:1.25rem;font-weight:800}
.section-header a{color:var(--muted);font-size:.85rem}
.video-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px}
.video-grid.small{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:12px}
.hscroll{display:flex;gap:14px;overflow-x:auto;padding-bottom:8px;scroll-snap-type:x proximity}
.hscroll .video-card{flex:0 0 150px;scroll-snap-align:start}
.video-card{background:var(--card);border-radius:var(--radius);overflow:hidden;cursor:pointer;transition:transform .2s,box-shadow .2s;border:1px solid transparent;position:relative;outline:none}
.video-card:hover,.video-card:focus-visible{transform:translateY(-5px);box-shadow:var(--shadow);border-color:rgba(229,9,20,.4)}
.thumb-wrap{position:relative;aspect-ratio:2/3;background:#1a1a22;overflow:hidden}
.thumb{width:100%;height:100%;object-fit:cover;display:block}
.badge{position:absolute;top:8px;right:8px;background:rgba(229,9,20,.92);color:#fff;font-size:.68rem;font-weight:700;padding:3px 8px;border-radius:6px}
.badge.alt{background:rgba(20,20,30,.85);right:auto;left:8px}
.play-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35);opacity:0;transition:.2s}
.video-card:hover .play-overlay{opacity:1}
.play-overlay span{width:44px;height:44px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center}
.info{padding:9px 10px 11px}
.title{font-size:.8rem;font-weight:700;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4;min-height:2.3em}
.meta{font-size:.7rem;color:var(--muted);margin-top:3px}
.empty,.loading{grid-column:1/-1;text-align:center;padding:44px 16px;color:var(--muted)}
.empty .btn-outline{margin-top:12px}
.notice{background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.4);color:#ffd28a;padding:10px 14px;border-radius:10px;margin-bottom:12px;font-size:.88rem}
.skeleton{aspect-ratio:2/3;border-radius:var(--radius);background:linear-gradient(90deg,#1a1a24 25%,#242433 50%,#1a1a24 75%);background-size:200% 100%;animation:shimmer 1.2s infinite}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
.cats{display:flex;flex-wrap:wrap;gap:8px}
.cat-chip{background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:999px;cursor:pointer;font-size:.86rem}
.cat-chip:hover{background:var(--accent);border-color:var(--accent)}
.player-wrap{max-width:1000px;margin:0 auto}
.player-top{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.player-top h1{font-size:1.2rem;flex:1;font-weight:800;min-width:60%}
.player-frame-wrap{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:16px;overflow:hidden;border:1px solid var(--border);box-shadow:var(--shadow)}
.player-frame-wrap iframe,#directVideo{position:absolute;inset:0;width:100%;height:100%;border:0;background:#000}
.player-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:rgba(10,10,14,.92);color:var(--muted);text-align:center;padding:18px;z-index:5}
.player-overlay.hidden{display:none}
.spinner{width:34px;height:34px;border:3px solid #333;border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.overlay-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.toolbar{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px}
.mode-switch{display:flex;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:3px;gap:3px;flex:1;min-width:260px}
.mode-btn{flex:1;background:transparent;border:0;color:var(--muted);padding:9px 10px;border-radius:9px;cursor:pointer;font-size:.88rem;font-weight:700}
.mode-btn.active{background:var(--accent);color:#fff}
.tool-actions{display:flex;gap:8px}
.panel{margin-top:14px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px}
.panel[hidden]{display:none}
.panel-title{font-weight:800;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;gap:8px}
.servers-list{display:flex;flex-wrap:wrap;gap:8px}
.server-btn{background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:10px;cursor:pointer;font-size:.86rem}
.server-btn:hover{border-color:var(--accent)}
.server-btn.active{background:var(--accent);border-color:var(--accent);color:#fff}
.server-btn small{opacity:.7;margin-right:4px;font-size:.72rem}
.direct-list{display:flex;flex-direction:column;gap:8px}
.src-row{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:9px 12px;flex-wrap:wrap}
.src-row.active{border-color:var(--accent)}
.src-main{flex:1;min-width:150px}
.src-name{font-weight:700;font-size:.88rem}
.src-host{color:var(--muted);font-size:.74rem;direction:ltr;text-align:right}
.src-reason{color:var(--muted);font-size:.74rem;margin-top:2px}
.pill{font-size:.72rem;padding:3px 10px;border-radius:999px;font-weight:700}
.pill.available{background:rgba(46,204,113,.15);color:var(--ok)}
.pill.unavailable,.pill.failed{background:rgba(229,9,20,.15);color:#ff6b6b}
.pill.unsupported{background:rgba(245,166,35,.15);color:var(--warn)}
.meta-row{margin-top:12px;color:var(--muted);font-size:.88rem}
.nav-row{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
.nav-row .btn-outline{flex:1;min-width:130px}
.season-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.season-tab{background:var(--card);border:1px solid var(--border);color:var(--text);padding:6px 14px;border-radius:999px;cursor:pointer;font-size:.82rem}
.season-tab.active{background:var(--accent);border-color:var(--accent)}
.episodes-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;max-height:300px;overflow-y:auto;padding:2px}
.ep-btn{background:var(--card);border:1px solid var(--border);color:var(--text);padding:9px 6px;border-radius:10px;cursor:pointer;font-size:.82rem;text-align:center}
.ep-btn:hover{border-color:var(--accent)}
.ep-btn.active{background:var(--accent);border-color:var(--accent)}
#downloadsList a{display:inline-block;background:var(--card);border:1px solid var(--border);color:#8ec7ff;padding:8px 12px;border-radius:8px;margin:4px;font-size:.84rem;direction:ltr}
.series-head{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.series-head img{width:150px;border-radius:12px;aspect-ratio:2/3;object-fit:cover;background:#1a1a22}
.series-info{flex:1;min-width:220px;color:var(--muted);font-size:.9rem}
.footer{border-top:1px solid var(--border);padding:12px 0;background:var(--surface);font-size:.82rem;color:var(--muted)}
.footer-inner{display:flex;justify-content:space-between;align-items:center}
.status{padding:3px 10px;border-radius:999px;font-size:.74rem}
.status.online{background:rgba(46,204,113,.15);color:var(--ok)}
.status.offline{background:rgba(229,9,20,.15);color:#ff6b6b}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid var(--border);padding:12px 20px;border-radius:12px;box-shadow:var(--shadow);z-index:200;max-width:92vw;text-align:center;font-size:.9rem}
.toast.error{border-color:var(--accent)}
@media (max-width:640px){
  .header-inner{flex-wrap:wrap}
  .logo span:last-child{display:none}
  .video-grid{grid-template-columns:repeat(auto-fill,minmax(115px,1fr));gap:10px}
  .hscroll .video-card{flex-basis:125px}
  .player-top h1{font-size:1rem}
  .player-frame-wrap{border-radius:12px}
  .server-config-body input{width:170px}
  .tool-actions{width:100%}.tool-actions .btn-sm{flex:1}
}
`;

const EMBEDDED_JS = String.raw`/* Laroza Player v3.0.0 — front-end */
(function () {
  'use strict';
  var VERSION = '3.0.0';

  // ---------- helpers ----------
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var SS = {
    get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  };
  var API_BASE = (LS.get('laroza_api') || window.location.origin).replace(/\/+$/, '');
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function enc(s) { return encodeURIComponent(s); }
  var PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect fill="#1a1a24" width="300" height="450"/><text x="150" y="230" fill="#666" font-size="18" text-anchor="middle" font-family="Arial">Laroza</text></svg>');

  var ERR_AR = {
    SOURCE_BLOCKED: 'الموقع المصدر يحجب الطلبات مؤقتاً. انتظر قليلاً ثم أعد المحاولة (لا يتم تجاوز أي حماية).',
    TIMEOUT: 'انتهت مهلة الطلب. السيرفر أو الموقع المصدر بطيء.',
    NETWORK: 'تعذّر الاتصال بالموقع المصدر.',
    NOT_FOUND: 'المحتوى غير موجود أو تم حذفه.',
    PARSE_EMPTY: 'لم يتم العثور على بيانات في الصفحة (ربما تغيّر تصميم الموقع).',
    RATE_LIMITED: 'عدد الطلبات كبير. حاول بعد قليل.',
    OFFLINE: 'لا يوجد اتصال بالإنترنت أو بالخادم.',
    BAD_REQUEST: 'طلب غير صالح.'
  };
  function errText(e) {
    if (!e) return 'خطأ غير معروف';
    if (e.code && ERR_AR[e.code]) return ERR_AR[e.code];
    return e.message || 'خطأ غير معروف';
  }

  function api(path, opts) {
    opts = opts || {};
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, opts.timeout || 60000);
    return fetch(API_BASE + path, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) {
            var e = new Error(data.error || ('HTTP ' + res.status));
            e.status = res.status; e.code = data.code; e.retryAfter = data.retryAfter;
            throw e;
          }
          return data;
        });
      })
      .catch(function (err) {
        if (err.name === 'AbortError') { var t = new Error('timeout'); t.code = 'TIMEOUT'; throw t; }
        if (err instanceof TypeError) { var o = new Error('offline'); o.code = 'OFFLINE'; throw o; }
        throw err;
      })
      .then(function (d) { clearTimeout(timer); return d; }, function (e) { clearTimeout(timer); throw e; });
  }

  var toastTimer = null;
  function toast(msg, isErr, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isErr);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 3200);
  }
  function setStatus(on) {
    var el = $('#apiStatus');
    el.textContent = on ? 'متصل' : 'غير متصل';
    el.className = 'status ' + (on ? 'online' : 'offline');
  }

  // ---------- state ----------
  var ui = { token: 0, suppress: false, list: null, retry: null, lastView: 'home' };
  var prefs = { mode: SS.get('lp_mode') || 'laroza', serverIdx: parseInt(SS.get('lp_server') || '0', 10) || 0 };
  var P = { rec: null, vid: null, mode: 'laroza', serverIdx: 0, sources: null, srcIdx: -1, hls: null, playToken: 0, stall: null, season: null, hlsLoading: null };
  function savePrefs() { SS.set('lp_mode', prefs.mode); SS.set('lp_server', String(prefs.serverIdx)); }

  // ---------- views ----------
  var VIEWS = ['homeView', 'listView', 'seriesView', 'playerView'];
  function showView(id) {
    VIEWS.forEach(function (v) { $('#' + v).classList.toggle('hidden', v !== id); });
    if (id !== 'playerView') stopAll();
    window.scrollTo(0, 0);
  }
  function setHash(h) {
    if (location.hash !== h) { ui.suppress = true; location.hash = h; }
  }

  // ---------- cards ----------
  function typeBadge(v) {
    if (v.kind === 'series') return '<span class="badge">مسلسل</span>';
    if (v.type === 'episode') return '<span class="badge">حلقة</span>';
    return '';
  }
  function card(v) {
    var isSeries = v.kind === 'series';
    var act = isSeries ? 'open-series' : 'open-video';
    var id = isSeries ? (v.ser || v.id) : (v.vid || v.id);
    var thumb = v.thumbnail || PLACEHOLDER;
    var meta = [v.duration, v.rating ? '⭐ ' + v.rating : ''].filter(Boolean).join(' • ');
    return '<div class="video-card" role="link" tabindex="0" data-act="' + act + '" data-id="' + esc(id) + '">' +
      '<div class="thumb-wrap"><img class="thumb" src="' + esc(thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
      typeBadge(v) + (v.local ? '<span class="badge alt">أرشيف</span>' : '') +
      '<div class="play-overlay"><span>▶</span></div></div>' +
      '<div class="info"><div class="title">' + esc(v.title || id) + '</div>' +
      '<div class="meta">' + esc(meta) + '</div></div></div>';
  }
  function grid(el, items, emptyMsg) {
    if (!items || !items.length) { el.innerHTML = '<div class="empty">' + esc(emptyMsg || 'لا توجد نتائج') + '</div>'; return; }
    el.innerHTML = items.map(card).join('');
  }
  function skeletons(el, n) {
    var h = '';
    for (var i = 0; i < (n || 12); i++) h += '<div class="skeleton"></div>';
    el.innerHTML = h;
  }
  function errorBox(el, err, retryAct, retryId) {
    el.innerHTML = '<div class="empty">' + esc(errText(err)) +
      (retryAct ? '<br><button class="btn-outline" data-act="' + retryAct + '" data-id="' + esc(retryId || '') + '" type="button">إعادة المحاولة</button>' : '') + '</div>';
  }

  // ---------- home ----------
  function loadHome(force) {
    showView('homeView');
    setHash('#');
    var tok = ++ui.token;
    var s = $('#homeSeries'), sec = $('#homeSections');
    skeletons(s, 8); sec.innerHTML = '';
    api('/api/home' + (force ? '?refresh=1' : ''), { timeout: 60000 }).then(function (d) {
      if (tok !== ui.token) return;
      if (d.stale) toast('تعذّر التحديث — يتم عرض نسخة محفوظة', true);
      if (d.series && d.series.length) { s.innerHTML = d.series.map(card).join(''); }
      else { s.innerHTML = ''; s.previousElementSibling.classList.add('hidden'); }
      if (d.series && d.series.length) s.previousElementSibling.classList.remove('hidden');
      var html = '';
      var sections = d.sections && d.sections.length ? d.sections : [{ title: 'أحدث الإضافات', isNew: true, items: d.videos || [] }];
      sections.forEach(function (sc) {
        var link = sc.cat ? '<a href="#cat/' + enc(sc.cat) + '">عرض الكل</a>' : (sc.isNew ? '<a href="#new">عرض الكل</a>' : '');
        html += '<div class="section-header"><h2>' + esc(sc.title) + '</h2>' + link + '</div>' +
          '<div class="video-grid">' + sc.items.slice(0, 12).map(card).join('') + '</div>';
      });
      sec.innerHTML = html;
    }).catch(function (e) {
      if (tok !== ui.token) return;
      s.innerHTML = '';
      errorBox(sec, e, 'refresh-home');
    });
  }
  function loadCategories() {
    api('/api/categories', { timeout: 15000 }).then(function (cats) {
      $('#categories').innerHTML = Object.keys(cats).map(function (k) {
        return '<a class="cat-chip" href="#cat/' + enc(k) + '">' + esc(cats[k].name) + '</a>';
      }).join('');
    }).catch(function () {});
  }

  // ---------- generic paged list (search / category / new) ----------
  function openList(title, loader) {
    showView('listView');
    $('#listTitle').textContent = title;
    $('#listNotice').classList.add('hidden');
    ui.list = { loader: loader, page: 0, busy: false, items: [], done: false, tok: ++ui.token };
    skeletons($('#listGrid'), 12);
    $('#listMore').classList.add('hidden');
    listMore();
  }
  function listMore() {
    var L = ui.list;
    if (!L || L.busy || L.done) return;
    L.busy = true;
    var tok = L.tok;
    $('#listMore').disabled = true;
    L.loader(L.page + 1).then(function (d) {
      if (!ui.list || ui.list.tok !== tok) return;
      L.page++;
      var seen = {};
      L.items.forEach(function (v) { seen[v.kind + ':' + v.id] = 1; });
      (d.videos || []).forEach(function (v) { if (!seen[v.kind + ':' + v.id]) L.items.push(v); });
      L.done = !d.hasNext || !(d.videos && d.videos.length);
      grid($('#listGrid'), L.items, d.message || 'لا توجد نتائج');
      var n = $('#listNotice');
      if (d.warning) { n.textContent = d.warning; n.classList.remove('hidden'); } else n.classList.add('hidden');
      $('#listMore').classList.toggle('hidden', L.done || !L.items.length);
    }).catch(function (e) {
      if (!ui.list || ui.list.tok !== tok) return;
      if (!L.items.length) errorBox($('#listGrid'), e, 'list-retry');
      else toast(errText(e), true);
    }).then(function () { L.busy = false; $('#listMore').disabled = false; });
  }
  function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    $('#searchInput').value = q;
    hideSuggest();
    setHash('#search/' + enc(q));
    openList('نتائج: ' + q, function (page) { return api('/api/search?q=' + enc(q) + '&page=' + page, { timeout: 60000 }); });
  }
  function openCategory(key) {
    setHash('#cat/' + enc(key));
    api('/api/categories', { timeout: 15000 }).catch(function () { return {}; }).then(function (cats) {
      var name = cats[key] ? cats[key].name : key;
      openList(name, function (page) { return api('/api/category/' + enc(key) + '?page=' + page, { timeout: 60000 }); });
    });
  }
  function openNew() {
    setHash('#new');
    openList('أحدث الإضافات', function (page) { return api('/api/new?page=' + page, { timeout: 60000 }); });
  }

  // ---------- suggestions dropdown ----------
  var sugTimer = null;
  function hideSuggest() { $('#suggestBox').classList.add('hidden'); }
  function onSearchInput() {
    var q = $('#searchInput').value.trim();
    clearTimeout(sugTimer);
    if (q.length < 2) { hideSuggest(); return; }
    sugTimer = setTimeout(function () {
      api('/api/suggest?q=' + enc(q), { timeout: 8000 }).then(function (d) {
        var box = $('#suggestBox');
        if (!d.suggestions || !d.suggestions.length || $('#searchInput').value.trim() !== q) { hideSuggest(); return; }
        box.innerHTML = d.suggestions.map(function (s) {
          return '<button type="button" data-act="suggest" data-q="' + esc(s.title) + '">' + esc(s.title) + '</button>';
        }).join('');
        box.classList.remove('hidden');
      }).catch(hideSuggest);
    }, 250);
  }

  // ---------- series ----------
  function openSeries(ser) {
    showView('seriesView');
    setHash('#series/' + enc(ser));
    var tok = ++ui.token;
    $('#seriesTitle').textContent = '...';
    skeletons($('#seriesBody'), 6);
    api('/api/series/' + enc(ser), { timeout: 60000 }).then(function (s) {
      if (tok !== ui.token) return;
      $('#seriesTitle').textContent = s.title;
      var html = '<div class="series-head"><img src="' + esc(s.thumbnail || PLACEHOLDER) + '" alt="" referrerpolicy="no-referrer"><div class="series-info">' +
        '<div>' + esc(s.seasonCount) + ' موسم • ' + esc(s.episodeCount) + ' حلقة' + (s.category ? ' • ' + esc(s.category.name) : '') + '</div>' +
        '<p style="margin-top:8px">' + esc(s.description || '') + '</p></div></div>';
      (s.seasons || []).forEach(function (se) {
        html += '<div class="section-header"><h2>الموسم ' + esc(se.season) + '</h2></div><div class="episodes-list" style="max-height:none">' +
          se.episodes.map(function (e) {
            return '<button class="ep-btn" type="button" data-act="open-video" data-id="' + esc(e.vid) + '">' + esc(e.label) + '</button>';
          }).join('') + '</div>';
      });
      if (!(s.seasons || []).length) html += '<div class="empty">لا توجد حلقات متاحة</div>';
      $('#seriesBody').innerHTML = html;
    }).catch(function (e) {
      if (tok !== ui.token) return;
      errorBox($('#seriesBody'), e, 'open-series', ser);
    });
  }

  // ---------- player core ----------
  function setOverlay(kind, msg, actions) {
    var o = $('#playerOverlay');
    if (kind === 'hidden') { o.classList.add('hidden'); o.innerHTML = ''; return; }
    o.classList.remove('hidden');
    var h = kind === 'loading' ? '<div class="spinner"></div>' : '';
    h += '<div>' + esc(msg || '') + '</div>';
    if (actions && actions.length) {
      h += '<div class="overlay-actions">' + actions.map(function (a) {
        return '<button class="btn-sm" type="button" data-act="' + a.act + '"' + (a.data ? ' data-id="' + esc(a.data) + '"' : '') + '>' + esc(a.label) + '</button>';
      }).join('') + '</div>';
    }
    o.innerHTML = h;
  }

  function destroyHls() {
    if (P.hls) { try { P.hls.destroy(); } catch (e) {} P.hls = null; }
  }
  function stopDirect() {
    clearTimeout(P.stall);
    P.playToken++;
    destroyHls();
    var v = $('#directVideo');
    if (v) {
      try { v.pause(); } catch (e) {}
      v.removeAttribute('src');
      try { v.load(); } catch (e) {}
      v.classList.add('hidden');
    }
  }
  function stopFrame() {
    var f = $('#playerFrame');
    if (f) { f.src = 'about:blank'; f.classList.remove('hidden'); }
  }
  function stopAll() { stopDirect(); stopFrame(); }

  function resetPlayer() {
    stopAll();
    P.rec = null; P.sources = null; P.srcIdx = -1; P.season = null;
    $('#playerTitle').textContent = '...';
    $('#playerMeta').textContent = '';
    $('#serversList').innerHTML = '';
    $('#directList').innerHTML = '';
    $('#navRow').innerHTML = '';
    $('#downloadsList').innerHTML = '';
    $('#episodesBox').hidden = true;
    $('#relatedBox').hidden = true;
  }

  function openVideo(vid) {
    var tok = ++ui.token;
    showView('playerView');
    resetPlayer();
    P.vid = vid;
    setHash('#play/' + enc(vid));
    ui.retry = function () { openVideo(vid); };
    setOverlay('loading', 'جاري تحميل بيانات الفيديو...');
    api('/api/video/' + enc(vid), { timeout: 70000 }).then(function (rec) {
      if (tok !== ui.token) return;
      P.rec = rec;
      renderPlayerInfo(rec);
      if (rec.stale) toast('تعذّر التحديث — بيانات محفوظة', true);
      selectMode(prefs.mode, true);
    }).catch(function (e) {
      if (tok !== ui.token) return;
      $('#playerTitle').textContent = 'فشل التحميل';
      setOverlay('error', errText(e), [{ act: 'retry', label: 'إعادة المحاولة' }]);
    });
  }

  function renderPlayerInfo(rec) {
    $('#playerTitle').textContent = rec.title || P.vid;
    document.title = (rec.title || 'لاروزا بلاير') + ' — لاروزا بلاير';
    var parts = [];
    if (rec.duration) parts.push(rec.duration);
    if (rec.year) parts.push(rec.year);
    if (rec.category && rec.category.name) parts.push(rec.category.name);
    parts.push((rec.servers || []).length + ' سيرفر');
    if (rec.episodes && rec.episodes.length) parts.push(rec.episodes.length + ' حلقة');
    $('#playerMeta').textContent = parts.join(' • ');

    var nav = '';
    if (rec.prev) nav += '<button class="btn-outline" type="button" data-act="open-video" data-id="' + esc(rec.prev.vid) + '">→ ' + esc(rec.prev.label || 'السابقة') + '</button>';
    if (rec.seriesId) nav += '<button class="btn-outline" type="button" data-act="open-series" data-id="' + esc(rec.seriesId) + '">كل الحلقات</button>';
    if (rec.next) nav += '<button class="btn-outline" type="button" data-act="open-video" data-id="' + esc(rec.next.vid) + '">' + esc(rec.next.label || 'التالية') + ' ←</button>';
    $('#navRow').innerHTML = nav;

    renderEpisodes(rec);
    var rel = (rec.related || []);
    $('#relatedBox').hidden = !rel.length;
    if (rel.length) $('#relatedGrid').innerHTML = rel.map(card).join('');
  }

  function renderEpisodes(rec) {
    var seasons = rec.seasons || [];
    if (!seasons.length || (rec.episodes || []).length < 2) { $('#episodesBox').hidden = true; return; }
    $('#episodesBox').hidden = false;
    if (P.season == null) P.season = rec.season || seasons[0].season;
    $('#seasonTabs').innerHTML = seasons.length > 1 ? seasons.map(function (s) {
      return '<button class="season-tab' + (s.season === P.season ? ' active' : '') + '" type="button" data-act="season" data-id="' + s.season + '">الموسم ' + s.season + '</button>';
    }).join('') : '';
    var cur = seasons.filter(function (s) { return s.season === P.season; })[0] || seasons[0];
    $('#episodesList').innerHTML = cur.episodes.map(function (e) {
      return '<button class="ep-btn' + (e.vid === rec.vid ? ' active' : '') + '" type="button" data-act="open-video" data-id="' + esc(e.vid) + '">' + esc(e.label) + '</button>';
    }).join('');
    var act = $('#episodesList .active');
    if (act && act.scrollIntoView) { try { act.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  // ---- mode: laroza servers / direct ----
  function selectMode(mode, silent) {
    P.mode = mode;
    if (!silent || prefs.mode !== mode) { prefs.mode = mode; savePrefs(); }
    $('#modeLaroza').classList.toggle('active', mode === 'laroza');
    $('#modeDirect').classList.toggle('active', mode === 'direct');
    $('#panelLaroza').classList.toggle('hidden', mode !== 'laroza');
    $('#panelDirect').classList.toggle('hidden', mode !== 'direct');
    stopAll();
    if (!P.rec) return;
    if (mode === 'laroza') renderServers(); else loadDirect(false);
  }

  function renderServers() {
    var list = P.rec.servers || [];
    if (!list.length) {
      $('#serversList').innerHTML = '<span style="color:var(--muted)">لا توجد سيرفرات متاحة لهذا الفيديو</span>';
      setOverlay('error', 'لا توجد سيرفرات متاحة حالياً لهذا الفيديو.', [
        { act: 'retry-full', label: 'إعادة الجلب' }, { act: 'mode-direct', label: 'جرّب التشغيل المباشر' }
      ]);
      return;
    }
    var idx = prefs.serverIdx < list.length ? prefs.serverIdx : 0;
    if (idx === 0) { var pi = list.findIndex(function (s) { return s.primary; }); if (pi >= 0 && prefs.serverIdx === 0) idx = pi; }
    $('#serversList').innerHTML = list.map(function (s, i) {
      return '<button class="server-btn' + (i === idx ? ' active' : '') + '" type="button" data-act="server" data-id="' + i + '">' + esc(s.name) + (s.primary ? '<small>★</small>' : '') + '<small>' + esc(s.host.replace(/^www\./, '')) + '</small></button>';
    }).join('');
    playServer(idx, true);
  }

  function playServer(i, silent) {
    var s = (P.rec.servers || [])[i];
    if (!s) return;
    stopDirect();
    P.serverIdx = i;
    if (!silent) { prefs.serverIdx = i; savePrefs(); }
    $$('#serversList .server-btn').forEach(function (b, k) { b.classList.toggle('active', k === i); });
    var f = $('#playerFrame');
    f.classList.remove('hidden');
    setOverlay('loading', 'جاري تحميل ' + s.name + '...');
    var done = false;
    var finish = function () {
      if (done) return;
      done = true;
      setOverlay('hidden');
    };
    f.onload = finish;
    setTimeout(finish, 6000);
    f.src = s.url;
  }

  // ---- direct sources ----
  var STATUS_AR = { available: 'متاح', unavailable: 'غير متاح', failed: 'فشل الاتصال', unsupported: 'غير مدعوم' };
  function loadDirect(force) {
    if (P.sources && !force) { renderSources(); return; }
    var vid = P.vid;
    $('#directList').innerHTML = '<div class="empty" style="padding:18px">جاري فحص مصادر التشغيل المباشر...</div>';
    setOverlay('loading', 'جاري البحث عن مصادر مباشرة متاحة...');
    api('/api/video/' + enc(vid) + '/sources?probe=1', { timeout: 90000 }).then(function (d) {
      if (P.vid !== vid || P.mode !== 'direct') return;
      P.sources = d.sources || [];
      renderSources();
    }).catch(function (e) {
      if (P.vid !== vid || P.mode !== 'direct') return;
      $('#directList').innerHTML = '<div class="empty" style="padding:18px">' + esc(errText(e)) + '</div>';
      setOverlay('error', errText(e), [{ act: 'recheck-sources', label: 'إعادة المحاولة' }, { act: 'mode-laroza', label: 'سيرفرات لاروزا' }]);
    });
  }
  function renderSources() {
    var list = P.sources || [];
    if (!list.length) {
      $('#directList').innerHTML = '<div class="empty" style="padding:18px">لا توجد مصادر تشغيل مباشر معلنة لهذا الفيديو.</div>';
      setOverlay('error', 'لا توجد مصادر مباشرة متاحة. استخدم سيرفرات لاروزا.', [{ act: 'mode-laroza', label: 'سيرفرات لاروزا' }]);
      return;
    }
    $('#directList').innerHTML = list.map(function (s, i) {
      var playable = s.status === 'available';
      return '<div class="src-row' + (i === P.srcIdx ? ' active' : '') + '"><div class="src-main"><div class="src-name">' +
        (s.type === 'hls' ? 'HLS (m3u8)' : 'MP4') + ' #' + (i + 1) + '</div><div class="src-host">' + esc(s.host) + '</div>' +
        (s.reason ? '<div class="src-reason">' + esc(s.reason) + '</div>' : '') + '</div>' +
        '<span class="pill ' + esc(s.status) + '">' + esc(STATUS_AR[s.status] || s.status) + '</span>' +
        '<button class="server-btn' + (i === P.srcIdx ? ' active' : '') + '" type="button" data-act="play-src" data-id="' + i + '"' + (playable ? '' : ' disabled style="opacity:.45;cursor:not-allowed"') + '>▶ تشغيل</button></div>';
    }).join('');
    var first = list.findIndex(function (s) { return s.status === 'available'; });
    if (first >= 0) { if (P.srcIdx < 0) playDirect(first); }
    else setOverlay('error', 'لا يوجد مصدر مباشر متاح حالياً (راجع حالة كل مصدر).', [{ act: 'mode-laroza', label: 'سيرفرات لاروزا' }]);
  }

  function ensureHls() {
    if (window.Hls) return Promise.resolve(true);
    if (P.hlsLoading) return P.hlsLoading;
    P.hlsLoading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
      s.onload = function () { resolve(!!window.Hls); };
      s.onerror = function () { P.hlsLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return P.hlsLoading;
  }

  function playDirect(i) {
    var s = (P.sources || [])[i];
    if (!s) return;
    stopAll();
    var token = ++P.playToken;
    P.srcIdx = i;
    renderSourcesActiveOnly();
    var v = $('#directVideo');
    $('#playerFrame').classList.add('hidden');
    v.classList.remove('hidden');
    setOverlay('loading', 'جاري تشغيل المصدر المباشر...');
    var failed = false;
    var fail = function (msg) {
      if (failed || token !== P.playToken) return;
      failed = true;
      clearTimeout(P.stall);
      destroyHls();
      setOverlay('error', msg, [
        { act: 'retry-src', label: 'إعادة المحاولة', data: String(i) },
        { act: 'mode-laroza', label: 'سيرفرات لاروزا' }
      ]);
    };
    v.onplaying = function () { if (token === P.playToken) { clearTimeout(P.stall); setOverlay('hidden'); } };
    v.onerror = function () { fail('تعذّر تشغيل هذا المصدر (قد يكون محظوراً أو غير متاح للمتصفح).'); };
    P.stall = setTimeout(function () { fail('انتهت مهلة تحميل المصدر.'); }, 25000);

    if (s.type === 'hls') {
      ensureHls().then(function (ok) {
        if (token !== P.playToken) return;
        if (ok && window.Hls.isSupported()) {
          var h = new window.Hls({ enableWorker: true, backBufferLength: 60 });
          P.hls = h;
          h.on(window.Hls.Events.MANIFEST_PARSED, function () { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); });
          h.on(window.Hls.Events.ERROR, function (_, data) {
            if (data && data.fatal) fail('فشل تحميل مصدر HLS' + (data.details ? ' (' + data.details + ')' : '') + '. غالباً بسبب قيود الموقع المصدر.');
          });
          h.loadSource(s.url);
          h.attachMedia(v);
        } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
          v.src = s.url;
          var p2 = v.play(); if (p2 && p2.catch) p2.catch(function () {});
        } else {
          fail('المتصفح لا يدعم HLS.');
        }
      });
    } else {
      v.src = s.url;
      var p = v.play(); if (p && p.catch) p.catch(function () {});
    }
  }
  function renderSourcesActiveOnly() {
    $$('#directList .src-row').forEach(function (r, k) { r.classList.toggle('active', k === P.srcIdx); });
    $$('#directList [data-act="play-src"]').forEach(function (b, k) { b.classList.toggle('active', k === P.srcIdx); });
  }

  function fullscreen() {
    var v = $('#directVideo');
    var wrap = $('#playerFrameWrap');
    try {
      if (!v.classList.contains('hidden') && v.webkitEnterFullscreen && !wrap.requestFullscreen) { v.webkitEnterFullscreen(); return; }
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      if (wrap.requestFullscreen) wrap.requestFullscreen();
      else if (wrap.webkitRequestFullscreen) wrap.webkitRequestFullscreen();
    } catch (e) { toast('ملء الشاشة غير مدعوم هنا', true); }
  }

  function loadDownloads() {
    var vid = P.vid;
    $('#downloadsList').innerHTML = '<span style="color:var(--muted)">جاري التحميل...</span>';
    api('/api/video/' + enc(vid) + '/downloads', { timeout: 60000 }).then(function (d) {
      if (P.vid !== vid) return;
      var l = d.downloads || [];
      $('#downloadsList').innerHTML = l.length ? l.map(function (x) {
        return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.host || 'تحميل') + '</a>';
      }).join('') : '<span style="color:var(--muted)">لا توجد روابط تحميل</span>';
    }).catch(function (e) { $('#downloadsList').innerHTML = '<span style="color:var(--muted)">' + esc(errText(e)) + '</span>'; });
  }

  // ---------- routing ----------
  function route() {
    var h = location.hash || '';
    var m;
    if ((m = h.match(/^#play\/(.+)$/))) return openVideo(decodeURIComponent(m[1]));
    if ((m = h.match(/^#series\/(.+)$/))) return openSeries(decodeURIComponent(m[1]));
    if ((m = h.match(/^#search\/(.+)$/))) return doSearch(decodeURIComponent(m[1]));
    if ((m = h.match(/^#cat\/(.+)$/))) return openCategory(decodeURIComponent(m[1]));
    if (h === '#new') return openNew();
    document.title = 'لاروزا بلاير';
    loadHome(false);
  }
  window.addEventListener('hashchange', function () {
    if (ui.suppress) { ui.suppress = false; return; }
    route();
  });

  // ---------- events (delegated; no inline handlers) ----------
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (!t) { if (!e.target.closest('#searchForm')) hideSuggest(); return; }
    var act = t.getAttribute('data-act');
    var id = t.getAttribute('data-id');
    switch (act) {
      case 'home': e.preventDefault(); history.replaceState(null, '', location.pathname); loadHome(false); break;
      case 'back': if (history.length > 1) history.back(); else loadHome(false); break;
      case 'refresh-home': loadHome(true); break;
      case 'open-video': openVideo(id); break;
      case 'open-series': openSeries(id); break;
      case 'list-more': listMore(); break;
      case 'list-retry': if (ui.list) { ui.list.done = false; ui.list.busy = false; listMore(); } break;
      case 'suggest': doSearch(t.getAttribute('data-q')); break;
      case 'save-api': saveApi(); break;
      case 'mode': prefs.serverIdx = prefs.serverIdx; selectMode(t.getAttribute('data-mode')); break;
      case 'mode-direct': selectMode('direct'); break;
      case 'mode-laroza': selectMode('laroza'); break;
      case 'server': playServer(parseInt(id, 10)); break;
      case 'play-src': playDirect(parseInt(id, 10)); break;
      case 'retry-src': playDirect(parseInt(id, 10)); break;
      case 'retry': if (ui.retry) ui.retry(); break;
      case 'retry-full': api('/api/video/' + enc(P.vid) + '?refresh=1', { timeout: 70000 }).then(function (r) { P.rec = r; renderPlayerInfo(r); selectMode(P.mode, true); }).catch(function (er) { toast(errText(er), true); }); break;
      case 'recheck-sources': P.sources = null; P.srcIdx = -1; loadDirect(true); break;
      case 'reload-player': if (P.mode === 'laroza') playServer(P.serverIdx, true); else if (P.srcIdx >= 0) playDirect(P.srcIdx); else loadDirect(true); break;
      case 'fullscreen': fullscreen(); break;
      case 'season': P.season = parseInt(id, 10); renderEpisodes(P.rec); break;
      case 'load-downloads': loadDownloads(); break;
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (t && t.getAttribute && t.getAttribute('role') === 'link' && t.getAttribute('data-act')) { e.preventDefault(); t.click(); }
  });
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && !t.getAttribute('data-fb')) { t.setAttribute('data-fb', '1'); t.src = PLACEHOLDER; }
  }, true);
  // Category chips and "view all" links are plain anchors with hash routes.

  $('#searchForm').addEventListener('submit', function (e) { e.preventDefault(); doSearch($('#searchInput').value); });
  $('#searchInput').addEventListener('input', onSearchInput);

  function saveApi() {
    var val = $('#apiBase').value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(val)) { toast('اكتب رابطاً صحيحاً يبدأ بـ http(s)://', true); return; }
    API_BASE = val;
    LS.set('laroza_api', val);
    toast('تم الحفظ');
    boot();
  }

  function boot() {
    $('#apiBase').value = API_BASE;
    api('/health', { timeout: 12000 }).then(function () {
      setStatus(true);
      loadCategories();
      route();
    }).catch(function (e) {
      setStatus(false);
      showView('homeView');
      $('#homeSeries').innerHTML = '';
      $('#homeSections').innerHTML = '<div class="empty">السيرفر غير متصل<br><small>' + esc(errText(e)) + '</small><br><button class="btn-outline" type="button" data-act="refresh-home">إعادة المحاولة</button></div>';
    });
  }
  window.__LAROZA_VERSION__ = VERSION;
  boot();
})();
`;

// ============================================================================
// HTTP SERVER
// ============================================================================

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN'
};
const CSP = "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; " +
  "img-src * data: blob:; media-src * blob: data:; frame-src *; connect-src *; base-uri 'none'; form-action 'self'";

class ApiServer {
  constructor(service, store, site) {
    this.service = service;
    this.store = store;
    this.site = site;
    this.routes = [];
    this.server = null;
    this.hits = new Map();
  }

  get(pattern, handler) { this.routes.push({ parts: pattern.split('/').filter(Boolean), handler }); }

  match(pathname) {
    const pp = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.parts.length !== pp.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pp.length; i++) {
        if (r.parts[i].startsWith(':')) {
          try { params[r.parts[i].slice(1)] = decodeURIComponent(pp[i]); } catch (_) { ok = false; break; }
        } else if (r.parts[i] !== pp[i]) { ok = false; break; }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  rateLimited(ip) {
    const now = Date.now();
    let h = this.hits.get(ip);
    if (!h || now - h.start > 60000) { h = { start: now, n: 0 }; this.hits.set(ip, h); }
    h.n++;
    if (this.hits.size > 5000) { for (const [k, v] of this.hits) if (now - v.start > 60000) this.hits.delete(k); }
    return h.n > CONFIG.RATE_LIMIT_PER_MIN;
  }

  adminOk(req) {
    if (!CONFIG.ADMIN_TOKEN) return process.env.NODE_ENV !== 'production';
    const supplied = req.headers['x-admin-token'] || req.query.token;
    return supplied === CONFIG.ADMIN_TOKEN;
  }

  json(res, status, data, extra) {
    const body = JSON.stringify(data);
    res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) }, extra || {}));
    res.end(body);
  }

  sendError(res, err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) Logger.error('API error:', err.code || '', err.message);
    const extra = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
    this.json(res, status, {
      error: err.message || 'internal error', code: err.code || 'ERROR',
      retryAfter: err.retryAfter,
      stack: process.env.DEBUG === '1' ? err.stack : undefined
    }, extra);
  }

  serveStatic(res, pathname) {
    let body, ctype;
    if (pathname === '/' || pathname === '/index.html') { body = EMBEDDED_HTML; ctype = 'text/html; charset=utf-8'; }
    else if (pathname === '/style.css') { body = EMBEDDED_CSS; ctype = 'text/css; charset=utf-8'; }
    else if (pathname === '/app.js') { body = EMBEDDED_JS; ctype = 'application/javascript; charset=utf-8'; }
    else if (pathname === '/favicon.ico') { res.writeHead(204, SECURITY_HEADERS); res.end(); return true; }
    else return false;
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, Object.assign({
      'Content-Type': ctype, 'Content-Length': buf.length,
      'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=600',
      'Content-Security-Policy': CSP
    }, SECURITY_HEADERS));
    res.end(buf);
    return true;
  }

  async handle(req, res) {
    const parsed = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname;
    const method = (req.method || 'GET').toUpperCase();

    res.setHeader('Access-Control-Allow-Origin', CONFIG.CORS_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Admin-Token');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (method !== 'GET' && method !== 'HEAD') { this.json(res, 405, { error: 'method not allowed', code: 'METHOD' }); return; }

    if (this.serveStatic(res, pathname)) return;

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    if (pathname.startsWith('/api/') && this.rateLimited(ip)) {
      this.json(res, 429, { error: 'too many requests', code: 'RATE_LIMITED', retryAfter: 30 }, { 'Retry-After': '30' });
      return;
    }

    const m = this.match(pathname);
    if (!m) { this.json(res, 404, { error: 'Not found', code: 'NOT_FOUND', path: pathname }); return; }

    req.query = Object.fromEntries(parsed.searchParams);
    req.params = m.params;
    try { await m.handler(req, res); } catch (err) { if (!res.headersSent) this.sendError(res, err); else res.end(); }
  }

  start(port = CONFIG.PORT, host = CONFIG.HOST) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.requestTimeout = 120000;
    this.server.listen(port, host, () => {
      Logger.ok(`Laroza Player v${CONFIG.VERSION} → http://${host}:${port}  (upstream: ${this.site.origin})`);
    });
    return this.server;
  }
}

function setupRoutes(api, svc, store, site) {
  const qPage = req => clampInt(req.query.page, 1, 200, 1);
  const bool = v => v === '1' || v === 'true';

  api.get('/health', async (req, res) => {
    api.json(res, 200, {
      status: 'ok', version: CONFIG.VERSION, uptime: Math.round(process.uptime()),
      origin: site.origin, videos: store.cards.size,
      blocked: Date.now() < site.blockedUntil
    });
  });

  api.get('/api/stats', async (req, res) => {
    api.json(res, 200, {
      version: CONFIG.VERSION, origin: site.origin,
      store: { cards: store.cards.size, videos: store.videos.size, series: store.series.size, errors: store.stats.errors, lastCrawl: store.stats.lastCrawl },
      upstream: Object.assign({}, site.stats, { blockedUntil: site.blockedUntil ? new Date(site.blockedUntil).toISOString() : null }),
      cacheEntries: svc.cache.size
    });
  });

  api.get('/api/categories', async (req, res) => api.json(res, 200, CONFIG.CATEGORIES));

  api.get('/api/home', async (req, res) => api.json(res, 200, await svc.home({ force: bool(req.query.refresh) })));
  api.get('/api/category/:cat', async (req, res) => api.json(res, 200, await svc.category(req.params.cat, qPage(req))));
  api.get('/api/new', async (req, res) => api.json(res, 200, await svc.newVideos(qPage(req))));
  api.get('/api/top', async (req, res) => api.json(res, 200, await svc.topVideos()));
  api.get('/api/series-index', async (req, res) => api.json(res, 200, await svc.seriesIndex(qPage(req))));
  api.get('/api/search', async (req, res) => api.json(res, 200, await svc.search(req.query.q || req.query.keywords, qPage(req))));
  api.get('/api/suggest', async (req, res) => api.json(res, 200, { suggestions: svc.suggest(req.query.q || '') }));
  api.get('/api/series/:ser', async (req, res) => api.json(res, 200, await svc.series(req.params.ser)));
  api.get('/api/video/:vid', async (req, res) => api.json(res, 200, await svc.video(req.params.vid, { force: bool(req.query.refresh) })));
  api.get('/api/video/:vid/sources', async (req, res) => {
    api.json(res, 200, await svc.sources(req.params.vid, { probe: bool(req.query.probe), checkServers: bool(req.query.check) }));
  });
  api.get('/api/video/:vid/downloads', async (req, res) => api.json(res, 200, await svc.downloads(req.params.vid)));
  api.get('/api/videos', async (req, res) => {
    const limit = clampInt(req.query.limit, 1, 500, 100);
    const kind = req.query.kind;
    const list = [...store.cards.values()].filter(c => !kind || c.kind === kind).sort((a, b) => b.seenAt - a.seenAt).slice(0, limit);
    api.json(res, 200, { count: store.cards.size, videos: list });
  });
  api.get('/api/search/local', async (req, res) => {
    if (!req.query.q) throw new HttpError(400, 'missing q', 'BAD_REQUEST');
    api.json(res, 200, { results: store.search(req.query.q) });
  });

  // ---- legacy (v2) routes, kept so existing clients keep working ----------
  api.get('/api/scrape/home', async (req, res) => api.json(res, 200, await svc.home({ force: bool(req.query.refresh) })));
  api.get('/api/scrape/category/:cat', async (req, res) => {
    const pages = clampInt(req.query.pages, 1, 3, 1);
    let videos = [];
    for (let p = 1; p <= pages; p++) {
      const d = await svc.category(req.params.cat, p);
      videos = videos.concat(d.videos);
      if (!d.hasNext) break;
    }
    api.json(res, 200, { category: req.params.cat, count: videos.length, videos });
  });
  api.get('/api/scrape/new', async (req, res) => api.json(res, 200, await svc.newVideos(qPage(req))));
  api.get('/api/scrape/top', async (req, res) => api.json(res, 200, await svc.topVideos()));
  api.get('/api/scrape/search', async (req, res) => api.json(res, 200, await svc.search(req.query.q || req.query.keywords, qPage(req))));
  api.get('/api/scrape/video-light/:vid', async (req, res) => api.json(res, 200, await svc.video(req.params.vid)));
  api.get('/api/scrape/video/:vid', async (req, res) => {
    const rec = Object.assign({}, await svc.video(req.params.vid));
    if (req.query.downloads !== '0') { try { rec.downloads = (await svc.downloads(req.params.vid)).downloads; } catch (_) { /* optional */ } }
    if (req.query.m3u8 === '1') { try { rec.m3u8Probes = (await svc.sources(req.params.vid, { probe: true })).sources; } catch (_) { /* optional */ } }
    rec.light = false;
    api.json(res, 200, rec);
  });
  api.get('/api/scrape/play/:vid', async (req, res) => api.json(res, 200, await svc.play(req.params.vid)));
  api.get('/api/scrape/download/:vid', async (req, res) => api.json(res, 200, await svc.downloads(req.params.vid)));
  api.get('/api/embeds/:vid', async (req, res) => {
    const p = await svc.play(req.params.vid);
    api.json(res, 200, { vid: req.params.vid, embeds: p.servers, current: p.currentEmbed });
  });
  api.get('/api/probe/:vid', async (req, res) => {
    const r = await svc.sources(req.params.vid, { probe: true });
    api.json(res, 200, { vid: req.params.vid, probes: r.sources });
  });

  // ---- admin (token-protected in production) ------------------------------
  api.get('/api/scrape/full', async (req, res) => {
    if (!api.adminOk(req)) throw new HttpError(403, 'admin token required', 'FORBIDDEN');
    api.json(res, 200, Object.assign({ message: 'crawl runs in the background (home → latest videos)' }, await svc.crawl(clampInt(req.query.limit, 1, 100, 20))));
  });
  api.get('/api/export', async (req, res) => {
    if (!api.adminOk(req)) throw new HttpError(403, 'admin token required', 'FORBIDDEN');
    api.json(res, 200, { file: store.exportJSON() });
  });
  api.get('/api/cache/clear', async (req, res) => {
    if (!api.adminOk(req)) throw new HttpError(403, 'admin token required', 'FORBIDDEN');
    svc.cache.clear();
    api.json(res, 200, { cleared: true });
  });

  api.get('/admin', async (req, res) => {
    if (!api.adminOk(req)) throw new HttpError(403, 'admin token required', 'FORBIDDEN');
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Laroza Admin v${CONFIG.VERSION}</title>
<style>body{margin:0;font-family:Tahoma,Arial,sans-serif;background:#0b0b0f;color:#e8e8ed;line-height:1.7}.w{max-width:900px;margin:0 auto;padding:22px}h1{color:#ff3b5c}.c{background:#15151c;border:1px solid #222;border-radius:12px;padding:16px;margin:12px 0}code{background:#222;padding:2px 6px;border-radius:4px;direction:ltr;display:inline-block}li{margin:4px 0}</style></head><body><div class="w">
<h1>Laroza Scraper <small style="color:#9a9aad;font-size:.55em">v${CONFIG.VERSION}</small></h1>
<div class="c">المصدر الحالي: <code>${esc(site.origin)}</code><br>بطاقات: ${store.cards.size} • تفاصيل محفوظة: ${store.videos.size} • مسلسلات: ${store.series.size}<br>
طلبات: ${site.stats.requests} • أخطاء: ${site.stats.errors} • حجب: ${site.stats.blocks} • إعادة توجيه معتمدة: ${site.stats.redirectsAdopted}<br>
الحالة: ${Date.now() < site.blockedUntil ? 'تهدئة بعد حجب من المصدر' : 'طبيعية'}</div>
<div class="c"><b>Endpoints</b><ul>
<li><code>GET /api/home</code> • <code>/api/category/:cat?page=</code> • <code>/api/new</code> • <code>/api/search?q=&amp;page=</code> • <code>/api/suggest?q=</code></li>
<li><code>GET /api/video/:vid</code> • <code>/api/video/:vid/sources?probe=1</code> • <code>/api/video/:vid/downloads</code> • <code>/api/series/:ser</code></li>
<li><code>GET /health</code> • <code>/api/stats</code> • <code>/api/cache/clear</code> • <code>/api/scrape/full?limit=20</code> • <code>/api/export</code></li>
<li>مسارات v2 القديمة <code>/api/scrape/*</code> ما زالت تعمل.</li></ul></div></div></body></html>`;
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }, SECURITY_HEADERS));
    res.end(html);
  });
}

// ============================================================================
// MAIN
// ============================================================================

function createApp() {
  const store = new DataStore();
  const site = new SiteClient();
  const service = new LarozaService(store, site);
  const api = new ApiServer(service, store, site);
  setupRoutes(api, service, store, site);
  return { store, site, service, api };
}

async function main() {
  ensureDir(CONFIG.DATA_DIR);
  const app = createApp();
  const server = app.api.start();

  const shutdown = sig => {
    Logger.info(`${sig}: shutting down`);
    app.store.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', e => Logger.error('Unhandled rejection:', e && e.message ? e.message : e));
  process.on('uncaughtException', e => Logger.error('Uncaught exception:', e && e.stack ? e.stack : e));

  if (process.env.AUTO_SCRAPE === '1') {
    Logger.info('AUTO_SCRAPE: warming cache (low rate)');
    app.service.crawl(8);
  }
  return app;
}

module.exports = {
  CONFIG, HtmlDoc, DataStore, SiteClient, LarozaService, ApiServer, TTLCache,
  extractCards, extractPagination, extractSections, parseVideoPage, parseSeriesPage, parsePlayPage,
  collectMedia, classifyMedia, verifySource, normalizeArabic, createApp, main
};

if (require.main === module) {
  main().catch(err => { Logger.error('Fatal:', err); process.exit(1); });
}
