/**
 * ============================================================================
 * LAROZA SCRAPER API SERVER  v2.3
 * ============================================================================
 * - API only (no embedded HTML frontend)
 * - Category: مسلسلات رمضان 2026 (ramadan-2026)
 * - Better episodes (select + anchors) + related/recommendations
 * - m3u8 / mp4 probe from embed hosts
 * - Stream proxy: /api/stream/proxy?url=... (server fetches like origin)
 * - Light + full scrape paths, memory cache, CF-aware client
 *
 * Usage:
 *   npm i dotenv https-proxy-agent socks-proxy-agent cheerio
 *   PROXY_URL=... node laroza-scraper-server.js
 * ============================================================================
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { URL } = require('url');
const zlib = require('zlib');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const querystring = require('querystring');

let dotenv = null;
let HttpsProxyAgent = null;
let SocksProxyAgent = null;
let cheerio = null;
try { dotenv = require('dotenv'); } catch (e) {}
try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch (e) {}
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch (e) {}
try { cheerio = require('cheerio'); } catch (e) {}
if (dotenv) dotenv.config();

const CONFIG = {
  BASE_URL: 'https://laroza1.lat',
  HOME_PATH: '/home.24',
  PORT: parseInt(process.env.PORT || '3030', 10),
  HOST: process.env.HOST || '0.0.0.0',
  REQUEST_TIMEOUT: 22000,
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3', 10),
  RETRY_DELAY_MS: 1200,
  REQUEST_DELAY_MS: parseInt(process.env.REQUEST_DELAY_MS || '450', 10),
  CONCURRENCY: parseInt(process.env.CONCURRENCY || '2', 10),
  DATA_DIR: path.join(__dirname, 'laroza_data'),
  MEMORY_CACHE_TTL_MS: 1000 * 60 * 12,
  PROXY_URL: process.env.PROXY_URL || '',
  PROXY_LIST: (process.env.PROXY_LIST || '').split(',').map(s => s.trim()).filter(Boolean),
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0'
  ],
  CATEGORIES: {
    'ramadan-2026': { name: 'مسلسلات رمضان 2026', type: 'series', featured: true },
    'arabic-series46': { name: 'مسلسلات عربية', type: 'series' },
    'turkish-3isk-seriess47': { name: 'مسلسلات تركية', type: 'series' },
    'english-series10': { name: 'مسلسلات أجنبية', type: 'series' },
    '11indian-series': { name: 'مسلسلات هندية', type: 'series' },
    '6-asya': { name: 'مسلسلات آسيوية', type: 'series' },
    '6-anime-series': { name: 'مسلسلات أنمي', type: 'series' },
    'arabic-movies35': { name: 'أفلام عربية', type: 'movie' },
    'indian-movies9': { name: 'أفلام هندية', type: 'movie' },
    '6-asian-movies': { name: 'أفلام آسيوية', type: 'movie' },
    'anime-movies-7': { name: 'أفلام أنمي', type: 'movie' },
    '7-aflammdblgh': { name: 'أفلام مدبلجة', type: 'movie' },
    '8-aflam3isk': { name: 'أفلام رومانسية', type: 'movie' },
    'all_movies_13': { name: 'كل الأفلام', type: 'movie' },
    'tv-programs12': { name: 'برامج تلفزيونية', type: 'other' },
    'masrh-5': { name: 'مسرحيات', type: 'other' }
  },
  DEFAULT_HEADERS: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'Connection': 'keep-alive'
  },
  M3U8_FRIENDLY_HOSTS: [
    'okhd', 'okprime', 'streamhls', 'vidmoly', 'voe.sx', 'mixdrop', 'dsvplay',
    'film77', 'vidoba', 'mp4plus', 'anafast', 'vidspeed', 'hgcloud', 'upzur',
    'vidara', 'streamwish', 'filemoon', 'voe', 'dood'
  ]
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomDelay(min = 250, max = 800) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}
function nowISO() { return new Date().toISOString(); }
function absoluteUrl(relative, base = CONFIG.BASE_URL) {
  try { return new URL(relative, base).href; } catch { return relative; }
}
function extractVidFromUrl(u) {
  if (!u) return null;
  const m = String(u).match(/[?&]vid=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}
function cleanText(txt) {
  if (!txt) return '';
  return String(txt).replace(/\s+/g, ' ').replace(/[\r\n\t]+/g, ' ').trim();
}
function isCloudflareChallenge(html, status) {
  if (status === 403 || status === 503) return true;
  if (!html) return false;
  return ['cf-browser-verification', 'Just a moment', 'cf-challenge', 'challenge-platform',
    'Attention Required! | Cloudflare', 'Checking your browser'].some(m => html.includes(m));
}
function seriesBaseTitle(title) {
  if (!title) return '';
  return cleanText(title)
    .replace(/\s*الحلقة\s*\d+.*$/i, '')
    .replace(/\s*حلقه\s*\d+.*$/i, '')
    .replace(/\s*Episode\s*\d+.*$/i, '')
    .replace(/\s+\d+\s*$/, '')
    .trim();
}

const Logger = {
  info: (...a) => console.log(`[${nowISO()}] [INFO]`, ...a),
  warn: (...a) => console.warn(`[${nowISO()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${nowISO()}] [ERROR]`, ...a),
  success: (...a) => console.log(`[${nowISO()}] [OK]`, ...a),
  debug: (...a) => { if (process.env.DEBUG === '1') console.log(`[${nowISO()}] [DEBUG]`, ...a); }
};

class MemoryCache {
  constructor(ttlMs = CONFIG.MEMORY_CACHE_TTL_MS) {
    this.ttl = ttlMs;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this.map.delete(key); return null; }
    return e.val;
  }
  set(key, val, ttl) {
    this.map.set(key, { val, exp: Date.now() + (ttl || this.ttl) });
  }
}

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.index = 0;
    if (CONFIG.PROXY_URL) this.proxies.push(CONFIG.PROXY_URL);
    if (CONFIG.PROXY_LIST.length) this.proxies.push(...CONFIG.PROXY_LIST);
    this.proxies = [...new Set(this.proxies.filter(Boolean))];
    if (this.proxies.length) Logger.info(`Loaded ${this.proxies.length} proxy(ies)`);
    else Logger.warn('No proxy – CF may throttle Railway IP');
  }
  hasProxy() { return this.proxies.length > 0; }
  next() {
    if (!this.proxies.length) return null;
    const p = this.proxies[this.index % this.proxies.length];
    this.index++;
    return p;
  }
  createAgent(proxyUrl) {
    if (!proxyUrl) return null;
    try {
      if (proxyUrl.startsWith('socks')) {
        if (!SocksProxyAgent) return null;
        return new SocksProxyAgent(proxyUrl);
      }
      if (!HttpsProxyAgent) return null;
      return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      Logger.warn('Proxy agent error:', e.message);
      return null;
    }
  }
}

class HttpClient {
  constructor() {
    this.timeout = CONFIG.REQUEST_TIMEOUT;
    this.maxRetries = CONFIG.MAX_RETRIES;
    this.retryDelay = CONFIG.RETRY_DELAY_MS;
    this.cookies = {};
    this.lastRequestTime = 0;
    this.proxyManager = new ProxyManager();
    this.cfBlockedUntil = 0;
    this.cfHits = 0;
  }

  pickUA() { return randomItem(CONFIG.USER_AGENTS); }

  getCookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  buildHeaders(extra = {}) {
    const headers = Object.assign({}, CONFIG.DEFAULT_HEADERS, {
      'User-Agent': this.pickUA(),
      'Referer': CONFIG.BASE_URL + '/',
      'Origin': CONFIG.BASE_URL
    }, extra);
    const c = this.getCookieHeader();
    if (c) headers['Cookie'] = c;
    return headers;
  }

  async throttle() {
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < CONFIG.REQUEST_DELAY_MS) await sleep(CONFIG.REQUEST_DELAY_MS - elapsed);
    this.lastRequestTime = Date.now();
  }

  _parseSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const c of list) {
      const part = c.split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) this.cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }

  clearCfCookies() {
    delete this.cookies['cf_clearance'];
    delete this.cookies['__cf_bm'];
  }

  request(targetUrl, options = {}) {
    return new Promise(async (resolve, reject) => {
      if (!options.skipThrottle) await this.throttle();
      if (Date.now() < this.cfBlockedUntil) {
        const wait = this.cfBlockedUntil - Date.now();
        Logger.warn(`CF cooldown ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }

      let parsed;
      try { parsed = new URL(targetUrl); } catch (e) { return reject(e); }
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const headers = this.buildHeaders(options.headers || {});
      if (options.method === 'POST' && options.body) {
        headers['Content-Type'] = headers['Content-Type'] || 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(options.body);
      }
      const proxyUrl = options.proxy !== undefined ? options.proxy : this.proxyManager.next();
      const agent = this.proxyManager.createAgent(proxyUrl);
      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers,
        timeout: options.timeout || this.timeout,
        rejectUnauthorized: false
      };
      if (agent) reqOptions.agent = agent;

      const req = lib.request(reqOptions, (res) => {
        if (options.rawStream) {
          resolve({ status: res.statusCode, headers: res.headers, stream: res, url: targetUrl });
          return;
        }
        const chunks = [];
        let stream = res;
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') {
          try { stream = res.pipe(zlib.createBrotliDecompress()); } catch { stream = res; }
        }
        stream.on('data', c => chunks.push(c));
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let body = '';
          try { body = buffer.toString('utf8'); } catch { body = buffer.toString('latin1'); }
          this._parseSetCookie(res.headers['set-cookie']);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            buffer,
            url: targetUrl,
            proxyUsed: proxyUrl || null
          });
        });
        stream.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async get(targetUrl, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.request(targetUrl, options);
        if (options.rawStream) return res;
        if (isCloudflareChallenge(res.body, res.status)) {
          this.cfHits++;
          Logger.warn(`CF challenge attempt ${attempt} on ${targetUrl}`);
          this.clearCfCookies();
          this.cfBlockedUntil = Date.now() + Math.min(8000 + 2500 * attempt + this.cfHits * 400, 22000);
          await sleep(this.retryDelay * attempt);
          continue;
        }
        if (res.status >= 200 && res.status < 400) {
          if (this.cfHits > 0) this.cfHits--;
          return res;
        }
        if (res.status === 403 || res.status === 429) {
          this.clearCfCookies();
          await sleep(this.retryDelay * attempt * 1.3);
          continue;
        }
        if (res.status >= 500) {
          await sleep(this.retryDelay * attempt);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        Logger.warn(`Request fail ${attempt}: ${err.message}`);
        if (attempt < this.maxRetries) await sleep(this.retryDelay * attempt);
      }
    }
    throw lastError || new Error('Max retries exceeded');
  }
}

class HtmlParser {
  constructor(html) {
    this.html = html || '';
    this.$ = null;
    if (cheerio) {
      try { this.$ = cheerio.load(this.html); } catch (e) {}
    }
  }

  extractVideoCards() {
    const videos = [];
    const seen = new Set();
    const thumbByVid = {};
    let tm;
    const thumbRe = /uploads\/thumbs\/([a-zA-Z0-9_-]+)-1\.(?:jpg|jpeg|png|webp)[^"'\s]*/gi;
    while ((tm = thumbRe.exec(this.html)) !== null) {
      const id = tm[1];
      const full = tm[0].startsWith('http') ? tm[0] : (CONFIG.BASE_URL + '/' + tm[0].replace(/^\//, ''));
      if (!thumbByVid[id]) thumbByVid[id] = full.split('"')[0].split("'")[0];
    }
    const imgRe = /(?:src|data-src)=["']([^"']*uploads\/thumbs\/[^"']+)["']/gi;
    while ((tm = imgRe.exec(this.html)) !== null) {
      const src = tm[1];
      const idm = src.match(/uploads\/thumbs\/([a-zA-Z0-9_-]+)/);
      if (idm && !thumbByVid[idm[1]]) {
        thumbByVid[idm[1]] = src.startsWith('http') ? src : absoluteUrl(src);
      }
    }
    const re1 = /href=["']([^"']*video\.php\?vid=([a-zA-Z0-9_-]+))["'][^>]*(?:title=["']([^"']*)["'])?/gi;
    let m;
    while ((m = re1.exec(this.html)) !== null) {
      const vid = m[2];
      if (seen.has(vid)) continue;
      seen.add(vid);
      videos.push({
        vid,
        url: absoluteUrl(m[1]),
        title: cleanText(m[3] || ''),
        thumbnail: thumbByVid[vid] || (CONFIG.BASE_URL + '/uploads/thumbs/' + vid + '-1.jpg'),
        source: 'video.php'
      });
    }
    for (const v of videos) {
      if (!v.title) {
        const idx = this.html.indexOf('vid=' + v.vid);
        if (idx === -1) continue;
        const around = this.html.substring(Math.max(0, idx - 450), idx + 450);
        const titleMatch = around.match(/title=["']([^"']{5,140})["']/i) ||
          around.match(/alt=["']([^"']{5,140})["']/i) ||
          around.match(/<strong[^>]*>([^<]{5,110})<\/strong>/i) ||
          around.match(/<h[12][^>]*>([^<]{5,120})<\/h[12]>/i);
        if (titleMatch) v.title = cleanText(titleMatch[1]);
      }
      if (thumbByVid[v.vid]) v.thumbnail = thumbByVid[v.vid];
    }
    return videos;
  }

  extractEpisodes() {
    const episodes = [];
    const seen = new Set();
    const optRe = /<option[^>]*value=["']([^"']*video\.php\?vid=([a-zA-Z0-9_-]+))["'][^>]*>([\s\S]*?)<\/option>/gi;
    let m;
    while ((m = optRe.exec(this.html)) !== null) {
      const vid = m[2];
      if (seen.has(vid)) continue;
      let label = cleanText(m[3].replace(/<[^>]+>/g, ' '));
      if (!label || label.length > 80) continue;
      let num = null;
      const nm = label.match(/(?:الحلقة|حلقه|Episode)\s*(\d+)/i) || label.match(/(\d+)/);
      if (nm) num = parseInt(nm[1], 10);
      seen.add(vid);
      episodes.push({
        vid, url: absoluteUrl(m[1]),
        label: num != null ? ('الحلقة ' + num) : label,
        title: label, episode: num
      });
    }
    const re = /href=["']([^"']*video\.php\?vid=([a-zA-Z0-9_-]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re.exec(this.html)) !== null) {
      const vid = m[2];
      let inner = cleanText(m[3].replace(/<[^>]+>/g, ' '));
      if (!inner || inner.length > 60) continue;
      if (/var |function|MELODY|document\.|\{|\}/.test(inner)) continue;
      const isEp = /(?:الحلقة|حلقه)\s*\d+|\d+\s*(?:حلقة|حلقه)|Episode\s*\d+/i.test(inner);
      if (!isEp || seen.has(vid)) continue;
      seen.add(vid);
      let num = null;
      const numMatch = inner.match(/(?:الحلقة|حلقه|Episode)\s*(\d+)/i) || inner.match(/(\d+)\s*(?:حلقة|حلقه)/i);
      if (numMatch) num = parseInt(numMatch[1], 10);
      episodes.push({
        vid, url: absoluteUrl(m[1]),
        label: num != null ? ('الحلقة ' + num) : inner,
        title: inner, episode: num
      });
    }
    episodes.sort((a, b) => {
      if (a.episode != null && b.episode != null) return a.episode - b.episode;
      if (a.episode != null) return -1;
      if (b.episode != null) return 1;
      return 0;
    });
    return episodes;
  }

  extractEmbedServers() {
    const servers = [];
    const re = /<li[^>]*data-embed-id=["'](\d+)["'][^>]*data-embed-url=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(this.html)) !== null) {
      let u = m[2].replace(/&amp;/g, '&');
      servers.push({ id: parseInt(m[1], 10), url: u, name: `سيرفر ${m[1]}` });
    }
    if (!servers.length) {
      const iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
      while ((m = iframeRe.exec(this.html)) !== null) {
        if (/laroza|about:blank|telegram/i.test(m[1])) continue;
        servers.push({ id: servers.length + 1, url: m[1].replace(/&amp;/g, '&'), name: `Embed ${servers.length + 1}` });
      }
    }
    const dataSrcRe = /data-(?:src|url|embed|file)=["'](https?:\/\/[^"']+)["']/gi;
    while ((m = dataSrcRe.exec(this.html)) !== null) {
      const u = m[1].replace(/&amp;/g, '&');
      if (!servers.find(s => s.url === u)) {
        servers.push({ id: servers.length + 1, url: u, name: `Data ${servers.length + 1}` });
      }
    }
    return servers;
  }

  extractRelated() {
    const related = [];
    const seen = new Set();
    const sections = [];
    const secRe = /(?:قد تود|قد يعجبك|مشاهدتها|مسلسلات\s+\S+\s+قد|Related|Similar)[\s\S]{0,8000}/gi;
    let sm;
    while ((sm = secRe.exec(this.html)) !== null) sections.push(sm[0]);
    const blobs = sections.length ? sections : [this.html];
    for (const blob of blobs) {
      const cards = new HtmlParser(blob).extractVideoCards();
      for (const c of cards) {
        if (seen.has(c.vid)) continue;
        seen.add(c.vid);
        related.push(c);
      }
    }
    return related.slice(0, 24);
  }

  extractDownloadLinks() {
    const links = [];
    const re = /href=["'](https?:\/\/[^"']+)["'][^>]*>[\s\S]*?(?:تحميل|Download|اضغط)/gi;
    let m;
    while ((m = re.exec(this.html)) !== null) {
      const href = m[1];
      if (href.includes('laroza1.lat') || href.includes('javascript')) continue;
      try { links.push({ url: href, host: new URL(href).hostname }); } catch (e) {}
    }
    return links;
  }

  extractMetadata() {
    const meta = { title: '', description: '', duration: '', thumbnail: '', year: '' };
    const titleMatch = this.html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) meta.title = cleanText(titleMatch[1].replace(/\s*[-|].*$/, ''));
    const ogTitle = this.html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
      this.html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitle) meta.title = cleanText(ogTitle[1]);
    const ogDesc = this.html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    if (ogDesc) meta.description = cleanText(ogDesc[1]);
    const ogImage = this.html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    if (ogImage) meta.thumbnail = ogImage[1];
    const h1 = this.html.match(/<h1[^>]*>([^<]{4,160})<\/h1>/i);
    if (h1 && (!meta.title || meta.title.length < 8)) meta.title = cleanText(h1[1]);
    const dur =
      this.html.match(/class=["'][^"']*time[^"']*["'][^>]*>\s*<i>(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})<\/i>/i) ||
      this.html.match(/duration["'\s:=]+(\d{1,2}:\d{2}:\d{2})/i);
    if (dur) meta.duration = dur[1];
    const year = this.html.match(/(20[0-2][0-9])/);
    if (year) meta.year = year[1];
    return meta;
  }

  extractPagination() {
    const pages = [];
    const seen = new Set();
    const re = /href=["']([^"']*page=(\d+)[^"']*)["']/gi;
    let m;
    while ((m = re.exec(this.html)) !== null) {
      const p = parseInt(m[2], 10);
      if (!seen.has(p)) {
        seen.add(p);
        pages.push({ page: p, url: absoluteUrl(m[1]) });
      }
    }
    pages.sort((a, b) => a.page - b.page);
    return pages;
  }
}

class StreamProber {
  constructor(client) { this.client = client; }

  isFriendlyHost(embedUrl) {
    try {
      const host = new URL(embedUrl).hostname.toLowerCase();
      return CONFIG.M3U8_FRIENDLY_HOSTS.some(h => host.includes(h));
    } catch { return false; }
  }

  extractStreamsFromHtml(html) {
    const sources = [];
    if (!html) return sources;
    const patterns = [
      /https?:\/\/[^"'\\\s<>]+?\.m3u8[^"'\\\s<>]*/gi,
      /https?:\/\/[^"'\\\s<>]+?\.mp4[^"'\\\s<>]*/gi,
      /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi,
      /["'](https?:\/\/[^"']+\.mp4[^"']*)["']/gi,
      /file\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi,
      /src\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)["']/gi,
      /source\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi
    ];
    for (const re of patterns) {
      let mm;
      while ((mm = re.exec(html)) !== null) {
        const u = (mm[1] || mm[0]).replace(/\\+/g, '').replace(/&amp;/g, '&');
        if (u.startsWith('http') && !/google|facebook|telegram|gstatic/i.test(u)) sources.push(u);
      }
    }
    const jw = html.match(/sources\s*:\s*(\[[^\]]+\])/i);
    if (jw) {
      try {
        const arr = JSON.parse(jw[1].replace(/(['"])?([a-zA-Z0-9_]+)\1\s*:/g, '"$2":'));
        if (Array.isArray(arr)) {
          arr.forEach(s => {
            if (s.file) sources.push(s.file);
            if (s.src) sources.push(s.src);
          });
        }
      } catch (e) {}
    }
    return [...new Set(sources)];
  }

  async probeEmbed(embedUrl) {
    const result = { embedUrl, m3u8: null, mp4: null, sources: [], error: null, status: null };
    if (!embedUrl || !embedUrl.startsWith('http')) {
      result.error = 'invalid embed';
      return result;
    }
    try {
      const res = await this.client.get(embedUrl, {
        headers: {
          'Referer': CONFIG.BASE_URL + '/',
          'Origin': CONFIG.BASE_URL,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });
      result.status = res.status;
      const sources = this.extractStreamsFromHtml(res.body || '');
      result.sources = sources;
      const m3 = sources.find(s => /\.m3u8/i.test(s));
      const mp = sources.find(s => /\.mp4/i.test(s));
      if (m3) result.m3u8 = m3;
      if (mp) result.mp4 = mp;
    } catch (err) {
      result.error = err.message;
    }
    return result;
  }

  async probeMany(embedUrls, limit = 4) {
    const results = [];
    for (const u of (embedUrls || []).slice(0, limit)) {
      if (!this.isFriendlyHost(u)) {
        results.push({ embedUrl: u, skipped: true, reason: 'host not friendly' });
        continue;
      }
      results.push(await this.probeEmbed(u));
      await randomDelay(350, 800);
    }
    return results;
  }
}

class DataStore {
  constructor(baseDir = CONFIG.DATA_DIR) {
    this.baseDir = baseDir;
    ensureDir(baseDir);
    this.videos = new Map();
    this.categories = new Map();
    this.stats = {
      totalVideos: 0, totalEmbeds: 0, totalDownloads: 0, totalM3u8: 0,
      lastCrawl: null, errors: 0, startedAt: nowISO()
    };
    this.load();
  }

  load() {
    try {
      const f = path.join(this.baseDir, 'videos.json');
      if (fs.existsSync(f)) {
        const data = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const [k, v] of Object.entries(data)) this.videos.set(k, v);
        this.stats.totalVideos = this.videos.size;
        Logger.info(`Loaded ${this.videos.size} videos`);
      }
      const sf = path.join(this.baseDir, 'stats.json');
      if (fs.existsSync(sf)) Object.assign(this.stats, JSON.parse(fs.readFileSync(sf, 'utf8')));
    } catch (e) { Logger.warn('Load failed:', e.message); }
  }

  save() {
    try {
      fs.writeFileSync(path.join(this.baseDir, 'videos.json'), JSON.stringify(Object.fromEntries(this.videos), null, 2));
      fs.writeFileSync(path.join(this.baseDir, 'stats.json'), JSON.stringify(this.stats, null, 2));
    } catch (e) { Logger.error('Save failed:', e.message); }
  }

  upsertVideo(vid, data) {
    const existing = this.videos.get(vid) || {};
    const merged = Object.assign({}, existing, data, { vid, updatedAt: nowISO() });
    if (!existing.createdAt) merged.createdAt = nowISO();
    this.videos.set(vid, merged);
    this.stats.totalVideos = this.videos.size;
    if (data.embeds) this.stats.totalEmbeds += (data.embeds.length || 0);
    if (data.downloads) this.stats.totalDownloads += (data.downloads.length || 0);
    if (data.m3u8Probes) {
      this.stats.totalM3u8 += (data.m3u8Probes || []).filter(p => p.m3u8 || p.mp4).length;
    }
    return merged;
  }

  getVideo(vid) { return this.videos.get(vid) || null; }

  getAllVideos(limit = 500) {
    return Array.from(this.videos.values())
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, limit);
  }

  searchLocal(q, limit = 50) {
    const query = String(q).toLowerCase();
    const results = [];
    for (const v of this.videos.values()) {
      if ((v.title || '').toLowerCase().includes(query) || (v.description || '').toLowerCase().includes(query)) {
        results.push(v);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  recommend(vid, limit = 12) {
    const base = this.getVideo(vid);
    const out = [];
    const seen = new Set([vid]);
    if (base) {
      for (const r of (base.related || [])) {
        if (seen.has(r.vid)) continue;
        seen.add(r.vid);
        out.push(r);
        if (out.length >= limit) return out;
      }
      const series = seriesBaseTitle(base.title);
      if (series.length >= 4) {
        for (const v of this.videos.values()) {
          if (seen.has(v.vid)) continue;
          if (seriesBaseTitle(v.title).includes(series) || (v.title || '').includes(series)) {
            seen.add(v.vid);
            out.push({ vid: v.vid, title: v.title, thumbnail: v.thumbnail, duration: v.duration });
            if (out.length >= limit) return out;
          }
        }
      }
    }
    for (const v of this.getAllVideos(80)) {
      if (seen.has(v.vid)) continue;
      seen.add(v.vid);
      out.push({ vid: v.vid, title: v.title, thumbnail: v.thumbnail, duration: v.duration });
      if (out.length >= limit) break;
    }
    return out;
  }
}

class LarozaScraper extends EventEmitter {
  constructor(store, client) {
    super();
    this.store = store || new DataStore();
    this.client = client || new HttpClient();
    this.prober = new StreamProber(this.client);
    this.memCache = new MemoryCache();
    this.queue = [];
    this.running = false;
    this.visited = new Set();
  }

  async fetchHome() {
    const res = await this.client.get(CONFIG.BASE_URL + CONFIG.HOME_PATH);
    const parser = new HtmlParser(res.body);
    return { videos: parser.extractVideoCards(), meta: parser.extractMetadata() };
  }

  async fetchCategory(catKey, page = 1, sortby = 'date') {
    const cat = CONFIG.CATEGORIES[catKey];
    if (!cat) throw new Error('Unknown category: ' + catKey);
    const target = `${CONFIG.BASE_URL}/category.php?cat=${encodeURIComponent(catKey)}&page=${page}&order=DESC&sortby=${sortby}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    return {
      category: catKey, name: cat.name, type: cat.type, page,
      videos: parser.extractVideoCards(),
      pagination: parser.extractPagination(),
      meta: parser.extractMetadata()
    };
  }

  async fetchVideoPage(vid) {
    const cacheKey = 'videoPage:' + vid;
    const cached = this.memCache.get(cacheKey);
    if (cached) return cached;
    const res = await this.client.get(`${CONFIG.BASE_URL}/video.php?vid=${encodeURIComponent(vid)}`);
    const parser = new HtmlParser(res.body);
    const meta = parser.extractMetadata();
    let playVid = vid;
    const playMatch = res.body.match(/play\.php\?vid=([a-zA-Z0-9_-]+)/);
    if (playMatch) playVid = playMatch[1];
    const episodes = parser.extractEpisodes();
    const related = parser.extractRelated().filter(c => c.vid !== vid);
    const cards = parser.extractVideoCards().filter(c => c.vid !== vid);
    const seen = new Set(related.map(r => r.vid));
    for (const c of cards) {
      if (!seen.has(c.vid)) { related.push(c); seen.add(c.vid); }
    }
    const out = {
      vid, playVid,
      playUrl: `${CONFIG.BASE_URL}/play.php?vid=${playVid}`,
      meta, episodes,
      related: related.slice(0, 18)
    };
    this.memCache.set(cacheKey, out, 1000 * 60 * 8);
    return out;
  }

  async fetchPlayPage(vid) {
    const cacheKey = 'playPage:' + vid;
    const cached = this.memCache.get(cacheKey);
    if (cached) return cached;
    const res = await this.client.get(`${CONFIG.BASE_URL}/play.php?vid=${encodeURIComponent(vid)}`);
    const parser = new HtmlParser(res.body);
    const embeds = parser.extractEmbedServers();
    const iframeMatch = res.body.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
    const currentEmbed = iframeMatch ? iframeMatch[1] : (embeds[0] && embeds[0].url) || null;
    const out = {
      vid,
      meta: parser.extractMetadata(),
      embeds, currentEmbed,
      related: parser.extractRelated().filter(c => c.vid !== vid).slice(0, 12),
      downloadPage: `${CONFIG.BASE_URL}/download.php?vid=${vid}`
    };
    this.memCache.set(cacheKey, out);
    return out;
  }

  async fetchDownloadPage(vid) {
    const res = await this.client.get(`${CONFIG.BASE_URL}/download.php?vid=${encodeURIComponent(vid)}`);
    const parser = new HtmlParser(res.body);
    return { vid, meta: parser.extractMetadata(), downloads: parser.extractDownloadLinks() };
  }

  async search(keywords, page = 1) {
    const target = `${CONFIG.BASE_URL}/search.php?keywords=${encodeURIComponent(keywords)}` +
      (page > 1 ? `&page=${page}` : '');
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    return { query: keywords, page, videos: parser.extractVideoCards(), pagination: parser.extractPagination() };
  }

  async scrapeVideoLight(vid) {
    Logger.info(`Light scrape: ${vid}`);
    const videoPage = await this.fetchVideoPage(vid);
    await randomDelay(200, 450);
    const playPage = await this.fetchPlayPage(videoPage.playVid || vid);
    const record = {
      vid: videoPage.vid,
      playVid: videoPage.playVid,
      title: playPage.meta.title || videoPage.meta.title,
      description: playPage.meta.description || videoPage.meta.description,
      thumbnail: playPage.meta.thumbnail || videoPage.meta.thumbnail ||
        `${CONFIG.BASE_URL}/uploads/thumbs/${videoPage.vid}-1.jpg`,
      duration: playPage.meta.duration || videoPage.meta.duration,
      year: playPage.meta.year || videoPage.meta.year,
      seriesTitle: seriesBaseTitle(playPage.meta.title || videoPage.meta.title),
      embeds: playPage.embeds || [],
      currentEmbed: playPage.currentEmbed,
      downloads: [],
      m3u8Probes: [],
      streams: [],
      episodes: videoPage.episodes || [],
      related: (videoPage.related || []).slice(0, 16),
      playUrl: videoPage.playUrl,
      sourceUrl: `${CONFIG.BASE_URL}/video.php?vid=${vid}`,
      scrapedAt: nowISO(),
      light: true
    };
    this.store.upsertVideo(vid, record);
    Logger.success(`Light ${vid} embeds=${record.embeds.length} eps=${record.episodes.length} related=${record.related.length}`);
    return record;
  }

  async scrapeFullVideo(vid, opts = {}) {
    const { includeDownloads = true, probeM3u8 = true, maxProbe = 4 } = opts;
    Logger.info(`Full scrape: ${vid}`);
    const videoPage = await this.fetchVideoPage(vid);
    await randomDelay(200, 450);
    const playPage = await this.fetchPlayPage(videoPage.playVid || vid);
    await randomDelay(200, 450);
    let downloads = [];
    if (includeDownloads) {
      try { downloads = (await this.fetchDownloadPage(videoPage.playVid || vid)).downloads; }
      catch (e) { Logger.warn('download page:', e.message); }
    }
    let m3u8Probes = [];
    let streams = [];
    if (probeM3u8 && playPage.embeds && playPage.embeds.length) {
      try {
        m3u8Probes = await this.prober.probeMany(playPage.embeds.map(e => e.url), maxProbe);
        for (const p of m3u8Probes) {
          if (p.m3u8) streams.push({ type: 'm3u8', url: p.m3u8, from: p.embedUrl });
          if (p.mp4) streams.push({ type: 'mp4', url: p.mp4, from: p.embedUrl });
          for (const s of (p.sources || [])) {
            if (!streams.find(x => x.url === s)) {
              streams.push({ type: /\.m3u8/i.test(s) ? 'm3u8' : (/\.mp4/i.test(s) ? 'mp4' : 'src'), url: s, from: p.embedUrl });
            }
          }
        }
      } catch (e) { Logger.warn('probe:', e.message); }
    }
    const record = {
      vid: videoPage.vid,
      playVid: videoPage.playVid,
      title: playPage.meta.title || videoPage.meta.title,
      description: playPage.meta.description || videoPage.meta.description,
      thumbnail: playPage.meta.thumbnail || videoPage.meta.thumbnail ||
        `${CONFIG.BASE_URL}/uploads/thumbs/${videoPage.vid}-1.jpg`,
      duration: playPage.meta.duration || videoPage.meta.duration,
      year: playPage.meta.year || videoPage.meta.year,
      seriesTitle: seriesBaseTitle(playPage.meta.title || videoPage.meta.title),
      embeds: playPage.embeds,
      currentEmbed: playPage.currentEmbed,
      downloads, m3u8Probes, streams,
      episodes: videoPage.episodes || [],
      related: (videoPage.related || []).slice(0, 16),
      playUrl: videoPage.playUrl,
      sourceUrl: `${CONFIG.BASE_URL}/video.php?vid=${vid}`,
      scrapedAt: nowISO(),
      light: false
    };
    this.store.upsertVideo(vid, record);
    Logger.success(`Full ${vid} streams=${streams.length} embeds=${record.embeds.length}`);
    return record;
  }

  async resolveStreams(vid, maxProbe = 5) {
    let data = this.store.getVideo(vid);
    if (!data || !data.embeds || !data.embeds.length) {
      data = await this.scrapeVideoLight(vid);
    }
    const urls = (data.embeds || []).map(e => e.url);
    const probes = await this.prober.probeMany(urls, maxProbe);
    const streams = [];
    for (const p of probes) {
      if (p.m3u8) streams.push({ type: 'm3u8', url: p.m3u8, embed: p.embedUrl });
      if (p.mp4) streams.push({ type: 'mp4', url: p.mp4, embed: p.embedUrl });
      for (const s of (p.sources || [])) {
        if (!streams.find(x => x.url === s)) {
          streams.push({
            type: /\.m3u8/i.test(s) ? 'm3u8' : (/\.mp4/i.test(s) ? 'mp4' : 'src'),
            url: s, embed: p.embedUrl
          });
        }
      }
    }
    if (streams.length) this.store.upsertVideo(vid, { streams, m3u8Probes: probes });
    return { vid, embeds: data.embeds, streams, probes };
  }

  async scrapeCategory(catKey, maxPages = 2, enqueue = false) {
    const all = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= maxPages) {
      const result = await this.fetchCategory(catKey, page);
      all.push(...result.videos);
      if (enqueue) {
        for (const v of result.videos) {
          if (!this.visited.has(v.vid)) {
            this.visited.add(v.vid);
            this.queue.push({ type: 'video', vid: v.vid });
          }
        }
      }
      const maxPage = result.pagination.reduce((mx, p) => Math.max(mx, p.page), 1);
      hasMore = page < maxPage && result.videos.length > 0;
      page++;
      await randomDelay(500, 1000);
    }
    this.store.categories.set(catKey, {
      key: catKey,
      name: CONFIG.CATEGORIES[catKey]?.name,
      videoCount: all.length,
      scrapedAt: nowISO()
    });
    return all;
  }

  async scrapeHomeAndQueue(limit = 36, enqueue = false) {
    const home = await this.fetchHome();
    if (enqueue) {
      for (const v of home.videos.slice(0, limit)) {
        if (!this.visited.has(v.vid)) {
          this.visited.add(v.vid);
          this.queue.push({ type: 'video', vid: v.vid });
        }
      }
    }
    return home.videos;
  }
}

async function proxyStream(client, targetUrl, req, res, referer) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid url' }));
    return;
  }
  const ref = referer || CONFIG.BASE_URL + '/';
  const headers = {
    'User-Agent': client.pickUA(),
    'Accept': '*/*',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    'Referer': ref,
    'Origin': (() => { try { return new URL(ref).origin; } catch { return CONFIG.BASE_URL; } })(),
    'Connection': 'keep-alive'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  const upstream = await client.request(targetUrl, {
    method: 'GET', headers, rawStream: true, skipThrottle: true, timeout: 60000,
    proxy: client.proxyManager.hasProxy() ? client.proxyManager.next() : null
  });

  const outHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    'Accept-Ranges': upstream.headers['accept-ranges'] || 'bytes'
  };
  for (const h of ['content-type', 'content-length', 'content-range', 'cache-control']) {
    if (upstream.headers[h]) outHeaders[h] = upstream.headers[h];
  }

  const ctype = (upstream.headers['content-type'] || '').toLowerCase();
  if (ctype.includes('mpegurl') || /\.m3u8(\?|$)/i.test(targetUrl)) {
    const chunks = [];
    for await (const c of upstream.stream) chunks.push(c);
    let body = Buffer.concat(chunks).toString('utf8');
    const base = targetUrl.replace(/\/[^/]*$/, '/');
    body = body.replace(/^(?!#)(.+)$/gm, (line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      let abs = t;
      try { abs = new URL(t, targetUrl).href; } catch {
        try { abs = new URL(t, base).href; } catch { return line; }
      }
      return `/api/stream/proxy?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(ref)}`;
    });
    outHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
    outHeaders['Content-Length'] = Buffer.byteLength(body);
    res.writeHead(upstream.status || 200, outHeaders);
    res.end(body);
    return;
  }
  res.writeHead(upstream.status || 200, outHeaders);
  upstream.stream.pipe(res);
}

class ApiServer {
  constructor(scraper, store) {
    this.scraper = scraper;
    this.store = store;
    this.routes = [];
    this.server = null;
  }
  get(p, h) { this.routes.push({ method: 'GET', pathPattern: p, handler: h }); }

  matchRoute(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = {};
      const pp = route.pathPattern.split('/').filter(Boolean);
      const tp = pathname.split('/').filter(Boolean);
      if (pp.length !== tp.length) continue;
      let ok = true;
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(tp[i]);
        else if (pp[i] !== tp[i]) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data, null, 2));
  }

  async handle(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const method = req.method.toUpperCase();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (method === 'GET' && pathname === '/api/stream/proxy') {
      const target = parsed.query.url;
      const ref = parsed.query.ref || CONFIG.BASE_URL + '/';
      if (!target) return this.json(res, 400, { error: 'missing url' });
      try { await proxyStream(this.scraper.client, target, req, res, ref); }
      catch (err) {
        Logger.error('proxy:', err.message);
        if (!res.headersSent) this.json(res, 502, { error: err.message });
      }
      return;
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/api')) {
      return this.json(res, 200, {
        name: 'Laroza Scraper API',
        version: '2.3.0',
        endpoints: [
          'GET /health',
          'GET /api/categories',
          'GET /api/scrape/category/ramadan-2026',
          'GET /api/scrape/video-light/:vid',
          'GET /api/scrape/video/:vid',
          'GET /api/stream/resolve/:vid',
          'GET /api/stream/proxy?url=&ref=',
          'GET /api/recommend/:vid',
          'GET /api/video/:vid'
        ]
      });
    }

    const matched = this.matchRoute(method, pathname);
    if (!matched) return this.json(res, 404, { error: 'Not found', path: pathname });
    req.query = parsed.query;
    req.params = matched.params;
    try { await matched.handler(req, res); }
    catch (err) {
      Logger.error('API:', err.message);
      this.json(res, 500, {
        error: err.message,
        hint: /cloudflare|challenge|403|429|timeout/i.test(err.message) ? 'CF/timeout – set PROXY_URL' : undefined
      });
    }
  }

  start(port = CONFIG.PORT, host = CONFIG.HOST) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(port, host, () => {
      Logger.success(`Laroza API v2.3 → http://${host}:${port}`);
      Logger.info('Proxy: ' + (this.scraper.client.proxyManager.hasProxy() ? 'YES' : 'NO'));
    });
  }
}

function setupRoutes(api, scraper, store) {
  api.get('/health', async (req, res) => {
    api.json(res, 200, {
      status: 'ok', version: '2.3.0', uptime: process.uptime(),
      videos: store.stats.totalVideos, proxy: scraper.client.proxyManager.hasProxy()
    });
  });

  api.get('/api/stats', async (req, res) => {
    api.json(res, 200, {
      stats: store.stats, queueLength: scraper.queue.length, visited: scraper.visited.size,
      proxyEnabled: scraper.client.proxyManager.hasProxy(), cfHits: scraper.client.cfHits || 0, version: '2.3.0'
    });
  });

  api.get('/api/categories', async (req, res) => { api.json(res, 200, CONFIG.CATEGORIES); });

  api.get('/api/videos', async (req, res) => {
    const limit = parseInt(req.query.limit || '100', 10);
    api.json(res, 200, { count: store.videos.size, videos: store.getAllVideos(limit) });
  });

  api.get('/api/video/:vid', async (req, res) => {
    const v = store.getVideo(req.params.vid);
    if (!v) return api.json(res, 404, { error: 'Not in store' });
    api.json(res, 200, v);
  });

  api.get('/api/recommend/:vid', async (req, res) => {
    const limit = parseInt(req.query.limit || '12', 10);
    let v = store.getVideo(req.params.vid);
    if (!v || !(v.related && v.related.length)) {
      try { v = await scraper.scrapeVideoLight(req.params.vid); store.save(); } catch (e) {}
    }
    const items = store.recommend(req.params.vid, limit);
    api.json(res, 200, { vid: req.params.vid, count: items.length, recommendations: items });
  });

  api.get('/api/scrape/video-light/:vid', async (req, res) => {
    const data = await scraper.scrapeVideoLight(req.params.vid);
    store.save();
    api.json(res, 200, data);
  });

  api.get('/api/scrape/video/:vid', async (req, res) => {
    const data = await scraper.scrapeFullVideo(req.params.vid, {
      includeDownloads: req.query.downloads !== '0',
      probeM3u8: req.query.m3u8 !== '0',
      maxProbe: parseInt(req.query.maxProbe || '4', 10)
    });
    store.save();
    api.json(res, 200, data);
  });

  api.get('/api/scrape/play/:vid', async (req, res) => {
    api.json(res, 200, await scraper.fetchPlayPage(req.params.vid));
  });

  api.get('/api/scrape/download/:vid', async (req, res) => {
    api.json(res, 200, await scraper.fetchDownloadPage(req.params.vid));
  });

  api.get('/api/scrape/home', async (req, res) => {
    const videos = await scraper.scrapeHomeAndQueue(parseInt(req.query.limit || '36', 10), req.query.queue === '1');
    store.save();
    api.json(res, 200, { count: videos.length, videos });
  });

  api.get('/api/scrape/category/:cat', async (req, res) => {
    const pages = parseInt(req.query.pages || '1', 10);
    const videos = await scraper.scrapeCategory(req.params.cat, pages, req.query.queue === '1');
    store.save();
    api.json(res, 200, {
      category: req.params.cat,
      name: CONFIG.CATEGORIES[req.params.cat]?.name,
      count: videos.length, videos
    });
  });

  api.get('/api/scrape/search', async (req, res) => {
    const q = req.query.q || req.query.keywords;
    if (!q) return api.json(res, 400, { error: 'Missing q' });
    api.json(res, 200, await scraper.search(q, parseInt(req.query.page || '1', 10)));
  });

  api.get('/api/search/local', async (req, res) => {
    if (!req.query.q) return api.json(res, 400, { error: 'Missing q' });
    api.json(res, 200, { results: store.searchLocal(req.query.q) });
  });

  api.get('/api/embeds/:vid', async (req, res) => {
    const play = await scraper.fetchPlayPage(req.params.vid);
    api.json(res, 200, { vid: req.params.vid, embeds: play.embeds, current: play.currentEmbed });
  });

  api.get('/api/stream/resolve/:vid', async (req, res) => {
    const maxProbe = parseInt(req.query.maxProbe || '5', 10);
    const data = await scraper.resolveStreams(req.params.vid, maxProbe);
    store.save();
    const proxied = (data.streams || []).map(s => ({
      ...s,
      proxyUrl: `/api/stream/proxy?url=${encodeURIComponent(s.url)}&ref=${encodeURIComponent(s.embed || CONFIG.BASE_URL + '/')}`
    }));
    api.json(res, 200, { ...data, streams: proxied });
  });

  api.get('/api/probe/:vid', async (req, res) => {
    const play = await scraper.fetchPlayPage(req.params.vid);
    const probes = await scraper.prober.probeMany((play.embeds || []).map(e => e.url), parseInt(req.query.limit || '5', 10));
    api.json(res, 200, { vid: req.params.vid, probes });
  });
}

async function main() {
  ensureDir(CONFIG.DATA_DIR);
  const store = new DataStore();
  const client = new HttpClient();
  const scraper = new LarozaScraper(store, client);
  const api = new ApiServer(scraper, store);
  setupRoutes(api, scraper, store);
  api.start();
  process.on('SIGINT', () => { store.save(); process.exit(0); });
  process.on('SIGTERM', () => { store.save(); process.exit(0); });
}

module.exports = { CONFIG, HttpClient, HtmlParser, DataStore, LarozaScraper, StreamProber, ApiServer, main };

if (require.main === module) {
  main().catch(err => { Logger.error('Fatal:', err); process.exit(1); });
}
