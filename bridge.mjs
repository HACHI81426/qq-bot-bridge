import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = __dirname;
const USER_HOME = process.env.USERPROFILE || process.env.HOME || BRIDGE_DIR;
const DEFAULT_CHAT_ROOT = path.join(USER_HOME, 'qq-bot-chat');
const DEFAULT_ICLOUD_DIR = path.join(USER_HOME, 'iCloudDrive', 'Codex');
const DEFAULT_CODEX_HOME = path.join(USER_HOME, '.codex');
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
const chatRoot = env.CHAT_LOG_ROOT || DEFAULT_CHAT_ROOT;

let bots = [];
try {
  const arr = JSON.parse(env.QQBOTS_JSON || '[]');
  bots = arr.filter(b => b && b.appId && b.clientSecret)
    .map(b => ({ id: b.accountId || b.appId, name: b.name || b.accountId || b.appId, appId: b.appId, clientSecret: b.clientSecret, projectDir: b.workDir || null, adminOpenid: b.adminOpenid || '' }));
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
  codexOpenids: (env.CODEX_OPENIDS || '').split(',').map(s => s.trim()).filter(Boolean),
  codexCli: env.CODEX_CLI_PATH || 'codex',
  codexHome: env.CODEX_HOME || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : ''),
  workDir: env.WORK_DIR || path.join(BRIDGE_DIR, 'workspace'),
  inboxDir: env.INBOX_DIR || path.join(BRIDGE_DIR, 'inbox'),
  watchDir: env.WATCH_DIR || path.join(BRIDGE_DIR, 'watch'),
  codexTimeoutMs: Number(env.CODEX_TIMEOUT_MS || 300000),
  // 流式消息（/v2/users/{openid}/stream_messages）：2026-09-25 实测**被动回复（带真实 msg_id）可用**，
  // 不带 msg_id 的主动流式仍然一律 500 `50015001 系统繁忙`；群聊不支持流式参数。
  // 默认关闭，把 .env 的 QQ_STREAM 设为 1 开启（代码路径已备好，失败会自动退回普通消息）。
  // 用户 2026-09-25 决定保持关闭：现有实现只能"占位气泡 + 跑完追加整段"，不是打字机，且占位文字擦不掉。
  qqStream: env.QQ_STREAM === '1',
  // 长任务存活提示：typing（默认，单聊用"正在输入"状态）| text（沿用旧版每 2 分钟一条"处理中…"）
  pingStyle: (env.QQ_PING || 'typing').trim(),
  chatRoot,
  panelPort: Number(env.PANEL_PORT || 17890),
  icloudDir: env.ICLOUD_DIR || DEFAULT_ICLOUD_DIR,
  selfTest: process.argv.includes('--self-test'),
  bots,
};

const SETTINGS_FILE = path.join(BRIDGE_DIR, 'data', 'settings.json');
const savedSettings = (() => {
  try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
})();
cfg.broadcastNotify = {};
const savedBcast = savedSettings.broadcastNotify;
if (typeof savedBcast === 'object' && savedBcast !== null) {
  for (const b of bots) cfg.broadcastNotify[b.id] = savedBcast[b.id] === true;
} else {
  for (const b of bots) cfg.broadcastNotify[b.id] = savedBcast === true;
}
function persistSettings() {
  try {
    mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify({ broadcastNotify: cfg.broadcastNotify }));
  } catch (e) { log('persist settings error:', e.message); }
}

for (const b of bots) if (!b.projectDir) b.projectDir = cfg.workDir;

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

// 定位 codex CLI：优先显式配置的路径，其次扫描 OpenAI Codex bin 目录下最新的 codex.exe（客户端更新会换哈希目录），最后回退 PATH
function resolveCodexCli(configured) {
  if (configured && configured !== 'codex' && existsSync(configured)) return configured;
  const binRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (binRoot && existsSync(binRoot)) {
    let best = null;
    let bestTime = 0;
    for (const name of readdirSync(binRoot)) {
      const cand = path.join(binRoot, name, 'codex.exe');
      try {
        if (existsSync(cand) && statSync(cand).isFile()) {
          const t = statSync(cand).mtimeMs;
          if (t > bestTime) { bestTime = t; best = cand; }
        }
      } catch {}
    }
    if (best) return best;
  }
  return configured || 'codex';
}
let codexCliResolved = resolveCodexCli(cfg.codexCli);
if (codexCliResolved !== cfg.codexCli) log('codex CLI 路径自动解析为:', codexCliResolved);

// 每次任务前校验缓存路径是否还在：Codex 桌面端更新会换哈希目录并删掉旧目录，
// 常驻桥接若一直用启动时缓存的路径，所有任务都会 spawn ENOENT（2026-09-11 踩坑）。
function currentCodexCli() {
  if (codexCliResolved && codexCliResolved !== 'codex' && existsSync(codexCliResolved)) return codexCliResolved;
  const next = resolveCodexCli(cfg.codexCli);
  if (next !== codexCliResolved) {
    log('codex CLI 路径已失效，重新解析为:', next, '（原:', codexCliResolved + '）');
    codexCliResolved = next;
  }
  return codexCliResolved;
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
  // 2026-08-10 起官方把所有接口域名统一到 api.bot.qq.com（旧 api.sgroup.qq.com 仍可用但不保证）
  const r = await apiRequest(bot, 'GET', pathname);
  if (!r.ok) throw new Error(`[${bot.id}] GET ${pathname} -> ${r.status} ${r.text.slice(0, 200)}`);
  return r.data;
}

const API_BASE = 'https://api.bot.qq.com';

// 统一请求：失败时把 err_code + trace_id 打进日志（官方明确不要按 message 判断成败，且 err_code 才是排查依据）
async function apiRequest(bot, method, pathname, body) {
  const t = await getAccessToken(bot);
  const res = await fetch(API_BASE + pathname, {
    method,
    headers: { Authorization: `QQBot ${t}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const code = data.err_code || data.code || res.status;
    const trace = res.headers.get('x-tps-trace-id') || data.trace_id || '-';
    log(`[${bot.id}] ${method} ${pathname} -> ${res.status} err_code=${code} msg=${String(data.message || text).slice(0, 120)} trace=${trace}`);
  }
  return { ok: res.ok, status: res.status, data, text };
}

// 发消息：默认纯文本；opts.markdown=true 或 opts.keyboard 存在时走 msg_type=2
// （官方 2026-04-23 起单聊/群聊 Markdown 全量开放；内嵌键盘挂在 Markdown 消息上）。
// Markdown/按钮被拒时自动降级为纯文本重发：用同一个 msg_seq 是安全的，因为发送失败说明没落库，
// 不会撞上"相同 msg_id + msg_seq 重复发送会失败"的去重规则。
async function sendMessage(bot, pathname, content, msgId, msgSeq, opts = {}) {
  const base = { msg_seq: msgSeq || 1 };
  if (msgId) base.msg_id = msgId;
  const text = String(content == null ? '' : content);
  if (opts.markdown || opts.keyboard) {
    const body = { ...base, msg_type: 2, markdown: { content: text } };
    if (opts.keyboard) body.keyboard = opts.keyboard;
    const r = await apiRequest(bot, 'POST', pathname, body);
    if (r.ok) return true;
    log(`[${bot.id}] ${opts.keyboard ? 'markdown+keyboard' : 'markdown'} 发送被拒，降级为纯文本重发`);
  }
  const r2 = await apiRequest(bot, 'POST', pathname, { ...base, msg_type: 0, content: text });
  return r2.ok;
}

function sendC2CText(bot, openid, content, msgId, msgSeq, opts) {
  return sendMessage(bot, `/v2/users/${openid}/messages`, content, msgId, msgSeq, opts);
}

function sendGroupText(bot, groupOpenid, content, msgId, msgSeq, opts) {
  return sendMessage(bot, `/v2/groups/${groupOpenid}/messages`, content, msgId, msgSeq, opts);
}

// 输入中状态（msg_type=6）：聊天里显示"正在输入"，替代过去每 2 分钟一条"处理中…"文本。
// 文本提示会占被动回复额度（单聊每条用户消息 4 次），长任务里正是它把最终回复挤掉；输入状态不计入聊天记录。
async function sendTypingC2C(bot, openid, msgId, msgSeq, seconds = 60) {
  const body = {
    msg_type: 6,
    msg_seq: msgSeq || 1,
    input_notify: { input_type: 1, input_second: Math.min(Math.max(Number(seconds) || 60, 1), 60) },
  };
  if (msgId) body.msg_id = msgId;
  const r = await apiRequest(bot, 'POST', `/v2/users/${openid}/messages`, body);
  return r.ok;
}

// 流式消息：首片不传 stream_msg_id、由服务端返回；后续片带上，index 递增。
async function streamOpen(bot, openid, text, msgId, msgSeq) {
  const r = await apiRequest(bot, 'POST', `/v2/users/${openid}/stream_messages`, {
    input_mode: 'append',
    input_state: 1,
    index: 0,
    content_type: 'markdown',
    content_raw: String(text || ''),
    msg_id: msgId,
    msg_seq: msgSeq || 1,
  });
  return r.ok && r.data && r.data.id ? r.data.id : null;
}

async function streamChunk(bot, openid, streamId, index, text, final, msgId, msgSeq) {
  const r = await apiRequest(bot, 'POST', `/v2/users/${openid}/stream_messages`, {
    input_mode: 'append',
    input_state: final ? 10 : 1,
    index,
    content_type: 'markdown',
    content_raw: String(text || ''),
    stream_msg_id: streamId,
    msg_id: msgId,
    msg_seq: msgSeq || 1,
  });
  return r.ok;
}

// ---------- 富媒体上传（把本地文件发回 QQ） ----------
// 本地文件没有公网 URL，走官方推荐的"分片上传"：upload_prepare → 逐片 PUT 预签名 URL →
// upload_part_finish → 带 upload_id 调 files 合并，拿 file_info，再用 msg_type=7 发出去。
// file_info 有 ttl（0 表示长期可用），所以按 机器人+会话+路径+大小+mtime 缓存，避免重复上传。
const MEDIA_CACHE_FILE = path.join(BRIDGE_DIR, 'data', 'media-cache.json');
const mediaCache = (() => {
  try { return JSON.parse(readFileSync(MEDIA_CACHE_FILE, 'utf8')); } catch { return {}; }
})();
function persistMediaCache() {
  try {
    mkdirSync(path.dirname(MEDIA_CACHE_FILE), { recursive: true });
    // 只留最近 200 条，防止无限膨胀
    const keys = Object.keys(mediaCache);
    if (keys.length > 200) {
      keys.sort((a, b) => (mediaCache[a].at || 0) - (mediaCache[b].at || 0));
      for (const k of keys.slice(0, keys.length - 200)) delete mediaCache[k];
    }
    writeFileSync(MEDIA_CACHE_FILE, JSON.stringify(mediaCache));
  } catch (e) { log('persist media cache error:', e.message); }
}

// 官方上传接口口径：图片只认 png/jpg（jpeg 兼容处理），其余一律走 file_type=4 文件卡片，
// 这样 gif/webp/zip/docx/pdf 都不会因为"不支持的文件格式"被拒。
function mediaFileType(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') return 1;
  if (ext === '.mp4') return 2;
  if (ext === '.silk') return 3;
  return 4;
}

function mediaBasePath(chan) {
  return chan.kind === 'group' ? `/v2/groups/${chan.target}` : `/v2/users/${chan.target}`;
}

const MEDIA_MAX_BYTES = 64 * 1024 * 1024; // 一次性读进内存上传，超过就拒绝（官方单选文件硬限 200MB）

async function uploadMedia(bot, chan, filePath) {
  let st;
  try {
    st = statSync(filePath);
    if (!st.isFile()) { log(`[${bot.id}] 上传跳过（不是文件）:`, filePath); return null; }
  } catch (e) {
    log(`[${bot.id}] 上传跳过（读不到文件）:`, filePath, e.message);
    return null;
  }
  if (st.size > MEDIA_MAX_BYTES) {
    log(`[${bot.id}] 上传跳过（超过本地 ${Math.round(MEDIA_MAX_BYTES / 1048576)}MB 上限）:`, filePath, st.size);
    return null;
  }
  const cacheKey = [bot.id, chan.kind, chan.target, filePath, st.size, Math.floor(st.mtimeMs)].join('|');
  const hit = mediaCache[cacheKey];
  if (hit && (hit.ttl === 0 || (hit.expiresAt || 0) > Date.now())) return hit.file_info;

  const base = mediaBasePath(chan);
  const buf = readFileSync(filePath);
  const fileName = path.basename(filePath);
  const fileType = mediaFileType(filePath);
  const prep = await apiRequest(bot, 'POST', `${base}/upload_prepare`, {
    file_type: fileType,
    file_size: String(st.size),
    file_name: fileName,
    md5: createHash('md5').update(buf).digest('hex'),
    sha1: createHash('sha1').update(buf).digest('hex'),
    md5_10m: createHash('md5').update(buf.subarray(0, 10002432)).digest('hex'),
  });
  if (!prep.ok) return null;

  const uploadId = prep.data.upload_id;
  const parts = Array.isArray(prep.data.parts) ? prep.data.parts : [];
  const defaultBlock = Number(prep.data.block_size || 5242880);
  // 注意：服务端返回的 parts[].index 是从 1 开始的（首片 index=1），不能用 index*block_size 算偏移，
  // 否则第一片就切在文件末尾、上传 0 字节，最终合并报 40034002「富媒体文件格式不支持」。
  // 这里按 index 排序后用"累加偏移"切片，与服务端的编号基准无关。
  let offset = 0;
  for (const part of [...parts].sort((a, b) => Number(a.index) - Number(b.index))) {
    const blockSize = Number(part.block_size || defaultBlock);
    const slice = buf.subarray(offset, offset + blockSize);
    offset += slice.length;
    try {
      const putRes = await fetch(part.presigned_url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: slice,
      });
      if (!putRes.ok) {
        log(`[${bot.id}] 分片 PUT 失败: part=${part.index} bytes=${slice.length} status=${putRes.status}`);
        return null;
      }
    } catch (e) {
      log(`[${bot.id}] 分片 PUT 异常: part=${part.index}`, e.message);
      return null;
    }
    const fin = await apiRequest(bot, 'POST', `${base}/upload_part_finish`, {
      upload_id: uploadId,
      part_index: Number(part.index),
      block_size: String(blockSize),
      md5: createHash('md5').update(slice).digest('hex'),
    });
    if (!fin.ok) return null;
  }

  const merge = await apiRequest(bot, 'POST', `${base}/files`, {
    file_type: fileType,
    srv_send_msg: false,
    file_name: fileName,
    upload_id: uploadId,
  });
  if (!merge.ok) return null;
  const fileInfo = merge.data.file_info;
  if (!fileInfo) {
    log(`[${bot.id}] 上传合并返回缺少 file_info:`, JSON.stringify(merge.data).slice(0, 200));
    return null;
  }
  const ttl = Number(merge.data.ttl || 0);
  mediaCache[cacheKey] = { file_info: fileInfo, ttl, expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0, at: Date.now() };
  persistMediaCache();
  log(`[${bot.id}] 上传成功 ${fileName}（${st.size} 字节, file_type=${fileType}, ttl=${ttl}）`);
  return fileInfo;
}

async function sendMedia(bot, chan, fileInfo, msgId, msgSeq) {
  const body = { msg_type: 7, media: { file_info: fileInfo }, msg_seq: msgSeq || 1 };
  if (msgId) body.msg_id = msgId;
  const p = chan.kind === 'group' ? `/v2/groups/${chan.target}/messages` : `/v2/users/${chan.target}/messages`;
  const r = await apiRequest(bot, 'POST', p, body);
  return r.ok;
}

// 模型在回复里用 <qqfile>绝对路径</qqfile>（或 <qqimg>/<qqmedia>）声明要发给用户的文件，
// 标签行从正文里剔除。
function extractMediaPaths(reply) {
  const paths = [];
  const text = String(reply == null ? '' : reply).replace(
    /<qq(file|img|image|media)>([^<>\n]{1,400})<\/qq\1>/gi,
    (_m, _tag, p) => { paths.push(p.trim()); return ''; }
  );
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), paths };
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

// 语音消息判定：官方给 content_type=voice，并附带 voice_wav_url（SILK 转好的 WAV）与 asr_refer_text（识别文本）
function isVoiceAttachment(att) {
  const ct = String(att.content_type || '').toLowerCase();
  if (ct === 'voice' || att.voice_wav_url) return true;
  return /\.(silk|slk|amr)$/i.test(String(att.filename || ''));
}

// 纯函数：决定"下载哪个地址、存成什么名字"。语音优先用 QQ 转好的 WAV
// （SILK 在 Windows 上放不了、Codex 也读不了），没有 WAV 才存原始 SILK。
function attachmentSource(att) {
  const isVoice = isVoiceAttachment(att);
  const useWav = !!(isVoice && att.voice_wav_url);
  const url = useWav ? att.voice_wav_url : att.url;
  let rawName = String(att.filename || '').trim();
  if (!rawName) rawName = isVoice ? 'voice.silk' : 'attachment';
  if (useWav) rawName = rawName.replace(/\.(silk|slk|amr)$/i, '') + '.wav';
  return {
    isVoice,
    useWav,
    url,
    name: rawName.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120),
  };
}

async function downloadAttachment(bot, att) {
  const { isVoice, useWav, url, name: safeName } = attachmentSource(att);
  const destDir = path.join(cfg.inboxDir, bot.name, localDateStr());
  mkdirSync(destDir, { recursive: true });
  const filePath = path.join(destDir, `${Date.now()}-${safeName}`);
  const token = await getAccessToken(bot);
  let res = await fetch(url, { headers: { Authorization: `QQBot ${token}` } });
  if (!res.ok) throw new Error('下载附件失败 HTTP ' + res.status);
  writeFileSync(filePath, Buffer.from(await res.arrayBuffer()));
  log(`[${bot.id}] saved attachment:`, filePath, '| size:', att.size || '?');
  return { path: filePath, name: safeName, isVoice, wav: !!useWav };
}

// ---------- Codex ----------
const sessions = new Map(); // `${userKey}:${topicId}` -> thread_id
const running = new Map();  // openid -> boolean
const onboardingSent = new Set(); // openid -> 已发送安全模式引导
const activeProcs = new Map(); // openid -> child（当前运行的 Codex 进程）
const cancelled = new Set();   // openid -> 已请求停止
const STOP_RE = /^(停止|停|stop|cancel|取消|中断|终止)$/i;

// ---------- 话题（每个机器人多个聊天） ----------
const TOPICS_FILE = path.join(BRIDGE_DIR, 'data', 'topics.json');
const topicsState = (() => { try { return JSON.parse(readFileSync(TOPICS_FILE, 'utf8')); } catch { return {}; } })();
// 收件箱“处理中批次”落盘在 inboxFlush。桥接若在 Codex 运行期间退出，启动时先把它
// 放回活动队列并重新打开收件箱，避免半途重启把一批碎片永久卡在不可见状态。
let recoveredInFlightInbox = false;
for (const stt of Object.values(topicsState)) {
  const tps = (stt && stt.topics) || {};
  for (const tp of Object.values(tps)) {
    if (!tp || !Array.isArray(tp.inboxFlush) || !tp.inboxFlush.length) continue;
    const active = Array.isArray(tp.inbox) ? tp.inbox : [];
    tp.inbox = [...tp.inboxFlush, ...active].map((it, i) => ({ ...it, n: i + 1 }));
    tp.inboxOpen = true;
    delete tp.inboxFlush;
    recoveredInFlightInbox = true;
  }
}
if (recoveredInFlightInbox) persistTopics();
// 收件箱模式（2026-10-16 加）：桥接启动时先把"已经处在收件箱模式里"的话题记下来，
// 这些话题的下一条消息要附一句"重启过、模式仍在"——否则隔一夜用户早忘了自己还在模式里。
const inboxRestored = new Set(); // `${bot.id}:${topicId}`
for (const [bid, stt] of Object.entries(topicsState)) {
  const tps = (stt && stt.topics) || {};
  for (const [tid, tp] of Object.entries(tps)) {
    if (tp && (tp.inboxOpen || (Array.isArray(tp.inbox) && tp.inbox.length))) inboxRestored.add(`${bid}:${tid}`);
  }
}
const restoredThreadCount = restorePersistedThreads();
if (restoredThreadCount) log(`restored ${restoredThreadCount} persisted topic thread mapping(s)`);
const pendingNaming = new Map(); // bot.id -> topicId（等待用户命名）
const pendingTopic = new Map();  // bot.id -> true（等待用户回复编号选择话题）
const pendingRename = new Map(); // bot.id -> topicId（等待用户回复新名称）
const pendingAsk = new Map();    // bot.id -> 快捷指令 spec（ask:true，等待回复编号追加为末参）
// 快捷指令第二步的回复算不算"正在等的那条"：
//  · 默认只认纯数字（如「个股」回编号）；
//  · 指令额外配了 askAny:true 时，再认一段文本（如「红心歌单」等用户贴分享链接），
//    长度限 4~500 字，避免把一句闲聊当成参数；不配这个键的机器人行为完全不变。
function isAskReply(bot, text) {
  const spec = pendingAsk.get(bot.id);
  if (!spec) return false;
  const t = String(text || '').trim();
  if (/^\d+$/.test(t) || /^\d+\s+\d+$/.test(t)) return true;
  return !!spec.askAny && t.length >= 4 && t.length <= 500;
}
function persistTopics() {
  try {
    mkdirSync(path.dirname(TOPICS_FILE), { recursive: true });
    writeFileSync(TOPICS_FILE, JSON.stringify(topicsState));
  } catch (e) { log('persist topics error:', e.message); }
}
function restorePersistedThreads() {
  let count = 0;
  for (const [botId, st] of Object.entries(topicsState)) {
    const tps = (st && st.topics) || {};
    for (const [topicId, tp] of Object.entries(tps)) {
      if (!tp || tp.archived || !tp.threadIds || typeof tp.threadIds !== 'object') continue;
      for (const [ownerKey, entry] of Object.entries(tp.threadIds)) {
        const threadId = typeof entry === 'string' ? entry : entry && entry.id;
        if (typeof threadId !== 'string' || !threadId) continue;
        sessions.set(`${ownerKey}:${topicId}`, threadId);
        count += 1;
      }
    }
  }
  return count;
}
function recordTopicThread(meta, threadId) {
  if (!meta || !meta.botId || !meta.topicId || !meta.ownerKey) return;
  const st = topicsState[meta.botId];
  const tp = st && st.topics && st.topics[meta.topicId];
  if (!tp) return;
  if (!tp.threadIds || typeof tp.threadIds !== 'object') tp.threadIds = {};
  if (threadId) {
    tp.threadIds[meta.ownerKey] = { id: String(threadId), updatedAt: Date.now() };
  } else if (Object.prototype.hasOwnProperty.call(tp.threadIds, meta.ownerKey)) {
    delete tp.threadIds[meta.ownerKey];
  } else {
    return;
  }
  persistTopics();
}
function botTopics(bot) {
  if (!topicsState[bot.id]) topicsState[bot.id] = { current: null, topics: {} };
  return topicsState[bot.id];
}
function topicFile(bot, topicId) { return path.join(bot.workDir, 'topics', topicId + '.txt'); }
function ensureTopic(bot) {
  const st = botTopics(bot);
  if (!st.current || !st.topics[st.current]) {
    const id = 't' + Date.now().toString(36);
    st.topics[id] = { name: '默认', threadId: null, threadIds: {}, createdAt: Date.now(), lastActiveAt: Date.now(), archived: false };
    st.current = id;
    try {
      if (existsSync(bot.transcriptFile)) mkdirSync(path.join(bot.workDir, 'topics'), { recursive: true });
      if (existsSync(bot.transcriptFile) && !existsSync(topicFile(bot, id))) {
        writeFileSync(topicFile(bot, id), readFileSync(bot.transcriptFile, 'utf8'));
      }
    } catch {}
    persistTopics();
  }
  return st.current;
}
function activeTopicList(bot) {
  const st = botTopics(bot);
  return Object.keys(st.topics)
    .filter(id => !st.topics[id].archived)
    .map(id => ({ id, name: st.topics[id].name, lastActiveAt: st.topics[id].lastActiveAt }))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}
function newTopic(bot, name) {
  const st = botTopics(bot);
  const id = 't' + Date.now().toString(36);
  st.topics[id] = { name: String(name || '').trim() || '新话题', threadId: null, threadIds: {}, createdAt: Date.now(), lastActiveAt: Date.now(), archived: false };
  st.current = id;
  persistTopics();
  return id;
}
function switchTopic(bot, topicId) {
  const st = botTopics(bot);
  if (!st.topics[topicId]) return null;
  st.current = topicId;
  st.topics[topicId].lastActiveAt = Date.now();
  persistTopics();
  return topicId;
}
function archiveTopic(bot, topicId) {
  const st = botTopics(bot);
  if (!st.topics[topicId] || st.topics[topicId].archived) return false;
  st.topics[topicId].archived = true;
  if (st.current === topicId) {
    const active = Object.keys(st.topics).filter(id => !st.topics[id].archived && id !== topicId);
    st.current = active.length ? active.sort((a, b) => st.topics[b].lastActiveAt - st.topics[a].lastActiveAt)[0] : null;
  }
  persistTopics();
  return true;
}
// 归档后的提示文案（2026-09-27 用户要求）：要说清顺延切换到了哪个话题
function archiveReplyText(bot, archivedName, before, after) {
  const st = botTopics(bot);
  const label = archivedName ? '「' + archivedName + '」' : '';
  if (!after || !st.topics[after]) {
    return '已归档话题' + label + '。当前没有其他话题，收到下一条消息时会自动新建一个话题。';
  }
  const name = st.topics[after].name;
  if (after === before) return '已归档话题' + label + '。当前话题仍是「' + name + '」。';
  return '已归档话题' + label + '。顺延切换到「' + name + '」。';
}
function broadcastTopics(bot) {
  const st = botTopics(bot);
  broadcast({ type: 'topic', bot: bot.id, current: st.current, topics: activeTopicList(bot) });
}
function topicListText(bot) {
  const list = activeTopicList(bot);
  if (!list.length) return '暂无话题。';
  return '话题列表：\n' + list.map((t, i) => `${i + 1}. ${t.name}${inboxSuffix(bot, t.id)}`).join('\n');
}
// 切换话题列表的超链接：QQ Markdown 支持 mqqapi://aio/inlinecmd 指令链接。
// enter=true 在支持的内嵌消息里点击即发；reply=false 不引用原消息。
function topicSwitchLinks(bot) {
  const list = activeTopicList(bot);
  if (!list.length) return '暂无话题。';
  return '话题列表：\n' + list.map((t, i) => {
    const label = `${i + 1}. ${String(t.name || '话题').replace(/[\r\n]+/g, ' ')}${inboxSuffix(bot, t.id)}`
      .replace(/([\\\[\]])/g, '\\$1');
    const command = encodeURIComponent(`切换话题 ${i + 1}`);
    return `[${label}](mqqapi://aio/inlinecmd?command=${command}&reply=false&enter=true)`;
  }).join('\n');
}
function resolveTopicRef(bot, ref) {
  const st = botTopics(bot);
  if (st.topics[ref]) return ref;
  if (/^\d+$/.test(String(ref))) {
    const list = activeTopicList(bot);
    const idx = Number(ref) - 1;
    if (idx >= 0 && idx < list.length) return list[idx].id;
  }
  return null;
}

// ---------- 收件箱模式（2026-10-16 加） ----------
// 口径：模式挂在话题上——手动开过一次（inboxOpen）或队列里还有货（inbox 非空），
// 进来的文本就只记录、不调模型；回执由桥接直接发，零 token。
// 队列跟着话题记录一起写进 topics.json，桥接重启不丢。
function topicInboxItems(bot, topicId) {
  const tp = botTopics(bot).topics[topicId];
  return tp && Array.isArray(tp.inbox) ? tp.inbox : [];
}
function inboxModeOn(bot, topicId) {
  const tp = botTopics(bot).topics[topicId];
  if (!tp) return false;
  return !!tp.inboxOpen || (Array.isArray(tp.inbox) && tp.inbox.length > 0);
}
function inboxCount(bot, topicId) {
  return topicInboxItems(bot, topicId).length;
}
function inboxFlushBusy(bot, topicId) {
  const tp = botTopics(bot).topics[topicId];
  return !!(tp && Array.isArray(tp.inboxFlush) && tp.inboxFlush.length);
}
// 收到「直连」后立即封存本批：活动队列清空、退出收件箱模式，并把本批单独记到
// inboxFlush。处理期间的普通消息因此会落到 running 分支，提示“正在处理，请稍候”。
function beginInboxFlush(bot, topicId) {
  const tp = botTopics(bot).topics[topicId];
  if (!tp) return [];
  const items = Array.isArray(tp.inbox) ? tp.inbox.slice() : [];
  tp.inbox = [];
  tp.inboxFlush = items;
  tp.inboxOpen = false;
  persistTopics();
  return items;
}
function finishInboxFlush(bot, topicId) {
  const tp = botTopics(bot).topics[topicId];
  if (!tp) return;
  delete tp.inboxFlush;
  // 正常处理时活动队列为空。若通过其他入口意外追加了新碎片，保留并重新打开模式，
  // 不用“清空整个数组”的方式误伤这些后到内容。
  tp.inboxOpen = Array.isArray(tp.inbox) && tp.inbox.length > 0;
  persistTopics();
}
function restoreInboxFlush(bot, topicId) {
  const tp = botTopics(bot).topics[topicId];
  if (!tp || !Array.isArray(tp.inboxFlush) || !tp.inboxFlush.length) return 0;
  const active = Array.isArray(tp.inbox) ? tp.inbox : [];
  tp.inbox = [...tp.inboxFlush, ...active].map((it, i) => ({ ...it, n: i + 1 }));
  tp.inboxOpen = true;
  delete tp.inboxFlush;
  persistTopics();
  return tp.inbox.length;
}
// 话题列表里带一句"收件箱 N 条"
function inboxSuffix(bot, topicId) {
  const n = inboxCount(bot, topicId);
  return n ? `（收件箱 ${n} 条）` : '';
}
// 切到一个有货的话题时，告诉用户已经自动进了收件箱模式、以及两条出路
function inboxSwitchNote(bot, topicId) {
  const n = inboxCount(bot, topicId);
  if (!n) return '';
  return `\n该话题收件箱还有 ${n} 条未处理，已自动进入收件箱模式：`
    + '发送「直连」打包送给模型，发送「清空并直连」丢弃本批。';
}
// 收件箱留档：清空/送出/归档前先落一份 md，方便回溯
function archiveInboxBatch(bot, topicId, items, tag) {
  try {
    const tp = botTopics(bot).topics[topicId] || {};
    const dir = path.join(cfg.inboxDir, bot.name, tag || '已处理');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const safe = String(tp.name || topicId).replace(/[\\/:*?"<>|]/g, '_').slice(0, 24);
    const file = path.join(dir, `${stamp}-${safe}.md`);
    const lines = [
      `# 收件箱留档（${tag || '已处理'}）`,
      '',
      `- 机器人：${bot.name}`,
      `- 话题：${tp.name || topicId}（${topicId}）`,
      `- 留档时间：${fmtLogTime(new Date().toISOString())}`,
      `- 条目数：${items.length}`,
      '',
    ];
    for (const it of items) {
      lines.push(`## ${it.n}. ${fmtLogTime(it.ts)}`);
      lines.push('');
      lines.push(it.text ? it.text : '（无文字）');
      if (it.files && it.files.length) {
        lines.push('');
        for (const f of it.files) lines.push(`附件：${f}`);
      }
      lines.push('');
    }
    writeFileSync(file, lines.join('\n'), 'utf8');
    return file;
  } catch (e) {
    log('inbox archive error:', e.message);
    return '';
  }
}
// 把所有碎片按顺序拼成一个 prompt 交给模型
// 2026-10-16 用户口径：直连只送正文——不带包装句、不带编号与时间戳，免得这些框架话术
// 留在会话历史里污染后续上下文；附件仍带路径（不带模型就打不开文件）。
function buildInboxPrompt(items) {
  return items.map((it) => {
    const text = String(it.text || '').trim() || '（无文字）';
    const files = it.files && it.files.length ? `附件：${it.files.join('；')}` : '';
    return [text, files].filter(Boolean).join('\n');
  }).join('\n\n');
}
// 记一条碎片并回执（回执不经过模型，零 token）
async function addInboxItem(bot, topicId, text, files, chan, msgId, msgSeq, notifyQQ) {
  const tp = botTopics(bot).topics[topicId];
  if (!tp) return null;
  tp.inbox = Array.isArray(tp.inbox) ? tp.inbox : [];
  const body = String(text || '').trim();
  const item = {
    n: tp.inbox.length + 1,
    ts: new Date().toISOString(),
    text: body,
    files: Array.isArray(files) ? files.slice() : [],
  };
  tp.inbox.push(item);
  persistTopics();
  let note = '';
  if (inboxRestored.has(bot.id + ':' + topicId)) {
    inboxRestored.delete(bot.id + ':' + topicId);
    note = '（桥接重启过，收件箱模式仍在运行）';
  }
  // 2026-10-16 用户口径（晚，定稿）：回执＝抬头「话题「X」已缓存如下：」＋条目全文列表＋
  // 尾句「回复「直连」把这批打包发送。」。「已存入 #N｜本批…」表头与「清空并直连」提示
  // 都不出现在回执里（后者只在进入收件箱模式、切回有货话题时各说一次）。
  // 只有送模型的那一份（buildInboxPrompt）不带前后句——框架话术会污染后续上下文。
  const lines = tp.inbox.map((it) => {
    const b = String(it.text || '').trim();
    const shown = b || (it.files && it.files.length
      ? `[附件] ${it.files.map(f => path.basename(f)).join('、')}`
      : '（无文字）');
    return `${it.n}. ${shown}`;
  });
  const receipt = `话题「${tp.name || topicId}」已缓存如下：\n`
    + lines.join('\n') + '\n'
    + '回复「直连」把这批打包发送。'
    + (note ? '\n\n' + note : '');
  await respondCommand(bot, topicId, receipt, chan, msgId, msgSeq, notifyQQ);
  return item;
}

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

// 分片发送：markdown 模式下按 1500 字切分。
// 关键点：如果切点落在 ``` 代码块内部，本片末尾补一个 ``` 收口、下一片开头补 ``` 重新打开，
// 否则 QQ 端 markdown 渲染会把后半段全吞进代码块（渲染层面出错比截断更难排查）。
function chunkText(text, max = 1500) {
  const chunks = [];
  let rest = String(text == null ? '' : text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    let piece = rest.slice(0, cut).trim();
    if (((piece.match(/^\s*```/gm) || []).length % 2) === 1) {
      // 切点落在代码块内部：本片末尾补收口，下一片用同一个起始标记（含语言名）重新开头
      const opened = piece.match(/^\s*```[^\n]*$/gm) || [];
      const opener = opened.length ? opened[opened.length - 1].trim() : '```';
      piece += '\n```';
      rest = opener + '\n' + rest.slice(cut).trim();
    } else {
      rest = rest.slice(cut).trim();
    }
    chunks.push(piece);
  }
  const tail = rest.trim();
  if (tail) {
    // 原文本身有未闭合的代码块时补一个收口，避免 QQ 端把后续内容全渲染成代码
    chunks.push(((tail.match(/^\s*```/gm) || []).length % 2) === 1 ? tail + '\n```' : tail);
  }
  return chunks.length ? chunks : ['（无输出）'];
}

// 杀 Codex 进程树（Windows 上 child.kill() 只杀主进程，会留下孤儿进程继续占用线程写锁）
function killTree(child) {
  try { child.kill(); } catch {}
  if (child && child.pid) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch {}
  }
}

function isResumeRecoveryError(err) {
  const text = [err && err.message, err && err.stderr].filter(Boolean).join('\n');
  return /thread\/resume failed|no rollout found for thread id|failed to resume/i.test(text);
}

function runCodexAttempt(prompt, openid, workDir, resumeId, outFile) {
  return new Promise((resolve, reject) => {
    let args = ['exec', '--json', '--skip-git-repo-check', '-C', workDir, '--dangerously-bypass-approvals-and-sandbox', '-o', outFile];
    if (resumeId) args.push('resume', resumeId);
    args.push(prompt);

    const child = spawn(currentCodexCli(), args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: USER_HOME,
        USERPROFILE: USER_HOME,
        CODEX_HOME: cfg.codexHome || DEFAULT_CODEX_HOME,
      },
    });
    activeProcs.set(openid, child);

    let jsonBuf = '';
    let stderrBuf = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      activeProcs.delete(openid);
      fn(val);
    };
    const timer = cfg.codexTimeoutMs > 0 ? setTimeout(() => {
      killTree(child);
      finish(reject, new Error('Codex 处理超时'));
    }, cfg.codexTimeoutMs) : null;
    const codexError = (code, signal, errText) => {
      const err = new Error(errText || (
        signal ? `Codex 被信号 ${signal} 终止` : `Codex 退出码 ${code}`
      ));
      err.exitCode = code;
      err.signal = signal;
      err.stderr = errText;
      err.resumeId = resumeId || null;
      return err;
    };

    child.stdout.on('data', d => { jsonBuf += d.toString(); });
    child.stderr.on('data', d => {
      if (stderrBuf.length < 4000) stderrBuf += d.toString('utf8');
    });
    child.on('error', err => finish(reject, err));
    child.on('close', (code, signal) => {
      try {
        const errText = stderrBuf.trim();
        if (code !== 0) {
          return finish(reject, codexError(code, signal, errText));
        }
        const thread = parseThreadId(jsonBuf);
        const out = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : '';
        finish(resolve, { out: out || '（无输出）', thread });
      } catch (e) {
        finish(reject, e);
      }
    });
    // 进程已退出但 close 迟迟不来（子进程继承 stdout 管道）时的兜底，防止任务状态永久卡住
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        if (settled) return;
        const errText = stderrBuf.trim();
        if (code !== 0) {
          return finish(reject, codexError(code, signal, errText));
        }
        let out = '';
        try { out = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : ''; } catch {}
        finish(resolve, { out: out || '（无输出）', thread: parseThreadId(jsonBuf) });
      }, 5000);
    });
  });
}

async function runCodex(prompt, openid, workDir = cfg.workDir, threadKey = openid, threadMeta = null) {
  const outFile = suffix => path.join(OUT_DIR, `${Date.now()}-${randomUUID().slice(0, 8)}${suffix}.txt`);
  const prev = sessions.get(threadKey);
  let result = null;

  if (prev) {
    try {
      result = await runCodexAttempt(prompt, openid, workDir, prev, outFile('-resume'));
    } catch (err) {
      if (!isResumeRecoveryError(err)) throw err;
      log(`[${openid}] resume failed for ${threadKey}, starting a new thread:`, err.message);
      sessions.delete(threadKey);
      recordTopicThread(threadMeta, null);
    }
  }

  if (!result) result = await runCodexAttempt(prompt, openid, workDir, null, outFile('-new'));
  if (result.thread) {
    sessions.set(threadKey, result.thread);
    recordTopicThread(threadMeta, result.thread);
  }
  return result.out;
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
const CONTACTS_FILE = path.join(BRIDGE_DIR, 'data', 'contacts.json');
const botContacts = new Map((() => {
  try {
    const o = JSON.parse(readFileSync(CONTACTS_FILE, 'utf8'));
    return Object.entries(o);
  } catch { return []; }
})());
function persistContacts() {
  try {
    mkdirSync(path.dirname(CONTACTS_FILE), { recursive: true });
    writeFileSync(CONTACTS_FILE, JSON.stringify(Object.fromEntries(botContacts)));
  } catch (e) { log('persist contacts error:', e.message); }
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
    try { existing = readFileSync(topicFile(bot, ensureTopic(bot)), 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
    const seen = new Set(existing);
    const toAdd = hits.filter(h => !seen.has(h));
    if (toAdd.length) {
      const out = existing.concat(toAdd).sort();
      writeFileSync(topicFile(bot, ensureTopic(bot)), out.join('\n') + '\n');
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
    const dirs = [wd, ...bots.map(x => x.projectDir).filter(Boolean).map(norm)];
    return dirs.includes(cwd) || (!!cr && (cwd === cr || cwd.startsWith(cr + '/')));
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
    try { existing = readFileSync(topicFile(bot, ensureTopic(bot)), 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
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
      writeFileSync(topicFile(bot, ensureTopic(bot)), out.join('\n') + '\n');
      log(`[${bot.id}] backfilled ${toAdd.length} LLM replies from sessions`);
    }
  } catch (e) { log('reply backfill error:', e.message); }
}

function loadTranscriptHistory(bot, topicId) {
  const key = bot.id + ':' + topicId;
  try {
    const text = readFileSync(topicFile(bot, topicId), 'utf8');
    const entries = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const m = line.match(/^\[(.*?)\] (用户|Codex): (.*)$/);
      if (m) entries.push({ ts: m[1], role: m[2] === '用户' ? 'user' : 'codex', text: unescapeTranscript(m[3]) });
    }
    chatLogs.set(key, entries.slice(-MAX_LOG));
  } catch { chatLogs.set(key, []); }
}

// 聊天记录文件约定"一行一条"，多行文本转义后再落盘，读回时还原（保留段落）
function escapeTranscript(s) {
  return String(s).slice(0, 2000).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}
function unescapeTranscript(s) {
  return s.replace(/\\\\/g, '\uE000').replace(/\\n/g, '\n').replace(/\uE000/g, '\\');
}

function pushChat(bot, topicId, entry) {
  const key = bot.id + ':' + topicId;
  const arr = chatLogs.get(key) || [];
  arr.push({ ts: fmtLogTime(new Date().toISOString()), role: entry.role, text: entry.text });
  chatLogs.set(key, arr.slice(-MAX_LOG));
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) { try { res.write(data); } catch {} }
}

function botStatus(bot) {
  if (!bot.online) return '离线';
  return running.get(`qq:${bot.id}`) ? '处理中' : '在线';
}

// ---------- 机器人头像（电脑端面板显示用） ----------
// 头像文件放 avatars\ 下，按 accountId 命名（main/second/third/fourth/fifth），
// 找不到时回退到按显示名命名（改名后不必跟着改文件名）。QQ 端头像是平台上设的，与这里无关。
const AVATAR_DIR = path.join(BRIDGE_DIR, 'avatars');
const AVATAR_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const AVATAR_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function avatarFile(bot) {
  for (const base of [bot.id, bot.name]) {
    if (!base) continue;
    for (const ext of AVATAR_EXTS) {
      const f = path.join(AVATAR_DIR, base + ext);
      if (existsSync(f)) return f;
    }
  }
  return null;
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
  prompt += '\n\n（要把本地文件发给用户时：单独一行写 <qqfile>文件的绝对路径</qqfile>，桥接会上传并作为 QQ 文件/图片发出，'
    + '标签行不会出现在正文里。图片请用 png/jpg，其它格式会作为文件卡片发送。）';
  return prompt;
}

async function respondCommand(bot, topicId, text, chan, msgId, msgSeq, notifyQQ, extraOpts = null) {
  // 快捷指令/兜底指令的回复同样支持 <qqfile>：正文照发，声明的文件走富媒体通道（2026-09-29 加）。
  // 被动回复额度：单聊一条用户消息共 4 次，正文占 1 格，文件最多再发 2 个。
  const { text: plain, paths } = extractMediaPaths(text);
  const { storeText, ...sendExtraOpts } = extraOpts || {};
  const sentFiles = [];
  // 指令/快捷指令/兜底指令的回复按机器人配置走 Markdown（2026-09-14）：配了 reply.json 的才转
  if (notifyQQ && chan) {
    const sendOpts = { ...(mdOpts(bot) || {}), ...sendExtraOpts };
    await chan.send(plain, msgId, msgSeq + 1, Object.keys(sendOpts).length ? sendOpts : undefined).catch(() => {});
    let seq = msgSeq + 2;
    for (const f of paths.slice(0, 2)) {
      const info = await uploadMedia(bot, chan, f);
      if (!info) { log(`[${bot.id}] 指令回复里的文件未上传：`, f); continue; }
      const ok = await sendMedia(bot, chan, info, msgId, seq);
      log(`[${bot.id}] 指令回复文件${ok ? '已发送' : '发送失败'}：`, f);
      if (ok) { sentFiles.push(path.basename(f)); seq += 1; }
    }
  }
  const storedText = typeof storeText === 'string' ? storeText : plain;
  const stored = storedText + (sentFiles.length ? `\n\n[已通过 QQ 发送文件] ${sentFiles.join('、')}` : '');
  pushChat(bot, topicId, { role: 'codex', text: stored });
  appendTranscript(bot, topicId, 'Codex', stored);
  const arr = chatLogs.get(bot.id + ':' + topicId);
  if (arr && arr.length) broadcast({ type: 'chat', bot: bot.id, topic: topicId, entry: arr[arr.length - 1] });
}

const DEFAULT_HELP = '可用指令：\n新话题 [名称] - 新建聊天\n话题列表 - 查看聊天列表\n切换话题 <编号> - 切换聊天\n归档话题 <编号> - 归档聊天\n重命名 - 重命名当前话题\n收件箱模式 - 本话题只记不答，碎片攒批\n直连 - 把收件箱打包送给模型，并切回直接对话\n清空并直连 - 丢弃本批收件箱，并切回直接对话\n停止 - 终止当前任务';

// 每个机器人可在自己的项目目录放 HELP.md 覆盖默认帮助；未放则用 DEFAULT_HELP
function botHelp(bot) {
  try {
    const f = path.join(bot.workDir, 'HELP.md');
    if (existsSync(f)) {
      const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n').trim();
      if (text) return text;
    }
  } catch {}
  return DEFAULT_HELP;
}

// 每机器人可在项目目录放 reply.json 打开 Markdown 回复：{"markdown": true}
// 与 HELP.md / commands.json 一样实时读取；未放该文件的机器人回复仍是纯文本，
// 所以这次改动只影响配置了的机器人（2026-09-14 加）。
function botMarkdownReply(bot) {
  try {
    const f = path.join(bot.workDir, 'reply.json');
    if (existsSync(f)) {
      const cfg = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
      if (cfg && cfg.markdown === true) return true;
    }
  } catch (e) {
    log(`[${bot.id}] reply.json 读取失败：${String((e && e.message) || e)}`);
  }
  return false;
}

// 传给 chan.send 的选项：配了 reply.json 的机器人走 msg_type=2 Markdown，其余 undefined（纯文本）
function mdOpts(bot) {
  return botMarkdownReply(bot) ? { markdown: true } : undefined;
}

// 每个机器人可在自己的项目目录放 commands.json 定义快捷指令（消息原文 -> 要执行的命令）
function botCommands(bot) {
  try {
    const f = path.join(bot.workDir, 'commands.json');
    if (existsSync(f)) {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    }
  } catch {}
  return {};
}

// 快捷指令匹配：先精确匹配，再大小写不敏感兜底（如 "ETF" 也认 "etf"/"Etf"）。
// 指令项设置 prefix:true 后也匹配 "指令 + 参数"，参数会作为一个末参传给脚本。
function findBotCommand(bot, text) {
  const map = botCommands(bot);
  const t = String(text || '');
  if (map[t]) return map[t];
  const low = t.toLowerCase();
  for (const k of Object.keys(map)) {
    if (String(k).toLowerCase() === low) return map[k];
  }
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || !spec.prefix || key === '*') continue;
    const prefix = String(key);
    if (low.startsWith(prefix.toLowerCase() + ' ') && Array.isArray(spec.cmd) && spec.cmd.length) {
      const args = t.slice(prefix.length).trim();
      if (args) {
        return Object.assign({}, spec, {
          cmd: spec.cmd.concat([args]),
          _hasArgs: true,
        });
      }
    }
  }
  return null;
}

// 仅管理员可用的快捷指令（指令项配 adminOnly:true）：
// 非管理员既不执行、也不出现在"可用快捷指令"提示里；管理员行为不变。
function isAdminOnlyCmd(spec) {
  return !!(spec && spec.adminOnly);
}

// 非管理员能看到/能用的快捷指令名（提示语用；排除 "*" 兜底与 adminOnly 指令）
function botCommandNames(bot, isAdmin) {
  const map = botCommands(bot);
  return Object.keys(map).filter(k => k !== '*' && (isAdmin || !isAdminOnlyCmd(map[k])));
}

// 兜底指令（2026-09-14 加）：commands.json 里用 "*" 键声明「除内置指令与快捷指令之外的
// 一切文本」交给哪个程序，收到消息时把原文追加为命令末参再执行；返回输出作为回复。
// 只对配置了 "*" 的机器人生效，未配置的机器人行为完全不变。
function findBotFallback(bot, text) {
  const map = botCommands(bot);
  const spec = map['*'];
  if (!spec || !Array.isArray(spec.cmd) || !spec.cmd.length) return null;
  const t = String(text || '').trim();
  if (!t) return null;
  return Object.assign({}, spec, { cmd: spec.cmd.concat([t]) });
}

// 配了兜底指令 "*" 的机器人：非管理员发来的纯文本也放行——消息交给
// 本地脚本处理，不经过 Codex；附件仍拦，避免非白名单用户往项目目录丢文件。
function hasBotFallback(bot) {
  try {
    const spec = botCommands(bot)['*'];
    return !!(spec && Array.isArray(spec.cmd) && spec.cmd.length);
  } catch { return false; }
}

// 传给快捷指令/兜底指令的环境变量：让脚本知道是谁在哪个机器人上说话
function botCmdEnv(bot, chan, msgId) {
  return {
    QQ_BOT: bot.id,
    QQ_BOT_NAME: bot.name || '',
    QQ_OPENID: (chan && chan.sender) || '',
    QQ_CHAT_KIND: (chan && chan.kind) || '',
    QQ_MSG_ID: msgId || '',
  };
}

function runBotCommand(spec, extraEnv) {
  return new Promise((resolve, reject) => {
    if (!spec || !Array.isArray(spec.cmd) || !spec.cmd.length) {
      return reject(new Error('commands.json 配置无效'));
    }
    // 用 spawn + stdio[0]='ignore'（与 runCodex 同款），不要用 execFile：
    // execFile 会给子进程一个"开着且从不关闭"的 stdin 管道，非 TTY 环境下
    // codex exec 这类"stdin 不是 TTY 就当成管道输入来读"的程序会一直等 EOF，
    // 表现为脚本静默卡住、直到被 timeoutMs 杀掉（下游脚本踩坑）
    // 「更新新闻」的 python 脚本里再起 codex exec，整个指令卡到 180s 超时）。
    const child = spawn(spec.cmd[0], spec.cmd.slice(1), {
      cwd: spec.cwd || undefined,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    const limit = Number(spec.timeoutMs || 60000);
    const maxBuffer = 8 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, limit);
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const keep = buf => {
      if (buf.length > maxBuffer) { try { child.kill(); } catch {} }
      return buf;
    };
    child.stdout.on('data', d => { stdout = keep(stdout + d.toString('utf8')); });
    child.stderr.on('data', d => { stderr = keep(stderr + d.toString('utf8')); });
    child.on('error', err => done(reject, err));
    child.on('close', code => {
      if (timedOut) {
        return done(reject, new Error(
          `命令超过 ${Math.round(limit / 1000)} 秒未结束，已中止`));
      }
      if (code !== 0) {
        return done(reject, new Error(
          String(stderr || '').trim() || `命令退出码 ${code}`));
      }
      done(resolve, String(stdout || '').trim().replace(/\r\n/g, '\n'));
    });
  });
}

async function processBotText(bot, prompt, displayText, { chan = null, msgId = null, msgSeq = 1, notifyQQ = false, userKey = `qq:${bot.id}`, inboxFiles = [] } = {}) {
  const topicId = ensureTopic(bot);
  // [语音] 前缀只用于聊天记录/面板展示，命令匹配时剥掉，保证"用语音说新话题"也能命中
  const t = String(displayText || '').replace(/^\[语音\]\s*/, '').trim();
  pushChat(bot, topicId, { role: 'user', text: displayText });
  appendTranscript(bot, topicId, '用户', displayText);
  broadcast({ type: 'chat', bot: bot.id, topic: topicId, entry: chatLogs.get(bot.id + ':' + topicId).slice(-1)[0] });

  const helpRe = /^(帮助|help|菜单|指令)$/i;
  const newRe = /^新话题(?:\s+(.+))?$/;
  const listRe = /^(话题列表|列表)$/;
  const switchRe = /^切换话题(?:\s+(\S+))?$/;
  const archiveRe = /^归档话题(?:\s+(\S+))?$/;
  const renameRe = /^重命名(?:话题)?(?:\s+(\S+))?$/;
  const st = botTopics(bot);
  // 非管理员好友：仅放行快捷指令（股票功能）+ 帮助，禁止触发大模型对话
  const codexAllowed = !cfg.codexOpenids.length || !chan || cfg.codexOpenids.includes(chan.sender || '');
  const gateCmd = findBotCommand(bot, t);
  // 仅管理员可用的快捷指令（adminOnly）：非管理员单独回一句，不进下面的通用提示
  if (!codexAllowed && isAdminOnlyCmd(gateCmd)) {
    log(`[${bot.id}] admin-only cmd blocked from`, (chan && chan.sender) || '', ':', t.slice(0, 40));
    await respondCommand(bot, topicId, '该指令仅管理员可用。', chan, msgId, msgSeq, notifyQQ);
    return { ok: true, restricted: true, custom: t };
  }
  // ask 两步式（如"个股"）的编号回复也要放行，否则非管理员在第二步被拦
  if (!codexAllowed && !hasBotFallback(bot) && !helpRe.test(t) && !gateCmd
      && !isAskReply(bot, t)) {
    const cmds = botCommandNames(bot, codexAllowed);
    const hint = cmds.length ? '我只能使用快捷指令：' + cmds.join(' / ') + '。' : '';
    await respondCommand(bot, topicId, (hint || '当前仅管理员可对话。') + '其他功能请联系管理员。', chan, msgId, msgSeq, notifyQQ);
    return { ok: true, restricted: true };
  }
  if (pendingNaming.has(bot.id)) {
    const pt = pendingNaming.get(bot.id);
    const isCmd = helpRe.test(t) || newRe.test(t) || listRe.test(t) || switchRe.test(t) || archiveRe.test(t) || renameRe.test(t) || STOP_RE.test(t);
    if (isCmd) {
      pendingNaming.delete(bot.id);
    } else {
      const name = t.slice(0, 30);
      if (name && botTopics(bot).topics[pt]) botTopics(bot).topics[pt].name = name;
      persistTopics();
      pendingNaming.delete(bot.id);
      broadcastTopics(bot);
      await respondCommand(bot, pt, '已命名话题：' + (name || '新话题'), chan, msgId, msgSeq, notifyQQ);
      return { ok: true, action: 'named', topic: pt };
    }
  }
  if (pendingRename.has(bot.id)) {
    const rt = pendingRename.get(bot.id);
    const isCmd = helpRe.test(t) || newRe.test(t) || listRe.test(t) || switchRe.test(t) || archiveRe.test(t) || renameRe.test(t) || STOP_RE.test(t);
    if (isCmd) {
      pendingRename.delete(bot.id);
    } else {
      const name = t.slice(0, 30);
      if (name && botTopics(bot).topics[rt]) botTopics(bot).topics[rt].name = name;
      persistTopics();
      pendingRename.delete(bot.id);
      broadcastTopics(bot);
      await respondCommand(bot, rt, '已重命名话题：' + (name || ''), chan, msgId, msgSeq, notifyQQ);
      return { ok: true, action: 'renamed', topic: rt };
    }
  }
  if (pendingTopic.has(bot.id)) {
    if (/^\d+$/.test(t)) {
      pendingTopic.delete(bot.id);
      const target = resolveTopicRef(bot, t);
      if (!target) {
        const storeText = '编号无效。\n' + topicListText(bot);
        await respondCommand(bot, topicId, '编号无效。\n' + topicSwitchLinks(bot), chan, msgId, msgSeq, notifyQQ,
          { markdown: true, storeText });
        return { ok: true, action: 'list' };
      }
      switchTopic(bot, target);
      pendingNaming.delete(bot.id);
      broadcastTopics(bot);
      await respondCommand(bot, target, '已切换到话题：' + botTopics(bot).topics[target].name + inboxSwitchNote(bot, target), chan, msgId, msgSeq, notifyQQ);
      return { ok: true, action: 'switch', topic: target };
    }
    pendingTopic.delete(bot.id);
  }
  // 快捷指令两步式：commands.json 配 ask:true 时（如"个股"），回复编号后把
  // 编号追加为命令末参重跑；非编号回复则取消等待，继续正常处理
  if (pendingAsk.has(bot.id)) {
    const askSpec = pendingAsk.get(bot.id);
    if (isAskReply(bot, t)) {
      const cmd = Array.isArray(askSpec.cmd) ? [...askSpec.cmd, t] : null;
      let out;
      try {
        // 第二步同样要把机器人身份传下去：漏传 botCmdEnv 时脚本里的 QQ_BOT / QQ_OPENID 是空的，
        // 它回头调桥接的 /api/notify、/api/file 就会被回 400「缺少 bot 或 path」
        // （红心歌单的表生成出来送不出去，2026-10-13 与 2026-10-16 各踩一次）。
        out = cmd ? await runBotCommand({ ...askSpec, cmd }, botCmdEnv(bot, chan, msgId)) : '';
      } catch (e) {
        out = '执行出错：' + String((e && e.message) || e).slice(0, 300);
      }
      const reply = out || '（无输出）';
      await respondCommand(bot, topicId, reply, chan, msgId, msgSeq, notifyQQ);
      return { ok: true, custom: t, reply };
    }
    pendingAsk.delete(bot.id);
  }
  if (helpRe.test(t)) {
    await respondCommand(bot, topicId, botHelp(bot), chan, msgId, msgSeq, notifyQQ);
    return { ok: true, help: true };
  }
  if (newRe.test(t)) {
    const m = t.match(newRe);
    const id = newTopic(bot, m && m[1]);
    broadcastTopics(bot);
    if (notifyQQ && chan) {
      pendingNaming.set(bot.id, id);
      await respondCommand(bot, id, '已新建话题。请命名本话题（直接回复名称即可）。', chan, msgId, msgSeq, notifyQQ);
    } else {
      await respondCommand(bot, id, '已新建话题：' + botTopics(bot).topics[id].name, chan, msgId, msgSeq, notifyQQ);
    }
    return { ok: true, action: 'new', topic: id };
  }
  if (listRe.test(t)) {
    await respondCommand(bot, topicId, topicListText(bot), chan, msgId, msgSeq, notifyQQ);
    return { ok: true, action: 'list' };
  }
  if (switchRe.test(t)) {
    const m = t.match(switchRe);
    const target = m && m[1] ? resolveTopicRef(bot, m[1]) : null;
    if (!target) {
      pendingTopic.set(bot.id, true);
      const storeText = '请选择话题（可直接点击蓝色链接）：\n' + topicListText(bot);
      await respondCommand(bot, topicId, '请选择话题（可直接点击蓝色链接）：\n' + topicSwitchLinks(bot),
        chan, msgId, msgSeq, notifyQQ, { markdown: true, storeText });
      return { ok: true, action: 'list' };
    }
    switchTopic(bot, target);
    pendingNaming.delete(bot.id);
    broadcastTopics(bot);
    await respondCommand(bot, target, '已切换到话题：' + st.topics[target].name + inboxSwitchNote(bot, target), chan, msgId, msgSeq, notifyQQ);
    return { ok: true, action: 'switch', topic: target };
  }
  if (archiveRe.test(t)) {
    const m = t.match(archiveRe);
    const target = m && m[1] ? (resolveTopicRef(bot, m[1]) || st.current) : st.current;
    const before = st.current;
    const archivedName = st.topics[target] ? st.topics[target].name : '';
    // 归档的话题切不回去（不在活动列表里），收件箱里的货会变成孤岛——先留档再清空，并在回复里点名
    const pendingItems = topicInboxItems(bot, target).slice();
    const ok = archiveTopic(bot, target);
    let inboxWarn = '';
    if (ok && pendingItems.length) {
      const arch = archiveInboxBatch(bot, target, pendingItems, '已归档');
      const tp = st.topics[target];
      if (tp) { tp.inbox = []; tp.inboxOpen = false; }
      persistTopics();
      inboxWarn = `\n注意：该话题收件箱还有 ${pendingItems.length} 条未处理，已随话题归档留档`
        + (arch ? `在 ${arch}` : '（留档失败，见桥接日志）');
    }
    pendingNaming.delete(bot.id);
    broadcastTopics(bot);
    const done = ok ? archiveReplyText(bot, archivedName, before, botTopics(bot).current) : '未找到该话题。';
    await respondCommand(bot, botTopics(bot).current || topicId, done + inboxWarn, chan, msgId, msgSeq, notifyQQ);
    return { ok: true, action: 'archive' };
  }
  if (renameRe.test(t)) {
    const m = t.match(renameRe);
    const target = m && m[1] ? (resolveTopicRef(bot, m[1]) || st.current) : st.current;
    if (!st.topics[target]) {
      await respondCommand(bot, topicId, '未找到该话题。', chan, msgId, msgSeq, notifyQQ);
      return { ok: true, action: 'rename-ask' };
    }
    pendingRename.set(bot.id, target);
    await respondCommand(bot, topicId, '请回复新名称（直接回复名称即可）。', chan, msgId, msgSeq, notifyQQ);
    return { ok: true, action: 'rename-ask', topic: target };
  }

  // ---------- 收件箱模式三条指令（2026-10-16 加）----------
  // 排在快捷指令/兜底指令之前：配了 "*" 兜底的机器人也不该把这三条吞掉。
  const inboxOnRe = /^(收件箱|收件箱模式)$/;
  const inboxFlushRe = /^(直连|直连模式|直接对话|直接对话模式)$/;
  const inboxClearRe = /^(清空并直连|清空直连|清空收件箱并直连)$/;
  let inboxFlush = null;
  if (inboxOnRe.test(t)) {
    const tp = st.topics[topicId];
    if (tp) {
      if (inboxFlushBusy(bot, topicId)) {
        if (notifyQQ && chan) await chan.send('上一条还在处理，请稍候。', msgId, msgSeq + 1, mdOpts(bot));
        return { ok: false, reason: 'busy' };
      }
      tp.inboxOpen = true;
      tp.inbox = Array.isArray(tp.inbox) ? tp.inbox : [];
      persistTopics();
      const n = tp.inbox.length;
      await respondCommand(bot, topicId,
        '已进入收件箱模式：这个话题接下来收到的消息只记录、不回复。'
        + (n ? `\n本批已有 ${n} 条。` : '')
        + '\n发送「直连」打包送给模型，发送「清空并直连」丢弃本批。', chan, msgId, msgSeq, notifyQQ);
      return { ok: true, action: 'inbox-on', topic: topicId };
    }
  }
  if (inboxClearRe.test(t)) {
    const tp = st.topics[topicId];
    if (inboxFlushBusy(bot, topicId)) {
      if (notifyQQ && chan) await chan.send('上一条还在处理，请稍候。', msgId, msgSeq + 1, mdOpts(bot));
      return { ok: false, reason: 'busy' };
    }
    const items = topicInboxItems(bot, topicId).slice();
    const arch = items.length ? archiveInboxBatch(bot, topicId, items, '已废弃') : '';
    if (tp) { tp.inbox = []; tp.inboxOpen = false; persistTopics(); }
    await respondCommand(bot, topicId,
      items.length
        ? `已丢弃本批 ${items.length} 条，并切到直接对话模式。`
          + (arch ? `\n留档：${arch}` : '（留档失败，见桥接日志）')
        : '收件箱是空的，已切到直接对话模式。', chan, msgId, msgSeq, notifyQQ);
    return { ok: true, action: 'inbox-clear', dropped: items.length };
  }
  if (inboxFlushRe.test(t)) {
    if (running.get(userKey)) {
      if (notifyQQ && chan) await chan.send('上一条还在处理，请稍候。', msgId, msgSeq + 1, mdOpts(bot));
      return { ok: false, reason: 'busy' };
    }
    const items = topicInboxItems(bot, topicId);
    if (!items.length) {
      const tp = st.topics[topicId];
      if (tp) { tp.inboxOpen = false; persistTopics(); }
      await respondCommand(bot, topicId, '收件箱是空的，已切到直接对话模式。', chan, msgId, msgSeq, notifyQQ);
      return { ok: true, action: 'inbox-flush-empty' };
    }
    inboxFlush = beginInboxFlush(bot, topicId);
  }

  if (STOP_RE.test(t)) {
    const proc = activeProcs.get(userKey);
    if (running.get(userKey)) {
      if (proc) killTree(proc);
      cancelled.add(userKey);
      running.delete(userKey);
      if (notifyQQ && chan) await chan.send('已停止当前任务。', msgId, msgSeq + 1).catch(() => {});
      return { ok: false, reason: 'cancelled' };
    }
    if (notifyQQ && chan) await chan.send('当前没有正在处理的任务。', msgId, msgSeq + 1).catch(() => {});
    return { ok: false, reason: 'idle-stop' };
  }
  const customCmd = findBotCommand(bot, t);
  if (customCmd) {
    // 双保险：入口闸门已拦过，这里再挡一次（processBotText 也可能被 /api/send 等路径直接调用）
    if (isAdminOnlyCmd(customCmd) && !codexAllowed) {
      await respondCommand(bot, topicId, '该指令仅管理员可用。', chan, msgId, msgSeq, notifyQQ);
      return { ok: true, restricted: true, custom: t };
    }
    let out;
    try {
      out = await runBotCommand(customCmd, botCmdEnv(bot, chan, msgId));
    } catch (e) {
      out = '执行出错：' + String((e && e.message) || e).slice(0, 300);
    }
    const reply = out || '（无输出）';
    await respondCommand(bot, topicId, reply, chan, msgId, msgSeq, notifyQQ);
    if (customCmd.ask && (!customCmd.askIfNoArgs || !customCmd._hasArgs)) {
      const pending = Object.assign({}, customCmd, { _hasArgs: false });
      pendingAsk.set(bot.id, pending);
    }
    return { ok: true, custom: t, reply };
  }
  const fallbackCmd = findBotFallback(bot, t);
  if (fallbackCmd) {
    let out;
    try {
      out = await runBotCommand(fallbackCmd, botCmdEnv(bot, chan, msgId));
    } catch (e) {
      out = '执行出错：' + String((e && e.message) || e).slice(0, 300);
    }
    const reply = out || '（无输出）';
    await respondCommand(bot, topicId, reply, chan, msgId, msgSeq, notifyQQ);
    return { ok: true, custom: t, reply, fallback: true };
  }
  // 收件箱模式：落在最后的兜底——上面所有指令都匹配不上，才算"一条碎片"，只记录不调模型
  // （「直连」不走这里：它已经把 inboxFlush 立起来了，要往下走 Codex 通道）
  if (!inboxFlush && inboxModeOn(bot, topicId)) {
    await addInboxItem(bot, topicId, t, inboxFiles, chan, msgId, msgSeq, notifyQQ);
    return { ok: true, action: 'inbox-add', topic: topicId };
  }
  if (running.get(userKey)) {
    if (notifyQQ && chan) await chan.send('上一条还在处理，请稍候。', msgId, msgSeq + 1, mdOpts(bot));
    return { ok: false, reason: 'busy' };
  }
  running.set(userKey, true);
  // 「直连」：把收件箱按顺序打包成 prompt，走下面正常的 Codex 通道（含回执、文件、留档）
  if (inboxFlush) prompt = buildInboxPrompt(inboxFlush);
  broadcastStatus(bot);
  let nextSeq = msgSeq + 1;
  let progressTimer = null;
  // 单聊一条用户消息最多被动回复 4 次、群聊 5 次，超出的会被 QQ 直接拒发（40034128）。
  // 过去的"处理中…"文本提示会占用这些额度，长任务的最终回复正是被它挤掉的，
  // 所以这里统一记账：usedSeq 记本次任务已经用掉几次回复，剩下的额度留给正文。
  const replyLimit = chan && chan.kind === 'group' ? 5 : 4;
  let usedSeq = 0;
  const sendSlot = async (content, opts) => {
    if (!notifyQQ || !chan) return false;
    usedSeq += 1;
    return chan.send(content, msgId, nextSeq++, opts);
  };
  // 媒体消息同样占一次被动回复额度，所以和文本走同一本账
  const sendSlotMedia = async (fileInfo) => {
    if (!notifyQQ || !chan) return false;
    usedSeq += 1;
    return sendMedia(bot, chan, fileInfo, msgId, nextSeq++);
  };
  // 流式消息：被动回复（带 msg_id）2026-09-25 实测可用；主动流式（无 msg_id）仍 50015001。默认关闭（.env QQ_STREAM=1 打开）。
  // 打开后先用流式气泡显示"⏳ 正在处理…"，结束时把正文追加进同一条气泡，不额外占被动回复额度。
  // 注意：已下发的前缀擦不掉（replace 模式也要求以上次内容开头），所以那行占位文字会一直留在气泡里。
  let streamId = null;
  let streamIndex = 0;
  let streamLen = 0;
  const streamCap = 2000;
  // 流式气泡一旦开了就必须收尾，否则 QQ 那边永远停在"⏳ 正在处理…"（成功/取消/报错三条路都要收）
  const closeStream = async (tail) => {
    if (!streamId || !chan) return false;
    const id = streamId;
    streamId = null;
    const body = tail ? '\n\n' + tail : '';
    return streamChunk(bot, chan.target, id, ++streamIndex, body, true, msgId, msgSeq).catch(() => false);
  };
  if (cfg.qqStream && notifyQQ && chan && chan.kind === 'c2c' && msgId) {
    streamId = await streamOpen(bot, chan.target, '⏳ 正在处理…', msgId, msgSeq).catch(() => null);
    if (streamId) {
      streamLen = 8;
      usedSeq += 1;
      log(`[${bot.id}] 流式消息已开启`);
    } else {
      log(`[${bot.id}] 流式消息不可用，本次回退普通消息`);
    }
  }
  // 单聊用"正在输入"状态做存活提示：不产生聊天记录，且把额度让给正文（最多用 2 个提示位）
  const useTyping = !streamId && !!(notifyQQ && chan && chan.typing && msgId && cfg.pingStyle !== 'text');
  const progressPing = () => {
    if (!running.get(userKey)) return;
    const proc = activeProcs.get(userKey);
    if (!proc || proc.exitCode !== null) { running.delete(userKey); return; }
    if (streamId) {
      // 流式气泡本身就是存活信号，不再额外发提示
    } else if (useTyping && usedSeq < 2) {
      usedSeq += 1;
      chan.typing(msgId, 1, 60).catch(() => {});
    } else if (!useTyping && notifyQQ && chan && usedSeq < replyLimit - 1) {
      sendSlot('处理中…').catch(() => {});
    }
    progressTimer = setTimeout(progressPing, useTyping ? 50000 : 120000);
  };
  if (useTyping) { usedSeq += 1; chan.typing(msgId, 1, 60).catch(() => {}); }
  if (!streamId) progressTimer = setTimeout(progressPing, useTyping ? 50000 : 120000);
  try {
    // 2026-10-11 用户要求：每条消息把「当前话题名」一并带给模型——机器人的 AGENTS.md 里有按话题名分流的规则
    // 某些机器人会按题名把任务路由到其他本地项目，而模型本来看不到题名。
    // 只作上下文，明确让模型不要写进回复；聊天记录存的仍是 displayText，不含这行附注。
    const topicName = ((botTopics(bot).topics[topicId] || {}).name || '').trim();
    const topicNote = topicName ? `（当前 QQ 话题名：「${topicName}」，仅作上下文，不要在回复里提及。）\n\n` : '';
    const reply = await runCodex(
      topicNote + prompt,
      userKey,
      bot.projectDir,
      userKey + ':' + topicId,
      { botId: bot.id, topicId, ownerKey: userKey }
    );
    if (cancelled.has(userKey)) { cancelled.delete(userKey); await closeStream('（已取消）'); return { ok: false, reason: 'cancelled' }; }
    log(`[${bot.id}] codex done, reply length:`, reply.length);
    // 「直连」跑成功才算送出：先留档，再清空队列、退出收件箱模式。
    // 失败/取消时队列原样保留（见上面的 cancelled 分支与 catch 分支），碎片不会蒸发。
    let inboxNote = '';
    if (inboxFlush) {
      const arch = archiveInboxBatch(bot, topicId, inboxFlush, '已处理');
      const flushedCount = inboxFlush.length;
      finishInboxFlush(bot, topicId);
      inboxFlush = null;
      broadcastTopics(bot);
      inboxNote = `（收件箱本批 ${flushedCount} 条已送出，队列已清空`
        + (arch ? `，留档在 ${arch}` : '') + '）';
    }
    // 回复里的 <qqfile>路径</qqfile> 是"把文件发给用户"的声明，正文里不显示这些标签
    const { text: replyTextBase, paths: mediaPaths } = extractMediaPaths(reply);
    const replyText = inboxNote ? replyTextBase + '\n\n' + inboxNote : replyTextBase;
    const sentFiles = [];
    if (notifyQQ && chan) {
      let streamed = false;
      if (streamId) {
        const fits = streamLen + replyText.length + 2 <= streamCap;
        const ok = await closeStream(fits ? replyText : '');
        if (ok) {
          streamed = true;
          if (!fits) log(`[${bot.id}] 正文超出流式上限，仅收尾气泡，正文另发`);
          log(`[${bot.id}] 流式消息已收尾`);
        } else {
          log(`[${bot.id}] 流式收尾失败，改用普通消息`);
        }
      }
      if (!streamed) {
        const budget = Math.max(1, replyLimit - usedSeq);
        const all = chunkText(replyText, 1500);
        const chunks = all.slice(0, budget);
        for (const c of chunks) { if (!(await sendSlot(c, { markdown: true }))) break; }
        if (all.length > budget && usedSeq < replyLimit) await sendSlot('（内容过长，已截断）', { markdown: true });
      }
      // 文件在正文之后发；每条媒体占一次额度，最多 2 个，且不挤掉正文那一格
      const fileCap = Math.min(2, Math.max(0, replyLimit - usedSeq));
      const chosen = mediaPaths.slice(0, fileCap);
      if (mediaPaths.length > chosen.length) {
        log(`[${bot.id}] 回复里声明了 ${mediaPaths.length} 个文件，受被动回复额度限制只发前 ${chosen.length} 个`);
      }
      for (const f of chosen) {
        const info = await uploadMedia(bot, chan, f);
        if (!info) continue;
        if (await sendSlotMedia(info)) sentFiles.push(path.basename(f));
      }
    }
    const failedFiles = mediaPaths.filter(f => !sentFiles.includes(path.basename(f)));
    const storedText = replyText
      + (sentFiles.length ? `\n\n[已通过 QQ 发送文件] ${sentFiles.join('、')}` : '')
      + (failedFiles.length ? `\n\n[文件未送出] ${failedFiles.map(f => path.basename(f)).join('、')}` : '');
    pushChat(bot, topicId, { role: 'codex', text: storedText });
    appendTranscript(bot, topicId, 'Codex', storedText);
    broadcast({ type: 'chat', bot: bot.id, topic: topicId, entry: chatLogs.get(bot.id + ':' + topicId).slice(-1)[0] });
    return { ok: true, reply: replyText };
  } catch (e) {
    log(`[${bot.id}] codex error:`, e.message);
    if (cancelled.has(userKey)) { cancelled.delete(userKey); await closeStream('（已取消）'); return { ok: false, reason: 'cancelled' }; }
    const errText = '处理出错：' + String(e.message).slice(0, 200)
      + (inboxFlush ? '\n本批已放回收件箱，可重新发送「直连」。' : '');
    if (notifyQQ && chan) {
      // 报错也走收尾气泡，避免留下一个永远转圈的"正在处理…"
      const closed = await closeStream(errText);
      if (!closed) await sendSlot(errText, { markdown: true });
    }
    pushChat(bot, topicId, { role: 'codex', text: errText });
    broadcast({ type: 'chat', bot: bot.id, topic: topicId, entry: chatLogs.get(bot.id + ':' + topicId).slice(-1)[0] });
    return { ok: false, error: String(e.message) };
  } finally {
    clearTimeout(progressTimer);
    // 成功路径已在上面 finishInboxFlush；失败、取消或其他异常路径统一恢复本批。
    if (inboxFlush) {
      restoreInboxFlush(bot, topicId);
      broadcastTopics(bot);
    }
    running.delete(userKey);
    broadcastStatus(bot);
  }
}

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
        <title>QQ Bot Bridge v1.1.0</title>
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
        <h1>QQ Bot Bridge v1.1.0</h1>
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
        res.end(JSON.stringify(cfg.bots.map(b => ({
          id: b.id, name: b.name, status: botStatus(b),
          avatar: avatarFile(b) ? '/api/avatar?bot=' + encodeURIComponent(b.id) : null,
        }))));
      } else if (req.method === 'GET' && p === '/api/avatar') {
        const bot = cfg.bots.find(b => b.id === url.searchParams.get('bot'));
        const file = bot ? avatarFile(bot) : null;
        if (!file) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('no avatar');
        } else {
          const ext = path.extname(file).toLowerCase();
          res.writeHead(200, {
            'Content-Type': AVATAR_MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
          });
          res.end(readFileSync(file));
        }
      } else if (req.method === 'GET' && p === '/api/chat') {
        const bot = cfg.bots.find(b => b.id === url.searchParams.get('bot'));
        let topic = url.searchParams.get('topic');
        if (bot) {
          if (!topic) topic = ensureTopic(bot);
          loadTranscriptHistory(bot, topic);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(bot && topic ? (chatLogs.get(bot.id + ':' + topic) || []) : []));
      } else if (req.method === 'GET' && p === '/api/topics') {
        const bot = cfg.bots.find(b => b.id === url.searchParams.get('bot'));
        let out = { ok: false };
        if (bot) {
          const cur = ensureTopic(bot);
          out = { ok: true, current: cur, topics: activeTopicList(bot) };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
      } else if (req.method === 'POST' && p === '/api/topic') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
          let data = {};
          try { data = JSON.parse(body); } catch {}
          const bot = cfg.bots.find(b => b.id === data.bot);
          if (!bot) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '缺少 bot' }));
            return;
          }
          const action = String(data.action || '');
          const st = botTopics(bot);
          const topic = String(data.topic || '');
          let msg = '';
          if (action === 'new') {
            const id = newTopic(bot, data.name);
            msg = '已新建话题：' + botTopics(bot).topics[id].name;
          } else if (action === 'switch') {
            if (!st.topics[topic]) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: '未找到话题' }));
              return;
            }
            switchTopic(bot, topic);
            msg = '已切换到话题：' + st.topics[topic].name;
          } else if (action === 'archive') {
            const target = topic && st.topics[topic] ? topic : st.current;
            const before = st.current;
            const archivedName = st.topics[target] ? st.topics[target].name : '';
            if (!archiveTopic(bot, target)) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: '未找到话题' }));
              return;
            }
            msg = archiveReplyText(bot, archivedName, before, botTopics(bot).current);
          } else if (action === 'rename') {
            const name = String(data.name || '').trim().slice(0, 30);
            if (!name) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: '缺少名称' }));
              return;
            }
            const target = topic && st.topics[topic] ? topic : st.current;
            if (!st.topics[target]) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: '未找到话题' }));
              return;
            }
            st.topics[target].name = name;
            persistTopics();
            msg = '已重命名话题：' + name;
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '未知操作' }));
            return;
          }
          broadcastTopics(bot);
          const openid = botLastContact.get(bot.id) || '';
          if (openid) sendC2CText(bot, openid, msg, null, 1).catch(() => {});
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, current: botTopics(bot).current, topics: activeTopicList(bot), msg }));
        });
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
          // 面板推送默认发给该机器人管理员（QQBOTS_JSON.adminOpenid），未配置时回退最近 QQ 会话对象
          const targetOpenid = bot.adminOpenid || botLastContact.get(bot.id) || '';
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
      } else if (req.method === 'POST' && p === '/api/notify') {
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
          const requested = String(data.openid || '');
          let targets = [];
          if (requested && requested !== 'all' && cfg.allowedOpenids.includes(requested)) {
            targets = [requested];
          } else if (requested === 'all' || cfg.broadcastNotify[bot.id]) {
            const list = botContacts.get(bot.id) || {};
            targets = Object.keys(list);
            if (!targets.length) {
              const last = botLastContact.get(bot.id) || '';
              if (last) targets = [last];
            }
          } else {
            const last = botLastContact.get(bot.id) || '';
            if (last) targets = [last];
          }
          if (!targets.length) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '没有可推送的QQ会话目标。请先让用户给该机器人发一条QQ消息，或传入白名单内的 openid。' }));
            return;
          }
          let sent = 0;
          const failed = [];
          // markdown=true 时走 msg_type=2（发失败自动降级纯文本，见 sendMessage）
          const mdOpts = data.markdown === true ? { markdown: true } : undefined;
          for (const oid of targets) {
            try {
              if (await sendC2CText(bot, oid, msg, null, 1, mdOpts)) sent++;
              else failed.push({ openid: oid, error: '发送失败（QQ 返回非 2xx）' });
            } catch (e) {
              failed.push({ openid: oid, error: String(e.message).slice(0, 120) });
            }
            if (targets.length > 1) await new Promise(r => setTimeout(r, 150));
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: sent > 0, sent, failed, total: targets.length }));
        });
      } else if (req.method === 'POST' && p === '/api/file') {
        // 把本机文件发到 QQ：{bot, path, openid?}
        // 目标口径与 /api/notify 完全一致（2026-09-21 改，此前是"省略 openid 一律发管理员"）：
        //   省略 openid = 按该机器人群发开关 broadcastNotify：开=发所有联系人，关=发管理员（回退最近会话）；
        //   openid="all" = 强制群发；白名单内 openid = 强制单发（绕过开关）。
        // 单聊富媒体是按用户上传的（file_info 与 user_openid 绑定），所以群发时逐个目标各上传一次。
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
          let data = {};
          try { data = JSON.parse(body); } catch {}
          const bot = cfg.bots.find(b => b.id === data.bot);
          const filePath = String(data.path || '').trim();
          if (!bot || !filePath) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '缺少 bot 或 path' }));
            return;
          }
          const requested = String(data.openid || '').trim();
          let targets = [];
          if (requested && requested !== 'all' && cfg.allowedOpenids.includes(requested)) {
            targets = [requested];
          } else if (requested === 'all' || cfg.broadcastNotify[bot.id]) {
            targets = Object.keys(botContacts.get(bot.id) || {});
            if (!targets.length) {
              const last = bot.adminOpenid || botLastContact.get(bot.id) || '';
              if (last) targets = [last];
            }
          } else {
            const last = bot.adminOpenid || botLastContact.get(bot.id) || '';
            if (last) targets = [last];
          }
          if (!targets.length) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: '没有可推送的QQ会话目标，请先让用户给该机器人发一条QQ消息，或传入白名单内的 openid。' }));
            return;
          }
          let sent = 0;
          const failed = [];
          for (const oid of targets) {
            const chan = {
              kind: 'c2c',
              target: oid,
              sender: oid,
              send: (content, msgId, msgSeq, opts) => sendC2CText(bot, oid, content, msgId, msgSeq, opts),
            };
            try {
              const info = await uploadMedia(bot, chan, filePath);
              if (!info) {
                failed.push({ openid: oid, error: '上传失败，详见 logs/bridge.log 里的 err_code 行' });
              } else if (await sendMedia(bot, chan, info, null, 1)) {
                sent += 1;
              } else {
                failed.push({ openid: oid, error: '发送失败（QQ 返回非 2xx）' });
              }
            } catch (e) {
              failed.push({ openid: oid, error: String(e.message).slice(0, 120) });
            }
            if (targets.length > 1) await new Promise(r => setTimeout(r, 150));
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: sent > 0, file: path.basename(filePath),
            sent, failed, total: targets.length }));
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
        res.end(JSON.stringify({ ok: true, icloudDir: cfg.icloudDir, broadcastNotify: cfg.broadcastNotify }));
      } else if (req.method === 'POST' && p === '/api/settings') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          let data = {};
          try { data = JSON.parse(body); } catch {}
          if (data.icloudDir !== undefined && data.icloudDir !== null) {
            const dir = String(data.icloudDir).trim().replace(/[\\/]+$/, '');
            const valid = /^[a-zA-Z]:[\\/]/.test(dir) || /^\\/.test(dir);
            if (!valid) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: '路径无效，请输入本机绝对路径' }));
              return;
            }
            try {
              mkdirSync(dir, { recursive: true });
              cfg.icloudDir = dir;
              setEnvValue(ENV_FILE, 'ICLOUD_DIR', dir);
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: e.message }));
              return;
            }
          }
          if (typeof data.broadcastNotify === 'boolean' && data.bot && cfg.broadcastNotify[data.bot] !== undefined) {
            cfg.broadcastNotify[data.bot] = data.broadcastNotify;
            persistSettings();
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, icloudDir: cfg.icloudDir, broadcastNotify: cfg.broadcastNotify }));
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
function appendTranscript(bot, topicId, role, text) {
  try {
    const ts = fmtLogTime(new Date().toISOString());
    const line = `[${ts}] ${role}: ${escapeTranscript(text)}`;
    mkdirSync(path.dirname(topicFile(bot, topicId)), { recursive: true });
    appendFileSync(topicFile(bot, topicId), line + '\n');
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
      send: (content, msgId, msgSeq, opts) => sendGroupText(bot, d.group_openid, content, msgId, msgSeq, opts),
    };
  }
  const sender = author.user_openid || '';
  return {
    kind: 'c2c',
    target: sender,
    sender,
    allow: !!cfg.allowedOpenids.length && !!sender && cfg.allowedOpenids.includes(sender),
    send: (content, msgId, msgSeq, opts) => sendC2CText(bot, sender, content, msgId, msgSeq, opts),
    typing: (msgId, msgSeq, seconds) => sendTypingC2C(bot, sender, msgId, msgSeq, seconds),
  };
}

async function onChatMessage(bot, d) {
  const msgId = d.id;
  const chan = makeChannel(bot, d);
  const openid = chan.sender;
  let content = (d.content || '').trim();
  // 事件体里没有 msg_seq（它是发送侧的回复序号，用于避免同一条消息重复回复），
  // 之前这里读 d.msg_seq 永远是 undefined→1。被动回复序号改为本地维护：1 给存活提示，2 起给正文。
  const msgSeq = 1;
  const topicId = ensureTopic(bot);

  if (!chan.target || !openid) return;
  if (chan.kind === 'c2c') {
    // 所有聊过天的用户都登记为联系人（群发推送用），不限于白名单；任务执行仍受白名单限制
    const list = botContacts.get(bot.id) || {};
    const uname = (d && d.author && d.author.username) ? String(d.author.username) : '';
    list[openid] = { name: uname, lastActiveAt: Date.now() };
    botContacts.set(bot.id, list);
    persistContacts();
  }
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

  // 非管理员：仅放行快捷指令/帮助；附件与其他消息一律拦截（不落盘、不进 Codex）
  const codexAllowed = !cfg.codexOpenids.length || cfg.codexOpenids.includes(openid);
  // ask 两步式（如"个股"）的编号回复也要放行，否则非管理员在入口即被拦，
  // 消息根本到不了 processBotText 的 pendingAsk 分支
  const trimmed = String(content || '').trim();
  // 配了兜底指令 "*" 的机器人：非管理员的纯文本放行，交给本地脚本处理（不进 Codex）
  const localOnly = hasBotFallback(bot) && !(Array.isArray(d.attachments) && d.attachments.length);
  const gateCmd = findBotCommand(bot, trimmed);
  // 仅管理员可用的快捷指令（adminOnly）：非管理员在入口就拦掉并说明原因
  if (!codexAllowed && isAdminOnlyCmd(gateCmd)) {
    log(`[${bot.id}] admin-only cmd blocked from`, openid, ':', trimmed.slice(0, 40));
    await chan.send('该指令仅管理员可用。', msgId, msgSeq).catch(() => {});
    return;
  }
  if (!codexAllowed && !localOnly && !/^(帮助|help|菜单|指令)$/i.test(trimmed) && !gateCmd
      && !isAskReply(bot, trimmed)) {
    const cmds = botCommandNames(bot, codexAllowed);
    const hint = cmds.length ? '我只能使用快捷指令：' + cmds.join(' / ') + '。' : '';
    log(`[${bot.id}] restricted non-admin msg from`, openid, ':', content.slice(0, 80));
    await chan.send((hint || '当前仅管理员可对话。') + '其他功能请联系管理员。', msgId, msgSeq).catch(() => {});
    return;
  }

  const attachments = Array.isArray(d.attachments) ? d.attachments : [];
  const saved = [];
  const voiceTexts = [];
  const voiceFiles = [];
  for (const att of attachments) {
    // 语音消息可能没有 filename，只要有一个可下载地址就收
    if (!att || !(att.url || att.voice_wav_url)) continue;
    try {
      const rec = await downloadAttachment(bot, att);
      saved.push(rec);
      if (rec.isVoice) {
        const asr = String(att.asr_refer_text || '').trim();
        if (asr) voiceTexts.push(asr);
        voiceFiles.push(rec.path);
      }
    } catch (e) {
      log(`[${bot.id}] attachment download error:`, e.message);
    }
  }

  // 语音消息：QQ 已经给出 ASR 文本，直接当文字指令跑（音频文件照样归档），
  // 没有识别结果时才退回"先存后议"。
  const voiceText = voiceTexts.join('\n').trim();
  if (voiceText) {
    log(`[${bot.id}] voice→text from`, openid, `(${chan.kind}):`, voiceText.slice(0, 80));
    recentFiles[userKey] = [...(recentFiles[userKey] || []).slice(-8), ...saved.map(s => s.path)];
    persistRecentFiles();
    content = voiceText;
  }

  // 收件箱模式：附件也进队列（记路径），不走"先存后议"
  if (saved.length && !voiceText && inboxModeOn(bot, topicId)) {
    const files = saved.map(s => s.path);
    const names = saved.map(s => s.name).join('、');
    log(`[${bot.id}] inbox attachment from`, openid, `(${chan.kind}):`, names);
    await addInboxItem(bot, topicId, content, files, chan, msgId, msgSeq, true);
    recentFiles[userKey] = [...(recentFiles[userKey] || []).slice(-8), ...files];
    persistRecentFiles();
    const shown = `[收件箱·附件] ${names}` + (content ? ` ${content}` : '');
    appendTranscript(bot, topicId, '用户', shown);
    pushChat(bot, topicId, { role: 'user', text: shown });
    broadcast({ type: 'chat', bot: bot.id, topic: topicId, entry: chatLogs.get(bot.id + ':' + topicId).slice(-1)[0] });
    return;
  }

  // 先存后议：有附件时只归档，不调 Codex，等用户下一步文字指令
  if (saved.length && !voiceText) {
    log(`[${bot.id}] msg from`, openid, `(${chan.kind}): [附件]`, saved.map(s => s.name).join('、'));
    const summary = saved.map(s => s.name).join('、');
    await chan.send(`已收到并归档：${summary}\n存放位置：收件箱\\${bot.name}\\${localDateStr()}\n等你下一步指示。`, msgId, msgSeq);
    recentFiles[userKey] = [...(recentFiles[userKey] || []).slice(-8), ...saved.map(s => s.path)];
    persistRecentFiles();
    appendTranscript(bot, topicId, '用户', `[附件] ${summary}`);
    pushChat(bot, topicId, { role: 'user', text: `[附件] ${summary}` });
    broadcast({ type: 'chat', bot: bot.id, topic: topicId, entry: chatLogs.get(bot.id + ':' + topicId).slice(-1)[0] });
    return;
  }

  let prompt = content;
  if (voiceText) {
    prompt = `（用户发来语音消息，以下是语音转文字结果；原始音频已归档在：${voiceFiles.join('；')}）\n${prompt}`;
  }
  const known = recentFiles[userKey] || [];
  if (known.length) {
    prompt += `\n\n（用户此前通过 QQ 发来的文件已归档在收件箱：\n${known.join('\n')}\n若用户要求分析/处理其中某个文件，请读取对应文件；否则无需理会）`;
  }
  if (!prompt) return;

  // 语音消息在聊天记录/面板里标记 [语音]，命令匹配时会剥掉这个前缀（见 processBotText 里的 t）
  const displayText = voiceText ? `[语音] ${voiceText}` : content;
  log(`[${bot.id}] msg from`, openid, `(${chan.kind}):`, displayText.slice(0, 120));
  await processBotText(bot, prompt, displayText, {
    chan, msgId, msgSeq, notifyQQ: true, userKey, inboxFiles: saved.map(s => s.path),
  });
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
        // 带上 msg_id：流式 / 引用 / 撤回排查都要它（2026-09-25 加）
        log(`[${bot.id}] event:`, msg.t, (msg.d && msg.d.id) ? `msg_id=${msg.d.id}` : '');
        onChatMessage(bot, msg.d).catch(e => log(`[${bot.id}] chat handler error:`, e.message));
      } else if (msg.t === 'FRIEND_ADD' || msg.t === 'FRIEND_DEL') {
        const fd = msg.d || {};
        const fOpenid = (fd.author && fd.author.user_openid) || fd.user_openid || fd.openid || '';
        log(`[${bot.id}] event:`, msg.t, fOpenid ? `openid=${fOpenid}` : '(无 openid 字段)');
        if (msg.t === 'FRIEND_ADD' && fOpenid) {
          const list = botContacts.get(bot.id) || {};
          const uname = (fd.author && fd.author.username) ? String(fd.author.username) : '';
          list[fOpenid] = { name: uname, lastActiveAt: Date.now() };
          botContacts.set(bot.id, list);
          persistContacts();
        }
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
  log('回复通道: API 域名 api.bot.qq.com | markdown=on | 存活提示=' + cfg.pingStyle
    + ' | 流式消息=' + (cfg.qqStream ? 'on' : 'off（QQ 侧暂未开放，接口返回 50015001）'));
  if (!cfg.allowedOpenids.length) {
    log('SECURITY: ALLOWED_OPENIDS is empty -> safe mode. No Codex task runs until the whitelist is configured.');
  } else {
    log('whitelist entries:', cfg.allowedOpenids.length);
  }
  for (const bot of cfg.bots) {
    connectGateway(bot).catch(e => log(`[${bot.id}] connect failed:`, e.message));
  }
  for (const bot of cfg.bots) ensureTopic(bot);
  for (const bot of cfg.bots) backfillHistoryFromLog(bot);
  for (const bot of cfg.bots) backfillRepliesFromSessions(bot);
  for (const bot of cfg.bots) loadTranscriptHistory(bot, ensureTopic(bot));
  startWatchDir();
  startPanelServer();
}

main().catch(e => {
  log('fatal:', e.message);
  process.exit(1);
});

process.on('uncaughtException', e => log('uncaught:', e.message));
process.on('unhandledRejection', e => log('unhandled:', e && e.message));
