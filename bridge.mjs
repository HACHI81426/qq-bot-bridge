// QQ Bot Bridge - QQ 官方机器人桥接本机 Codex CLI
// Author: 8!!
// GitHub: https://github.com/HACHI81426

import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = __dirname;
const LOG_FILE = path.join(BRIDGE_DIR, 'logs', 'bridge.log');
const OUT_DIR = path.join(BRIDGE_DIR, '.out');
const ENV_FILE = path.join(BRIDGE_DIR, '.env');

// ---------- config ----------
function loadEnv(file) {
  const cfg = {};
  if (!existsSync(file)) return cfg;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return cfg;
}

function setEnvValue(file, key, value) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch {}
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '=.*$', 'm');
  const line = key + '=' + value;
  if (re.test(text)) {
    text = text.replace(re, line);
  } else {
    text = (text ? text.replace(/\s*$/, '\n') : '') + line + '\n';
  }
  writeFileSync(file, text, 'utf8');
}

const env = loadEnv(ENV_FILE);
const chatRoot = env.CHAT_LOG_ROOT || path.join(BRIDGE_DIR, 'chat-logs');

let bots = [];
try {
  const arr = JSON.parse(env.QQBOTS_JSON || '[]');
  bots = arr.filter(b => b && b.appId && b.clientSecret)
    .map(b => ({ id: b.accountId || b.appId, name: b.name || b.accountId || b.appId, appId: b.appId, clientSecret: b.clientSecret }));
} catch (e) { console.log('QQBOTS_JSON parse error:', e.message); }
if (!bots.length && env.QQBOT_APP_ID && env.QQBOT_CLIENT_SECRET) {
  bots = [{ id: 'default', appId: env.QQBOT_APP_ID, clientSecret: env.QQBOT_CLIENT_SECRET }];
}
for (const b of bots) {
  b.accessToken = null;
  b.tokenExpiresAt = 0;
  b.ws = null;
  b.lastSeq = null;
  b.heartbeatTimer = null;
  b.reconnectDelay = 3000;
  b.sessionId = null;
  b.workDir = path.join(chatRoot, b.name);
  b.transcriptFile = path.join(b.workDir, '聊天记录.txt');
}

const cfg = {
  allowedOpenids: (env.ALLOWED_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean),
  codexCli: env.CODEX_CLI_PATH || 'codex',
  codexHome: env.CODEX_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : ''),
  workDir: env.WORK_DIR || path.join(BRIDGE_DIR, 'workspace'),
  inboxDir: env.INBOX_DIR || path.join(BRIDGE_DIR, 'inbox'),
  watchDir: env.WATCH_DIR || path.join(BRIDGE_DIR, 'watch'),
  codexTimeoutMs: Number(env.CODEX_TIMEOUT_MS || 300000),
  chatRoot,
  panelPort: Number(env.PANEL_PORT || 17890),
  icloudDir: env.ICLOUD_DIR || 'F:\\iCloud\\iCloudDrive\\Codex',
  selfTest: process.argv.includes('--self-test'),
  bots,
};

mkdirSync(path.dirname(LOG_FILE), { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(cfg.workDir, { recursive: true });
mkdirSync(cfg.inboxDir, { recursive: true });
for (const b of bots) mkdirSync(b.workDir, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

// ---------- QQ API ----------
async function getAccessToken(bot, force = false) {
  if (!force && bot.accessToken && Date.now() < bot.tokenExpiresAt - 60000) return bot.accessToken;
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: bot.appId, clientSecret: bot.clientSecret }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`[${bot.id}] getAccessToken failed: ` + JSON.stringify(data));
  bot.accessToken = data.access_token;
  bot.tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
  return bot.accessToken;
}

async function apiGet(bot, pathname) {
  const t = await getAccessToken(bot);
  const res = await fetch('https://api.sgroup.qq.com' + pathname, {
    headers: { Authorization: `QQBot ${t}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`[${bot.id}] GET ${pathname} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function sendC2CText(bot, openid, content, msgId, msgSeq) {
  const t = await getAccessToken(bot);
  const body = { content, msg_type: 0, msg_seq: msgSeq || 1 };
  if (msgId) body.msg_id = msgId;
  const res = await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) log(`[${bot.id}] send failed`, res.status, text.slice(0, 200));
  return res.ok;
}

async function sendGroupText(bot, groupOpenid, content, msgId, msgSeq) {
  const t = await getAccessToken(bot);
  const body = { content, msg_type: 0, msg_seq: msgSeq || 1 };
  if (msgId) body.msg_id = msgId;
  const res = await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenid}/messages`, {
    method: 'POST',
    headers: { Authorization: `QQBot ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) log(`[${bot.id}] group send failed`, res.status, text.slice(0, 200));
  return res.ok;
}

// ---------- attachments ----------
const FILE_CATEGORIES = [
  ['图片', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']],
  ['文档', ['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.md', '.csv']],
  ['音频', ['.mp3', '.wav', '.m4a', '.amr', '.silk', '.ogg', '.flac']],
  ['视频', ['.mp4', '.avi', '.mkv', '.mov', '.flv', '.wmv']],
];

function categorizeFile(name) {
  const ext = path.extname(String(name)).toLowerCase();
  for (const [label, exts] of FILE_CATEGORIES) {
    if (exts.includes(ext)) return label;
  }
  return '其他';
}

function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function downloadAttachment(bot, att) {
  const safeName = String(att.filename || 'attachment').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
  const destDir = path.join(cfg.inboxDir, bot.name, localDateStr());
  mkdirSync(destDir, { recursive: true });
  const filePath = path.join(destDir, `${Date.now()}-${safeName}`);
  const token = await getAccessToken(bot);
  let res = await fetch(att.url, { headers: { Authorization: `QQBot ${token}` } });
  if (!res.ok) throw new Error('下载附件失败 HTTP ' + res.status);
  writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  log(`[${bot.id}] saved attachment:`, filePath, '| size:', att.size || '?');
  return { path: filePath, name: safeName };
}

// ---------- Codex ----------
const sessions = new Map(); // openid -> thread_id
const running = new Map();  // openid -> boolean
const onboardingSent = new Set(); // openid -> 已发送安全模式引导

function parseThreadId(jsonl) {
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.thread_id) return ev.thread_id;
    } catch {}
  }
  return null;
}

function chunkText(text, max = 1500) {
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : ['（无输出）'];
}

function runCodex(prompt, openid, workDir = cfg.workDir) {
  return new Promise((resolve, reject) => {
    const outFile = path.join(OUT_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}.txt`);
    let args = ['exec', '--json', '--skip-git-repo-check', '-C', workDir, '--dangerously-bypass-approvals-and-sandbox', '-o', outFile];
    const prev = sessions.get(openid);
    if (prev) args.push('resume', prev);
    args.push(prompt);

    const child = spawn(cfg.codexCli, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: process.env.USERPROFILE || os.homedir(),
        USERPROFILE: process.env.USERPROFILE || os.homedir(),
        CODEX_HOME: cfg.codexHome || path.join(os.homedir(), '.codex'),
      },
    });

    let jsonBuf = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('Codex 处理超时'));
    }, cfg.codexTimeoutMs);

    child.stdout.on('data', d => { jsonBuf += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const thread = parseThreadId(jsonBuf);
        if (thread) sessions.set(openid, thread);
        const out = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
        resolve(out || '（无输出）');
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------- C2C messages ----------
const recentMsg = new Map(); // msgId -> timestamp
const STATE_FILE = path.join(BRIDGE_DIR, 'data', 'recent-files.json');
const recentFiles = (() => {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
})();
function persistRecentFiles() {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(recentFiles));
  } catch (e) { log('persist recent files error:', e.message); }
}

// ---------- workbuddy inbox watcher ----------
const WATCH_SEEN_FILE = path.join(BRIDGE_DIR, 'data', 'watched-files.json');
let notifyOpenid = cfg.allowedOpenids[0] || '';
let lastContact = null; // { bot, openid }
const LAST_CONTACT_FILE = path.join(BRIDGE_DIR, 'data', 'last-contact.json');
const botLastContact = new Map((() => {
  try {
    const o = JSON.parse(readFileSync(LAST_CONTACT_FILE, 'utf8'));
    return Object.entries(o);
  } catch { return []; }
})());
function persistLastContact() {
  try {
    mkdirSync(path.dirname(LAST_CONTACT_FILE), { recursive: true });
    writeFileSync(LAST_CONTACT_FILE, JSON.stringify(Object.fromEntries(botLastContact)));
  } catch (e) { log('persist last contact error:', e.message); }
}
const watchSeen = (() => {
  try { return JSON.parse(readFileSync(WATCH_SEEN_FILE, 'utf8')); } catch { return {}; }
})();
function persistWatchSeen() {
  try {
    mkdirSync(path.dirname(WATCH_SEEN_FILE), { recursive: true });
    writeFileSync(WATCH_SEEN_FILE, JSON.stringify(watchSeen));
  } catch (e) { log('persist watch seen error:', e.message); }
}

async function scanWatchDir() {
  let entries;
  try { entries = readdirSync(cfg.watchDir, { withFileTypes: true }).filter(e => e.isFile()); }
  catch { return; }
  for (const f of entries) {
    const full = path.join(cfg.watchDir, f.name);
    try {
      const st = statSync(full);
      const prev = watchSeen[f.name];
      if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) {
        const isNew = !prev;
        watchSeen[f.name] = { size: st.size, mtimeMs: st.mtimeMs };
        persistWatchSeen();
        if (isNew) {
          log('workbuddy file:', full);
          const key = notifyOpenid || 'workbuddy';
          recentFiles[key] = [...(recentFiles[key] || []).slice(-8), full];
          persistRecentFiles();
          if (lastContact) {
            await sendC2CText(lastContact.bot, lastContact.openid, `收到来自 workbuddy 的新文件：${f.name}（${st.size} 字节）`, null, 1)
              .catch(e => log('watch notify error:', e.message));
          }
        }
      }
    } catch {}
  }
}

function startWatchDir() {
  try { mkdirSync(cfg.watchDir, { recursive: true }); } catch {}
  log('watching workbuddy dir:', cfg.watchDir);
  scanWatchDir().catch(() => {});
  setInterval(() => scanWatchDir().catch(e => log('watch scan error:', e.message)), 10000);
}

// ---------- Panel（本地聊天面板） ----------
const chatLogs = new Map();   // bot.id -> [{ts, role, text}]
const sseClients = new Set(); // SSE 响应对象
const MAX_LOG = 500;

function fmtLogTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 从桥接日志回填历史消息（旧版本只记了用户消息，回复内容当时未落盘，无法恢复）
function backfillHistoryFromLog(bot) {
  try {
    const lines = readFileSync(LOG_FILE, 'utf8').split(/\r?\n/);
    const re = /^\[([^\]]+)\] (?:\[([a-z0-9_]+)\] )?msg from ([0-9A-F]+)(?: \(([a-z0-9]+)\))?\s*: (.*)$/;
    const hits = [];
    for (const line of lines) {
      const m = line.match(re);
      if (!m) continue;
      const botId = m[2] || 'main'; // 早期日志无机器人标识，归属当时唯一的 main
      if (botId !== bot.id) continue;
      let text = m[5].replace(/\s*\|\s*attachments: \d+$/, '').trim();
      if (m[4] === 'group') text = `[群] ${text}`;
      if (!text) text = '[附件]';
      hits.push(`[${fmtLogTime(m[1])}] 用户: ${text}`);
    }
    if (!hits.length) return;
    let existing = [];
    try { existing = readFileSync(bot.transcriptFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
    const seen = new Set(existing);
    const toAdd = hits.filter(h => !seen.has(h));
    if (toAdd.length) {
      const out = existing.concat(toAdd).sort();
      writeFileSync(bot.transcriptFile, out.join('\n') + '\n');
      log(`[${bot.id}] backfilled ${toAdd.length} historical messages`);
    }
  } catch (e) { log('backfill error:', e.message); }
}

// 从旧的桥接会话文件回补大模型回复（旧日志没存回复内容，但 Codex 会话文件里有）
function walkBridgeSessions(codexHome) {
  const out = [];
  const root = path.join(codexHome, 'sessions');
  const walk = dir => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

function isBridgeSession(file) {
  try {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0];
    const meta = JSON.parse(first).payload || {};
    if (meta.source !== 'exec' || !meta.cwd) return false;
    const norm = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const cwd = norm(meta.cwd);
    const wd = norm(cfg.workDir);
    const cr = norm(chatRoot);
    return cwd === wd || (!!cr && (cwd === cr || cwd.startsWith(cr + '/')));
  } catch { return false; }
}

function extractTurns(file) {
  const turns = [];
  let cur = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const ev = JSON.parse(line);
      const p = ev.payload;
      if (ev.type === 'response_item' && p && p.type === 'message' && (p.role === 'user' || p.role === 'assistant') && Array.isArray(p.content)) {
        const text = p.content.map(c => c.text || '').join(' ').trim();
        if (!text) continue;
        if (p.role === 'user') {
          if (cur) turns.push(cur);
          cur = { user: { text, ts: ev.timestamp || '' }, reply: '', replyTs: '' };
        } else if (p.role === 'assistant' && cur) {
          cur.reply = (cur.reply ? cur.reply + '\n' : '') + text;
          cur.replyTs = ev.timestamp || cur.replyTs;
        }
      }
    } catch {}
  }
  if (cur) turns.push(cur);
  return turns.filter(t => t.reply);
}

function parseLogMessages(botId) {
  const out = [];
  const re = /^\[([^\]]+)\] (?:\[([a-z0-9_]+)\] )?msg from ([0-9A-F]+)(?: \(([a-z0-9]+)\))?\s*: (.*)$/;
  for (const line of readFileSync(LOG_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const id = m[2] || 'main';
    if (id !== botId) continue;
    let text = m[5].replace(/\s*\|\s*attachments: \d+$/, '').trim();
    if (!text) text = '[附件]';
    out.push({ ts: m[1], text });
  }
  return out;
}

function backfillRepliesFromSessions(bot) {
  try {
    const logMsgs = parseLogMessages(bot.id);
    if (!logMsgs.length) return;
    let existing = [];
    try { existing = readFileSync(bot.transcriptFile, 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
    const seen = new Set(existing);
    const toAdd = [];
    for (const f of walkBridgeSessions(cfg.codexHome)) {
      if (!isBridgeSession(f)) continue;
      for (const turn of extractTurns(f)) {
        const q = turn.user.text.split(/\r?\n/)[0]
          .split('（用户此前')[0]
          .split('（说明：')[0]
          .trim();
        if (!q) continue;
        const hit = logMsgs.find(lm => {
          const a = q.slice(0, 120);
          const b = lm.text.slice(0, 120);
          return (a === b || a.startsWith(b) || b.startsWith(a))
            && Math.abs(Date.parse(turn.user.ts) - Date.parse(lm.ts)) < 10 * 60 * 1000;
        });
        if (!hit) continue;
        const ts = fmtLogTime(turn.replyTs || turn.user.ts);
        const line = `[${ts}] Codex: ${turn.reply.replace(/\s+/g, ' ').trim().slice(0, 2000)}`;
        if (!seen.has(line) && !toAdd.includes(line)) toAdd.push(line);
      }
    }
    if (toAdd.length) {
      const out = existing.concat(toAdd).sort();
      writeFileSync(bot.transcriptFile, out.join('\n') + '\n');
      log(`[${bot.id}] backfilled ${toAdd.length} LLM replies from sessions`);
    }
  } catch (e) { log('reply backfill error:', e.message); }
}

function loadTranscriptHistory(bot) {
  try {
    const text = readFileSync(bot.transcriptFile, 'utf8');
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/^\[(.*?)\] (用户|Codex): (.*)$/);
      if (m) entries.push({ ts: m[1], role: m[2] === '用户' ? 'user' : 'codex', text: m[3] });
    }
    chatLogs.set(bot.id, entries.slice(-MAX_LOG));
  } catch { chatLogs.set(bot.id, []); }
}

function pushChat(bot, entry) {
  const arr = chatLogs.get(bot.id) || [];
  arr.push({ ts: new Date().toLocaleString('zh-CN', { hour12: false }), role: entry.role, text: entry.text });
  chatLogs.set(bot.id, arr.slice(-MAX_LOG));
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}

function botStatus(bot) {
  if (!bot.online) return '离线';
  return running.get(`qq:${bot.id}`) ? '处理中' : '在线';
}

function broadcastStatus(bot) {
  broadcast({ type: 'status', bot: bot.id, name: bot.name, status: botStatus(bot) });
}

function buildPrompt(bot, content) {
  const known = recentFiles[`qq:${bot.id}`] || [];
  let prompt = content;
  if (known.length) {
    prompt += `\n\n（用户此前通过 QQ 发来的文件已归档在收件箱：\n${known.join('\n')}\n若用户要求分析/处理其中某个文件，请读取对应文件；否则无需理会）`;
  }
  return prompt;
}

async function processBotText(bot, prompt, displayText, { chan = null, msgId = null, msgSeq = 1, notifyQQ = false, userKey = `qq:${bot.id}` } = {}) {
  pushChat(bot, { role: 'user', text: displayText });
  appendTranscript(bot, '用户', displayText);
  broadcast({ type: 'chat', bot: bot.id, entry: chatLogs.get(bot.id).slice(-1)[0] });
  if (running.get(userKey)) {
    if (notifyQQ && chan) await chan.send('上一条还在处理，请稍候。', msgId, msgSeq + 1);
    return { ok: false, reason: 'busy' };
  }
  running.set(userKey, true);
  broadcastStatus(bot);
  try {
    const reply = await runCodex(prompt, userKey, cfg.workDir);
    log(`[${bot.id}] codex done, reply length:`, reply.length);
    const chunks = chunkText(reply, 1500).slice(0, 3);
    if (notifyQQ && chan) {
      let seq = msgSeq + 1;
      for (const c of chunks) { if (!(await chan.send(c, msgId, seq++))) break; }
      if (chunks.length > 3) await chan.send('（内容过长，已截断）', msgId, seq);
    }
    pushChat(bot, { role: 'codex', text: reply });
    appendTranscript(bot, 'Codex', reply);
    broadcast({ type: 'chat', bot: bot.id, entry: chatLogs.get(bot.id).slice(-1)[0] });
    return { ok: true, reply };
  } catch (e) {
    log(`[${bot.id}] codex error:`, e.message);
    const errText = '处理出错：' + String(e.message).slice(0, 200);
    if (notifyQQ && chan) await chan.send(errText, msgId, msgSeq + 1);
    pushChat(bot, { role: 'codex', text: errText });
    broadcast({ type: 'chat', bot: bot.id, entry: chatLogs.get(bot.id).slice(-1)[0] });
    return { ok: false, error: String(e.message) };
  } finally {
    running.delete(userKey);
    broadcastStatus(bot);
  }
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>我是机器人 v1.0.5</title>
<style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:0;background:#f5f6f8;color:#222}
header{display:flex;align-items:center;gap:12px;padding:10px 14px;background:#fff;border-bottom:1px solid #e3e5e8}
header h1{font-size:15px;margin:0}
#bots{display:flex;gap:6px;flex-wrap:wrap}
.tab{padding:6px 12px;border:1px solid #d4d7dc;border-radius:14px;cursor:pointer;font-size:13px;background:#fff}
.tab.active{background:#1f6feb;color:#fff;border-color:#1f6feb}
.badge{font-size:11px;padding:1px 7px;border-radius:9px;background:#e8eaee;margin-left:6px}
.badge.online{background:#d1f0d8;color:#177a34}
.badge.busy{background:#fff3cd;color:#8a6d1a}
.badge.off{background:#fde2e2;color:#b02a2a}
main{display:flex;flex-direction:column;height:calc(100vh - 116px)}
#msgs{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.msg{max-width:80%;padding:8px 11px;border-radius:10px;font-size:13px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:#1f6feb;color:#fff}
.msg.codex{align-self:flex-start;background:#fff;border:1px solid #e3e5e8}
.msg .t{font-size:11px;opacity:.65;display:block;margin-bottom:3px}
#composer{display:flex;gap:8px;padding:10px 14px;background:#fff;border-top:1px solid #e3e5e8}
#input{flex:1;padding:8px 10px;border:1px solid #d4d7dc;border-radius:8px;font-size:13px;resize:none;font-family:inherit}
button{padding:8px 14px;border:none;border-radius:8px;background:#1f6feb;color:#fff;cursor:pointer;font-size:13px}
button.ghost{background:#fff;color:#1f6feb;border:1px solid #1f6feb}
#empty{color:#999;text-align:center;margin-top:30px}
</style>
</head>
<body>
<header>
<h1>我是机器人 v1.0.5</h1>
  <div id="bots"></div>
  <button class="ghost" id="icloud" title="在资源管理器中打开 iCloud Codex 文件夹">打开 iCloud 文件夹</button>
</header>
<main>
  <div id="msgs"><div id="empty">加载中…</div></div>
  <div id="composer">
    <textarea id="input" rows="2" placeholder="以当前机器人身份发送消息给大模型（仅显示在本面板，不会推送手机 QQ）"></textarea>
    <button id="send">发送</button>
  </div>
</main>
<script>
const state = { bots: [], current: null, es: null };
const $ = s => document.querySelector(s);
async function loadBots(){
  const r = await fetch('/api/bots'); state.bots = await r.json();
  $('#bots').innerHTML = '';
  state.bots.forEach(b => {
    const el = document.createElement('div');
    el.className = 'tab'; el.dataset.id = b.id;
    const cls = b.status === '在线' ? 'online' : b.status === '处理中' ? 'busy' : 'off';
    el.innerHTML = b.name + '<span class="badge ' + cls + '">' + b.status + '</span>';
    el.onclick = () => selectBot(b.id);
    $('#bots').appendChild(el);
  });
  if (!state.current && state.bots.length) selectBot(state.bots[0].id);
}
async function selectBot(id){
  state.current = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  const r = await fetch('/api/chat?bot=' + encodeURIComponent(id));
  render(await r.json());
}
function render(list){
  const box = $('#msgs'); box.innerHTML = '';
  if (!list.length){ box.innerHTML = '<div id="empty">暂无聊天记录</div>'; return; }
  list.forEach(m => appendMsg(m));
  box.scrollTop = box.scrollHeight;
}
function appendMsg(m){
  const d = document.createElement('div');
  d.className = 'msg ' + m.role;
  d.innerHTML = '<span class="t">' + m.ts + ' ' + (m.role === 'user' ? '用户' : 'Codex') + '</span>' + esc(m.text);
  $('#msgs').appendChild(d);
  const empty = $('#empty'); if (empty) empty.remove();
  $('#msgs').scrollTop = $('#msgs').scrollHeight;
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function connectSSE(){
  state.es = new EventSource('/events');
  state.es.onmessage = e => {
    try {
      const p = JSON.parse(e.data);
      if (p.type === 'status'){
        const tab = document.querySelector('.tab[data-id="' + p.bot + '"]');
        if (tab){
          const b = tab.querySelector('.badge');
          b.className = 'badge ' + (p.status === '在线' ? 'online' : p.status === '处理中' ? 'busy' : 'off');
          b.textContent = p.status;
        }
      } else if (p.type === 'chat' && p.bot === state.current){
        appendMsg(p.entry);
      }
    } catch(err){}
  };
  state.es.onerror = () => { setTimeout(() => { try { state.es.close(); } catch(err){} connectSSE(); }, 3000); };
}
$('#send').onclick = async () => {
  const msg = $('#input').value.trim();
  if (!msg || !state.current) return;
  $('#input').value = '';
  await fetch('/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ bot: state.current, message: msg, pushQQ: true }) });
};
$('#input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); $('#send').click(); } });
$('#icloud').onclick = () => fetch('/api/open-icloud', { method:'POST' });
loadBots(); connectSSE();
</script>
</body>
</html>`;

function panelOriginOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch { return false; }
}

function startPanelServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${cfg.panelPort}`);
    const p = url.pathname;
    try {
      if (p !== '/' && !panelOriginOk(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      if (req.method === 'GET' && p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        let html = PANEL_HTML;
        try { html = readFileSync(path.join(BRIDGE_DIR, 'panel.html'), 'utf8'); } catch {}
        res.end(html);
      } else if (req.method === 'GET' && p === '/api/bots') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cfg.bots.map(b => ({ id: b.id, name: b.name, status: botStatus(b) }))));
      } else if (req.method === 'GET' && p === '/api/chat') {
        const bot = cfg.bots.find(b => b.id === url.searchParams.get('bot'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(bot ? (chatLogs.get(bot.id) || []) : []));
      } else if (req.method === 'POST' && p === '/api/send') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
          let data = {};
          try { data = JSON.parse(body); } catch {}
          const bot = cfg.bots.find(b => b.id === data.bot);
          const msg = String(data.message || '').trim();
          if (!bot || !msg) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '缺少 bot 或 message' }));
            return;
          }
          const pushQQ = !!data.pushQQ;
          const targetOpenid = botLastContact.get(bot.id) || '';
          let chan = null;
          if (pushQQ && targetOpenid) {
            chan = {
              kind: 'c2c',
              target: targetOpenid,
              sender: targetOpenid,
              send: (content, msgId, msgSeq) => sendC2CText(bot, targetOpenid, content, msgId, msgSeq),
            };
          }
          const result = await processBotText(bot, buildPrompt(bot, msg), msg, { chan, notifyQQ: pushQQ && !!chan });
          if (pushQQ && !chan) result.pushNote = '该机器人还没有最近的QQ会话，本次未推送到QQ';
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result));
        });
      } else if (req.method === 'POST' && p === '/api/open-icloud') {
        try {
          mkdirSync(cfg.icloudDir, { recursive: true });
          execFile('explorer.exe', [cfg.icloudDir]);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      } else if (req.method === 'GET' && p === '/api/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, icloudDir: cfg.icloudDir }));
      } else if (req.method === 'POST' && p === '/api/settings') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let data = {};
          try { data = JSON.parse(body); } catch {}
          const dir = String(data.icloudDir || '').trim().replace(/[\\/]+$/, '');
          const valid = /^[a-zA-Z]:[\\/]/.test(dir) || /^\\/.test(dir);
          if (!valid) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '路径无效，请输入本地绝对路径，如 F:\\iCloud\\iCloudDrive\\Codex' }));
            return;
          }
          try {
            mkdirSync(dir, { recursive: true });
            cfg.icloudDir = dir;
            setEnvValue(ENV_FILE, 'ICLOUD_DIR', dir);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: true, icloudDir: dir }));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else if (req.method === 'GET' && p === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
      } else {
        res.writeHead(404); res.end();
      }
    } catch (e) {
      try { res.writeHead(500); res.end(); } catch {}
    }
  });
  server.listen(cfg.panelPort, '127.0.0.1', () => log('panel server: http://127.0.0.1:' + cfg.panelPort));
}

// ---------- C2C handling ----------
function appendTranscript(bot, role, text) {
  try {
    const ts = fmtLogTime(new Date().toISOString());
    const line = `[${ts}] ${role}: ${String(text).replace(/\n/g, ' ').slice(0, 2000)}`;
    appendFileSync(bot.transcriptFile, line + '\n');
  } catch (e) { log('transcript error:', e.message); }
}

function makeChannel(bot, d) {
  const author = d.author || {};
  if (d.group_openid) {
    const sender = author.user_openid || author.member_openid || '';
    const allow = !!cfg.allowedOpenids.length
      && !!sender
      && cfg.allowedOpenids.includes(sender);
    return {
      kind: 'group',
      target: d.group_openid,
      sender,
      allow,
      send: (content, msgId, msgSeq) => sendGroupText(bot, d.group_openid, content, msgId, msgSeq),
    };
  }
  const sender = author.user_openid || '';
  return {
    kind: 'c2c',
    target: sender,
    sender,
    allow: !!cfg.allowedOpenids.length && !!sender && cfg.allowedOpenids.includes(sender),
    send: (content, msgId, msgSeq) => sendC2CText(bot, sender, content, msgId, msgSeq),
  };
}

async function onChatMessage(bot, d) {
  const msgId = d.id;
  const chan = makeChannel(bot, d);
  const openid = chan.sender;
  const content = (d.content || '').trim();
  const msgSeq = d.msg_seq || 1;

  if (!chan.target || !openid) return;
  if (!chan.allow) {
    const safeMode = !cfg.allowedOpenids.length;
    log(`[${bot.id}] ignored unauthorized sender:`, openid, 'in', chan.kind, safeMode ? '(safe mode: whitelist empty)' : '');
    if (safeMode && chan.kind === 'c2c' && !onboardingSent.has(openid)) {
      onboardingSent.add(openid);
      await chan.send(
        '当前为安全模式：白名单未配置，我不会执行任何任务。\n' +
        '请把 logs/bridge.log 中的 openid（' + openid + '）加入 .env 的 ALLOWED_OPENIDS，然后重启。',
        msgId, msgSeq
      ).catch(() => {});
    }
    return;
  }
  if (chan.kind === 'c2c') {
    lastContact = { bot, openid };
    botLastContact.set(bot.id, openid);
    persistLastContact();
  }
  const ownerMatch = cfg.allowedOpenids.includes(authorUserOpenid(d));
  const userKey = ownerMatch ? `qq:${bot.id}` : `${chan.kind}:${openid}`; // 白名单用户按机器人分开上下文
  if (recentMsg.has(msgId)) return;
  recentMsg.set(msgId, Date.now());
  if (recentMsg.size > 500) {
    const now = Date.now();
    for (const [k, v] of recentMsg) if (now - v > 300000) recentMsg.delete(k);
  }

  const attachments = Array.isArray(d.attachments) ? d.attachments : [];
  const saved = [];
  for (const att of attachments) {
    if (!att || !att.url || !att.filename) continue;
    try {
      saved.push(await downloadAttachment(bot, att));
    } catch (e) {
      log(`[${bot.id}] attachment download error:`, e.message);
    }
  }

  // 先存后议：有附件时只归档，不调 Codex，等用户下一步文字指令
  if (saved.length) {
    log(`[${bot.id}] msg from`, openid, `(${chan.kind}): [附件]`, saved.map(s => s.name).join('、'));
    const summary = saved.map(s => s.name).join('、');
    await chan.send(`已收到并归档：${summary}\n存放位置：收件箱\\${bot.name}\\${localDateStr()}\n等你下一步指示。`, msgId, msgSeq);
    recentFiles[userKey] = [...(recentFiles[userKey] || []).slice(-8), ...saved.map(s => s.path)];
    persistRecentFiles();
    appendTranscript(bot, '用户', `[附件] ${summary}`);
    pushChat(bot, { role: 'user', text: `[附件] ${summary}` });
    broadcast({ type: 'chat', bot: bot.id, entry: chatLogs.get(bot.id).slice(-1)[0] });
    return;
  }

  let prompt = content;
  const known = recentFiles[userKey] || [];
  if (known.length) {
    prompt += `\n\n（用户此前通过 QQ 发来的文件已归档在收件箱：\n${known.join('\n')}\n若用户要求分析/处理其中某个文件，请读取对应文件；否则无需理会）`;
  }
  if (!prompt) return;

  log(`[${bot.id}] msg from`, openid, `(${chan.kind}):`, content.slice(0, 120));
  await processBotText(bot, prompt, content, { chan, msgId, msgSeq, notifyQQ: true, userKey });
}

function authorUserOpenid(d) {
  return (d.author && d.author.user_openid) || '';
}

// ---------- WebSocket gateway ----------
async function connectGateway(bot) {
  const gw = await apiGet(bot, '/gateway/bot');
  bot.ws = new WebSocket(gw.url);
  bot.ws.onopen = () => { log(`[${bot.id}] ws open:`, gw.url); bot.reconnectDelay = 3000; };
  bot.ws.onmessage = ev => {
    try {
      handleWsMessage(bot, JSON.parse(ev.data));
    } catch (e) {
      log(`[${bot.id}] ws parse error:`, e.message);
    }
  };
  bot.ws.onclose = ev => {
    log(`[${bot.id}] ws closed:`, ev.code, ev.reason || '');
    bot.online = false;
    broadcastStatus(bot);
    clearInterval(bot.heartbeatTimer);
    setTimeout(() => connectGateway(bot).catch(e => {
      log(`[${bot.id}] reconnect failed:`, e.message);
    }), bot.reconnectDelay);
  };
  bot.ws.onerror = () => {};
}

async function handleWsMessage(bot, msg) {
  switch (msg.op) {
    case 10: {
      const interval = (msg.d && msg.d.heartbeat_interval) || 45000;
      clearInterval(bot.heartbeatTimer);
      bot.heartbeatTimer = setInterval(() => {
        if (bot.ws && bot.ws.readyState === 1) bot.ws.send(JSON.stringify({ op: 1, d: bot.lastSeq }));
      }, interval);
      const token = await getAccessToken(bot);
      bot.ws.send(JSON.stringify({
        op: 2,
        d: {
          token: `QQBot ${token}`,
          intents: 1 << 25,
          shard: [0, 1],
          properties: { $os: 'windows', $browser: 'codex-qq-bridge', $device: 'codex-qq-bridge' },
        },
      }));
      break;
    }
    case 11:
      break;
    case 0:
      if (msg.s) bot.lastSeq = msg.s;
      if (msg.t === 'READY') {
        bot.sessionId = msg.d && msg.d.session_id;
        log(`[${bot.id}] READY, session:`, bot.sessionId);
        bot.online = true;
        broadcastStatus(bot);
      } else if (msg.t === 'C2C_MESSAGE_CREATE' || msg.t === 'GROUP_AT_MESSAGE_CREATE') {
        log(`[${bot.id}] event:`, msg.t);
        onChatMessage(bot, msg.d).catch(e => log(`[${bot.id}] chat handler error:`, e.message));
      } else {
        log(`[${bot.id}] event (ignored):`, msg.t);
      }
      break;
    default:
      break;
  }
}

// ---------- self test ----------
async function selfTest() {
  for (const bot of cfg.bots) {
    log(`[${bot.id}] self-test start`);
    const token = await getAccessToken(bot);
    log(`[${bot.id}] token ok`);
    const gw = await apiGet(bot, '/gateway/bot');
    log(`[${bot.id}] gateway:`, gw.url);
    await new Promise((resolve, reject) => {
      bot.ws = new WebSocket(gw.url);
      const timer = setTimeout(() => { reject(new Error('self-test timeout')); }, 15000);
      bot.ws.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.op === 10) {
            bot.ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] } }));
          } else if (msg.op === 0 && msg.t === 'READY') {
            clearTimeout(timer);
            log(`[${bot.id}] self-test READY ok, session:`, msg.d.session_id);
            bot.ws.close();
            resolve();
          }
        } catch (e) {}
      };
      bot.ws.onerror = () => reject(new Error('ws error'));
      bot.ws.onclose = ev => {
        if (ev.code !== 1000) reject(new Error('ws closed: ' + ev.code));
      };
    });
  }
  log('self-test done');
  process.exit(0);
}

// ---------- main ----------
async function main() {
  if (cfg.selfTest) return selfTest();
  log('bridge starting, bots:', cfg.bots.map(b => b.id).join(', '), '| workDir:', cfg.workDir);
  if (!cfg.allowedOpenids.length) {
    log('SECURITY: ALLOWED_OPENIDS is empty -> safe mode. No Codex task runs until the whitelist is configured.');
  } else {
    log('whitelist entries:', cfg.allowedOpenids.length);
  }
  for (const bot of cfg.bots) {
    connectGateway(bot).catch(e => log(`[${bot.id}] connect failed:`, e.message));
  }
  for (const bot of cfg.bots) backfillHistoryFromLog(bot);
  for (const bot of cfg.bots) backfillRepliesFromSessions(bot);
  for (const bot of cfg.bots) loadTranscriptHistory(bot);
  startWatchDir();
  startPanelServer();
}

main().catch(e => {
  log('fatal:', e.message);
  process.exit(1);
});

process.on('uncaughtException', e => log('uncaught:', e.message));
process.on('unhandledRejection', e => log('unhandled:', e && e.message));
