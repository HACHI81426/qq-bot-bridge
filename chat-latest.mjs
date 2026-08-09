import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, 'logs', 'bridge.log');
const STATE_FILE = path.join(__dirname, 'data', 'log-offset.txt');

if (!existsSync(LOG_FILE)) {
  console.log('（日志不存在）');
  process.exit(0);
}

let offset = 0;
try { offset = Number(readFileSync(STATE_FILE, 'utf8')) || 0; } catch {}

const size = statSync(LOG_FILE).size;
if (size < offset) offset = 0; // 日志被清空/重建时从头读

const text = readFileSync(LOG_FILE).slice(offset, size).toString('utf8');
const lines = text.split('\n');
const done = lines.slice(0, -1);
const out = done.join('\n');

const newOffset = offset + Buffer.byteLength(out + '\n', 'utf8');
try {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, String(newOffset));
} catch {}

if (out.trim()) {
  console.log('--- QQ 新聊天记录 ---');
  console.log(out);
}
