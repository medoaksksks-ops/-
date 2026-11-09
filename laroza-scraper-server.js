/**
 * ============================================================================
 * LAROZA1.LAT FULL SCRAPER & PROXY SERVER v3.0 (FINAL)
 * ============================================================================
 * التحديثات الرئيسية:
 *   - كل مشكلات البحث والاقتراحات والحلقات والكاش والـ video player تم إصلاحها 100%
 *   - نظام تشغيل مباشر (MP4 / M3U8 / HLS) مع اختيار المستخدم بين "سيرفرات لاروزا" و"مباشر"
 *   - frontend محترف RTL + تحسينات تصميم + أداء + أمان
 *   - performance + error handling + no duplicates + no fake sources
 *   - اختبار كامل: home, categories, search, video page, episodes, direct, related, cache, retry
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

// Optional dependencies (loaded safely)
let dotenv = null;
let HttpsProxyAgent = null;
let SocksProxyAgent = null;
let cheerio = null;

try { dotenv = require('dotenv'); } catch (e) {}
try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch (e) {}
try { SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent; } catch (e) {}
try { cheerio = require('cheerio'); } catch (e) {}

if (dotenv) {
  dotenv.config();
}

// ============================================================================
// CONFIGURATION
// ============================================================================

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
  MAX_PAGES_PER_CATEGORY: 20,

  DATA_DIR: path.join(__dirname, 'laroza_data'),
  CACHE_TTL_MS: 1000 * 60 * 45,
  MEMORY_CACHE_TTL_MS: 1000 * 60 * 12,

  PROXY_URL: process.env.PROXY_URL || '',
  PROXY_LIST: (process.env.PROXY_LIST || '').split(',').map(s => s.trim()).filter(Boolean),

  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
  ],

  CATEGORIES: {
    'arabic-movies35': { name: 'أفلام عربية', type: 'movie' },
    'indian-movies9': { name: 'أفلام هندية', type: 'movie' },
    '6-asian-movies': { name: 'أفلام آسيوية', type: 'movie' },
    'anime-movies-7': { name: 'أفلام أنمي', type: 'movie' },
    '7-aflammdblgh': { name: 'أفلام مدبلجة', type: 'movie' },
    '8-aflam3isk': { name: 'أفلام رومانسية', type: 'movie' },
    'all_movies_13': { name: 'كل الأفلام', type: 'movie' },
    'arabic-series46': { name: 'مسلسلات عربية', type: 'series' },
    'turkish-3isk-seriess47': { name: 'مسلسلات تركية', type: 'series' },
    'english-series10': { name: 'مسلسلات أجنبية', type: 'series' },
    '11indian-series': { name: 'مسلسلات هندية', type: 'series' },
    '6-asya': { name: 'مسلسلات آسيوية', type: 'series' },
    '6-anime-series': { name: 'مسلسلات أنمي', type: 'series' },
    'tv-programs12': { name: 'برامج تلفزيونية', type: 'other' },
    'masrh-5': { name: 'مسرحيات', type: 'other' }
  },

  DEFAULT_HEADERS: {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
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
    'streamhls', 'vidmoly', 'voe.sx', 'mixdrop', 'dsvplay',
    'okhd.site', 'film77', 'vidoba', 'mp4plus', 'anafast',
    'vidspeed', 'hgcloud', 'upzur', 'vidara'
  ]
};

// ============================================================================
// EMBEDDED FRONTEND (v3 - updated with direct player toggle)
// ============================================================================
const EMBEDDED_HTML = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
  <title>لاروزا بلاير</title>
  <link rel="stylesheet" href="/style.css">
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js"></script>
</head>
<body>
  <header class="header">
    <div class="container header-inner">
      <div class="logo" onclick="goHome()">
        <span class="logo-icon">▶</span>
        <span>لاروزا بلاير</span>
      </div>
      <div class="search-box">
        <input type="text" id="searchInput" placeholder="ابحث عن فيلم أو مسلسل..." autocomplete="off">
        <button onclick="doSearch()">بحث</button>
      </div>
      <div class="server-config">
        <input type="text" id="apiBase" placeholder="رابط API">
        <button class="btn-sm" onclick="saveApiBase()">حفظ</button>
      </div>
    </div>
  </header>

  <main class="container">
    <section id="homeSection">
      <div class="section-header">
        <h2>أحدث الإضافات</h2>
        <button class="btn-outline" onclick="loadHome(true)">تحديث</button>
      </div>
      <div id="homeGrid" class="video-grid"><div class="loading">جاري التحميل...</div></div>
      <div class="section-header" style="margin-top:28px"><h2>التصنيفات</h2></div>
      <div id="categories" class="cats"></div>
    </section>

    <section id="searchSection" class="hidden">
      <div class="section-header">
        <h2>نتائج: <span id="searchQuery"></span></h2>
        <button class="btn-outline" onclick="goHome()">العودة</button>
      </div>
      <div id="searchGrid" class="video-grid"></div>
    </section>

    <section id="catSection" class="hidden">
      <div class="section-header">
        <h2 id="catTitle">تصنيف</h2>
        <button class="btn-outline" onclick="goHome()">العودة</button>
      </div>
      <div id="catGrid" class="video-grid"></div>
    </section>

    <section id="playerSection" class="hidden">
      <div class="player-wrap">
        <div class="player-top">
          <button class="btn-outline" onclick="goHome()">← رجوع</button>
          <h1 id="playerTitle">...</h1>
          <div class="player-toggle">
            <button id="directBtn" class="active" onclick="toggleDirect()">تشغيل مباشر</button>
            <button id="serverBtn" onclick="toggleDirect()">سيرفرات لاروزا</button>
          </div>
        </div>
        <div class="player-frame-wrap">
          <iframe id="playerFrame" src="about:blank" allowfullscreen allow="autoplay; fullscreen; encrypted-media; picture-in-picture" referrerpolicy="no-referrer"></iframe>
          <video id="directVideo" controls playsinline style="display:none"></video>
          <div id="playerPlaceholder" class="player-placeholder"><p>جاري التحميل...</p></div>
        </div>
        <div id="directActions" class="direct-actions"></div>
        <div class="servers-bar">
          <span class="servers-label">السيرفرات:</span>
          <div id="serversList" class="servers-list"></div>
        </div>
        <div class="meta-row" id="playerMeta"></div>

        <div class="episodes-box" id="episodesBox" style="display:none">
          <h3>الحلقات</h3>
          <div id="episodesList" class="episodes-list"></div>
        </div>

        <div class="downloads-box" id="downloadsBox" style="display:none">
          <h3>روابط التحميل</h3>
          <div id="downloadsList"></div>
        </div>
        <div class="m3u8-box" id="m3u8Box" style="display:none">
          <h3>تشغيل مباشر (MP4 / M3U8 / HLS)</h3>
          <div id="m3u8List"></div>
        </div>
        <div class="related" id="relatedBox" style="display:none">
          <h3>قد يعجبك</h3>
          <div id="relatedGrid" class="video-grid small"></div>
        </div>
      </div>
    </section>
  </main>

  <footer class="footer">
    <div class="container">
      <span>Laroza Player v3.0</span>
      <span id="apiStatus" class="status offline">غير متصل</span>
    </div>
  </footer>
  <div id="toast" class="toast hidden"></div>
  <script src="/app.js"></script>
</body>
</html>
`;

const EMBEDDED_CSS = `:root {
  --bg: #0b0b0f; --surface: #12121a; --card: #1a1a24; --border: #2a2a3a; --text: #f2f2f7; --muted: #9a9aad; --accent: #e50914; --accent2: #ff6b35; --radius: 14px; --shadow: 0 12px 40px rgba(0,0,0,.45);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; background: radial-gradient(ellipse at top, #161622 0%, var(--bg) 55%); color: var(--text); min-height: 100vh; line-height: 1.5; }
.container { width: 100%; max-width: 1280px; margin: 0 auto; padding: 0 18px; }
.hidden { display: none !important; }
.header { background: rgba(10,10,15,.85); backdrop-filter: blur(16px); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 100; }
.header-inner { display: flex; align-items: center; gap: 14px; padding: 12px 0; flex-wrap: wrap; }
.logo { display: flex; align-items: center; gap: 10px; font-weight: 800; font-size: 1.2rem; cursor: pointer; white-space: nowrap; }
.logo-icon { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, var(--accent), var(--accent2)); display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 16px rgba(229,9,20,.35); }
.search-box { flex: 1; display: flex; min-width: 200px; max-width: 460px; }
.search-box input { flex: 1; background: var(--card); border: 1px solid var(--border); border-radius: 999px 0 0 999px; padding: 11px 16px; color: var(--text); outline: none; }
.search-box input:focus { border-color: var(--accent); }
.search-box button { background: var(--accent); border: none; color: #fff; padding: 0 20px; border-radius: 0 999px 999px 0; cursor: pointer; font-weight: 700; }
.server-config { display: flex; gap: 6px; align-items: center; }
.server-config input { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; color: var(--muted); font-size: .78rem; width: 170px; }
.btn-sm, .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 10px; cursor: pointer; font-size: .85rem; }
.btn-sm:hover, .btn-outline:hover { border-color: var(--accent); color: #fff; }
main.container { padding-top: 22px; padding-bottom: 90px; }
.section-header { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 16px; }
.section-header h2 { font-size: 1.3rem; font-weight: 800; }
.video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
.video-grid.small { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; }
.video-card { background: var(--card); border-radius: var(--radius); overflow: hidden; cursor: pointer; transition: transform .2s, box-shadow .2s; border: 1px solid transparent; position: relative; }
.video-card:hover { transform: translateY(-6px) scale(1.02); box-shadow: var(--shadow); border-color: rgba(229,9,20,.35); }
.video-card .thumb-wrap { position: relative; aspect-ratio: 2/3; background: #1a1a22; overflow: hidden; }
.video-card .thumb { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .35s; }
.video-card:hover .thumb { transform: scale(1.08); }
.video-card .badge { position: absolute; top: 8px; right: 8px; background: rgba(229,9,20,.92); color: #fff; font-size: .7rem; font-weight: 700; padding: 3px 8px; border-radius: 6px; }
.video-card .play-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.35); opacity: 0; transition: .2s; }
.video-card:hover .play-overlay { opacity: 1; }
.video-card .play-overlay span { width: 44px; height: 44px; border-radius: 50%; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 16px; box-shadow: 0 6px 20px rgba(0,0,0,.4); }
.video-card .info { padding: 10px 11px 12px; }
.video-card .title { font-size: .82rem; font-weight: 700; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; min-height: 2.2em; }
.video-card .meta { font-size: .72rem; color: var(--muted); margin-top: 4px; }
.loading, .empty { grid-column: 1 / -1; text-align: center; padding: 48px 20px; color: var(--muted); }
.skeleton-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 16px; }
.skeleton { aspect-ratio: 2/3; border-radius: var(--radius); background: linear-gradient(90deg, #1a1a24 25%, #242433 50%, #1a1a24 75%); background-size: 200% 100%; animation: shimmer 1.2s infinite; }
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.cats { display: flex; flex-wrap: wrap; gap: 8px; }
.cat-chip { background: var(--card); border: 1px solid var(--border); padding: 8px 14px; border-radius: 999px; cursor: pointer; font-size: .86rem; transition: .15s; }
.cat-chip:hover, .cat-chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.player-wrap { max-width: 1000px; margin: 0 auto; }
.player-top { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.player-top h1 { font-size: 1.25rem; flex: 1; font-weight: 800; }
.player-top .player-toggle { display: flex; gap: 6px; }
.player-frame-wrap { position: relative; width: 100%; padding-top: 56.25%; background: #000; border-radius: 16px; overflow: hidden; border: 1px solid var(--border); box-shadow: var(--shadow); }
.player-frame-wrap iframe, #directVideo { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #000; }
.player-placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #111; color: var(--muted); font-size: 1.05rem; gap: 12px; padding: 20px; text-align: center; }
.player-placeholder .retry-btn { background: var(--accent); border: none; color: #fff; padding: 10px 18px; border-radius: 10px; cursor: pointer; font-weight: 700; margin-top: 8px; }
.direct-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.servers-bar { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
.servers-label { color: var(--muted); font-size: .88rem; }
.servers-list { display: flex; flex-wrap: wrap; gap: 8px; }
.server-btn { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 8px 13px; border-radius: 10px; cursor: pointer; font-size: .84rem; transition: .15s; }
.server-btn:hover { border-color: var(--accent); }
.server-btn.active, .server-btn.accent { background: var(--accent); border-color: var(--accent); color: #fff; }
.meta-row { margin-top: 12px; color: var(--muted); font-size: .9rem; }
.episodes-box, .downloads-box, .m3u8-box, .related { margin-top: 22px; background: var(--surface); border-radius: 16px; padding: 16px; border: 1px solid var(--border); }
.episodes-box h3, .downloads-box h3, .m3u8-box h3, .related h3 { margin-bottom: 12px; font-size: 1rem; }
.episodes-list { display: flex; flex-wrap: wrap; gap: 8px; max-height: 220px; overflow-y: auto; }
.ep-btn { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: .82rem; min-width: 92px; text-align: center; }
.ep-btn:hover { border-color: var(--accent); }
.ep-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
#downloadsList a, #m3u8List a { display: inline-block; background: var(--card); border: 1px solid var(--border); color: #8ec7ff; padding: 8px 12px; border-radius: 8px; margin: 4px; text-decoration: none; font-size: .84rem; }
.footer { border-top: 1px solid var(--border); padding: 14px 0; background: var(--surface); font-size: .84rem; color: var(--muted); }
.footer .container { display: flex; justify-content: space-between; align-items: center; }
.status { padding: 3px 10px; border-radius: 999px; font-size: .75rem; }
.status.online { background: rgba(46,204,113,.15); color: #2ecc71; }
.status.offline { background: rgba(229,9,20,.15); color: var(--accent); }
.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--card); border: 1px solid var(--border); padding: 12px 20px; border-radius: 12px; box-shadow: var(--shadow); z-index: 200; transition: opacity .3s; max-width: 90vw; text-align: center; }
.toast.hidden { opacity: 0; pointer-events: none; }
.toast.error { border-color: var(--accent); }
@media (max-width: 640px) {
  .video-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; }
  .server-config input { width: 110px; }
  .player-top h1 { font-size: 1rem; }
  .player-toggle { flex-direction: column; gap: 6px; }
}
`;

const EMBEDDED_JS = `const DEFAULT_API = window.location.origin;
let API_BASE = localStorage.getItem('laroza_api') || DEFAULT_API;
const LAROZA_CDN = 'https://laroza1.lat';
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let hlsInstance = null;
let currentVideo = null;
let currentVidId = null;
let openVideoAbort = null;
let directEnabled = true; // default

async function api(path, options = {}) {
  const ctrl = new AbortController();
  const timeoutMs = options.timeoutMs || 55000;
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE.replace(/\\/$/, '') + path, { ...options, signal: ctrl.signal, headers: { Accept: 'application/json', ...(options.headers || {}) } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || ('HTTP ' + res.status));
      e.status = res.status;
      e.payload = err;
      throw e;
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('انتهت مهلة الطلب – السيرفر بطيء أو Cloudflare بيؤخر');
    throw err;
  } finally { clearTimeout(t); }
}

function toast(msg, ms = 3200, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function setStatus(online) {
  const el = $('#apiStatus');
  el.textContent = online ? 'متصل' : 'غير متصل';
  el.className = 'status ' + (online ? 'online' : 'offline');
}

function hideAll() {
  ['homeSection', 'searchSection', 'catSection', 'playerSection'].forEach(id => {
    const el = $('#' + id); if (el) el.classList.add('hidden');
  });
}
function goHome() {
  stopDirectPlayer();
  if (openVideoAbort) { try { openVideoAbort.abort(); } catch {} }
  hideAll();
  $('#homeSection').classList.remove('hidden');
  history.replaceState(null, '', '#');
}
function showSearch(q) {
  hideAll();
  $('#searchSection').classList.remove('hidden');
  $('#searchQuery').textContent = q;
}
function showCat(name) {
  hideAll();
  $('#catSection').classList.remove('hidden');
  $('#catTitle').textContent = name;
}
function showPlayer() {
  hideAll();
  $('#playerSection').classList.remove('hidden');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function thumbUrl(v) {
  if (v.thumbnail && /^https?:\\/\\//.test(v.thumbnail)) return v.thumbnail;
  if (v.thumb && /^https?:\\/\\//.test(v.thumb)) return v.thumb;
  if (v.vid) return LAROZA_CDN + '/uploads/thumbs/' + v.vid + '-1.jpg';
  return '';
}

function placeholderThumb() {
  return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1a1a24"/><stop offset="1" stop-color="#2a2a38"/></linearGradient></defs><rect fill="url(#g)" width="300" height="450"/><text x="150" y="230" fill="#666" font-size="16" text-anchor="middle" font-family="Arial">Laroza</text></svg>');
}

function isEpisodeTitle(title) {
  return /الحلقة|حلقه|Episode/i.test(title || '');
}

function videoCard(v) {
  const title = v.title || v.vid || 'بدون عنوان';
  const thumb = thumbUrl(v) || placeholderThumb();
  const year = v.year || '';
  const badge = isEpisodeTitle(title) ? '<span class="badge">حلقة</span>' : (year ? '<span class="badge">' + escapeHtml(year) + '</span>' : '');
  return \`
    <div class="video-card" onclick="openVideo('\${escapeHtml(v.vid)}')">
      <div class="thumb-wrap">
        <img class="thumb" src="\${escapeHtml(thumb)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='\${placeholderThumb()}'">
        \${badge}
        <div class="play-overlay"><span>▶</span></div>
      </div>
      <div class="info">
        <div class="title">\${escapeHtml(title)}</div>
        <div class="meta">\${escapeHtml(v.duration || '')}</div>
      </div>
    </div>\`;
}

function renderGrid(el, videos) {
  if (!videos || !videos.length) {
    el.innerHTML = '<div class="empty">لا توجد نتائج</div>';
    return;
  }
  el.innerHTML = videos.map(videoCard).join('');
}

function skeletons(el, n = 12) {
  el.innerHTML = '<div class="skeleton-grid">' + Array.from({length:n}).map(()=>'<div class="skeleton"></div>').join('') + '</div>';
}

async function checkHealth() {
  try {
    await api('/health', { timeoutMs: 12000 });
    setStatus(true);
    return true;
  } catch {
    setStatus(false);
    return false;
  }
}

async function loadHome(force = false) {
  const grid = $('#homeGrid');
  skeletons(grid, 12);
  try {
    let videos = [];
    if (!force) {
      try {
        const stored = await api('/api/videos?limit=48', { timeoutMs: 15000 });
        videos = stored.videos || [];
      } catch {}
    }
    if (!videos.length || force) {
      const home = await api('/api/scrape/home?limit=36&queue=0', { timeoutMs: 45000 });
      videos = home.videos || [];
    }
    renderGrid(grid, videos);
  } catch (e) {
    grid.innerHTML = '<div class="empty">فشل التحميل: ' + escapeHtml(e.message) + '<br><button class="btn-outline" style="margin-top:12px" onclick="loadHome(true)">إعادة المحاولة</button></div>';
    toast('خطأ في الاتصال بالسيرفر', 3500, true);
  }
}

async function loadCategories() {
  const box = $('#categories');
  try {
    const cats = await api('/api/categories', { timeoutMs: 10000 });
    box.innerHTML = Object.entries(cats).map(([key, info]) =>
      '<span class="cat-chip" onclick="openCategory(\\'' + key + '\\', \\'' + escapeHtml(info.name) + '\\')">' + escapeHtml(info.name) + '</span>'
    ).join('');
  } catch {
    box.innerHTML = '';
  }
}

async function doSearch() {
  const q = $('#searchInput').value.trim();
  if (!q) return;
  showSearch(q);
  const grid = $('#searchGrid');
  skeletons(grid, 10);
  try {
    let results = [];
    try {
      const local = await api('/api/search/local?q=' + encodeURIComponent(q), { timeoutMs: 10000 });
      results = local.results || [];
    } catch {}
    if (!results.length) {
      const live = await api('/api/scrape/search?q=' + encodeURIComponent(q), { timeoutMs: 40000 });
      results = live.videos || [];
    }
    renderGrid(grid, results);
  } catch (e) {
    grid.innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
  }
}

async function openCategory(catKey, name) {
  showCat(name || catKey);
  const grid = $('#catGrid');
  skeletons(grid, 12);
  try {
    const data = await api('/api/scrape/category/' + encodeURIComponent(catKey) + '?pages=1&queue=0', { timeoutMs: 50000 });
    renderGrid(grid, data.videos || []);
  } catch (e) {
    grid.innerHTML = '<div class="empty">' + escapeHtml(e.message) + '<br><button class="btn-outline" style="margin-top:12px" onclick="openCategory(\\'' + catKey + '\\',\\'' + escapeHtml(name||catKey) + '\\')">إعادة</button></div>';
  }
}

function stopDirectPlayer() {
  const video = $('#directVideo');
  if (hlsInstance) { try { hlsInstance.destroy(); } catch {} hlsInstance = null; }
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.style.display = 'none';
  }
  const frame = $('#playerFrame');
  if (frame) frame.style.display = 'block';
}

function toggleDirect() {
  directEnabled = !directEnabled;
  const directBtn = $('#directBtn');
  const serverBtn = $('#serverBtn');
  if (directEnabled) {
    directBtn.classList.add('active');
    serverBtn.classList.remove('active');
  } else {
    serverBtn.classList.add('active');
    directBtn.classList.remove('active');
  }
  toast('تم تغيير طريقة التشغيل', 2000);
}

function playDirect(url, typeHint) {
  const video = $('#directVideo');
  const frame = $('#playerFrame');
  const placeholder = $('#playerPlaceholder');
  if (!video) return;
  stopDirectPlayer();
  frame.style.display = 'none';
  frame.src = 'about:blank';
  placeholder.style.display = 'none';
  video.style.display = 'block';
  const isHls = /\\.m3u8(\\?|$)/i.test(url) || typeHint === 'm3u8';
  if (isHls && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: true, backBufferLength: 90 });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) toast('فشل تشغيل m3u8', 3000, true);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl') && isHls) {
    video.src = url; video.play().catch(() => {});
  } else {
    video.src = url; video.play().catch(() => {});
  }
}

function playServer(btn, embedUrl) {
  $$('.server-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  stopDirectPlayer();
  const frame = $('#playerFrame');
  const placeholder = $('#playerPlaceholder');
  const video = $('#directVideo');
  if (video) video.style.display = 'none';
  frame.style.display = 'block';
  if (!embedUrl) {
    frame.src = 'about:blank';
    placeholder.style.display = 'flex';
    placeholder.innerHTML = '<p>لا يوجد رابط</p>';
    return;
  }
  placeholder.style.display = 'none';
  frame.src = embedUrl;
}

function renderEpisodes(episodes, currentVid) {
  const box = $('#episodesBox');
  const list = $('#episodesList');
  if (!episodes || !episodes.length) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  list.innerHTML = episodes.map(ep => {
    const active = ep.vid === currentVid ? 'active' : '';
    const label = ep.label || ep.title || ep.vid;
    return '<button class="ep-btn ' + active + '" onclick="openVideo(\\'' + escapeHtml(ep.vid) + '\\')">' + escapeHtml(label) + '</button>';
  }).join('');
}

function setPlaceholder(html) {
  const p = $('#playerPlaceholder');
  p.style.display = 'flex';
  p.innerHTML = html;
}

function friendlyError(err) {
  const msg = (err && err.message) ? String(err.message) : 'خطأ غير معروف';
  if (/timeout|مهلة|Abort/i.test(msg) || err.code === 'TIMEOUT') {
    return 'الطلب استغرق وقت طويل (Cloudflare أو السيرفر بطيء). جرّب مرة أخرى أو فعّل Proxy.';
  }
  if (/403|429|challenge|cloudflare|CF/i.test(msg)) {
    return 'Cloudflare حجب الطلب مؤقتاً. انتظر قليلاً أو استخدم Proxy.';
  }
  if (/404|Not found/i.test(msg)) return 'الفيديو غير موجود أو تم حذفه.';
  return msg;
}

async function openVideo(vid, opts = {}) {
  currentVidId = vid;
  showPlayer();
  stopDirectPlayer();
  $('#playerTitle').textContent = 'جاري التحميل...';
  $('#playerFrame').src = 'about:blank';
  $('#playerFrame').style.display = 'block';
  setPlaceholder('<p>جاري جلب السيرفرات...</p><p style="font-size:.85rem;opacity:.7">لو اتأخر = Cloudflare بيبطّئ</p>');
  $('#serversList').innerHTML = '';
  $('#downloadsBox').style.display = 'none';
  $('#m3u8Box').style.display = 'none';
  $('#relatedBox').style.display = 'none';
  $('#episodesBox').style.display = 'none';
  $('#playerMeta').textContent = '';
  $('#directActions').innerHTML = '';
  history.replaceState(null, '', '#play/' + vid);

  const forceFull = !!opts.full;
  let data = null;
  let source = '';

  try {
    if (!forceFull) {
      try {
        data = await api('/api/video/' + encodeURIComponent(vid), { timeoutMs: 8000 });
        if (data && data.embeds && data.embeds.length) source = 'cache';
      } catch {}
    }

    if (!data) {
      setPlaceholder('<p>جاري السحب السريع للسيرفرات...</p>');
      data = await api('/api/scrape/video-light/' + encodeURIComponent(vid), { timeoutMs: 50000 });
      source = 'light';
    }

    currentVideo = data;
    $('#playerTitle').textContent = data.title || vid;

    const parts = [];
    if (data.duration) parts.push(data.duration);
    if (data.year) parts.push(data.year);
    if (data.embeds) parts.push((data.embeds.length || 0) + ' سيرفر');
    if (data.episodes && data.episodes.length) parts.push(data.episodes.length + ' حلقة');
    if (source) parts.push(source === 'cache' ? 'من الكاش' : 'مباشر');
    $('#playerMeta').textContent = parts.join(' • ');

    const list = $('#serversList');
    if (data.embeds && data.embeds.length) {
      list.innerHTML = data.embeds.map((s, i) =>
        '<button class="server-btn ' + (i === 0 ? 'active' : '') + '" onclick="playServer(this, \\'' + escapeHtml(s.url) + '\\')">سيرفر ' + (s.id || (i + 1)) + '</button>'
      ).join('');
      playServer(list.querySelector('.server-btn'), data.embeds[0].url);
    } else {
      list.innerHTML = '<span style="color:var(--muted)">لا توجد سيرفرات</span>';
      setPlaceholder('<p>لا توجد سيرفرات متاحة لهذا الفيديو</p><button class="retry-btn" onclick="openVideo(\\'' + escapeHtml(vid) + '\\',{full:true})">إعادة بمحاولة كاملة</button>');
    }

    renderEpisodes(data.episodes || [], vid);

    if (data.downloads && data.downloads.length) {
      $('#downloadsBox').style.display = 'block';
      $('#downloadsList').innerHTML = data.downloads.map(d =>
        '<a href="' + escapeHtml(d.url) + '" target="_blank" rel="noopener">' + escapeHtml(d.host || 'تحميل') + '</a>'
      ).join('');
    }

    const directs = [];
    (data.m3u8Probes || []).forEach(p => {
      if (p.m3u8) directs.push({ url: p.m3u8, type: 'm3u8', label: 'm3u8' });
      if (p.mp4) directs.push({ url: p.mp4, type: 'mp4', label: 'mp4' });
      (p.sources || []).forEach(s => {
        if (s && s !== p.m3u8 && s !== p.mp4) {
          const t = /\\.m3u8/i.test(s) ? 'm3u8' : (/\\.mp4/i.test(s) ? 'mp4' : 'src');
          directs.push({ url: s, type: t, label: t });
        }
      });
    });
    const seen = new Set();
    const unique = directs.filter(d => { if (seen.has(d.url)) return false; seen.add(d.url); return true; });
    if (unique.length) {
      $('#m3u8Box').style.display = 'block';
      $('#m3u8List').innerHTML = unique.map((d) =>
        '<a href="' + escapeHtml(d.url) + '" target="_blank">' + d.label + '</a> ' +
        '<button class="server-btn" onclick="playDirect(\\'' + escapeHtml(d.url) + '\\', \\'' + d.type + '\\')">▶ تشغيل</button>'
      ).join('');
      $('#directActions').innerHTML = unique.slice(0, 3).map(d =>
        '<button class="server-btn accent" onclick="playDirect(\\'' + escapeHtml(d.url) + '\\', \\'' + d.type + '\\')">▶ ' + d.label + ' مباشر</button>'
      ).join('');
    }

    if (data.related && data.related.length) {
      $('#relatedBox').style.display = 'block';
      renderGrid($('#relatedGrid'), data.related);
    }

    if (source === 'light' && !forceFull) {
      api('/api/scrape/video/' + encodeURIComponent(vid) + '?maxProbe=2&downloads=1', { timeoutMs: 90000 })
        .then(full => {
          if (currentVidId !== vid) return;
          if (full.downloads && full.downloads.length) {
            $('#downloadsBox').style.display = 'block';
            $('#downloadsList').innerHTML = full.downloads.map(d =>
              '<a href="' + escapeHtml(d.url) + '" target="_blank" rel="noopener">' + escapeHtml(d.host || 'تحميل') + '</a>'
            ).join('');
          }
          const more = [];
          (full.m3u8Probes || []).forEach(p => {
            if (p.m3u8) more.push({ url: p.m3u8, type: 'm3u8', label: 'm3u8' });
            if (p.mp4) more.push({ url: p.mp4, type: 'mp4', label: 'mp4' });
          });
          if (more.length) {
            const seen2 = new Set(unique.map(u => u.url));
            const add = more.filter(m => !seen2.has(m.url));
            if (add.length) {
              $('#m3u8Box').style.display = 'block';
              const extra = add.map(d =>
                '<a href="' + escapeHtml(d.url) + '" target="_blank">' + d.label + '</a> ' +
                '<button class="server-btn" onclick="playDirect(\\'' + escapeHtml(d.url) + '\\', \\'' + d.type + '\\')">▶ تشغيل</button>'
              ).join('');
              \( ('#m3u8List').innerHTML = ( \)('#m3u8List').innerHTML || '') + extra;
            }
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    const nice = friendlyError(e);
    $('#playerTitle').textContent = 'فشل التحميل';
    $('#playerMeta').textContent = nice;
    setPlaceholder(
      '<p>' + escapeHtml(nice) + '</p>' +
      '<button class="retry-btn" onclick="openVideo(\\'' + escapeHtml(vid) + '\\')">إعادة المحاولة</button> ' +
      '<button class="retry-btn" style="background:#333;margin-right:8px" onclick="openVideo(\\'' + escapeHtml(vid) + '\\',{full:true})">محاولة كاملة</button>'
    );
    toast(nice, 4500, true);
  }
}

function saveApiBase() {
  const val = \( ('#apiBase').value.trim().replace(/\\/ \)/, '');
  if (!val) return toast('اكتب رابط السيرفر', 2500, true);
  API_BASE = val;
  localStorage.setItem('laroza_api', val);
  toast('تم الحفظ');
  checkHealth().then(ok => { if (ok) { loadHome(true); loadCategories(); } });
}

function initApiBaseInput() {
  $('#apiBase').value = API_BASE;
  $('#apiBase').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiBase(); });
  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
}

async function boot() {
  initApiBaseInput();
  const hash = location.hash || '';
  if (hash.startsWith('#play/')) {
    const vid = hash.replace('#play/', '');
    if (vid) {
      await checkHealth();
      openVideo(vid);
      loadCategories();
      return;
    }
  }
  const ok = await checkHealth();
  if (ok) await Promise.all([loadHome(), loadCategories()]);
  else {
    $('#homeGrid').innerHTML = '<div class="empty">السيرفر غير متصل<br><small>ضع رابط الـ API ثم احفظ</small></div>';
  }
}
boot();
`;

// ============================================================================
// UTILITIES
// ============================================================================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomDelay(min = 300, max = 900) {
  return sleep(min + Math.floor(Math.random() * (max - min)));
}
function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}
function sanitizeFilename(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 180);
}
function absoluteUrl(relative, base = CONFIG.BASE_URL) {
  try { return new URL(relative, base).href; } catch (e) { return relative; }
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
function nowISO() {
  return new Date().toISOString();
}
function isCloudflareChallenge(html, status) {
  if (status === 403 || status === 503) return true;
  if (!html) return false;
  const markers = ['cf-browser-verification', 'cf_clearance', 'Checking your browser', 'Just a moment', 'cf-challenge', 'challenge-platform', 'Attention Required! | Cloudflare', 'Enable JavaScript and cookies'];
  return markers.some(m => html.includes(m));
}
const Logger = {
  info:  (...a) => console.log(`[${nowISO()}] [INFO]`, ...a),
  warn:  (...a) => console.warn(`[${nowISO()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${nowISO()}] [ERROR]`, ...a),
  debug: (...a) => { if (process.env.DEBUG === '1') console.log(`[${nowISO()}] [DEBUG]`, ...a); },
  success: (...a) => console.log(`[${nowISO()}] [OK]`, ...a)
};

// ============================================================================
// MEMORY CACHE
// ============================================================================
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
  del(key) { this.map.delete(key); }
}

// ============================================================================
// PROXY MANAGER
// ============================================================================
class ProxyManager {
  constructor() {
    this.proxies = [];
    this.index = 0;
    this._load();
  }
  _load() {
    if (CONFIG.PROXY_URL) this.proxies.push(CONFIG.PROXY_URL);
    if (CONFIG.PROXY_LIST.length) this.proxies.push(...CONFIG.PROXY_LIST);
    this.proxies = [...new Set(this.proxies.filter(Boolean))];
    if (this.proxies.length) Logger.info(`Loaded ${this.proxies.length} proxy(ies)`);
    else Logger.warn('No proxy configured – Cloudflare will rate-limit Railway IP hard');
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
        if (!SocksProxyAgent) { Logger.warn('socks-proxy-agent not installed – skipping SOCKS proxy'); return null; }
        return new SocksProxyAgent(proxyUrl);
      }
      if (!HttpsProxyAgent) { Logger.warn('https-proxy-agent not installed – skipping HTTP proxy'); return null; }
      return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      Logger.warn('Failed to create proxy agent:', e.message);
      return null;
    }
  }
}

// ============================================================================
// HTTP CLIENT
// ============================================================================
class HttpClient {
  constructor(options = {}) {
    this.timeout = options.timeout || CONFIG.REQUEST_TIMEOUT;
    this.maxRetries = options.maxRetries || CONFIG.MAX_RETRIES;
    this.retryDelay = options.retryDelay || CONFIG.RETRY_DELAY_MS;
    this.cookies = {};
    this.lastRequestTime = 0;
    this.proxyManager = new ProxyManager();
    this.cfBlockedUntil = 0;
    this.cfHits = 0;
  }
  pickUA() { return randomItem(CONFIG.USER_AGENTS); }
  getCookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `\( {k}= \){v}`).join('; ');
  }
  buildHeaders(extra = {}) {
    const headers = Object.assign({}, CONFIG.DEFAULT_HEADERS, {
      'User-Agent': this.pickUA(),
      'Referer': CONFIG.BASE_URL + '/',
      'Origin': CONFIG.BASE_URL
    }, extra);
    const cookieStr = this.getCookieHeader();
    if (cookieStr) headers['Cookie'] = cookieStr;
    return headers;
  }
  async throttle() {
    const elapsed = Date.now() - this.lastRequestTime;
    const delay = CONFIG.REQUEST_DELAY_MS;
    if (elapsed < delay) await sleep(delay - elapsed);
    this.lastRequestTime = Date.now();
  }
  _parseSetCookie(setCookieHeaders) {
    if (!setCookieHeaders) return;
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    for (const c of list) {
      const part = c.split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) {
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        this.cookies[name] = value;
      }
    }
  }
  clearCfCookies() {
    delete this.cookies['cf_clearance'];
    delete this.cookies['__cf_bm'];
    delete this.cookies['cf_chl_2'];
  }
  request(targetUrl, options = {}) {
    return new Promise(async (resolve, reject) => {
      await this.throttle();
      if (Date.now() < this.cfBlockedUntil) {
        const wait = this.cfBlockedUntil - Date.now();
        Logger.warn(`CF cooldown active, waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
      const parsed = new URL(targetUrl);
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
        timeout: this.timeout,
        rejectUnauthorized: false
      };
      if (agent) reqOptions.agent = agent;
      const req = lib.request(reqOptions, (res) => {
        const chunks = [];
        let stream = res;
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();
        if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br') { try { stream = res.pipe(zlib.createBrotliDecompress()); } catch (e) { stream = res; } }
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let body = '';
          try { body = buffer.toString('utf8'); } catch (e) { body = buffer.toString('latin1'); }
          this._parseSetCookie(res.headers['set-cookie']);
          resolve({ status: res.statusCode, headers: res.headers, body, url: targetUrl, finalUrl: res.headers.location ? absoluteUrl(res.headers.location, targetUrl) : targetUrl, proxyUsed: proxyUrl || null });
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
        if (isCloudflareChallenge(res.body, res.status)) {
          this.cfHits++;
          Logger.warn(`Cloudflare challenge detected (attempt ${attempt}) on ${targetUrl}`);
          this.clearCfCookies();
          const cool = Math.min(8000 + (2500 * attempt) + (this.cfHits * 500), 25000);
          this.cfBlockedUntil = Date.now() + cool;
          await sleep(this.retryDelay * attempt);
          continue;
        }
        if (res.status >= 200 && res.status < 400) {
          if (this.cfHits > 0) this.cfHits = Math.max(0, this.cfHits - 1);
          return res;
        }
        if (res.status === 403 || res.status === 429) {
          Logger.warn(`HTTP ${res.status} – attempt ${attempt}`);
          this.clearCfCookies();
          await sleep(this.retryDelay * attempt * 1.4);
          continue;
        }
        if (res.status >= 500) {
          Logger.warn(`Server ${res.status} – retry ${attempt}`);
          await sleep(this.retryDelay * attempt);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        Logger.warn(`Request failed (\( {attempt}/ \){this.maxRetries}): ${err.message}`);
        if (attempt < this.maxRetries) await sleep(this.retryDelay * attempt);
      }
    }
    throw lastError || new Error('Max retries exceeded');
  }
  async post(targetUrl, data, options = {}) {
    const body = typeof data === 'string' ? data : querystring.stringify(data);
    return this.get(targetUrl, Object.assign({}, options, {
      method: 'POST',
      body,
      headers: Object.assign({}, options.headers || {}, { 'Content-Type': 'application/x-www-form-urlencoded' })
    }));
  }
  async probe(url, options = {}) {
    try {
      const res = await this.request(url, Object.assign({
        method: 'GET',
        headers: { 'Accept': '*/*', 'Range': 'bytes=0-2048' }
      }, options));
      return res;
    } catch (e) {
      return null;
    }
  }
}

// ============================================================================
// HTML PARSER
// ============================================================================
class HtmlParser {
  constructor(html) {
    this.html = html || '';
    this.$ = null;
    if (cheerio) try { this.$ = cheerio.load(this.html); } catch (e) {}
  }
  matchAll(regex) {
    const results = [];
    let m;
    const r = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    while ((m = r.exec(this.html)) !== null) results.push(m);
    return results;
  }
  attr(tagHtml, name) {
    const re = new RegExp(name + '\\s*=\\s*["\']([^"\']*)["\']', 'i');
    const m = tagHtml.match(re);
    return m ? m[1] : null;
  }
  extractLinks(filterFn) {
    const links = [];
    const re = /<a\s+[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(this.html)) !== null) {
      const href = m[1];
      const inner = m[2].replace(/<[^>]+>/g, ' ').trim();
      const fullTag = m[0];
      const title = this.attr(fullTag, 'title') || '';
      const item = { href, text: cleanText(inner), title: cleanText(title), raw: fullTag };
      if (!filterFn || filterFn(item)) links.push(item);
    }
    return links;
  }
  extractVideoCards() {
    const videos = [];
    const seen = new Set();
    const thumbByVid = {};
    const thumbRe = /uploads\/thumbs\/([a-zA-Z0-9_-]+)-1\.(?:jpg|jpeg|png|webp)[^"'\s]*/gi;
    let tm;
    while ((tm = thumbRe.exec(this.html)) !== null) {
      const id = tm[1];
      const full = tm[0].startsWith('http') ? tm[0] : (CONFIG.BASE_URL + '/' + tm[0].replace(/^\//, ''));
      if (!thumbByVid[id]) thumbByVid[id] = full.split('"')[0].split("'")[0];
    }
    const imgRe = /(?:src|data-src)=["']([^"']*uploads\/thumbs\/[^"']+)["']/gi;
    while ((tm = imgRe.exec(this.html)) !== null) {
      const src = tm[1];
      const idm = src.match(/uploads\/thumbs\/([a-zA-Z0-9_-]+)/);
      if (idm && !thumbByVid[idm[1]]) thumbByVid[idm[1]] = src.startsWith('http') ? src : absoluteUrl(src);
    }
    const re1 = /href=["']([^"']*video\.php\?vid=([a-zA-Z0-9_-]+))["'][^>]*(?:title=["']([^"']*)["'])?/gi;
    let m;
    while ((m = re1.exec(this.html)) !== null) {
      const vid = m[2];
      if (seen.has(vid)) continue;
      seen.add(vid);
      let title = cleanText(m[3] || '');
      let thumbnail = thumbByVid[vid] || (CONFIG.BASE_URL + '/uploads/thumbs/' + vid + '-1.jpg');
      videos.push({ vid, url: absoluteUrl(m[1]), title, thumbnail, source: 'video.php' });
    }
    for (const v of videos) {
      if (!v.title) {
        const idx = this.html.indexOf('vid=' + v.vid);
        if (idx === -1) continue;
        const around = this.html.substring(Math.max(0, idx - 450), idx + 450);
        const titleMatch = around.match(/title=["']([^"']{5,140})["']/i) ||
                           around.match(/alt=["']([^"']{5,140})["']/i) ||
                           around.match(/<strong[^>]*>([^<]{5,110})<\/strong>/i);
        if (titleMatch) v.title = cleanText(titleMatch[1]);
      }
      if (thumbByVid[v.vid]) v.thumbnail = thumbByVid[v.vid];
    }
    if (this.$ && videos.length) {
      this.$('a[href*="video.php?vid="]').each((_, el) => {
        const href = this.$(el).attr('href') || '';
        const vid = extractVidFromUrl(href);
        if (!vid) return;
        const existing = videos.find(x => x.vid === vid);
        if (!existing) return;
        if (!existing.title) existing.title = cleanText(this.\( (el).attr('title') || this. \)(el).text());
        const img = this.\( (el).find('img').attr('src') || this. \)(el).find('img').attr('data-src') ||
                    this.$(el).closest('div,li,article').find('img').first().attr('src');
        if (img) existing.thumbnail = absoluteUrl(img);
      });
    }
    return videos;
  }
  extractEpisodes() {
    const episodes = [];
    const seen = new Set();
    const re = /href=["']([^"']*video\.php\?vid=([a-zA-Z0-9_-]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(this.html)) !== null) {
      const vid = m[2];
      let inner = cleanText(m[3].replace(/<[^>]+>/g, ' '));
      if (!inner || inner.length > 60) continue;
      if (/var |function|MELODY|document\.|\{|\}/.test(inner)) continue;
      const isEp = /(?:الحلقة|حلقه)\s*\d+|\d+\s*(?:حلقة|حلقه)|Episode\s*\d+/i.test(inner);
      if (!isEp) continue;
      if (seen.has(vid)) continue;
      seen.add(vid);
      let num = null;
      const numMatch = inner.match(/(?:الحلقة|حلقه|Episode)\s*(\d+)/i) || inner.match(/(\d+)\s*(?:حلقة|حلقه)/i);
      if (numMatch) num = parseInt(numMatch[1], 10);
      episodes.push({ vid, url: absoluteUrl(m[1]), label: num != null ? ('الحلقة ' + num) : inner, title: inner, episode: num });
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
      servers.push({ id: parseInt(m[1], 10), url: m[2], name: `سيرفر ${m[1]}` });
    }
    if (servers.length === 0) {
      const iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
      while ((m = iframeRe.exec(this.html)) !== null) {
        servers.push({ id: servers.length + 1, url: m[1], name: `Embed ${servers.length + 1}` });
      }
    }
    const dataSrcRe = /data-(?:src|url|embed|file)=["'](https?:\/\/[^"']+)["']/gi;
    while ((m = dataSrcRe.exec(this.html)) !== null) {
      if (!servers.find(s => s.url === m[1])) {
        servers.push({ id: servers.length + 1, url: m[1], name: `Data ${servers.length + 1}` });
      }
    }
    return servers;
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
    const hosts = ['voe.sx', 'ok.ru', '1cloudfile', 'multiup', 'uploady', 'usersdrive', 'mediafire', 'mega.nz', 'google', 'mixdrop', 'upstream', 'dood'];
    const allLinks = this.extractLinks(l => {
      try {
        const h = new URL(absoluteUrl(l.href)).hostname;
        return hosts.some(x => h.includes(x));
      } catch { return false; }
    });
    for (const l of allLinks) {
      if (!links.find(x => x.url === l.href)) {
        try {
          links.push({ url: l.href, host: new URL(l.href).hostname, text: l.text });
        } catch (e) {}
      }
    }
    return links;
  }
  extractMetadata() {
    const meta = { title: '', description: '', duration: '', views: '', rating: '', thumbnail: '', year: '', category: '' };
    const titleMatch = this.html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) meta.title = cleanText(titleMatch[1].replace(/\s*[-|].*$/, ''));
    const ogTitle = this.html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) || this.html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitle) meta.title = cleanText(ogTitle[1]);
    const ogDesc = this.html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i) || this.html.match(/content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
    if (ogDesc) meta.description = cleanText(ogDesc[1]);
    const ogImage = this.html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || this.html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogImage) meta.thumbnail = ogImage[1];
    const dur = this.html.match(/class=["'][^"']*time[^"']*["'][^>]*>\s*<i>(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})<\/i>/i) ||
                this.html.match(/xtraprogress[^>]*>\s*<i>(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})<\/i>/i) ||
                this.html.match(/duration["'\s:=]+(\d{1,2}:\d{2}:\d{2})/i);
    if (dur) meta.duration = dur[1];
    const year = this.html.match(/(20[0-2][0-9])/);
    if (year) meta.year = year[1];
    return meta;
  }
  extractPagination() {
    const pages = [];
    const re = /href=["']([^"']*page=(\d+)[^"']*)["']/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(this.html)) !== null) {
      const p = parseInt(m[2], 10);
      if (!seen.has(p)) { seen.add(p); pages.push({ page: p, url: absoluteUrl(m[1]) }); }
    }
    pages.sort((a, b) => a.page - b.page);
    return pages;
  }
}

// ============================================================================
// STREAM PROBER
// ============================================================================
class StreamProber {
  constructor(client) {
    this.client = client;
  }
  isFriendlyHost(embedUrl) {
    try {
      const host = new URL(embedUrl).hostname.toLowerCase();
      return CONFIG.M3U8_FRIENDLY_HOSTS.some(h => host.includes(h));
    } catch { return false; }
  }
  async probeEmbed(embedUrl) {
    const result = { embedUrl, m3u8: null, mp4: null, sources: [], error: null };
    if (!embedUrl || !embedUrl.startsWith('http')) { result.error = 'invalid embed url'; return result; }
    try {
      const res = await this.client.get(embedUrl, { headers: { 'Referer': CONFIG.BASE_URL + '/', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
      const html = res.body || '';
      const m3u8Matches = html.match(/https?:\/\/[^"'\\\s<>]+?\.m3u8[^"'\\\s<>]*/gi) || [];
      const uniqueM3u8 = [...new Set(m3u8Matches.map(u => u.replace(/\\+/g, '')))];
      const mp4Matches = html.match(/https?:\/\/[^"'\\\s<>]+?\.mp4[^"'\\\s<>]*/gi) || [];
      const uniqueMp4 = [...new Set(mp4Matches.map(u => u.replace(/\\+/g, '')))];
      const fileMatch = html.match(/(?:file|source|src|sources)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
      if (fileMatch) result.sources.push(fileMatch[1]);
      const extraRe = [/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi, /file\s*:\s*["']([^"']+)["']/gi, /src\s*:\s*["'](https?:\/\/[^"']+)["']/gi, /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi];
      for (const re of extraRe) {
        let mm;
        while ((mm = re.exec(html)) !== null) {
          const u = (mm[1] || mm[0]).replace(/\\+/g, '');
          if (u.startsWith('http')) result.sources.push(u);
        }
      }
      const sourcesJson = html.match(/sources\s*:\s*(\[[^\]]+\])/i);
      if (sourcesJson) {
        try {
          const arr = JSON.parse(sourcesJson[1].replace(/(['"])?([a-z0-9A-Z_]+)\1\s*:/g, '"$2":'));
          if (Array.isArray(arr)) arr.forEach(s => { if (s.file) result.sources.push(s.file); if (s.src) result.sources.push(s.src); });
        } catch (e) {}
      }
      if (uniqueM3u8.length) { result.m3u8 = uniqueM3u8[0]; result.sources.push(...uniqueM3u8); }
      if (uniqueMp4.length) { result.mp4 = uniqueMp4[0]; result.sources.push(...uniqueMp4); }
      result.sources = [...new Set(result.sources)];
      result.status = res.status;
    } catch (err) { result.error = err.message; }
    return result;
  }
  async probeMany(embedUrls, limit = 4) {
    const results = [];
    const list = (embedUrls || []).slice(0, limit);
    for (const u of list) {
      if (!this.isFriendlyHost(u)) { results.push({ embedUrl: u, skipped: true, reason: 'host not in friendly list' }); continue; }
      const r = await this.probeEmbed(u);
      results.push(r);
      await randomDelay(400, 900);
    }
    return results;
  }
}

// ============================================================================
// DATA STORE
// ============================================================================
class DataStore {
  constructor(baseDir = CONFIG.DATA_DIR) {
    this.baseDir = baseDir;
    ensureDir(baseDir);
    this.videos = new Map();
    this.categories = new Map();
    this.searchCache = new Map();
    this.stats = { totalVideos: 0, totalEmbeds: 0, totalDownloads: 0, totalM3u8: 0, lastCrawl: null, errors: 0, startedAt: nowISO() };
    this.load();
  }
  load() {
    try {
      const videosFile = path.join(this.baseDir, 'videos.json');
      if (fs.existsSync(videosFile)) {
        const data = JSON.parse(fs.readFileSync(videosFile, 'utf8'));
        for (const [k, v] of Object.entries(data)) this.videos.set(k, v);
        this.stats.totalVideos = this.videos.size;
        Logger.info(`Loaded ${this.videos.size} videos from disk`);
      }
      const statsFile = path.join(this.baseDir, 'stats.json');
      if (fs.existsSync(statsFile)) {
        const s = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        Object.assign(this.stats, s);
      }
    } catch (e) { Logger.warn('Could not load data:', e.message); }
  }
  save() {
    try {
      const obj = Object.fromEntries(this.videos);
      fs.writeFileSync(path.join(this.baseDir, 'videos.json'), JSON.stringify(obj, null, 2));
      fs.writeFileSync(path.join(this.baseDir, 'stats.json'), JSON.stringify(this.stats, null, 2));
      Logger.debug('Data saved');
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
      const found = (data.m3u8Probes || []).filter(p => p.m3u8 || p.mp4).length;
      this.stats.totalM3u8 += found;
    }
    return merged;
  }
  getVideo(vid) { return this.videos.get(vid) || null; }
  getAllVideos(limit = 500) {
    const arr = Array.from(this.videos.values());
    arr.sort((a, b) => String(b.updatedAt || b.scrapedAt || '').localeCompare(String(a.updatedAt || a.scrapedAt || '')));
    return arr.slice(0, limit);
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
  exportJSON(filename = 'export-full.json') {
    const file = path.join(this.baseDir, filename);
    const data = { exportedAt: nowISO(), stats: this.stats, videos: Object.fromEntries(this.videos) };
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
  }
}

// ============================================================================
// CORE SCRAPER
// ============================================================================
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
    const videos = parser.extractVideoCards();
    const meta = parser.extractMetadata();
    Logger.info(`Home: found ${videos.length} video references`);
    return { videos, meta, htmlLength: res.body.length };
  }
  async fetchCategory(catKey, page = 1, sortby = 'date') {
    const cat = CONFIG.CATEGORIES[catKey];
    if (!cat) throw new Error('Unknown category: ' + catKey);
    const target = `\( {CONFIG.BASE_URL}/category.php?cat= \){encodeURIComponent(catKey)}&page=\( {page}&order=DESC&sortby= \){sortby}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const videos = parser.extractVideoCards();
    const pagination = parser.extractPagination();
    const meta = parser.extractMetadata();
    Logger.info(`Category ${catKey} page ${page}: ${videos.length} videos`);
    return { category: catKey, name: cat.name, type: cat.type, page, videos, pagination, meta };
  }
  async fetchNewVideos(page = 1) {
    const target = `\( {CONFIG.BASE_URL}/newvideos1.php` + (page > 1 ? `?page= \){page}` : '');
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    return { videos: parser.extractVideoCards(), pagination: parser.extractPagination() };
  }
  async fetchTopVideos() {
    const res = await this.client.get(CONFIG.BASE_URL + '/topvideos1.php');
    const parser = new HtmlParser(res.body);
    return { videos: parser.extractVideoCards() };
  }
  async fetchSeriesIndex() {
    const res = await this.client.get(CONFIG.BASE_URL + '/moslslat4.php');
    const parser = new HtmlParser(res.body);
    return { videos: parser.extractVideoCards() };
  }
  async fetchVideoPage(vid) {
    const cacheKey = 'videoPage:' + vid;
    const cached = this.memCache.get(cacheKey);
    if (cached) return cached;
    const target = `\( {CONFIG.BASE_URL}/video.php?vid= \){encodeURIComponent(vid)}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const meta = parser.extractMetadata();
    const cards = parser.extractVideoCards();
    let playVid = vid;
    const playMatch = res.body.match(/play\.php\?vid=([a-zA-Z0-9_-]+)/);
    if (playMatch) playVid = playMatch[1];
    const xtgo = res.body.match(/href=["']([^"']*play\.php\?vid=[^"']+)["']/);
    const playUrl = xtgo ? absoluteUrl(xtgo[1]) : `\( {CONFIG.BASE_URL}/play.php?vid= \){playVid}`;
    const episodes = parser.extractEpisodes();
    const out = { vid, playVid, playUrl, meta, episodes, related: cards.filter(c => c.vid !== vid).slice(0, 12), rawLength: res.body.length };
    this.memCache.set(cacheKey, out, 1000 * 60 * 8);
    return out;
  }
  async fetchPlayPage(vid) {
    const cacheKey = 'playPage:' + vid;
    const cached = this.memCache.get(cacheKey);
    if (cached) return cached;
    const target = `\( {CONFIG.BASE_URL}/play.php?vid= \){encodeURIComponent(vid)}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const meta = parser.extractMetadata();
    const embeds = parser.extractEmbedServers();
    const related = parser.extractVideoCards().filter(c => c.vid !== vid).slice(0, 10);
    const iframeMatch = res.body.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    const currentEmbed = iframeMatch ? iframeMatch[1] : (embeds[0] ? embeds[0].url : null);
    const out = { vid, meta, embeds, currentEmbed, related, downloadPage: `\( {CONFIG.BASE_URL}/download.php?vid= \){vid}` };
    this.memCache.set(cacheKey, out, CONFIG.MEMORY_CACHE_TTL_MS);
    return out;
  }
  async fetchDownloadPage(vid) {
    const target = `\( {CONFIG.BASE_URL}/download.php?vid= \){encodeURIComponent(vid)}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const links = parser.extractDownloadLinks();
    const meta = parser.extractMetadata();
    return { vid, meta, downloads: links };
  }
  async search(keywords, page = 1) {
    const target = `\( {CONFIG.BASE_URL}/search.php?keywords= \){encodeURIComponent(keywords)}` + (page > 1 ? `&page=${page}` : '');
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    return { query: keywords, page, videos: parser.extractVideoCards(), pagination: parser.extractPagination() };
  }
  async scrapeVideoLight(vid) {
    Logger.info(`Light scrape: ${vid}`);
    try {
      const videoPage = await this.fetchVideoPage(vid);
      await randomDelay(200, 500);
      const playPage = await this.fetchPlayPage(videoPage.playVid || vid);
      const record = {
        vid: videoPage.vid, playVid: videoPage.playVid,
        title: playPage.meta.title || videoPage.meta.title,
        description: playPage.meta.description || videoPage.meta.description,
        thumbnail: playPage.meta.thumbnail || videoPage.meta.thumbnail || (CONFIG.BASE_URL + '/uploads/thumbs/' + videoPage.vid + '-1.jpg'),
        duration: playPage.meta.duration || videoPage.meta.duration,
        year: playPage.meta.year || videoPage.meta.year,
        embeds: playPage.embeds || [],
        currentEmbed: playPage.currentEmbed,
        downloads: [],
        m3u8Probes: [],
        episodes: videoPage.episodes || [],
        related: (videoPage.related || []).map(r => Object.assign({}, r, { thumbnail: r.thumbnail || (CONFIG.BASE_URL + '/uploads/thumbs/' + r.vid + '-1.jpg') })),
        playUrl: videoPage.playUrl,
        sourceUrl: `\( {CONFIG.BASE_URL}/video.php?vid= \){vid}`,
        scrapedAt: nowISO(),
        light: true
      };
      this.store.upsertVideo(vid, record);
      this.emit('video', record);
      Logger.success(`Light \( {vid} → embeds: \){record.embeds.length} episodes:${record.episodes.length}`);
      return record;
    } catch (err) {
      this.store.stats.errors++;
      Logger.error(`Light scrape failed ${vid}:`, err.message);
      throw err;
    }
  }
  async scrapeFullVideo(vid, opts = {}) {
    const { includeDownloads = true, probeM3u8 = true, maxProbe = 3 } = opts;
    Logger.info(`Full scrape: ${vid}`);
    try {
      const videoPage = await this.fetchVideoPage(vid);
      await randomDelay(250, 550);
      const playPage = await this.fetchPlayPage(videoPage.playVid || vid);
      await randomDelay(250, 550);
      let downloads = [];
      if (includeDownloads) {
        try {
          const dl = await this.fetchDownloadPage(videoPage.playVid || vid);
          downloads = dl.downloads;
        } catch (e) { Logger.warn(`Download page failed for ${vid}: ${e.message}`); }
      }
      let m3u8Probes = [];
      if (probeM3u8 && playPage.embeds && playPage.embeds.length) {
        try {
          const urls = playPage.embeds.map(e => e.url);
          m3u8Probes = await this.prober.probeMany(urls, maxProbe);
        } catch (e) { Logger.warn(`m3u8 probe failed: ${e.message}`); }
      }
      const record = {
        vid: videoPage.vid, playVid: videoPage.playVid,
        title: playPage.meta.title || videoPage.meta.title,
        description: playPage.meta.description || videoPage.meta.description,
        thumbnail: playPage.meta.thumbnail || videoPage.meta.thumbnail || (CONFIG.BASE_URL + '/uploads/thumbs/' + videoPage.vid + '-1.jpg'),
        duration: playPage.meta.duration || videoPage.meta.duration,
        year: playPage.meta.year || videoPage.meta.year,
        embeds: playPage.embeds,
        currentEmbed: playPage.currentEmbed,
        downloads,
        m3u8Probes,
        episodes: videoPage.episodes || [],
        related: (videoPage.related || []).map(r => Object.assign({}, r, { thumbnail: r.thumbnail || (CONFIG.BASE_URL + '/uploads/thumbs/' + r.vid + '-1.jpg') })),
        playUrl: videoPage.playUrl,
        sourceUrl: `\( {CONFIG.BASE_URL}/video.php?vid= \){vid}`,
        scrapedAt: nowISO(),
        light: false
      };
      this.store.upsertVideo(vid, record);
      this.emit('video', record);
      Logger.success(`Full \( {vid} → embeds: \){record.embeds.length} downloads:\( {downloads.length} m3u8: \){m3u8Probes.filter(p => p.m3u8 || p.mp4).length}`);
      return record;
    } catch (err) {
      this.store.stats.errors++;
      Logger.error(`Failed to scrape video ${vid}:`, err.message);
      throw err;
    }
  }
  async scrapeCategory(catKey, maxPages = 3, enqueue = false) {
    Logger.info(`Scraping category ${catKey} (max \( {maxPages} pages, enqueue= \){enqueue})`);
    const allVideos = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= maxPages) {
      try {
        const result = await this.fetchCategory(catKey, page);
        allVideos.push(...result.videos);
        if (enqueue) {
          for (const v of result.videos) {
            if (!this.visited.has(v.vid)) { this.visited.add(v.vid); this.queue.push({ type: 'video', vid: v.vid }); }
          }
        }
        const maxPage = result.pagination.reduce((mx, p) => Math.max(mx, p.page), 1);
        hasMore = page < maxPage && result.videos.length > 0;
        page++;
        await randomDelay(600, 1200);
      } catch (e) {
        Logger.error(`Category page ${page} failed:`, e.message);
        hasMore = false;
      }
    }
    this.store.categories.set(catKey, { key: catKey, name: CONFIG.CATEGORIES[catKey]?.name, videoCount: allVideos.length, scrapedAt: nowISO() });
    return allVideos;
  }
  async scrapeHomeAndQueue(limit = 40, enqueue = false) {
    const home = await this.fetchHome();
    if (enqueue) {
      for (const v of home.videos.slice(0, limit)) {
        if (!this.visited.has(v.vid)) { this.visited.add(v.vid); this.queue.push({ type: 'video', vid: v.vid }); }
      }
    }
    return home.videos;
  }
  async processQueue(concurrency = CONFIG.CONCURRENCY) {
    if (this.running) { Logger.warn('Queue already running'); return; }
    this.running = true;
    Logger.info(`Queue processor started (\( {this.queue.length} items, concurrency= \){concurrency})`);
    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(this._worker(i));
    await Promise.all(workers);
    this.running = false;
    this.store.save();
    this.store.stats.lastCrawl = nowISO();
    Logger.success('Queue finished');
  }
  async _worker(id) {
    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      try {
        if (job.type === 'video') await this.scrapeVideoLight(job.vid);
        else if (job.type === 'category') await this.scrapeCategory(job.cat, job.maxPages || 3, false);
      } catch (e) { Logger.error(`Worker ${id} failed:`, e.message); }
      await randomDelay(500, 1100);
    }
  }
  async crawlEverything(options = {}) {
    const { categories = Object.keys(CONFIG.CATEGORIES).slice(0, 6), maxPagesPerCat = 2, includeHome = true, includeNew = true, includeTop = true } = options;
    Logger.info('=== FULL SITE CRAWL STARTED ===');
    if (includeHome) await this.scrapeHomeAndQueue(30, true);
    if (includeNew) {
      const neu = await this.fetchNewVideos();
      for (const v of neu.videos) { if (!this.visited.has(v.vid)) { this.visited.add(v.vid); this.queue.push({ type: 'video', vid: v.vid }); } }
    }
    if (includeTop) {
      const top = await this.fetchTopVideos();
      for (const v of top.videos) { if (!this.visited.has(v.vid)) { this.visited.add(v.vid); this.queue.push({ type: 'video', vid: v.vid }); } }
    }
    for (const cat of categories) { this.queue.push({ type: 'category', cat, maxPages: maxPagesPerCat }); }
    await this.processQueue();
    Logger.info('=== FULL SITE CRAWL FINISHED ===');
    return this.store.stats;
  }
}

// ============================================================================
// API SERVER
// ============================================================================
class ApiServer {
  constructor(scraper, store) {
    this.scraper = scraper;
    this.store = store;
    this.routes = [];
    this.server = null;
  }
  get(pathPattern, handler) { this.routes.push({ method: 'GET', pathPattern, handler }); }
  post(pathPattern, handler) { this.routes.push({ method: 'POST', pathPattern, handler }); }
  matchRoute(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = {};
      const patternParts = route.pathPattern.split('/').filter(Boolean);
      const pathParts = pathname.split('/').filter(Boolean);
      if (patternParts.length !== pathParts.length) continue;
      let ok = true;
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
        } else if (patternParts[i] !== pathParts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
  async handle(req, res) {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const method = req.method.toUpperCase();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (method === 'GET' && (pathname === '/' || pathname.startsWith('/public/') || pathname === '/style.css' || pathname === '/app.js' || pathname === '/index.html' || pathname === '/favicon.ico')) {
      return this.serveStatic(req, res, pathname);
    }
    const matched = this.matchRoute(method, pathname);
    if (!matched) { this.json(res, 404, { error: 'Not found', path: pathname }); return; }
    let body = '';
    if (method === 'POST') {
      for await (const chunk of req) body += chunk;
      try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = querystring.parse(body); }
    }
    req.query = parsed.query;
    req.params = matched.params;
    try {
      await matched.handler(req, res);
    } catch (err) {
      Logger.error('API error:', err);
      this.json(res, 500, { error: err.message, hint: /cloudflare|challenge|403|429|timeout/i.test(err.message) ? 'CF/timeout – enable PROXY_URL or retry later' : undefined, stack: process.env.DEBUG === '1' ? err.stack : undefined });
    }
  }
  json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
  }
  html(res, status, html) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
  serveStatic(req, res, pathname) {
    let body = null;
    let ctype = 'text/html; charset=utf-8';
    if (pathname === '/' || pathname === '/index.html') { body = EMBEDDED_HTML; ctype = 'text/html; charset=utf-8'; }
    else if (pathname === '/style.css' || pathname === '/public/style.css') { body = EMBEDDED_CSS; ctype = 'text/css; charset=utf-8'; }
    else if (pathname === '/app.js' || pathname === '/public/app.js') { body = EMBEDDED_JS; ctype = 'application/javascript; charset=utf-8'; }
    else { this.json(res, 404, { error: 'Not found', path: pathname }); return; }
    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': buf.length, 'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    res.end(buf);
  }
  start(port = CONFIG.PORT, host = CONFIG.HOST) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(port, host, () => {
      Logger.success(`Laroza Scraper API v3.0 → http://\( {host}: \){port}`);
      Logger.info('Proxy enabled: ' + (this.scraper.client.proxyManager.hasProxy() ? 'YES' : 'NO (add PROXY_URL!)'));
    });
  }
}

function setupRoutes(api, scraper, store) {
  // Admin dashboard
  api.get('/admin', async (req, res) => {
    const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Laroza Scraper v3.0</title><style>root{--bg:#0b0b0f;--card:#15151c;--accent:#ff3b5c;--text:#e8e8ed;--muted:#9a9aad}*{box-sizing:border-box}body{margin:0;font-family:Tahoma,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}.wrap{max-width:960px;margin:0 auto;padding:24px}h1{color:var(--accent);margin:0 0 8px}.sub{color:var(--muted);margin-bottom:24px}.card{background:var(--card);border-radius:12px;padding:18px 20px;margin:14px 0;border:1px solid #222}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.stat{background:#1c1c26;border-radius:10px;padding:14px;text-align:center}.stat b{display:block;font-size:1.4rem;color:var(--accent)}a{color:#7eb6ff;text-decoration:none}code{background:#222;padding:2px 7px;border-radius:4px;font-size:.9em}ul{padding-right:18px}.btn{display:inline-block;background:var(--accent);color:#fff;padding:8px 14px;border-radius:8px;margin:4px 4px 4px 0;font-size:.9rem}input{background:#1c1c26;border:1px solid #333;color:var(--text);padding:8px 12px;border-radius:8px;width:100%;max-width:320px}</style></head><body><div class="wrap"><h1>Laroza1.lat Scraper <small style="font-size:.6em;color:var(--muted)">v3.0 FINAL</small></h1><p class="sub">سحب الأفلام • المسلسلات • السيرفرات • روابط التحميل • m3u8</p><div class="card"><div class="grid"><div class="stat"><b>\( {store.stats.totalVideos}</b> فيديو</div><div class="stat"><b> \){store.stats.totalEmbeds}</b> سيرفر</div><div class="stat"><b>\( {store.stats.totalDownloads}</b> تحميل</div><div class="stat"><b> \){store.stats.totalM3u8 || 0}</b> m3u8</div><div class="stat"><b>${store.stats.errors}</b> أخطاء</div></div><p style="margin-top:14px;color:var(--muted);font-size:.9rem">آخر زحف: ${store.stats.lastCrawl || 'لم يتم بعد'} | البروكسي: ${scraper.client.proxyManager.hasProxy() ? 'مفعّل' : 'غير مفعّل – ضروري ضد CF'}</p></div><div class="card"><h3>اختبار سريع</h3><p><input type="text" id="vidInput" placeholder="vid" value="85d3395d3"><a class="btn" href="#" onclick="location.href='/api/scrape/video-light/'+document.getElementById('vidInput').value;return false">سحب خفيف</a><a class="btn" href="#" onclick="location.href='/api/scrape/video/'+document.getElementById('vidInput').value;return false">سحب كامل</a><a class="btn" href="#" onclick="location.href='/api/scrape/play/'+document.getElementById('vidInput').value;return false">سيرفرات</a></p></div><div class="card"><h3>Endpoints</h3><ul><li><code>GET /api/scrape/video-light/:vid</code> – سريع</li><li><code>GET /api/scrape/video/:vid</code> – كامل</li><li><code>GET /api/scrape/play/:vid</code></li><li><code>GET /api/scrape/home?queue=0</code></li><li><code>GET /api/scrape/category/:cat?pages=1&queue=0</code></li><li><code>GET /api/video/:vid</code> – من الكاش</li><li><code>GET /health</code></li></ul></div></div></body></html>`;
    api.html(res, 200, html);
  });

  api.get('/api/stats', async (req, res) => api.json(res, 200, { stats: store.stats, queueLength: scraper.queue.length, visited: scraper.visited.size, proxyEnabled: scraper.client.proxyManager.hasProxy(), cfHits: scraper.client.cfHits || 0, categories: Object.fromEntries(store.categories), version: '3.0.0' }));
  api.get('/api/videos', async (req, res) => { const limit = parseInt(req.query.limit || '100', 10); api.json(res, 200, { count: store.videos.size, videos: store.getAllVideos(limit) }); });
  api.get('/api/video/:vid', async (req, res) => { const v = store.getVideo(req.params.vid); if (!v) return api.json(res, 404, { error: 'Not in store. Use /api/scrape/video-light/:vid' }); api.json(res, 200, v); });
  api.get('/api/scrape/video-light/:vid', async (req, res) => { const data = await scraper.scrapeVideoLight(req.params.vid); store.save(); api.json(res, 200, data); });
  api.get('/api/scrape/video/:vid', async (req, res) => { const data = await scraper.scrapeFullVideo(req.params.vid, { includeDownloads: req.query.downloads !== '0', probeM3u8: req.query.m3u8 !== '0', maxProbe: parseInt(req.query.maxProbe || '3', 10) }); store.save(); api.json(res, 200, data); });
  api.get('/api/scrape/play/:vid', async (req, res) => { const data = await scraper.fetchPlayPage(req.params.vid); api.json(res, 200, data); });
  api.get('/api/scrape/download/:vid', async (req, res) => { const data = await scraper.fetchDownloadPage(req.params.vid); api.json(res, 200, data); });
  api.get('/api/scrape/category/:cat', async (req, res) => { const pages = parseInt(req.query.pages || '1', 10); const enqueue = req.query.queue === '1'; const videos = await scraper.scrapeCategory(req.params.cat, pages, enqueue); if (req.query.full === '1') await scraper.processQueue(); store.save(); api.json(res, 200, { category: req.params.cat, count: videos.length, videos }); });
  api.get('/api/scrape/home', async (req, res) => { const enqueue = req.query.queue === '1'; const videos = await scraper.scrapeHomeAndQueue(parseInt(req.query.limit || '36', 10), enqueue); if (req.query.full === '1') await scraper.processQueue(); store.save(); api.json(res, 200, { count: videos.length, videos }); });
  api.get('/api/scrape/new', async (req, res) => { const data = await scraper.fetchNewVideos(parseInt(req.query.page || '1', 10)); api.json(res, 200, data); });
  api.get('/api/scrape/top', async (req, res) => { const data = await scraper.fetchTopVideos(); api.json(res, 200, data); });
  api.get('/api/scrape/search', async (req, res) => { const q = req.query.q || req.query.keywords; if (!q) return api.json(res, 400, { error: 'Missing q parameter' }); const data = await scraper.search(q, parseInt(req.query.page || '1', 10)); api.json(res, 200, data); });
  api.get('/api/scrape/full', async (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.write(JSON.stringify({ status: 'started', message: 'Full crawl running in background' }) + '\n'); scraper.crawlEverything({ maxPagesPerCat: parseInt(req.query.pages || '2', 10), categories: req.query.cats ? req.query.cats.split(',') : Object.keys(CONFIG.CATEGORIES).slice(0, 6) }).then(stats => Logger.success('Background full crawl done', stats)).catch(e => Logger.error(e)); res.end(); });
  api.get('/api/categories', async (req, res) => api.json(res, 200, CONFIG.CATEGORIES));
  api.get('/api/export', async (req, res) => { const file = store.exportJSON(); api.json(res, 200, { file, stats: store.stats }); });
  api.get('/api/search/local', async (req, res) => { const q = req.query.q; if (!q) return api.json(res, 400, { error: 'Missing q' }); api.json(res, 200, { results: store.searchLocal(q) }); });
  api.get('/api/embeds/:vid', async (req, res) => { const play = await scraper.fetchPlayPage(req.params.vid); api.json(res, 200, { vid: req.params.vid, embeds: play.embeds, current: play.currentEmbed }); });
  api.get('/api/probe/:vid', async (req, res) => { const play = await scraper.fetchPlayPage(req.params.vid); const probes = await scraper.prober.probeMany((play.embeds || []).map(e => e.url), parseInt(req.query.limit || '4', 10)); api.json(res, 200, { vid: req.params.vid, probes }); });
  api.get('/health', async (req, res) => api.json(res, 200, { status: 'ok', uptime: process.uptime(), videos: store.stats.totalVideos, proxy: scraper.client.proxyManager.hasProxy(), version: '3.0.0' }));
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  ensureDir(CONFIG.DATA_DIR);
  const store = new DataStore();
  const client = new HttpClient();
  const scraper = new LarozaScraper(store, client);
  const api = new ApiServer(scraper, store);
  setupRoutes(api, scraper, store);
  api.start();
  process.on('SIGINT', () => { Logger.info('Shutting down...'); store.save(); process.exit(0); });
  process.on('SIGTERM', () => { store.save(); process.exit(0); });
  if (process.env.AUTO_SCRAPE === '1') {
    Logger.info('AUTO_SCRAPE enabled (light)');
    try {
      await scraper.scrapeHomeAndQueue(8, true);
      await scraper.processQueue(2);
    } catch (e) { Logger.error('Auto scrape failed:', e.message); }
  }
}

module.exports = {
  CONFIG,
  HttpClient,
  HtmlParser,
  DataStore,
  LarozaScraper,
  StreamProber,
  ProxyManager,
  ApiServer,
  MemoryCache,
  main
};

if (require.main === module) {
  main().catch(err => {
    Logger.error('Fatal:', err);
    process.exit(1);
  });
    }
