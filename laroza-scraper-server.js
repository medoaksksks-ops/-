/**
 * ============================================================================
 * LAROZA1.LAT FULL SCRAPER & PROXY SERVER  v2.1
 * ============================================================================
 * Comprehensive Node.js server that connects to https://laroza1.lat
 * extracts movies, series, multi-server embeds, download links...
 *
 * New in v2.1:
 *  - Proxy support (HTTP / SOCKS5) + rotation
 *  - Stronger Cloudflare-resistant headers & cookie jar
 *  - m3u8 / direct stream probing helpers for common hosts
 *  - Improved web dashboard
 *  - dotenv configuration
 *  - Better error recovery & stats
 * ============================================================================
 * Usage:
 *   cp .env.example .env
 *   npm install
 *   node laroza-scraper-server.js
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
const { pipeline } = require('stream');
const { promisify } = require('util');

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

  REQUEST_TIMEOUT: 28000,
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '4', 10),
  RETRY_DELAY_MS: 1800,
  REQUEST_DELAY_MS: parseInt(process.env.REQUEST_DELAY_MS || '900', 10),
  CONCURRENCY: parseInt(process.env.CONCURRENCY || '3', 10),
  MAX_PAGES_PER_CATEGORY: 30,

  DATA_DIR: path.join(__dirname, 'laroza_data'),
  CACHE_TTL_MS: 1000 * 60 * 30,

  // Proxy
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

  // Domains that often expose m3u8 or direct streams
  M3U8_FRIENDLY_HOSTS: [
    'streamhls', 'vidmoly', 'voe.sx', 'mixdrop', 'dsvplay',
    'okhd.site', 'film77', 'vidoba', 'mp4plus', 'anafast',
    'vidspeed', 'hgcloud', 'upzur', 'vidara'
  ]
};


// ============================================================================
// EMBEDDED FRONTEND (single-file deploy – no public/ folder needed)
// ============================================================================
const EMBEDDED_HTML = "<!DOCTYPE html>\n<html lang=\"ar\" dir=\"rtl\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1, maximum-scale=1\">\n  <title>لاروزا بلاير | Laroza Player</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n  <link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎬</text></svg>\">\n  <!-- HLS.js for direct m3u8 playback -->\n  <script src=\"https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js\"></script>\n</head>\n<body>\n  <header class=\"header\">\n    <div class=\"container header-inner\">\n      <div class=\"logo\" onclick=\"goHome()\">\n        <span class=\"logo-icon\">▶</span>\n        <span>لاروزا بلاير</span>\n      </div>\n      <div class=\"search-box\">\n        <input type=\"text\" id=\"searchInput\" placeholder=\"ابحث عن فيلم أو مسلسل...\" autocomplete=\"off\">\n        <button id=\"searchBtn\" onclick=\"doSearch()\">بحث</button>\n      </div>\n      <div class=\"server-config\">\n        <input type=\"text\" id=\"apiBase\" placeholder=\"رابط السيرفر (API)\" title=\"مثال: http://127.0.0.1:3030\">\n        <button onclick=\"saveApiBase()\" class=\"btn-sm\">حفظ</button>\n      </div>\n    </div>\n  </header>\n\n  <main class=\"container\">\n    <section id=\"homeSection\">\n      <div class=\"section-header\">\n        <h2>أحدث الإضافات</h2>\n        <button class=\"btn-outline\" onclick=\"loadHome(true)\">تحديث</button>\n      </div>\n      <div id=\"homeGrid\" class=\"video-grid\">\n        <div class=\"loading\">جاري التحميل...</div>\n      </div>\n      <div class=\"section-header\" style=\"margin-top:32px\">\n        <h2>التصنيفات</h2>\n      </div>\n      <div id=\"categories\" class=\"cats\"></div>\n    </section>\n\n    <section id=\"searchSection\" class=\"hidden\">\n      <div class=\"section-header\">\n        <h2>نتائج البحث: <span id=\"searchQuery\"></span></h2>\n        <button class=\"btn-outline\" onclick=\"goHome()\">العودة</button>\n      </div>\n      <div id=\"searchGrid\" class=\"video-grid\"></div>\n    </section>\n\n    <section id=\"catSection\" class=\"hidden\">\n      <div class=\"section-header\">\n        <h2 id=\"catTitle\">تصنيف</h2>\n        <button class=\"btn-outline\" onclick=\"goHome()\">العودة</button>\n      </div>\n      <div id=\"catGrid\" class=\"video-grid\"></div>\n      <div class=\"pager\" id=\"catPager\"></div>\n    </section>\n\n    <section id=\"playerSection\" class=\"hidden\">\n      <div class=\"player-wrap\">\n        <div class=\"player-top\">\n          <button class=\"btn-outline\" onclick=\"goHome()\">← رجوع</button>\n          <h1 id=\"playerTitle\">...</h1>\n        </div>\n\n        <div class=\"player-frame-wrap\">\n          <!-- Embed iframe -->\n          <iframe id=\"playerFrame\" src=\"about:blank\" allowfullscreen\n            allow=\"autoplay; fullscreen; encrypted-media; picture-in-picture\"\n            referrerpolicy=\"no-referrer\"></iframe>\n          <!-- Direct video element for m3u8 / mp4 -->\n          <video id=\"directVideo\" controls playsinline\n            style=\"display:none; position:absolute; inset:0; width:100%; height:100%; background:#000;\"\n            controlslist=\"nodownload\"></video>\n          <div id=\"playerPlaceholder\" class=\"player-placeholder\">\n            <p>اختر سيرفر للتشغيل</p>\n          </div>\n        </div>\n\n        <!-- Quick direct play buttons -->\n        <div id=\"directActions\" class=\"direct-actions\"></div>\n\n        <div class=\"servers-bar\">\n          <span class=\"servers-label\">السيرفرات (embed):</span>\n          <div id=\"serversList\" class=\"servers-list\"></div>\n        </div>\n\n        <div class=\"meta-row\" id=\"playerMeta\"></div>\n\n        <div class=\"downloads-box\" id=\"downloadsBox\" style=\"display:none\">\n          <h3>روابط التحميل</h3>\n          <div id=\"downloadsList\"></div>\n        </div>\n\n        <div class=\"m3u8-box\" id=\"m3u8Box\" style=\"display:none\">\n          <h3>روابط مباشرة (m3u8 / mp4) — تشغيل بـ HLS.js</h3>\n          <div id=\"m3u8List\"></div>\n        </div>\n\n        <div class=\"related\" id=\"relatedBox\" style=\"display:none\">\n          <h3>قد يعجبك أيضاً</h3>\n          <div id=\"relatedGrid\" class=\"video-grid small\"></div>\n        </div>\n      </div>\n    </section>\n  </main>\n\n  <footer class=\"footer\">\n    <div class=\"container\">\n      <span>Laroza Player • HLS.js + Multi-server</span>\n      <span id=\"apiStatus\" class=\"status offline\">غير متصل</span>\n    </div>\n  </footer>\n\n  <div id=\"toast\" class=\"toast hidden\"></div>\n  <script src=\"app.js\"></script>\n</body>\n</html>\n";
const EMBEDDED_CSS = ":root {\n  --bg: #0a0a0e;\n  --surface: #12121a;\n  --card: #1a1a24;\n  --border: #2a2a38;\n  --text: #f0f0f5;\n  --muted: #8b8b9e;\n  --accent: #e63956;\n  --accent-hover: #ff4d6d;\n  --success: #2ecc71;\n  --radius: 12px;\n  --shadow: 0 8px 24px rgba(0,0,0,.4);\n}\n\n* { box-sizing: border-box; margin: 0; padding: 0; }\nhtml { scroll-behavior: smooth; }\nbody {\n  font-family: 'Segoe UI', Tahoma, Arial, sans-serif;\n  background: var(--bg);\n  color: var(--text);\n  min-height: 100vh;\n  line-height: 1.5;\n}\n\n.container { width: 100%; max-width: 1200px; margin: 0 auto; padding: 0 16px; }\n.hidden { display: none !important; }\n\n/* Header */\n.header {\n  background: rgba(18,18,26,.92);\n  backdrop-filter: blur(12px);\n  border-bottom: 1px solid var(--border);\n  position: sticky;\n  top: 0;\n  z-index: 100;\n}\n.header-inner {\n  display: flex;\n  align-items: center;\n  gap: 16px;\n  padding: 12px 16px;\n  flex-wrap: wrap;\n}\n.logo {\n  display: flex;\n  align-items: center;\n  gap: 8px;\n  font-weight: 700;\n  font-size: 1.15rem;\n  cursor: pointer;\n  white-space: nowrap;\n}\n.logo-icon {\n  background: var(--accent);\n  width: 32px; height: 32px;\n  border-radius: 8px;\n  display: flex; align-items: center; justify-content: center;\n  font-size: .9rem;\n}\n\n.search-box {\n  flex: 1;\n  display: flex;\n  min-width: 200px;\n  max-width: 420px;\n}\n.search-box input {\n  flex: 1;\n  background: var(--card);\n  border: 1px solid var(--border);\n  border-radius: var(--radius) 0 0 var(--radius);\n  padding: 10px 14px;\n  color: var(--text);\n  font-size: .95rem;\n  outline: none;\n}\n.search-box input:focus { border-color: var(--accent); }\n.search-box button {\n  background: var(--accent);\n  border: none;\n  color: #fff;\n  padding: 0 18px;\n  border-radius: 0 var(--radius) var(--radius) 0;\n  cursor: pointer;\n  font-weight: 600;\n}\n.search-box button:hover { background: var(--accent-hover); }\n\n.server-config {\n  display: flex;\n  gap: 6px;\n  align-items: center;\n}\n.server-config input {\n  background: var(--card);\n  border: 1px solid var(--border);\n  border-radius: 8px;\n  padding: 8px 10px;\n  color: var(--muted);\n  font-size: .8rem;\n  width: 180px;\n}\n.btn-sm {\n  background: var(--card);\n  border: 1px solid var(--border);\n  color: var(--text);\n  padding: 8px 12px;\n  border-radius: 8px;\n  cursor: pointer;\n  font-size: .8rem;\n}\n.btn-sm:hover { border-color: var(--accent); }\n\n/* Main */\nmain.container { padding-top: 24px; padding-bottom: 80px; }\n\n.section-header {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  margin-bottom: 16px;\n}\n.section-header h2 { font-size: 1.25rem; }\n\n.btn-outline {\n  background: transparent;\n  border: 1px solid var(--border);\n  color: var(--text);\n  padding: 8px 14px;\n  border-radius: 8px;\n  cursor: pointer;\n  font-size: .9rem;\n}\n.btn-outline:hover { border-color: var(--accent); color: var(--accent); }\n\n/* Grid */\n.video-grid {\n  display: grid;\n  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));\n  gap: 16px;\n}\n.video-grid.small {\n  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));\n}\n.video-card {\n  background: var(--card);\n  border-radius: var(--radius);\n  overflow: hidden;\n  cursor: pointer;\n  transition: transform .2s, box-shadow .2s;\n  border: 1px solid transparent;\n}\n.video-card:hover {\n  transform: translateY(-4px);\n  box-shadow: var(--shadow);\n  border-color: var(--border);\n}\n.video-card .thumb {\n  aspect-ratio: 2/3;\n  background: #1e1e28;\n  object-fit: cover;\n  width: 100%;\n  display: block;\n}\n.video-card .info {\n  padding: 10px;\n}\n.video-card .title {\n  font-size: .85rem;\n  font-weight: 600;\n  display: -webkit-box;\n  -webkit-line-clamp: 2;\n  -webkit-box-orient: vertical;\n  overflow: hidden;\n  line-height: 1.35;\n}\n.video-card .meta {\n  font-size: .75rem;\n  color: var(--muted);\n  margin-top: 4px;\n}\n\n.loading, .empty {\n  grid-column: 1 / -1;\n  text-align: center;\n  padding: 40px;\n  color: var(--muted);\n}\n\n/* Categories */\n.cats {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 10px;\n}\n.cat-chip {\n  background: var(--card);\n  border: 1px solid var(--border);\n  padding: 8px 16px;\n  border-radius: 999px;\n  cursor: pointer;\n  font-size: .9rem;\n  transition: .15s;\n}\n.cat-chip:hover, .cat-chip.active {\n  background: var(--accent);\n  border-color: var(--accent);\n  color: #fff;\n}\n\n/* Player */\n.player-wrap { max-width: 960px; margin: 0 auto; }\n.player-top {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  margin-bottom: 12px;\n  flex-wrap: wrap;\n}\n.player-top h1 {\n  font-size: 1.2rem;\n  flex: 1;\n}\n\n.player-frame-wrap {\n  position: relative;\n  width: 100%;\n  padding-top: 56.25%;\n  background: #000;\n  border-radius: var(--radius);\n  overflow: hidden;\n  border: 1px solid var(--border);\n}\n.player-frame-wrap iframe {\n  position: absolute;\n  inset: 0;\n  width: 100%;\n  height: 100%;\n  border: 0;\n}\n.player-placeholder {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  background: #111;\n  color: var(--muted);\n  font-size: 1.1rem;\n}\n\n.servers-bar {\n  display: flex;\n  align-items: center;\n  gap: 10px;\n  margin-top: 14px;\n  flex-wrap: wrap;\n}\n.servers-label { color: var(--muted); font-size: .9rem; }\n.servers-list {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n}\n.server-btn {\n  background: var(--card);\n  border: 1px solid var(--border);\n  color: var(--text);\n  padding: 8px 14px;\n  border-radius: 8px;\n  cursor: pointer;\n  font-size: .85rem;\n  transition: .15s;\n}\n.server-btn:hover { border-color: var(--accent); }\n.server-btn.active {\n  background: var(--accent);\n  border-color: var(--accent);\n  color: #fff;\n}\n\n.meta-row {\n  margin-top: 12px;\n  color: var(--muted);\n  font-size: .9rem;\n}\n\n.downloads-box, .m3u8-box, .related {\n  margin-top: 24px;\n  background: var(--surface);\n  border-radius: var(--radius);\n  padding: 16px;\n  border: 1px solid var(--border);\n}\n.downloads-box h3, .m3u8-box h3, .related h3 {\n  margin-bottom: 12px;\n  font-size: 1rem;\n}\n#downloadsList a, #m3u8List a {\n  display: inline-block;\n  background: var(--card);\n  border: 1px solid var(--border);\n  color: #7eb6ff;\n  padding: 8px 12px;\n  border-radius: 8px;\n  margin: 4px;\n  text-decoration: none;\n  font-size: .85rem;\n}\n#downloadsList a:hover, #m3u8List a:hover { border-color: var(--accent); }\n\n.pager {\n  display: flex;\n  gap: 8px;\n  justify-content: center;\n  margin-top: 20px;\n}\n.pager button {\n  background: var(--card);\n  border: 1px solid var(--border);\n  color: var(--text);\n  padding: 8px 14px;\n  border-radius: 8px;\n  cursor: pointer;\n}\n.pager button.active { background: var(--accent); border-color: var(--accent); }\n\n/* Footer */\n.footer {\n  border-top: 1px solid var(--border);\n  padding: 14px 0;\n  background: var(--surface);\n  font-size: .85rem;\n  color: var(--muted);\n}\n.footer .container {\n  display: flex;\n  justify-content: space-between;\n  align-items: center;\n}\n.status { padding: 2px 8px; border-radius: 999px; font-size: .75rem; }\n.status.online { background: rgba(46,204,113,.15); color: var(--success); }\n.status.offline { background: rgba(230,57,86,.15); color: var(--accent); }\n\n/* Toast */\n.toast {\n  position: fixed;\n  bottom: 24px;\n  left: 50%;\n  transform: translateX(-50%);\n  background: var(--card);\n  border: 1px solid var(--border);\n  padding: 12px 20px;\n  border-radius: 10px;\n  box-shadow: var(--shadow);\n  z-index: 200;\n  transition: opacity .3s;\n}\n.toast.hidden { opacity: 0; pointer-events: none; }\n\n@media (max-width: 640px) {\n  .header-inner { gap: 10px; }\n  .server-config input { width: 120px; }\n  .video-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px; }\n  .player-top h1 { font-size: 1rem; }\n}\n\n/* Direct play actions */\n.direct-actions {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 8px;\n  margin-top: 12px;\n}\n.server-btn.accent {\n  background: var(--accent);\n  border-color: var(--accent);\n  color: #fff;\n}\n.server-btn.accent:hover {\n  background: var(--accent-hover);\n  border-color: var(--accent-hover);\n}\n\n#directVideo {\n  border-radius: var(--radius);\n}\n";
const EMBEDDED_JS = "/**\n * Laroza Player Frontend v2.2\n * - Connects to scraper API\n * - Multi-server embeds (iframe)\n * - Direct m3u8 / mp4 playback via HLS.js\n */\n\nconst DEFAULT_API = window.location.origin;\nlet API_BASE = localStorage.getItem('laroza_api') || DEFAULT_API;\n\nconst $ = (sel) => document.querySelector(sel);\nconst $$ = (sel) => document.querySelectorAll(sel);\n\nlet hlsInstance = null;\nlet currentVideo = null;\n\n// ---------- API ----------\nasync function api(path, options = {}) {\n  const url = API_BASE.replace(/\\/$/, '') + path;\n  const res = await fetch(url, {\n    ...options,\n    headers: { 'Accept': 'application/json', ...(options.headers || {}) }\n  });\n  if (!res.ok) {\n    const err = await res.json().catch(() => ({ error: res.statusText }));\n    throw new Error(err.error || `HTTP ${res.status}`);\n  }\n  return res.json();\n}\n\nfunction toast(msg, ms = 2800) {\n  const el = $('#toast');\n  el.textContent = msg;\n  el.classList.remove('hidden');\n  clearTimeout(el._t);\n  el._t = setTimeout(() => el.classList.add('hidden'), ms);\n}\n\nfunction setStatus(online) {\n  const el = $('#apiStatus');\n  el.textContent = online ? 'متصل' : 'غير متصل';\n  el.className = 'status ' + (online ? 'online' : 'offline');\n}\n\n// ---------- Navigation ----------\nfunction hideAll() {\n  ['homeSection', 'searchSection', 'catSection', 'playerSection'].forEach(id => {\n    const el = $('#' + id);\n    if (el) el.classList.add('hidden');\n  });\n}\nfunction goHome() {\n  stopDirectPlayer();\n  hideAll();\n  $('#homeSection').classList.remove('hidden');\n  history.replaceState(null, '', '#');\n}\nfunction showSearch(q) {\n  hideAll();\n  $('#searchSection').classList.remove('hidden');\n  $('#searchQuery').textContent = q;\n}\nfunction showCat(name) {\n  hideAll();\n  $('#catSection').classList.remove('hidden');\n  $('#catTitle').textContent = name;\n}\nfunction showPlayer() {\n  hideAll();\n  $('#playerSection').classList.remove('hidden');\n}\n\n// ---------- Render ----------\nfunction placeholderThumb() {\n  return 'data:image/svg+xml,' + encodeURIComponent(\n    `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"300\" height=\"450\"><rect fill=\"#1e1e28\" width=\"300\" height=\"450\"/><text x=\"150\" y=\"230\" fill=\"#555\" font-size=\"18\" text-anchor=\"middle\" font-family=\"Arial\">لا صورة</text></svg>`\n  );\n}\nfunction escapeHtml(s) {\n  return String(s || '').replace(/[&<>\"']/g, c =>\n    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c])\n  );\n}\nfunction videoCard(v) {\n  const title = v.title || v.vid || 'بدون عنوان';\n  const thumb = v.thumbnail || placeholderThumb();\n  const year = v.year ? `<span class=\"meta\">${v.year}</span>` : '';\n  return `\n    <div class=\"video-card\" data-vid=\"${v.vid}\" onclick=\"openVideo('${v.vid}')\">\n      <img class=\"thumb\" src=\"${thumb}\" alt=\"\" loading=\"lazy\" onerror=\"this.src='${placeholderThumb()}'\">\n      <div class=\"info\">\n        <div class=\"title\">${escapeHtml(title)}</div>\n        ${year}\n      </div>\n    </div>`;\n}\nfunction renderGrid(el, videos) {\n  if (!videos || !videos.length) {\n    el.innerHTML = '<div class=\"empty\">لا توجد نتائج</div>';\n    return;\n  }\n  el.innerHTML = videos.map(videoCard).join('');\n}\n\n// ---------- Data ----------\nasync function checkHealth() {\n  try {\n    await api('/health');\n    setStatus(true);\n    return true;\n  } catch (e) {\n    setStatus(false);\n    return false;\n  }\n}\n\nasync function loadHome(force = false) {\n  const grid = $('#homeGrid');\n  grid.innerHTML = '<div class=\"loading\">جاري التحميل من السيرفر...</div>';\n  try {\n    let videos = [];\n    try {\n      const stored = await api('/api/videos?limit=40');\n      videos = stored.videos || [];\n    } catch (e) {}\n    if (!videos.length || force) {\n      const home = await api('/api/scrape/home?limit=36');\n      videos = home.videos || [];\n    }\n    renderGrid(grid, videos);\n  } catch (e) {\n    grid.innerHTML = `<div class=\"empty\">فشل التحميل: ${escapeHtml(e.message)}<br><small>تأكد من رابط السيرفر</small></div>`;\n    toast('خطأ في الاتصال بالسيرفر');\n  }\n}\n\nasync function loadCategories() {\n  const box = $('#categories');\n  try {\n    const cats = await api('/api/categories');\n    box.innerHTML = Object.entries(cats).map(([key, info]) =>\n      `<span class=\"cat-chip\" data-cat=\"${key}\" onclick=\"openCategory('${key}', '${escapeHtml(info.name)}')\">${escapeHtml(info.name)}</span>`\n    ).join('');\n  } catch (e) {\n    box.innerHTML = '<span class=\"empty\">تعذر تحميل التصنيفات</span>';\n  }\n}\n\nasync function doSearch() {\n  const q = $('#searchInput').value.trim();\n  if (!q) return;\n  showSearch(q);\n  const grid = $('#searchGrid');\n  grid.innerHTML = '<div class=\"loading\">جاري البحث...</div>';\n  try {\n    let results = [];\n    try {\n      const local = await api('/api/search/local?q=' + encodeURIComponent(q));\n      results = local.results || [];\n    } catch (e) {}\n    if (!results.length) {\n      const live = await api('/api/scrape/search?q=' + encodeURIComponent(q));\n      results = live.videos || [];\n    }\n    renderGrid(grid, results);\n  } catch (e) {\n    grid.innerHTML = `<div class=\"empty\">فشل البحث: ${escapeHtml(e.message)}</div>`;\n  }\n}\n\nasync function openCategory(catKey, name) {\n  showCat(name || catKey);\n  const grid = $('#catGrid');\n  grid.innerHTML = '<div class=\"loading\">جاري التحميل...</div>';\n  try {\n    const data = await api(`/api/scrape/category/${encodeURIComponent(catKey)}?pages=1`);\n    renderGrid(grid, data.videos || []);\n    $('#catPager').innerHTML = `<button onclick=\"openCategory('${catKey}', '${escapeHtml(name)}')\">تحديث</button>`;\n  } catch (e) {\n    grid.innerHTML = `<div class=\"empty\">${escapeHtml(e.message)}</div>`;\n  }\n}\n\n// ---------- Direct player (HLS.js / native) ----------\nfunction stopDirectPlayer() {\n  const video = $('#directVideo');\n  if (hlsInstance) {\n    try { hlsInstance.destroy(); } catch (e) {}\n    hlsInstance = null;\n  }\n  if (video) {\n    video.pause();\n    video.removeAttribute('src');\n    video.load();\n    video.style.display = 'none';\n  }\n  const frame = $('#playerFrame');\n  if (frame) frame.style.display = 'block';\n}\n\nfunction playDirect(url, typeHint) {\n  const video = $('#directVideo');\n  const frame = $('#playerFrame');\n  const placeholder = $('#playerPlaceholder');\n  if (!video) return;\n\n  stopDirectPlayer();\n  frame.style.display = 'none';\n  frame.src = 'about:blank';\n  placeholder.style.display = 'none';\n  video.style.display = 'block';\n\n  const isHls = /\\.m3u8(\\?|$)/i.test(url) || typeHint === 'm3u8';\n\n  if (isHls && window.Hls && Hls.isSupported()) {\n    hlsInstance = new Hls({\n      enableWorker: true,\n      lowLatencyMode: false,\n      backBufferLength: 90\n    });\n    hlsInstance.loadSource(url);\n    hlsInstance.attachMedia(video);\n    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {\n      video.play().catch(() => {});\n    });\n    hlsInstance.on(Hls.Events.ERROR, (event, data) => {\n      if (data.fatal) {\n        console.error('HLS fatal', data);\n        toast('فشل تشغيل m3u8 – جرّب سيرفر آخر');\n        // fallback: open in new tab\n        // window.open(url, '_blank');\n      }\n    });\n  } else if (video.canPlayType('application/vnd.apple.mpegurl') && isHls) {\n    // Safari native HLS\n    video.src = url;\n    video.play().catch(() => {});\n  } else {\n    // mp4 or other\n    video.src = url;\n    video.play().catch(() => {});\n  }\n}\n\nfunction playServer(btn, embedUrl) {\n  $$('.server-btn').forEach(b => b.classList.remove('active'));\n  if (btn) btn.classList.add('active');\n\n  // Switching back to embed mode\n  stopDirectPlayer();\n  const frame = $('#playerFrame');\n  const placeholder = $('#playerPlaceholder');\n  const video = $('#directVideo');\n  if (video) video.style.display = 'none';\n  frame.style.display = 'block';\n\n  if (!embedUrl) {\n    frame.src = 'about:blank';\n    placeholder.style.display = 'flex';\n    placeholder.innerHTML = '<p>لا يوجد رابط</p>';\n    return;\n  }\n  placeholder.style.display = 'none';\n  frame.src = embedUrl;\n}\n\n// ---------- Open video ----------\nasync function openVideo(vid) {\n  showPlayer();\n  stopDirectPlayer();\n  $('#playerTitle').textContent = 'جاري التحميل...';\n  $('#playerFrame').src = 'about:blank';\n  $('#playerFrame').style.display = 'block';\n  $('#playerPlaceholder').style.display = 'flex';\n  $('#playerPlaceholder').innerHTML = '<p>جاري جلب السيرفرات...</p>';\n  $('#serversList').innerHTML = '';\n  $('#downloadsBox').style.display = 'none';\n  $('#m3u8Box').style.display = 'none';\n  $('#relatedBox').style.display = 'none';\n  $('#playerMeta').textContent = '';\n  $('#directActions').innerHTML = '';\n\n  history.replaceState(null, '', '#play/' + vid);\n\n  try {\n    const data = await api(`/api/scrape/video/${encodeURIComponent(vid)}?maxProbe=6`);\n    currentVideo = data;\n\n    $('#playerTitle').textContent = data.title || vid;\n    const metaParts = [];\n    if (data.duration) metaParts.push('المدة: ' + data.duration);\n    if (data.year) metaParts.push('السنة: ' + data.year);\n    if (data.embeds) metaParts.push(data.embeds.length + ' سيرفر');\n    $('#playerMeta').textContent = metaParts.join(' • ');\n\n    // Embed servers\n    const list = $('#serversList');\n    if (data.embeds && data.embeds.length) {\n      list.innerHTML = data.embeds.map((s, i) =>\n        `<button class=\"server-btn ${i === 0 ? 'active' : ''}\" data-url=\"${escapeHtml(s.url)}\" onclick=\"playServer(this, '${escapeHtml(s.url)}')\">سيرفر ${s.id || (i + 1)}</button>`\n      ).join('');\n      playServer(list.querySelector('.server-btn'), data.embeds[0].url);\n    } else {\n      list.innerHTML = '<span style=\"color:var(--muted)\">لا توجد سيرفرات</span>';\n    }\n\n    // Downloads\n    if (data.downloads && data.downloads.length) {\n      $('#downloadsBox').style.display = 'block';\n      $('#downloadsList').innerHTML = data.downloads.map(d =>\n        `<a href=\"${escapeHtml(d.url)}\" target=\"_blank\" rel=\"noopener\">${escapeHtml(d.host || 'تحميل')}</a>`\n      ).join('');\n    }\n\n    // Direct m3u8 / mp4\n    const directs = [];\n    (data.m3u8Probes || []).forEach(p => {\n      if (p.m3u8) directs.push({ url: p.m3u8, type: 'm3u8', label: 'm3u8' });\n      if (p.mp4) directs.push({ url: p.mp4, type: 'mp4', label: 'mp4' });\n      (p.sources || []).forEach(s => {\n        if (s && s !== p.m3u8 && s !== p.mp4) {\n          const t = /\\.m3u8/i.test(s) ? 'm3u8' : (/\\.mp4/i.test(s) ? 'mp4' : 'src');\n          directs.push({ url: s, type: t, label: t });\n        }\n      });\n    });\n    // unique by url\n    const seen = new Set();\n    const uniqueDirects = directs.filter(d => {\n      if (seen.has(d.url)) return false;\n      seen.add(d.url);\n      return true;\n    });\n\n    if (uniqueDirects.length) {\n      $('#m3u8Box').style.display = 'block';\n      $('#m3u8List').innerHTML = uniqueDirects.map((d, i) =>\n        `<a href=\"${escapeHtml(d.url)}\" target=\"_blank\" rel=\"noopener\">${d.label} #${i + 1}</a>\n         <button class=\"server-btn\" style=\"margin:4px\" onclick=\"playDirect('${escapeHtml(d.url)}', '${d.type}')\">▶ تشغيل مباشر</button>`\n      ).join('');\n\n      // Quick action buttons under player\n      $('#directActions').innerHTML = uniqueDirects.slice(0, 3).map((d, i) =>\n        `<button class=\"server-btn accent\" onclick=\"playDirect('${escapeHtml(d.url)}', '${d.type}')\">▶ تشغيل ${d.label} مباشر</button>`\n      ).join('');\n    }\n\n    // Related\n    if (data.related && data.related.length) {\n      $('#relatedBox').style.display = 'block';\n      renderGrid($('#relatedGrid'), data.related);\n    }\n  } catch (e) {\n    $('#playerTitle').textContent = 'فشل التحميل';\n    $('#playerMeta').textContent = e.message;\n    $('#playerPlaceholder').innerHTML = `<p>${escapeHtml(e.message)}</p>`;\n    toast('تعذر فتح الفيديو: ' + e.message);\n  }\n}\n\n// ---------- Config ----------\nfunction saveApiBase() {\n  const val = $('#apiBase').value.trim().replace(/\\/$/, '');\n  if (!val) { toast('اكتب رابط السيرفر'); return; }\n  API_BASE = val;\n  localStorage.setItem('laroza_api', val);\n  toast('تم حفظ رابط السيرفر');\n  checkHealth().then(ok => {\n    if (ok) { loadHome(true); loadCategories(); }\n  });\n}\n\nfunction initApiBaseInput() {\n  $('#apiBase').value = API_BASE;\n  $('#apiBase').addEventListener('keydown', e => { if (e.key === 'Enter') saveApiBase(); });\n  $('#searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });\n}\n\n// ---------- Boot ----------\nasync function boot() {\n  initApiBaseInput();\n\n  const hash = location.hash || '';\n  if (hash.startsWith('#play/')) {\n    const vid = hash.replace('#play/', '');\n    if (vid) {\n      await checkHealth();\n      openVideo(vid);\n      loadCategories();\n      return;\n    }\n  }\n\n  const ok = await checkHealth();\n  if (ok) {\n    await Promise.all([loadHome(), loadCategories()]);\n  } else {\n    $('#homeGrid').innerHTML = `\n      <div class=\"empty\">\n        السيرفر غير متصل<br>\n        <small>ضع رابط الـ API أعلى الصفحة ثم اضغط حفظ<br>\n        مثال: http://127.0.0.1:3030</small>\n      </div>`;\n  }\n}\n\nboot();\n";

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

function randomDelay(min = 400, max = 1200) {
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

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isCloudflareChallenge(html, status) {
  if (status === 403 || status === 503) return true;
  if (!html) return false;
  const markers = [
    'cf-browser-verification',
    'cf_clearance',
    'Checking your browser',
    'Just a moment',
    'cf-challenge',
    'challenge-platform',
    'Attention Required! | Cloudflare'
  ];
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
    if (this.proxies.length) {
      Logger.info(`Loaded ${this.proxies.length} proxy(ies)`);
    }
  }

  hasProxy() {
    return this.proxies.length > 0;
  }

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
        if (!SocksProxyAgent) {
          Logger.warn('socks-proxy-agent not installed – skipping SOCKS proxy');
          return null;
        }
        return new SocksProxyAgent(proxyUrl);
      }
      if (!HttpsProxyAgent) {
        Logger.warn('https-proxy-agent not installed – skipping HTTP proxy');
        return null;
      }
      return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      Logger.warn('Failed to create proxy agent:', e.message);
      return null;
    }
  }
}

// ============================================================================
// HTTP CLIENT (retry + proxy + CF-aware)
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
  }

  pickUA() {
    return randomItem(CONFIG.USER_AGENTS);
  }

  getCookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
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

  request(targetUrl, options = {}) {
    return new Promise(async (resolve, reject) => {
      await this.throttle();

      if (Date.now() < this.cfBlockedUntil) {
        const wait = this.cfBlockedUntil - Date.now();
        Logger.warn(`CF cooldown active, waiting ${Math.round(wait/1000)}s`);
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
        else if (encoding === 'br') {
          try { stream = res.pipe(zlib.createBrotliDecompress()); }
          catch (e) { stream = res; }
        }

        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let body = '';
          try { body = buffer.toString('utf8'); } catch (e) { body = buffer.toString('latin1'); }

          this._parseSetCookie(res.headers['set-cookie']);

          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            url: targetUrl,
            finalUrl: res.headers.location ? absoluteUrl(res.headers.location, targetUrl) : targetUrl,
            proxyUsed: proxyUrl || null
          });
        });
        stream.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

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
          Logger.warn(`Cloudflare challenge detected (attempt ${attempt}) on ${targetUrl}`);
          this.cfBlockedUntil = Date.now() + (15000 * attempt);
          // Clear some cookies that might be poisoned
          delete this.cookies['cf_clearance'];
          await sleep(this.retryDelay * attempt * 1.8);
          continue;
        }

        if (res.status >= 200 && res.status < 400) return res;

        if (res.status === 403 || res.status === 429) {
          Logger.warn(`HTTP ${res.status} – attempt ${attempt}`);
          await sleep(this.retryDelay * attempt * 1.6);
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
        Logger.warn(`Request failed (${attempt}/${this.maxRetries}): ${err.message}`);
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
      headers: Object.assign({}, options.headers || {}, {
        'Content-Type': 'application/x-www-form-urlencoded'
      })
    }));
  }

  // Lightweight HEAD / small GET to probe for m3u8
  async probe(url, options = {}) {
    try {
      const res = await this.request(url, Object.assign({
        method: 'GET',
        headers: {
          'Accept': '*/*',
          'Range': 'bytes=0-2048'
        }
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
    if (cheerio) {
      try { this.$ = cheerio.load(this.html); } catch (e) {}
    }
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
        source: 'video.php'
      });
    }

    // Enrich empty titles
    for (const v of videos) {
      if (!v.title) {
        const idx = this.html.indexOf(v.vid);
        if (idx === -1) continue;
        const around = this.html.substring(Math.max(0, idx - 450), idx + 450);
        const titleMatch = around.match(/title=["']([^"']{5,140})["']/i) ||
                           around.match(/alt=["']([^"']{5,140})["']/i) ||
                           around.match(/<strong[^>]*>([^<]{5,110})<\/strong>/i);
        if (titleMatch) v.title = cleanText(titleMatch[1]);
      }
    }

    // Cheerio fallback for better titles if available
    if (this.$ && videos.length) {
      this.$('a[href*="video.php?vid="]').each((_, el) => {
        const href = this.$(el).attr('href') || '';
        const vid = extractVidFromUrl(href);
        if (!vid) return;
        const existing = videos.find(x => x.vid === vid);
        if (existing && !existing.title) {
          existing.title = cleanText(this.$(el).attr('title') || this.$(el).text());
        }
        if (existing && !existing.thumbnail) {
          const img = this.$(el).find('img').attr('src') || this.$(el).find('img').attr('data-src');
          if (img) existing.thumbnail = absoluteUrl(img);
        }
      });
    }

    return videos;
  }

  extractEmbedServers() {
    const servers = [];
    const re = /<li[^>]*data-embed-id=["'](\d+)["'][^>]*data-embed-url=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(this.html)) !== null) {
      servers.push({
        id: parseInt(m[1], 10),
        url: m[2],
        name: `سيرفر ${m[1]}`
      });
    }

    if (servers.length === 0) {
      const iframeRe = /<iframe[^>]+src=["']([^"']+)["']/gi;
      while ((m = iframeRe.exec(this.html)) !== null) {
        servers.push({ id: servers.length + 1, url: m[1], name: `Embed ${servers.length + 1}` });
      }
    }

    // Also try data-src patterns
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
      try {
        links.push({ url: href, host: new URL(href).hostname });
      } catch (e) {}
    }

    const hosts = ['voe.sx', 'ok.ru', '1cloudfile', 'multiup', 'uploady', 'usersdrive',
                   'mediafire', 'mega.nz', 'google', 'mixdrop', 'upstream', 'dood'];
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
    const meta = {
      title: '',
      description: '',
      duration: '',
      views: '',
      rating: '',
      thumbnail: '',
      year: '',
      category: ''
    };

    const titleMatch = this.html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) meta.title = cleanText(titleMatch[1].replace(/\s*[-|].*$/, ''));

    const ogTitle = this.html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                    this.html.match(/content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (ogTitle) meta.title = cleanText(ogTitle[1]);

    const ogDesc = this.html.match(/property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                   this.html.match(/content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
    if (ogDesc) meta.description = cleanText(ogDesc[1]);

    const ogImage = this.html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                    this.html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogImage) meta.thumbnail = ogImage[1];

    const dur = this.html.match(/(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})/);
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
      if (!seen.has(p)) {
        seen.add(p);
        pages.push({ page: p, url: absoluteUrl(m[1]) });
      }
    }
    pages.sort((a, b) => a.page - b.page);
    return pages;
  }
}

// ============================================================================
// M3U8 / STREAM PROBER
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

  /**
   * Try to discover direct m3u8 or mp4 links from an embed page.
   * This is best-effort and host-specific heuristics.
   */
  async probeEmbed(embedUrl) {
    const result = {
      embedUrl,
      m3u8: null,
      mp4: null,
      sources: [],
      error: null
    };

    if (!embedUrl || !embedUrl.startsWith('http')) {
      result.error = 'invalid embed url';
      return result;
    }

    try {
      const res = await this.client.get(embedUrl, {
        headers: {
          'Referer': CONFIG.BASE_URL + '/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
      });

      const html = res.body || '';

      // Generic m3u8 regex
      const m3u8Matches = html.match(/https?:\/\/[^"'\\\s<>]+?\.m3u8[^"'\\\s<>]*/gi) || [];
      const uniqueM3u8 = [...new Set(m3u8Matches.map(u => u.replace(/\\+/g, '')))];

      // Generic mp4
      const mp4Matches = html.match(/https?:\/\/[^"'\\\s<>]+?\.mp4[^"'\\\s<>]*/gi) || [];
      const uniqueMp4 = [...new Set(mp4Matches.map(u => u.replace(/\\+/g, '')))];

      // Common player config patterns (jwplayer, videojs, clappr, etc.)
      const fileMatch = html.match(/(?:file|source|src|sources)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
      if (fileMatch) result.sources.push(fileMatch[1]);

      // Additional patterns: jwplayer setup, videojs, packed links
      const extraRe = [
        /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi,
        /file\s*:\s*["']([^"']+)["']/gi,
        /src\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
        /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/gi
      ];
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
          if (Array.isArray(arr)) {
            arr.forEach(s => {
              if (s.file) result.sources.push(s.file);
              if (s.src) result.sources.push(s.src);
            });
          }
        } catch (e) {}
      }

      if (uniqueM3u8.length) {
        result.m3u8 = uniqueM3u8[0];
        result.sources.push(...uniqueM3u8);
      }
      if (uniqueMp4.length) {
        result.mp4 = uniqueMp4[0];
        result.sources.push(...uniqueMp4);
      }

      result.sources = [...new Set(result.sources)];
      result.status = res.status;
    } catch (err) {
      result.error = err.message;
    }

    return result;
  }

  async probeMany(embedUrls, limit = 6) {
    const results = [];
    const list = (embedUrls || []).slice(0, limit);
    for (const u of list) {
      if (!this.isFriendlyHost(u)) {
        results.push({ embedUrl: u, skipped: true, reason: 'host not in friendly list' });
        continue;
      }
      const r = await this.probeEmbed(u);
      results.push(r);
      await randomDelay(500, 1100);
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
    this.stats = {
      totalVideos: 0,
      totalEmbeds: 0,
      totalDownloads: 0,
      totalM3u8: 0,
      lastCrawl: null,
      errors: 0,
      startedAt: nowISO()
    };
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
    } catch (e) {
      Logger.warn('Could not load data:', e.message);
    }
  }

  save() {
    try {
      const obj = Object.fromEntries(this.videos);
      fs.writeFileSync(path.join(this.baseDir, 'videos.json'), JSON.stringify(obj, null, 2));
      fs.writeFileSync(path.join(this.baseDir, 'stats.json'), JSON.stringify(this.stats, null, 2));
      Logger.debug('Data saved');
    } catch (e) {
      Logger.error('Save failed:', e.message);
    }
  }

  upsertVideo(vid, data) {
    const existing = this.videos.get(vid) || {};
    const merged = Object.assign({}, existing, data, {
      vid,
      updatedAt: nowISO()
    });
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
    return Array.from(this.videos.values()).slice(0, limit);
  }

  searchLocal(q, limit = 50) {
    const query = String(q).toLowerCase();
    const results = [];
    for (const v of this.videos.values()) {
      if ((v.title || '').toLowerCase().includes(query) ||
          (v.description || '').toLowerCase().includes(query)) {
        results.push(v);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  exportJSON(filename = 'export-full.json') {
    const file = path.join(this.baseDir, filename);
    const data = {
      exportedAt: nowISO(),
      stats: this.stats,
      videos: Object.fromEntries(this.videos)
    };
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

    const target = `${CONFIG.BASE_URL}/category.php?cat=${encodeURIComponent(catKey)}&page=${page}&order=DESC&sortby=${sortby}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const videos = parser.extractVideoCards();
    const pagination = parser.extractPagination();
    const meta = parser.extractMetadata();

    Logger.info(`Category ${catKey} page ${page}: ${videos.length} videos`);
    return { category: catKey, name: cat.name, type: cat.type, page, videos, pagination, meta };
  }

  async fetchNewVideos(page = 1) {
    const target = `${CONFIG.BASE_URL}/newvideos1.php` + (page > 1 ? `?page=${page}` : '');
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
    const target = `${CONFIG.BASE_URL}/video.php?vid=${encodeURIComponent(vid)}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const meta = parser.extractMetadata();
    const cards = parser.extractVideoCards();

    let playVid = vid;
    const playMatch = res.body.match(/play\.php\?vid=([a-zA-Z0-9_-]+)/);
    if (playMatch) playVid = playMatch[1];

    const xtgo = res.body.match(/href=["']([^"']*play\.php\?vid=[^"']+)["']/);
    const playUrl = xtgo ? absoluteUrl(xtgo[1]) : `${CONFIG.BASE_URL}/play.php?vid=${playVid}`;

    return {
      vid,
      playVid,
      playUrl,
      meta,
      related: cards.filter(c => c.vid !== vid).slice(0, 12),
      rawLength: res.body.length
    };
  }

  async fetchPlayPage(vid) {
    const target = `${CONFIG.BASE_URL}/play.php?vid=${encodeURIComponent(vid)}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const meta = parser.extractMetadata();
    const embeds = parser.extractEmbedServers();
    const related = parser.extractVideoCards().filter(c => c.vid !== vid).slice(0, 10);

    const iframeMatch = res.body.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    const currentEmbed = iframeMatch ? iframeMatch[1] : (embeds[0] ? embeds[0].url : null);

    return {
      vid,
      meta,
      embeds,
      currentEmbed,
      related,
      downloadPage: `${CONFIG.BASE_URL}/download.php?vid=${vid}`
    };
  }

  async fetchDownloadPage(vid) {
    const target = `${CONFIG.BASE_URL}/download.php?vid=${encodeURIComponent(vid)}`;
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    const links = parser.extractDownloadLinks();
    const meta = parser.extractMetadata();
    return { vid, meta, downloads: links };
  }

  async search(keywords, page = 1) {
    const target = `${CONFIG.BASE_URL}/search.php?keywords=${encodeURIComponent(keywords)}` +
                   (page > 1 ? `&page=${page}` : '');
    const res = await this.client.get(target);
    const parser = new HtmlParser(res.body);
    return {
      query: keywords,
      page,
      videos: parser.extractVideoCards(),
      pagination: parser.extractPagination()
    };
  }

  async scrapeFullVideo(vid, opts = {}) {
    const {
      includeDownloads = true,
      probeM3u8 = true,
      maxProbe = 5
    } = opts;

    Logger.info(`Scraping full video: ${vid}`);

    try {
      const videoPage = await this.fetchVideoPage(vid);
      await randomDelay(300, 700);

      const playPage = await this.fetchPlayPage(videoPage.playVid || vid);
      await randomDelay(300, 700);

      let downloads = [];
      if (includeDownloads) {
        try {
          const dl = await this.fetchDownloadPage(videoPage.playVid || vid);
          downloads = dl.downloads;
        } catch (e) {
          Logger.warn(`Download page failed for ${vid}: ${e.message}`);
        }
      }

      let m3u8Probes = [];
      if (probeM3u8 && playPage.embeds && playPage.embeds.length) {
        try {
          const urls = playPage.embeds.map(e => e.url);
          m3u8Probes = await this.prober.probeMany(urls, maxProbe);
        } catch (e) {
          Logger.warn(`m3u8 probe failed: ${e.message}`);
        }
      }

      const record = {
        vid: videoPage.vid,
        playVid: videoPage.playVid,
        title: playPage.meta.title || videoPage.meta.title,
        description: playPage.meta.description || videoPage.meta.description,
        thumbnail: playPage.meta.thumbnail || videoPage.meta.thumbnail,
        duration: playPage.meta.duration || videoPage.meta.duration,
        year: playPage.meta.year || videoPage.meta.year,
        embeds: playPage.embeds,
        currentEmbed: playPage.currentEmbed,
        downloads,
        m3u8Probes,
        related: videoPage.related,
        playUrl: videoPage.playUrl,
        sourceUrl: `${CONFIG.BASE_URL}/video.php?vid=${vid}`,
        scrapedAt: nowISO()
      };

      this.store.upsertVideo(vid, record);
      this.emit('video', record);
      Logger.success(`Video ${vid} → embeds:${record.embeds.length} downloads:${downloads.length} m3u8:${m3u8Probes.filter(p=>p.m3u8||p.mp4).length}`);
      return record;
    } catch (err) {
      this.store.stats.errors++;
      Logger.error(`Failed to scrape video ${vid}:`, err.message);
      throw err;
    }
  }

  async scrapeCategory(catKey, maxPages = 5) {
    Logger.info(`Scraping category ${catKey} (max ${maxPages} pages)`);
    const allVideos = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= maxPages) {
      try {
        const result = await this.fetchCategory(catKey, page);
        allVideos.push(...result.videos);

        for (const v of result.videos) {
          if (!this.visited.has(v.vid)) {
            this.visited.add(v.vid);
            this.queue.push({ type: 'video', vid: v.vid });
          }
        }

        const maxPage = result.pagination.reduce((mx, p) => Math.max(mx, p.page), 1);
        hasMore = page < maxPage && result.videos.length > 0;
        page++;
        await randomDelay(800, 1500);
      } catch (e) {
        Logger.error(`Category page ${page} failed:`, e.message);
        hasMore = false;
      }
    }

    this.store.categories.set(catKey, {
      key: catKey,
      name: CONFIG.CATEGORIES[catKey]?.name,
      videoCount: allVideos.length,
      scrapedAt: nowISO()
    });

    return allVideos;
  }

  async scrapeHomeAndQueue(limit = 40) {
    const home = await this.fetchHome();
    for (const v of home.videos.slice(0, limit)) {
      if (!this.visited.has(v.vid)) {
        this.visited.add(v.vid);
        this.queue.push({ type: 'video', vid: v.vid });
      }
    }
    return home.videos;
  }

  async processQueue(concurrency = CONFIG.CONCURRENCY) {
    if (this.running) {
      Logger.warn('Queue already running');
      return;
    }
    this.running = true;
    Logger.info(`Queue processor started (${this.queue.length} items, concurrency=${concurrency})`);

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
        if (job.type === 'video') await this.scrapeFullVideo(job.vid);
        else if (job.type === 'category') await this.scrapeCategory(job.cat, job.maxPages || 3);
      } catch (e) {
        Logger.error(`Worker ${id} failed:`, e.message);
      }
      await randomDelay(600, 1400);
    }
  }

  async crawlEverything(options = {}) {
    const {
      categories = Object.keys(CONFIG.CATEGORIES),
      maxPagesPerCat = 3,
      includeHome = true,
      includeNew = true,
      includeTop = true
    } = options;

    Logger.info('=== FULL SITE CRAWL STARTED ===');

    if (includeHome) await this.scrapeHomeAndQueue(50);
    if (includeNew) {
      const neu = await this.fetchNewVideos();
      for (const v of neu.videos) {
        if (!this.visited.has(v.vid)) {
          this.visited.add(v.vid);
          this.queue.push({ type: 'video', vid: v.vid });
        }
      }
    }
    if (includeTop) {
      const top = await this.fetchTopVideos();
      for (const v of top.videos) {
        if (!this.visited.has(v.vid)) {
          this.visited.add(v.vid);
          this.queue.push({ type: 'video', vid: v.vid });
        }
      }
    }

    for (const cat of categories) {
      this.queue.push({ type: 'category', cat, maxPages: maxPagesPerCat });
    }

    await this.processQueue();
    Logger.info('=== FULL SITE CRAWL FINISHED ===');
    return this.store.stats;
  }
}

// ============================================================================
// MINIMAL HTTP SERVER + ROUTES
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

    // Full CORS – allow any frontend
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Static files from /public
    if (method === 'GET' && (pathname === '/' || pathname.startsWith('/public/') || 
        pathname === '/style.css' || pathname === '/app.js' || pathname === '/index.html' ||
        pathname === '/favicon.ico')) {
      return this.serveStatic(req, res, pathname);
    }

    const matched = this.matchRoute(method, pathname);
    if (!matched) {
      this.json(res, 404, { error: 'Not found', path: pathname });
      return;
    }

    let body = '';
    if (method === 'POST') {
      for await (const chunk of req) body += chunk;
      try { req.body = body ? JSON.parse(body) : {}; }
      catch { req.body = querystring.parse(body); }
    }

    req.query = parsed.query;
    req.params = matched.params;

    try {
      await matched.handler(req, res);
    } catch (err) {
      Logger.error('API error:', err);
      this.json(res, 500, { error: err.message, stack: process.env.DEBUG === '1' ? err.stack : undefined });
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
    // Single-file mode: serve embedded frontend (no public/ folder required)
    let body = null;
    let ctype = 'text/html; charset=utf-8';

    if (pathname === '/' || pathname === '/index.html') {
      body = EMBEDDED_HTML;
      ctype = 'text/html; charset=utf-8';
    } else if (pathname === '/style.css' || pathname === '/public/style.css') {
      body = EMBEDDED_CSS;
      ctype = 'text/css; charset=utf-8';
    } else if (pathname === '/app.js' || pathname === '/public/app.js') {
      body = EMBEDDED_JS;
      ctype = 'application/javascript; charset=utf-8';
    } else {
      this.json(res, 404, { error: 'Not found', path: pathname });
      return;
    }

    const buf = Buffer.from(body, 'utf8');
    res.writeHead(200, {
      'Content-Type': ctype,
      'Content-Length': buf.length,
      'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(buf);
  }

  start(port = CONFIG.PORT, host = CONFIG.HOST) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.listen(port, host, () => {
      Logger.success(`Laroza Scraper API v2.1 → http://${host}:${port}`);
      Logger.info('Proxy enabled: ' + (this.scraper.client.proxyManager.hasProxy() ? 'YES' : 'NO'));
    });
  }
}

function setupRoutes(api, scraper, store) {
  // Dashboard
  api.get('/', async (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Laroza Scraper v2.1</title>
<style>
:root{--bg:#0b0b0f;--card:#15151c;--accent:#ff3b5c;--text:#e8e8ed;--muted:#9a9aad}
*{box-sizing:border-box}
body{margin:0;font-family:Tahoma,Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.wrap{max-width:960px;margin:0 auto;padding:24px}
h1{color:var(--accent);margin:0 0 8px}
.sub{color:var(--muted);margin-bottom:24px}
.card{background:var(--card);border-radius:12px;padding:18px 20px;margin:14px 0;border:1px solid #222}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.stat{background:#1c1c26;border-radius:10px;padding:14px;text-align:center}
.stat b{display:block;font-size:1.4rem;color:var(--accent)}
a{color:#7eb6ff;text-decoration:none}
a:hover{text-decoration:underline}
code{background:#222;padding:2px 7px;border-radius:4px;font-size:.9em}
ul{padding-right:18px}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:8px 14px;border-radius:8px;margin:4px 4px 4px 0;font-size:.9rem}
input,select{background:#1c1c26;border:1px solid #333;color:var(--text);padding:8px 12px;border-radius:8px;width:100%;max-width:320px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Laroza1.lat Scraper <small style="font-size:.6em;color:var(--muted)">v2.1</small></h1>
  <p class="sub">سحب الأفلام • المسلسلات • السيرفرات • روابط التحميل • m3u8</p>

  <div class="card">
    <div class="grid">
      <div class="stat"><b id="vcount">${store.stats.totalVideos}</b> فيديو</div>
      <div class="stat"><b>${store.stats.totalEmbeds}</b> سيرفر</div>
      <div class="stat"><b>${store.stats.totalDownloads}</b> تحميل</div>
      <div class="stat"><b>${store.stats.totalM3u8 || 0}</b> m3u8</div>
      <div class="stat"><b>${store.stats.errors}</b> أخطاء</div>
    </div>
    <p style="margin-top:14px;color:var(--muted);font-size:.9rem">
      آخر زحف: ${store.stats.lastCrawl || 'لم يتم بعد'} |
      البروكسي: ${scraper.client.proxyManager.hasProxy() ? 'مفعّل' : 'غير مفعّل'}
    </p>
  </div>

  <div class="card">
    <h3>اختبار سريع</h3>
    <p>
      <input type="text" id="vidInput" placeholder="vid مثال: 8d0e6f937" value="8d0e6f937">
      <a class="btn" href="#" onclick="location.href='/api/scrape/video/'+document.getElementById('vidInput').value;return false">سحب كامل</a>
      <a class="btn" href="#" onclick="location.href='/api/scrape/play/'+document.getElementById('vidInput').value;return false">سيرفرات فقط</a>
      <a class="btn" href="#" onclick="location.href='/api/embeds/'+document.getElementById('vidInput').value;return false">embeds</a>
    </p>
  </div>

  <div class="card">
    <h3>Endpoints</h3>
    <ul>
      <li><code>GET /api/stats</code></li>
      <li><code>GET /api/videos?limit=50</code></li>
      <li><code>GET /api/video/:vid</code></li>
      <li><code>GET /api/scrape/video/:vid</code> – كامل (embeds + downloads + m3u8 probe)</li>
      <li><code>GET /api/scrape/play/:vid</code></li>
      <li><code>GET /api/scrape/download/:vid</code></li>
      <li><code>GET /api/scrape/category/:cat?pages=3</code></li>
      <li><code>GET /api/scrape/home</code></li>
      <li><code>GET /api/scrape/search?q=كلمة</code></li>
      <li><code>GET /api/scrape/full</code> – زحف كبير (حذر)</li>
      <li><code>GET /api/export</code></li>
      <li><code>GET /api/categories</code></li>
      <li><code>GET /health</code></li>
    </ul>
  </div>

  <div class="card">
    <h3>تصنيفات معروفة</h3>
    <p style="font-size:.9rem;color:var(--muted)">${Object.entries(CONFIG.CATEGORIES).map(([k,v]) => `<code>${k}</code> ${v.name}`).join(' • ')}</p>
  </div>
</div>
</body>
</html>`;
    api.html(res, 200, html);
  });

  api.get('/api/stats', async (req, res) => {
    api.json(res, 200, {
      stats: store.stats,
      queueLength: scraper.queue.length,
      visited: scraper.visited.size,
      proxyEnabled: scraper.client.proxyManager.hasProxy(),
      categories: Object.fromEntries(store.categories)
    });
  });

  api.get('/api/videos', async (req, res) => {
    const limit = parseInt(req.query.limit || '100', 10);
    api.json(res, 200, { count: store.videos.size, videos: store.getAllVideos(limit) });
  });

  api.get('/api/video/:vid', async (req, res) => {
    const v = store.getVideo(req.params.vid);
    if (!v) return api.json(res, 404, { error: 'Not in store. Use /api/scrape/video/:vid' });
    api.json(res, 200, v);
  });

  api.get('/api/scrape/video/:vid', async (req, res) => {
    const data = await scraper.scrapeFullVideo(req.params.vid, {
      includeDownloads: req.query.downloads !== '0',
      probeM3u8: req.query.m3u8 !== '0',
      maxProbe: parseInt(req.query.maxProbe || '5', 10)
    });
    store.save();
    api.json(res, 200, data);
  });

  api.get('/api/scrape/play/:vid', async (req, res) => {
    const data = await scraper.fetchPlayPage(req.params.vid);
    api.json(res, 200, data);
  });

  api.get('/api/scrape/download/:vid', async (req, res) => {
    const data = await scraper.fetchDownloadPage(req.params.vid);
    api.json(res, 200, data);
  });

  api.get('/api/scrape/category/:cat', async (req, res) => {
    const pages = parseInt(req.query.pages || '2', 10);
    const videos = await scraper.scrapeCategory(req.params.cat, pages);
    if (req.query.full === '1') await scraper.processQueue();
    store.save();
    api.json(res, 200, { category: req.params.cat, count: videos.length, videos });
  });

  api.get('/api/scrape/home', async (req, res) => {
    const videos = await scraper.scrapeHomeAndQueue(parseInt(req.query.limit || '30', 10));
    if (req.query.full === '1') await scraper.processQueue();
    store.save();
    api.json(res, 200, { count: videos.length, videos });
  });

  api.get('/api/scrape/new', async (req, res) => {
    const data = await scraper.fetchNewVideos(parseInt(req.query.page || '1', 10));
    api.json(res, 200, data);
  });

  api.get('/api/scrape/top', async (req, res) => {
    const data = await scraper.fetchTopVideos();
    api.json(res, 200, data);
  });

  api.get('/api/scrape/search', async (req, res) => {
    const q = req.query.q || req.query.keywords;
    if (!q) return api.json(res, 400, { error: 'Missing q parameter' });
    const data = await scraper.search(q, parseInt(req.query.page || '1', 10));
    api.json(res, 200, data);
  });

  api.get('/api/scrape/full', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.write(JSON.stringify({ status: 'started', message: 'Full crawl running in background' }) + '\n');
    scraper.crawlEverything({
      maxPagesPerCat: parseInt(req.query.pages || '2', 10),
      categories: req.query.cats ? req.query.cats.split(',') : Object.keys(CONFIG.CATEGORIES).slice(0, 6)
    }).then(stats => Logger.success('Background full crawl done', stats))
      .catch(e => Logger.error(e));
    res.end();
  });

  api.get('/api/categories', async (req, res) => {
    api.json(res, 200, CONFIG.CATEGORIES);
  });

  api.get('/api/export', async (req, res) => {
    const file = store.exportJSON();
    api.json(res, 200, { file, stats: store.stats });
  });

  api.get('/api/search/local', async (req, res) => {
    const q = req.query.q;
    if (!q) return api.json(res, 400, { error: 'Missing q' });
    api.json(res, 200, { results: store.searchLocal(q) });
  });

  api.get('/api/embeds/:vid', async (req, res) => {
    const play = await scraper.fetchPlayPage(req.params.vid);
    api.json(res, 200, {
      vid: req.params.vid,
      embeds: play.embeds,
      current: play.currentEmbed
    });
  });

  api.get('/api/probe/:vid', async (req, res) => {
    const play = await scraper.fetchPlayPage(req.params.vid);
    const probes = await scraper.prober.probeMany((play.embeds || []).map(e => e.url), parseInt(req.query.limit || '6', 10));
    api.json(res, 200, { vid: req.params.vid, probes });
  });

  api.get('/health', async (req, res) => {
    api.json(res, 200, {
      status: 'ok',
      uptime: process.uptime(),
      videos: store.stats.totalVideos,
      proxy: scraper.client.proxyManager.hasProxy(),
      version: '2.1.0'
    });
  });
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

  process.on('SIGINT', () => {
    Logger.info('Shutting down...');
    store.save();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    store.save();
    process.exit(0);
  });

  if (process.env.AUTO_SCRAPE === '1') {
    Logger.info('AUTO_SCRAPE enabled');
    try {
      await scraper.scrapeHomeAndQueue(12);
      await scraper.processQueue(2);
    } catch (e) {
      Logger.error('Auto scrape failed:', e.message);
    }
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
  main
};

if (require.main === module) {
  main().catch(err => {
    Logger.error('Fatal:', err);
    process.exit(1);
  });
}
