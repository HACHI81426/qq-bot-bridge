// QQ 机器人「自定义菜单 + 指令面板」维护工具
//
//   node tools/qq-menu.mjs get <机器人id>            # 查询线上现状（菜单 + 面板列表）
//   node tools/qq-menu.mjs push <机器人id>           # 按机器人项目目录里的 menu.json / panel.json 下发
//   node tools/qq-menu.mjs delete-panel <机器人id> <panel_id>
//
// 配置约定（与 HELP.md / commands.json 一样放在机器人自己的项目目录里，即 QQBOTS_JSON 的 workDir）：
//   menu.json  —— { "items": [ {type:send_message|link|menu|switch, name, send_message?, link?, sub_menu_items?} ] }
//                 全局自定义菜单，最多 10 项、名称最多 10 字符（一个汉字算 2）
//   panel.json —— { "remark":"my-bot-c2c", "scope":"c2c", "target_type":"all", "panel":{ "items":[ {type:command|link,name,desc,link?} ] } }
//                 指令面板，remark 是本工具用来认出"要更新哪块面板"的稳定键
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.dirname(__dirname);
const BASE = 'https://api.bot.qq.com';

function loadEnv(file) {
  const cfg = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return cfg;
}

const env = loadEnv(path.join(BRIDGE_DIR, '.env'));
const bots = JSON.parse(env.QQBOTS_JSON || '[]');

async function tokenOf(bot) {
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: bot.appId, clientSecret: bot.clientSecret }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('取 token 失败：' + JSON.stringify(data).slice(0, 200));
  return data.access_token;
}

function makeApi(bot, token) {
  return async function api(method, p, body) {
    const res = await fetch(BASE + p, {
      method,
      headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) {
      const code = data.err_code || data.code || res.status;
      console.log(`  ${method} ${p} -> ${res.status} err_code=${code} ${String(data.message || text).slice(0, 160)}`);
    }
    return { ok: res.ok, status: res.status, data };
  };
}

// 官方要求：查列表必须带 scope（c2c/group/channel/dm）
async function listAllPanels(api, scope) {
  const records = [];
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const q = `?scope=${encodeURIComponent(scope)}&limit=50` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await api('GET', `/v2/panels${q}`);
    if (!r.ok) break;
    const recs = Array.isArray(r.data.records) ? r.data.records : [];
    records.push(...recs);
    if (r.data.is_end !== false || !r.data.next_cursor) break;
    cursor = r.data.next_cursor;
  }
  return records;
}

function readJsonIfExists(file) {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

// 官方长度口径：一个中文汉字（含全角标点）算 2 个字符
function charWeight(s) {
  let n = 0;
  for (const ch of String(s == null ? '' : s)) {
    n += /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef\u2018-\u201d]/.test(ch) ? 2 : 1;
  }
  return n;
}

// 本地先校验一遍官方限制，避免撞 40030013「超出数量限制」（它其实也用来报"字段超长"，不看 limit 字段很容易误判）
function validateMenu(items) {
  const errs = [];
  if (items.length > 10) errs.push(`菜单项 ${items.length} 个，最多 10 个`);
  for (const it of items) {
    if (charWeight(it.name) > 10) errs.push(`菜单项名「${it.name}」${charWeight(it.name)} 字符，上限 10`);
    if (it.type === 'link' && !/^https:\/\//.test(String(it.link || ''))) errs.push(`菜单项「${it.name}」的 link 必须以 https:// 开头`);
    if (it.type === 'menu') {
      const sub = it.sub_menu_items || [];
      if (!sub.length || sub.length > 5) errs.push(`「${it.name}」子菜单 ${sub.length} 项，需 1-5 项`);
      for (const s of sub) {
        if (charWeight(s.name) > 14) errs.push(`子菜单名「${s.name}」${charWeight(s.name)} 字符，上限 14`);
        if (s.type === 'menu') errs.push(`子菜单「${s.name}」不能再嵌套 menu`);
        if (s.type === 'link' && !/^https:\/\//.test(String(s.link || ''))) errs.push(`子菜单「${s.name}」的 link 必须以 https:// 开头`);
      }
    }
  }
  return errs;
}

function validatePanel(items) {
  const errs = [];
  if (items.length > 20) errs.push(`面板元素 ${items.length} 个，最多 20 个`);
  for (const it of items) {
    if (charWeight(it.name) > 14) errs.push(`面板元素名「${it.name}」${charWeight(it.name)} 字符，上限 14`);
    if (it.desc !== undefined && charWeight(it.desc) > 30) {
      errs.push(`「${it.name}」的 desc「${it.desc}」${charWeight(it.desc)} 字符，上限 30（汉字算 2）`);
    }
    if (it.type === 'link' && !/^https:\/\//.test(String(it.link || ''))) errs.push(`面板元素「${it.name}」的 link 必须以 https:// 开头`);
  }
  return errs;
}

async function main() {
  const [cmd, botKey, extra] = process.argv.slice(2);
  const bot = bots.find(b => [b.id, b.accountId, b.name].includes(botKey));
  if (!cmd || !bot) {
    console.log('用法：node tools/qq-menu.mjs get|push|delete-panel <机器人id> [panel_id]');
    console.log('可用机器人：' + bots.map(b => `${b.id}(${b.name})`).join('、'));
    process.exit(1);
  }
  const token = await tokenOf(bot);
  const api = makeApi(bot, token);
  const workDir = bot.workDir || BRIDGE_DIR;
  console.log(`机器人 ${bot.accountId || bot.id}（${bot.name}） 项目目录 ${workDir}`);

  if (cmd === 'get') {
    const menu = await api('GET', '/v2/menu');
    console.log('菜单：', JSON.stringify(menu.data));
    for (const scope of ['c2c', 'group', 'channel', 'dm']) {
      const panels = await listAllPanels(api, scope);
      if (!panels.length) continue;
      console.log(`面板（${scope}，${panels.length} 个）：`);
      for (const p of panels) {
        console.log(`  ${p.panel_id} target=${p.target_type} remark=${p.panel && p.panel.remark} v${p.version}`);
        console.log('    items: ' + (p.panel && p.panel.items ? p.panel.items.map(i => `${i.name}/${i.type}`).join(', ') : ''));
      }
    }
    return;
  }

  if (cmd === 'delete-panel') {
    const r = await api('DELETE', `/v2/panels/${extra}`);
    console.log(r.ok ? '已删除' : '删除失败');
    return;
  }

  if (cmd === 'push') {
    const menuCfg = readJsonIfExists(path.join(workDir, 'menu.json'));
    if (menuCfg) {
      const errs = validateMenu(menuCfg.items || []);
      if (errs.length) {
        console.log('菜单校验不通过，未下发：');
        for (const e of errs) console.log('  - ' + e);
        process.exitCode = 1;
        return;
      }
      const r = await api('PUT', '/v2/menu', { menu: { items: menuCfg.items || [] } });
      console.log(r.ok ? `菜单已更新，version=${r.data.version}` : '菜单更新失败');
    } else {
      console.log('（没有 menu.json，跳过菜单）');
    }

    const panelCfg = readJsonIfExists(path.join(workDir, 'panel.json'));
    if (panelCfg) {
      const { remark, ...panel } = panelCfg;
      const errs = validatePanel((panel.panel && panel.panel.items) || []);
      if (errs.length) {
        console.log('面板校验不通过，未下发：');
        for (const e of errs) console.log('  - ' + e);
        process.exitCode = 1;
        return;
      }
      const panels = panel.scope ? await listAllPanels(api, panel.scope) : [];
      const exist = panels.find(p => p.panel && p.panel.remark === remark);
      if (exist) {
        // 修改面板只收 panel（scope/target_type 不在请求体里，见 40030021：全局面板不支持改关联对象）
        const r = await api('PUT', `/v2/panels/${exist.panel_id}`, { panel: { ...panel.panel, remark } });
        console.log(r.ok ? `面板已更新（${exist.panel_id}，version=${r.data.version}）` : '面板更新失败');
      } else {
        const r = await api('POST', '/v2/panels', { ...panel, panel: { ...panel.panel, remark } });
        console.log(r.ok ? `面板已创建（${r.data.panel_id}）` : '面板创建失败');
      }
    } else {
      console.log('（没有 panel.json，跳过面板）');
    }
    return;
  }

  console.log('未知命令：' + cmd);
}

main().catch(e => {
  console.log('出错：' + e.message);
  process.exit(1);
});
