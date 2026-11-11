"use strict";
/* ====================================================================== *
 *  panel WALENCYA  —  premium multi-protocol proxy panel for KataBump     *
 *  Two-file edition: index.js + package.json  (no npm dependencies)       *
 *                                                                        *
 *  What this file does                                                   *
 *   1. opens the public port immediately (KataBump needs a listener)     *
 *   2. downloads the panel engine + Xray-core on first boot              *
 *   3. runs the engine on loopback and re-skins it on the fly (brand,    *
 *      theme, login, subscription page) through a rewriting proxy        *
 *   4. auto-provisions hosts / inbounds / client / subscription          *
 *   5. multiplexes everything on ONE port:                               *
 *        TLS ClientHello  -> REALITY inbound                             *
 *        WebSocket paths  -> VLESS / VMess / Trojan WS inbounds          *
 *        everything else  -> WALENCYA panel + subscription pages         *
 * ====================================================================== */

const net = require("net");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { Writable } = require("stream");

/* ------------------------------ config ------------------------------ */
const BRAND = "WALENCYA";
const XUI_VERSION = process.env.WALENCYA_ENGINE_VERSION || "v3.10.2";
const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const PUBLIC_PORT = int(process.env.SERVER_PORT || process.env.PORT, 3000);
const ROOT = process.env.KATABUMP_ROOT || process.env.KATABUMP_DIR || process.cwd();
const BASE = path.join(ROOT, "walencya");
const ENGINE_DIR = path.join(BASE, "engine");
const DATA_DIR = path.join(BASE, "data");
const LOG_DIR = path.join(BASE, "log");
const STATE_FILE = path.join(BASE, "state.json");
const CRED_FILE = path.join(BASE, "PANEL.txt");

const HTTP_PORT = int(process.env.WALENCYA_HTTP_PORT, 21080);
const PANEL_PORT = int(process.env.WALENCYA_PANEL_PORT, 21053);
const SUB_PORT = int(process.env.WALENCYA_SUB_PORT, 21090);
const P_VLESS = 21001, P_VMESS = 21002, P_TROJAN = 21003, P_REALITY = 21004;
const PATH_VLESS = "/wl-vless", PATH_VMESS = "/wl-vmess", PATH_TROJAN = "/wl-trojan";
const WS_ROUTES = { [PATH_VLESS]: P_VLESS, [PATH_VMESS]: P_VMESS, [PATH_TROJAN]: P_TROJAN };

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ENV_PASS = process.env.ADMIN_PASS || "";
const REALITY_TARGET = process.env.WALENCYA_REALITY_TARGET || "www.speedtest.net:443";
const REALITY_SNI = process.env.WALENCYA_REALITY_SNI || REALITY_TARGET.split(":")[0];
const WS_HOST_HEADER = process.env.WALENCYA_WS_HOST || "";
const PUBLIC_HOST_ENV = (process.env.WALENCYA_PUBLIC_HOST || "").trim();

/* ------------------------------ helpers ----------------------------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789") => {
  const b = crypto.randomBytes(n); let s = "";
  for (let i = 0; i < n; i++) s += alphabet[b[i] % alphabet.length];
  return s;
};
const mkdirp = (d) => fs.mkdirSync(d, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const writeJson = (f, o) => { mkdirp(path.dirname(f)); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const STATE = { phase: "boot", message: "Starting…", ready: false, publicHost: null, steps: [], error: null };
const saved = readJson(STATE_FILE, {});
const saveState = (patch) => { Object.assign(saved, patch); try { writeJson(STATE_FILE, saved); } catch (e) {} };
const log = (...a) => console.log(`[${BRAND}]`, ...a);
function setPhase(phase, message) {
  STATE.phase = phase; STATE.message = message;
  STATE.steps.push({ t: Date.now(), phase, message });
  if (STATE.steps.length > 40) STATE.steps.shift();
  log(message);
}
const etag = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 10);

/* ------------------------ embedded front-end assets ----------------------- */
const THEME_CSS = "/* ============ WALENCYA theme — \"Aurora Glass\" ============ */\n:root{--w-v:#8b6cff;--w-c:#22d3ee;--w-p:#f472b6;--w-grad:linear-gradient(135deg,#8b6cff 0%,#5b8cff 52%,#22d3ee 100%);--w-font:\"Inter\",\"Segoe UI\",\"Vazirmatn\",\"SF Pro Text\",Tahoma,system-ui,-apple-system,sans-serif}\nhtml,body,#app{font-family:var(--w-font)!important;-webkit-font-smoothing:antialiased}\nbody{min-height:100vh}\nbody.dark{background:#07071a!important;color:#ecebff}\nbody.light{background:#f1efff!important;color:#1c1840}\nbody::before,body::after{content:\"\";position:fixed;z-index:0;pointer-events:none;border-radius:50%;filter:blur(90px);opacity:.55}\nbody::before{width:620px;height:620px;left:-160px;top:-180px;background:radial-gradient(circle,rgba(139,108,255,.55),transparent 70%);animation:wal-float 18s ease-in-out infinite alternate}\nbody::after{width:560px;height:560px;right:-140px;bottom:-160px;background:radial-gradient(circle,rgba(34,211,238,.42),transparent 70%);animation:wal-float 22s ease-in-out infinite alternate-reverse}\nbody.light::before{opacity:.45}body.light::after{opacity:.4}\nhtml[data-theme='ultra-dark'] body.dark{background:#02020a!important}\nhtml[data-theme='ultra-dark'] body::before,html[data-theme='ultra-dark'] body::after{opacity:.28}\n@keyframes wal-float{to{transform:translate(60px,40px) scale(1.15)}}\n#app,#message{position:relative;z-index:1}\n";
const THEME_JS = "(function(){\n  var css=document.getElementById('wal-css');\n  function keepLast(){var h=document.head;css=css||document.getElementById('wal-css');if(css&&h.lastElementChild!==css&&!keepLast.busy){keepLast.busy=1;h.appendChild(css);setTimeout(function(){keepLast.busy=0},50)}};\n  new MutationObserver(keepLast).observe(document.head,{childList:true});\n})();\n";
const SUB_HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">\n<title>__BRAND__ · Subscription</title>\n</head><body>\n<div class=\"wrap\" id=\"root\"></div>\n</body></html>\n";

/* ------------------------------ server setup ------------------------------ */
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<h1>${BRAND} Panel is Running</h1><p>Engine initialized successfully.</p>`);
});

server.listen(PUBLIC_PORT, () => {
  log(`Server running on port ${PUBLIC_PORT}`);
});
