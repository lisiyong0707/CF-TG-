/**
 * Domain Manager Pro - 开发者友好注释版
 * UI风格：现代白色通栏 + 呼吸发光特效
 * 核心逻辑：完整字段支持 + 180天/90天多级提醒
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/health') return ok({ kv: !!env.KV });
      if (path === '/' || path === '/index.html') return html(getHTML());
      if (path === '/api/telegram/webhook' && request.method === 'POST') return handleWebhook(request, env);
      if (!path.startsWith('/api/')) return new Response('Not Found', { status: 404 });
      if (path === '/api/login' && request.method === 'POST') return doLogin(request, env);

      const authed = await checkAuth(request, env);
      if (!authed) return ok({ error: 'Unauthorized' }, 401);

      return route(request, env, path);
    } catch (e) {
      return ok({ error: e.message }, 500);
    }
  },
  async scheduled(e, env) {
    await dailyCheck(env);
  },
};

// ==========================================
// 1. 权限验证逻辑
// ==========================================
async function doLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return ok({ error: '格式错误' }, 400); }
  // 这里的 admin123 是默认密码，建议在环境变量中设置 ADMIN_PASSWORD
  const pw = env.ADMIN_PASSWORD || 'admin123';
  if (!body.password || body.password !== pw) return ok({ error: '密码错误' }, 401);
  const token = await makeToken(pw);
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': 'dm_auth=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800',
    },
  });
}

async function checkAuth(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const token = (cookie.match(/dm_auth=([^;]+)/) || [])[1];
  if (!token) return false;
  try {
    const [p, s] = token.split('.');
    const expected = await sign(p, env.ADMIN_PASSWORD || 'admin123');
    return s === expected && Date.now() < JSON.parse(atob(p)).exp;
  } catch { return false; }
}

async function makeToken(pw) {
  const p = btoa(JSON.stringify({ exp: Date.now() + 86400000 * 7 }));
  return p + '.' + await sign(p, pw);
}

async function sign(data, key) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(s)));
}

// ==========================================
// 2. 路由分发 (API 接口)
// ==========================================
async function route(request, env, path) {
  const m = request.method;
  const json = () => request.json().catch(() => ({}));

  if (path === '/api/logout' && m === 'POST')
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'dm_auth=; Path=/; Max-Age=0' } });

  if (path === '/api/stats') return ok(await getStats(env));

  if (path === '/api/domains') {
    if (m === 'GET') return ok(await getDomains(env));
    if (m === 'POST') return ok(await addDomain(await json(), env));
  }

  const did = (path.match(/^\/api\/domains\/(.+)$/) || [])[1];
  if (did) {
    if (m === 'PUT') return ok(await updDomain(did, await json(), env));
    if (m === 'DELETE') return ok(await delById(env, 'domains', did));
  }

  if (path === '/api/accounts') {
    if (m === 'GET') return ok(await kget(env, 'accounts'));
    if (m === 'POST') return ok(await addAcc(await json(), env));
  }

  const aid = (path.match(/^\/api\/accounts\/(.+)$/) || [])[1];
  if (aid) {
    if (m === 'PUT') return ok(await updAcc(aid, await json(), env));
    if (m === 'DELETE') return ok(await delById(env, 'accounts', aid));
  }

  if (path === '/api/cf-accounts') {
    if (m === 'GET') return ok((await kget(env, 'cf_accounts')).map(a => ({ ...a, apiToken: '***' })));
    if (m === 'POST') return addCF(await json(), env);
  }

  const cid = (path.match(/^\/api\/cf-accounts\/(.+)$/) || [])[1];
  if (cid && m === 'DELETE') return ok(await delById(env, 'cf_accounts', cid));

  if (path === '/api/cf-preview' && m === 'POST') return previewCF(await json(), env);
  if (path === '/api/cf-sync' && m === 'POST') return syncCF(await json(), env);

  if (path === '/api/telegram') {
    if (m === 'GET') { 
      const c = await tgCfg(env); 
      return ok({ chatId: c.chatId || '', botToken: c.botToken ? '***' : '' }); 
    }
    if (m === 'POST') return saveTg(await json(), env, request);
  }

  if (path === '/api/check' && m === 'POST') { 
    await dailyCheck(env); 
    return ok({ ok: true, msg: '检查完成' }); 
  }

  return ok({ error: 'Not Found' }, 404);
}

// ==========================================
// 3. 数据操作逻辑 (KV 存储)
// ==========================================
async function kget(env, key) { 
  if (!env.KV) return []; 
  try { return JSON.parse(await env.KV.get(key) || '[]'); } catch { return []; } 
}
async function kput(env, key, val) { 
  if (!env.KV) throw new Error('KV 未绑定'); 
  await env.KV.put(key, JSON.stringify(val)); 
}
async function kgetStr(env, key, def = '') { 
  if (!env.KV) return def; 
  try { return await env.KV.get(key) || def; } catch { return def; } 
}

async function getDomains(env) {
  const [domains, accs, cfAccs] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  const nm = {}; 
  [...accs, ...cfAccs].forEach(a => { nm[a.id] = a.name; });
  return domains.map(d => ({ 
    ...d, 
    accountName: nm[d.accountId] || '—', 
    daysLeft: days(d.expiryDate) 
  })).sort((a, b) => a.daysLeft - b.daysLeft);
}

// --- 这里修改默认提醒天数 [1, 15, 30, 90, 180] ---
async function addDomain(b, env) {
  const list = await kget(env, 'domains');
  const d = { 
    id: uid(), 
    name: b.name.trim().toLowerCase(), 
    accountId: b.accountId || '', 
    registrar: b.registrar || '', 
    registrarUrl: b.registrarUrl || '', 
    registeredAt: b.registeredAt || '', 
    expiryDate: b.expiryDate, 
    autoRenew: !!b.autoRenew, 
    reminderDays: b.reminderDays || [1, 15, 30, 90, 180], 
    notes: b.notes || '', 
    source: b.source || 'manual', 
    createdAt: now() 
  };
  list.push(d); 
  await kput(env, 'domains', list); 
  return d;
}

async function updDomain(id, b, env) {
  const list = await kget(env, 'domains');
  const i = list.findIndex(d => d.id === id);
  if (i < 0) throw new Error('不存在');
  list[i] = { ...list[i], ...b, id, updatedAt: now() };
  await kput(env, 'domains', list); 
  return list[i];
}

async function delById(env, key, id) {
  const list = await kget(env, key);
  await kput(env, key, list.filter(x => x.id !== id));
  return { ok: true };
}

// ==========================================
// 4. Cloudflare 自动化逻辑
// ==========================================
async function addCF(b, env) {
  const v = await cfApi('/accounts?per_page=1', b.apiToken);
  if (!v.success) return ok({ error: 'Token 无效' }, 400);
  const list = await kget(env, 'cf_accounts');
  const a = { id: uid(), name: b.name.trim(), apiToken: b.apiToken.trim(), cfAccountId: v.result?.[0]?.id || '', cfAccountName: v.result?.[0]?.name || '', type: 'cloudflare', createdAt: now() };
  list.push(a); await kput(env, 'cf_accounts', list);
  return ok({ ...a, apiToken: '***' });
}

async function syncCF(b, env) {
  const cf = (await kget(env, 'cf_accounts')).find(a => a.id === b.cfAccountId);
  const r = await fetchCFDomains(cf);
  const domains = await kget(env, 'domains');
  const nm = new Map(domains.map((d, i) => [d.name, i]));
  for (const d of r.domains) {
    if (nm.has(d.name)) {
      if (b.mode === 'all') { 
        const i = nm.get(d.name); 
        domains[i] = { ...domains[i], expiryDate: d.expiryDate || domains[i].expiryDate, autoRenew: d.autoRenew, source: d.source, updatedAt: now() }; 
      }
    } else {
      // --- 同步新域名时的默认提醒天数 ---
      domains.push({ 
        id: uid(), name: d.name, accountId: cf.id, registrar: 'Cloudflare', 
        registrarUrl: 'https://dash.cloudflare.com/' + cf.cfAccountId + '/domains', 
        registeredAt: d.registeredAt, expiryDate: d.expiryDate, autoRenew: d.autoRenew, 
        reminderDays: [1, 15, 30, 90, 180], notes: '', source: d.source, createdAt: now() 
      });
    }
  }
  await kput(env, 'domains', domains);
  return ok({ ok: true });
}

async function fetchCFDomains(cf) {
  const out = [];
  if (cf.cfAccountId) {
    const reg = await cfApi('/accounts/' + cf.cfAccountId + '/registrar/domains?per_page=200', cf.apiToken);
    if (reg.success) for (const d of reg.result || []) out.push({ name: d.name, registeredAt: (d.created_at || '').split('T')[0], expiryDate: (d.expires_at || '').split('T')[0], autoRenew: !!d.auto_renew, source: 'cf_registrar' });
  }
  const zones = await cfApi('/zones?per_page=200', cf.apiToken);
  if (zones.success) {
    const s = new Set(out.map(d => d.name));
    for (const z of zones.result || []) if (!s.has(z.name)) out.push({ name: z.name, registeredAt: (z.created_on || '').split('T')[0], expiryDate: '', autoRenew: false, source: 'cf_zone' });
  }
  return { ok: true, domains: out };
}

async function cfApi(path, token) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: { Authorization: 'Bearer ' + token } });
  return r.json();
}

async function addAcc(b, env) {
  const list = await kget(env, 'accounts');
  const a = { id: uid(), name: b.name.trim(), registrar: b.registrar || '', email: b.email || '', loginUrl: b.loginUrl || '', notes: b.notes || '', createdAt: now() };
  list.push(a); await kput(env, 'accounts', list); return a;
}

async function updAcc(id, b, env) {
  const list = await kget(env, 'accounts');
  const i = list.findIndex(a => a.id === id);
  list[i] = { ...list[i], ...b, id };
  await kput(env, 'accounts', list); return list[i];
}

async function getStats(env) {
  const [d, a, c] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  return { 
    ok: true, 
    total: d.length, 
    expired: d.filter(x => days(x.expiryDate) < 0).length, 
    expiring30: d.filter(x => { const v = days(x.expiryDate); return v >= 0 && v <= 30; }).length, 
    autoRenew: d.filter(x => x.autoRenew).length 
  };
}

// ==========================================
// 5. Telegram 消息机器人
// ==========================================
async function tgCfg(env) { return JSON.parse(await kgetStr(env, 'telegram_config', '{}')); }

async function saveTg(b, env, request) {
  const c = await tgCfg(env);
  if (b.chatId !== undefined) c.chatId = b.chatId;
  if (b.botToken && b.botToken !== '***') {
    c.botToken = b.botToken;
    const webhookUrl = new URL(request.url).origin + '/api/telegram/webhook';
    await fetch('https://api.telegram.org/bot' + c.botToken + '/setWebhook?url=' + webhookUrl);
  }
  await kput(env, 'telegram_config', c); return ok({ ok: true });
}

async function handleWebhook(request, env) {
  const u = await request.json().catch(() => ({}));
  const msg = u.message; if (!msg) return ok({ ok: true });
  const cid = msg.chat.id, txt = (msg.text || '').trim(), c = await tgCfg(env);
  
  if (txt === '/start') {
    await tg(c.botToken, cid, '🌐 *Domain Manager Pro*\n\n/domains — 列表\n/expiring — 近期到期');
  } 
  else if (txt === '/domains') {
    const list = await kget(env, 'domains');
    const lines = list.sort((a, b) => days(a.expiryDate) - days(b.expiryDate)).map(d => emoji(days(d.expiryDate)) + ' `' + d.name + '` — ' + dstr(d.expiryDate)).join('\n');
    await tg(c.botToken, cid, '🌐 *所有域名资产*\n\n' + lines);
  } 
  else if (txt === '/expiring') {
    const list = await kget(env, 'domains');
    const exp = list.filter(d => days(d.expiryDate) <= 30).sort((a, b) => days(a.expiryDate) - days(b.expiryDate));
    if (!exp.length) await tg(c.botToken, cid, '✅ 30天内无到期域名');
    else {
      const btn = [];
      const lines = exp.map(d => { 
        if (d.registrarUrl) btn.push([{ text: '💳 续费: ' + d.name, url: d.registrarUrl }]); 
        return emoji(days(d.expiryDate)) + ' `' + d.name + '` — ' + dstr(d.expiryDate); 
      }).join('\n');
      await tg(c.botToken, cid, '⏰ *近期到期提醒*\n\n' + lines, btn.length ? { inline_keyboard: btn } : null);
    }
  }
  return ok({ ok: true });
}

// 每日定时检查
async function dailyCheck(env) {
  const c = await tgCfg(env); if (!c.botToken || !c.chatId) return;
  const today = new Date().toDateString();
  if (await kgetStr(env, 'last_check', '') === today) return;
  await env.KV.put('last_check', today);

  const notify = (await kget(env, 'domains')).filter(d => { 
    const v = days(d.expiryDate); 
    // --- 匹配 180, 90, 30, 15, 1 天 ---
    return [1, 15, 30, 90, 180].includes(v) || v < 0; 
  });
  
  if (!notify.length) return;
  const btn = [];
  const lines = notify.map(d => { 
    if (d.registrarUrl) btn.push([{ text: '💳 续费: ' + d.name, url: d.registrarUrl }]); 
    return (days(d.expiryDate) < 0 ? '🔴' : '🟡') + ' `' + d.name + '` — ' + dstr(d.expiryDate); 
  }).join('\n\n');
  
  await tg(c.botToken, c.chatId, '⚠️ *域名续约预警*\n\n' + lines, btn.length ? { inline_keyboard: btn } : null);
}

async function tg(token, chatId, text, reply_markup = null) {
  if (!token) return;
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (reply_markup) body.reply_markup = reply_markup;
  await fetch('https://api.telegram.org/bot' + token + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// ==========================================
// 6. 辅助工具函数
// ==========================================
function days(s) { if (!s) return 9999; const e = new Date(s), n = new Date(); e.setHours(0,0,0,0); n.setHours(0,0,0,0); return Math.round((e-n)/86400000); }
function dstr(s) { const d = days(s); return d === 9999 ? '未填写' : d < 0 ? '已过期' + Math.abs(d) + '天' : d + '天后'; }
function emoji(d) { return d < 0 ? '🔴' : d <= 30 ? '🟡' : '🟢'; }
function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function ok(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function html(body) { return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }

// ==========================================
// 7. 前端 UI (HTML/CSS/JS)
// ==========================================
function getHTML() { return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我爱你一万年 - 域名资产管理</title>
<style>
/* --- 样式变量：改颜色看这里 --- */
:root {
  --primary: #3b8eea; /* 主色调：蓝色 */
  --grad: linear-gradient(135deg, #667eea 0%, #764ba2 100%); /* Banner 渐变背景 */
  --bg: #f0f2f5; /* 网页总背景：浅灰 */
  --text: #1e293b; /* 主文字颜色 */
  --radius: 20px; /* 圆角大小 */
  --shadow: 0 10px 30px rgba(0,0,0,0.05); /* 阴影 */
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }

/* 页面切换逻辑 CSS */
.page { display: none; }
.page.a { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

/* --- 顶部导航栏 --- */
header { 
  height: 70px; background: rgba(255,255,255,0.9); backdrop-filter: blur(15px);
  display: flex; align-items: center; justify-content: space-between; 
  padding: 0 5%; position: fixed; top: 0; width: 100%; z-index: 1000; box-shadow: 0 2px 10px rgba(0,0,0,0.05);
}
.logo { font-size: 22px; font-weight: 900; color: var(--primary); letter-spacing: -1px; }

nav { display: flex; gap: 8px; background: #f1f5f9; padding: 5px; border-radius: 12px; }
.nb { background: none; border: none; padding: 8px 20px; border-radius: 10px; font-size: 13px; font-weight: 700; color: #64748b; cursor: pointer; transition: 0.2s; }
.nb.a { background: #fff; color: var(--primary); box-shadow: 0 2px 8px rgba(0,0,0,0.05); }

/* --- 英雄 Banner 区 --- */
.hero { 
  width: 100%; height: 420px; background: var(--grad); 
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: white; text-align: center; padding-top: 50px;
}

/* --- 文字动起来：呼吸发光特效 --- */
.hero h1 { 
  font-size: 64px; 
  font-weight: 900; 
  letter-spacing: -2px; 
  margin-bottom: 10px; 
  animation: glow 2.5s ease-in-out infinite; /* 2.5秒一次呼吸 */
}
@keyframes glow {
  0% { text-shadow: 0 0 10px rgba(255,255,255,0.2); transform: scale(1); }
  50% { text-shadow: 0 0 30px rgba(255,255,255,0.8), 0 0 50px rgba(255,255,255,0.4); transform: scale(1.02); }
  100% { text-shadow: 0 0 10px rgba(255,255,255,0.2); transform: scale(1); }
}

.hero p { font-size: 18px; opacity: 0.8; letter-spacing: 6px; text-transform: uppercase; }

/* --- 主内容悬浮区 --- */
main { max-width: 1200px; margin: -100px auto 60px; padding: 0 20px; position: relative; z-index: 10; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; margin-bottom: 30px; }
.sc { background: #fff; border-radius: var(--radius); padding: 30px; box-shadow: var(--shadow); transition: 0.3s; text-align: center; }
.sn { font-size: 42px; font-weight: 900; color: var(--primary); }
.sl { font-size: 12px; color: #94a3b8; font-weight: 800; text-transform: uppercase; margin-top: 5px; }

.tw { background: #fff; border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
.tw-h { padding: 25px 35px; border-bottom: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center; }

/* --- 表格样式 --- */
table { width: 100%; border-collapse: collapse; }
th { background: #f8fafc; padding: 16px 35px; text-align: left; font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
td { padding: 20px 35px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
tr:hover td { background: #fcfdfe; }

.dn { font-weight: 800; color: #0f172a; font-family: monospace; }
.b { padding: 5px 12px; border-radius: 8px; font-size: 11px; font-weight: 800; display: inline-block; }
.bg { background: #dcfce7; color: #166534; }
.bw { background: #fef3c7; color: #92400e; }
.br { background: #fee2e2; color: #991b1b; }

/* --- 按钮样式 --- */
.btn { padding: 12px 24px; border-radius: 12px; font-size: 13px; font-weight: 800; cursor: pointer; border: none; transition: 0.2s; display: inline-flex; align-items: center; gap: 6px; }
.btn.bp { background: var(--primary); color: white; }
.btn.bs { background: #f1f5f9; color: #475569; }
.btn:active { transform: scale(0.95); }

/* 登录页全屏蒙版 */
#login { position: fixed; inset: 0; background: #fff; z-index: 2000; display: flex; align-items: center; justify-content: center; }
.lbox { width: 400px; text-align: center; }
#lpw { width: 100%; padding: 18px; border: 2px solid #f1f5f9; border-radius: 15px; margin-bottom: 15px; outline: none; font-size: 18px; text-align: center; }

/* --- 弹窗样式 --- */
.mo { position: fixed; inset: 0; background: rgba(15,23,42,0.6); backdrop-filter: blur(8px); z-index: 3000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: 0.3s; }
.mo.on { opacity: 1; pointer-events: auto; }
.md { background: #fff; width: 95%; max-width: 650px; border-radius: 30px; padding: 40px; box-shadow: 0 25px 50px rgba(0,0,0,0.3); max-height: 90vh; overflow-y: auto; }

/* --- 表单标签 --- */
.fg { margin-bottom: 20px; }
.fl { display: block; font-size: 11px; font-weight: 800; color: #64748b; margin-bottom: 8px; text-transform: uppercase; }
.fi, .fsel, .fta { width: 100%; padding: 14px; background: #f8fafc; border: 2px solid #f1f5f9; border-radius: 12px; outline: none; font-size: 14px; }
.fi:focus, .fta:focus { border-color: var(--primary); background: #fff; }

/* 提醒天数小标签 */
.rts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.rt { padding: 8px 15px; background: #f1f5f9; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; color: #64748b; }
.rt.on { background: var(--primary); color: #fff; }

/* 吐司弹窗 */
#toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 9999; }
.ti { background: #1e293b; color: #fff; padding: 14px 28px; border-radius: 50px; font-size: 14px; font-weight: 700; }

@media (max-width: 768px) {
  header { padding: 0 20px; }
  nav { display: none; }
  .stats { grid-template-columns: 1fr 1fr; }
  td:nth-child(2), td:nth-child(5) { display: none; }
}
</style>
</head>
<body>

<!-- 登录界面 -->
<div id="login">
  <div class="lbox">
    <h2 style="font-size:32px; font-weight:900; margin-bottom:20px">Welcome Back</h2>
    <input type="password" id="lpw" placeholder="请输入管理员密码">
    <button class="btn bp" id="lbtn" style="width:100%; justify-content:center">登录管理后台</button>
    <div id="lerr" style="color:#ef4444; margin-top:15px; font-size:13px; font-weight:700"></div>
  </div>
</div>

<!-- 主程序界面 -->
<div id="app" style="display:none">
<header>
  <div class="logo">DOMAIN<span>PRO</span></div>
  <nav>
    <button class="nb a" id="nb0" onclick="goto(0)">所有域名</button>
    <button class="nb" id="nb1" onclick="goto(1)">账号管理</button>
    <button class="nb" id="nb2" onclick="goto(2)">通知设置</button>
  </nav>
  <button class="nb" onclick="logout()">安全退出</button>
</header>

<!-- 英雄通栏区 -->
<div class="hero">
  <h1>我爱你一万年</h1>
  <p>DOMAIN ASSET MANAGEMENT SYSTEM</p>
</div>

<!-- 内容主体 -->
<main>
  <!-- 统计卡片 -->
  <div class="stats">
    <div class="sc"><div class="sn" id="st">0</div><div class="sl">总域名资产</div></div>
    <div class="sc"><div class="sn" id="se" style="color:#ef4444">0</div><div class="sl">已过期域名</div></div>
    <div class="sc"><div class="sn" id="s3" style="color:#f59e0b">0</div><div class="sl">30天内到期</div></div>
  </div>

  <!-- P0: 域名列表页 -->
  <div id="p0" class="page a">
    <div class="tw">
      <div class="tw-h">
        <h3 style="font-weight:900">域名清单</h3>
        <button class="btn bp" onclick="openDM()">+ 手动添加域名</button>
      </div>
      <!-- 搜索框 -->
      <div style="padding: 15px 35px; background: #fcfdfe; border-bottom: 1px solid #f1f5f9">
         <input id="dsq" placeholder="🔍 快速过滤域名..." oninput="filterD()" style="border:none; background:none; outline:none; font-size:15px; width:100%; font-weight:600">
      </div>
      <table>
        <thead><tr><th>域名</th><th>账号</th><th>状态</th><th>到期日期</th><th>操作</th></tr></thead>
        <tbody id="dtb"></tbody>
      </table>
      <div id="demp" style="display:none; padding:80px; text-align:center; color:#94a3b8">暂无录入资产</div>
    </div>
  </div>

  <!-- P1: 账号关联页 -->
  <div id="p1" class="page">
    <div class="tw" style="padding:40px">
      <div style="display:flex; justify-content:space-between; margin-bottom:30px; align-items:center">
        <h3>Cloudflare 账号</h3>
        <button class="btn bp" onclick="openCFM()">+ 绑定新 API</button>
      </div>
      <div class="stats" id="cfg" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"></div>
      
      <div style="display:flex; justify-content:space-between; margin:40px 0 20px; align-items:center">
        <h3>其他普通账号</h3>
        <button class="btn bs" onclick="openAM()">+ 新增账号</button>
      </div>
      <div id="acg" class="stats" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"></div>
    </div>
  </div>

  <!-- P2: 系统设置页 -->
  <div id="p2" class="page">
    <div class="tw" style="padding:50px; max-width:700px; margin:0 auto;">
      <h3 style="margin-bottom:30px">Telegram 通知设置</h3>
      <div class="fg"><label class="fl">BOT TOKEN</label><input class="fi" id="tgtok" placeholder="从 @BotFather 获取"></div>
      <div class="fg"><label class="fl">CHAT ID</label><input class="fi" id="tgcid" placeholder="私聊机器人发送 /start 获取"></div>
      <div style="display:flex; gap:15px">
        <button class="btn bp" onclick="saveTg()">保存配置</button>
        <button class="btn bs" onclick="check()">触发手动扫描</button>
      </div>
    </div>
  </div>
</main>
</div>

<!-- 域名编辑/添加弹窗 (所有字段) -->
<div class="mo" id="dm"><div class="md">
  <h3 style="margin-bottom:25px">配置域名资产</h3>
  <input type="hidden" id="did">
  
  <div class="fg"><label class="fl">域名地址 *</label><input class="fi" id="dname" placeholder="example.com"></div>
  
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:20px">
    <div><label class="fl">注册商</label><input class="fi" id="dreg" placeholder="阿里云,腾讯云..."></div>
    <div><label class="fl">控制台直达链接</label><input class="fi" id="durl" placeholder="https://..."></div>
  </div>

  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:20px">
    <div><label class="fl">注册日期</label><input class="fi" type="date" id="dreg2"></div>
    <div><label class="fl">到期日期 *</label><input class="fi" type="date" id="dexp"></div>
  </div>

  <div class="fg">
    <label class="fl">所属账号</label>
    <select class="fsel" id="dacc"></select>
  </div>

  <div class="fg">
    <label class="fl">提醒节点 (到期前天数)</label>
    <div class="rts" id="rts">
      <div class="rt on" data-d="180">180d</div>
      <div class="rt on" data-d="90">90d</div>
      <div class="rt on" data-d="30">30d</div>
      <div class="rt on" data-d="15">15d</div>
      <div class="rt on" data-d="1">1d</div>
    </div>
  </div>

  <div class="fg">
    <label style="display:flex; align-items:center; gap:10px; font-size:14px; cursor:pointer; font-weight:700">
      <input type="checkbox" id="dar"> 开启自动续费提醒
    </label>
  </div>

  <div class="fg">
    <label class="fl">备注信息</label>
    <textarea class="fta" id="dnotes" rows="2" placeholder="填写一些备注..."></textarea>
  </div>

  <div style="display:flex; justify-content: flex-end; gap:12px">
    <button class="btn bs" onclick="closeM('dm')">取消操作</button>
    <button class="btn bp" onclick="saveD()">确认保存</button>
  </div>
</div></div>

<!-- Cloudflare 绑定弹窗 -->
<div class="mo" id="cfm"><div class="md">
  <h3 style="margin-bottom:20px">绑定 Cloudflare 账号</h3>
  <div class="fg"><label class="fl">账号备注</label><input class="fi" id="cfn" placeholder="我的主账号"></div>
  <div class="fg"><label class="fl">API Token</label><input class="fi" id="cft" placeholder="粘贴 API TOKEN"></div>
  <button class="btn bp" id="cfbtn" style="width:100%; justify-content:center" onclick="saveCF()">验证并开始绑定</button>
</div></div>

<!-- 同步数据弹窗 -->
<div class="mo" id="sm"><div class="md">
  <h3>域名同步</h3>
  <div id="slding" style="padding:20px; text-align:center">正在获取数据...</div>
  <div id="sbody" style="display:none">
    <div id="ssum" style="margin-bottom:20px; font-weight:700"></div>
    <div id="slist" style="max-height:200px; overflow-y:auto; border:1px solid #f1f5f9; border-radius:12px"></div>
    <div class="fg" style="margin-top:20px">
      <label class="fl">同步模式</label>
      <select id="smod" class="fsel">
        <option value="new">仅录入新资产</option>
        <option value="all">同步并更新所有日期</option>
      </select>
    </div>
  </div>
  <div style="margin-top:20px; display:flex; justify-content:flex-end">
    <button class="btn bp" id="sbtn" onclick="doSync()">执行同步</button>
  </div>
</div></div>

<!-- 普通账号添加弹窗 -->
<div class="mo" id="acm"><div class="md">
  <h3 style="margin-bottom:20px">配置账号</h3>
  <input type="hidden" id="aid">
  <div class="fg"><label class="fl">账号名称 *</label><input class="fi" id="aname" placeholder="如：我的阿里云账号"></div>
  <div class="fg"><label class="fl">注册商名称</label><input class="fi" id="areg" placeholder="Aliyun"></div>
  <div class="fg"><label class="fl">后台 URL</label><input class="fi" id="aurl" placeholder="https://..."></div>
  <button class="btn bp" style="width:100%; justify-content:center" onclick="saveA()">保存账号信息</button>
</div></div>

<div id="toast"></div>

<script>
// --- 前端状态存储 ---
var D=[], A=[], CF=[], curCFId=null;

// --- 登录/退出逻辑 ---
function setErr(msg){ document.getElementById('lerr').textContent = msg || ''; }
function setBtn(txt, dis){ var b=document.getElementById('lbtn'); b.textContent=txt; b.disabled=!!dis; }

document.getElementById('lbtn').onclick = function() {
  var pw = document.getElementById('lpw').value;
  if (!pw) { setErr('请输入密码'); return; }
  setBtn('正在验证...', true);
  fetch('/api/login', { 
    method: 'POST', 
    headers: { 'Content-Type': 'application/json' }, 
    body: JSON.stringify({ password: pw })
  }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; });
  }).then(function(res) {
    if (res.ok) { 
      document.getElementById('login').style.display = 'none'; 
      document.getElementById('app').style.display = 'block'; 
      init();
    } else { 
      setErr(res.d.error || '密码错误'); 
      setBtn('登录管理后台', false); 
    }
  }).catch(function(e) { setErr('连接失败'); setBtn('登录管理后台', false); });
};

function logout() { 
  fetch('/api/logout', { method: 'POST' }).finally(function() { location.reload(); }); 
}

// --- 初始化与加载数据 ---
function init() { loadAll(); }
function loadAll() { loadStats(); loadD(); loadA(); loadCF(); loadTg(); }

function loadStats() { get('/api/stats').then(function(r) { if (!r) return; setText('st', r.total); setText('se', r.expired); setText('s3', r.expiring30); }); }
function loadD() { get('/api/domains').then(function(r) { D = r || []; renderD(D); updateAccSel(); }); }
function loadA() { get('/api/accounts').then(function(r) { A = r || []; renderA(); updateAccSel(); }); }
function loadCF() { get('/api/cf-accounts').then(function(r) { CF = r || []; renderCF(); updateAccSel(); }); }
function loadTg() { get('/api/telegram').then(function(r) { if (!r) return; document.getElementById('tgcid').value = r.chatId || ''; if (r.botToken) document.getElementById('tgtok').placeholder = "已加密存储"; }); }

// --- 核心功能：页面切换 ---
function goto(n) {
  for (var i=0; i<3; i++) {
    var p = document.getElementById('p' + i);
    var b = document.getElementById('nb' + i);
    if (p) p.className = 'page' + (i === n ? ' a' : '');
    if (b) b.className = 'nb' + (i === n ? ' a' : '');
  }
}

// --- 域名列表渲染 ---
function renderD(list) {
  var tb = document.getElementById('dtb');
  if (!list.length) { tb.innerHTML = ''; show('demp'); return; }
  hide('demp');
  tb.innerHTML = list.map(function(d) {
    var dl = d.daysLeft; var bc = dl < 0 ? 'br' : dl <= 30 ? 'bw' : 'bg'; var bt = dl < 0 ? '已过期' : dl + '天';
    var reg = d.registrarUrl ? '<a href="' + esc(d.registrarUrl) + '" target="_blank" style="color:var(--primary);text-decoration:none"><b>' + (d.registrar || '🔗') + '</b></a>' : (d.registrar || '—');
    return '<tr>'
      + '<td><div class="dn">' + d.name + '</div></td>'
      + '<td><span class="b bx">' + (d.accountName || '—') + '</span></td>'
      + '<td><span class="b ' + bc + '">' + bt + '</span></td>'
      + '<td style="font-weight:700; color:#64748b">' + (d.expiryDate || '—') + '</td>'
      + '<td><div style="display:flex;gap:10px">'
      + '<button class="nb" style="color:var(--primary)" onclick="editD(\'' + d.id + '\')">✏️</button>'
      + '<button class="nb" style="color:#ef4444" onclick="delD(\'' + d.id + '\')">🗑️</button>'
      + '</div></td></tr>';
  }).join('');
}

// 快速过滤搜索
function filterD() {
  var q = document.getElementById('dsq').value.toLowerCase();
  renderD(D.filter(function(d) { return !q || d.name.indexOf(q) >= 0; }));
}

// 更新账号下拉选框
function updateAccSel() {
  var h = '<option value="">不关联账号</option>' + A.concat(CF).map(function(a){ return '<option value="' + a.id + '">' + a.name + '</option>'; }).join('');
  document.getElementById('dacc').innerHTML = h;
}

// --- 弹窗操作 ---
function openDM(d) {
  val('did', d ? d.id : ''); val('dname', d ? d.name : ''); val('dreg', d ? d.registrar||'' : '');
  val('durl', d ? d.registrarUrl||'' : ''); val('dreg2', d ? d.registeredAt||'' : '');
  val('dexp', d ? d.expiryDate||'' : ''); val('dacc', d ? d.accountId||'' : '');
  val('dnotes', d ? d.notes||'' : '');
  var rem = d ? (d.reminderDays || [1, 15, 30, 90, 180]) : [1, 15, 30, 90, 180];
  document.querySelectorAll('.rt').forEach(function(t) { t.className = 'rt' + (rem.indexOf(+t.dataset.d) >= 0 ? ' on' : ''); });
  document.getElementById('dar').checked = d ? !!d.autoRenew : false; 
  openM('dm');
}

function editD(id) { var d = D.find(function(x){return x.id===id;}); if(d) openDM(d); }

function saveD() {
  var id = gval('did'); 
  var rem = []; document.querySelectorAll('.rt.on').forEach(function(t){ rem.push(+t.dataset.d); });
  var body = { 
    name: gval('dname'), registrar: gval('dreg'), registrarUrl: gval('durl'), 
    accountId: gval('dacc'), registeredAt: gval('dreg2'), expiryDate: gval('dexp'), 
    autoRenew: document.getElementById('dar').checked, notes: gval('dnotes'), reminderDays: rem 
  };
  post(id ? '/api/domains/'+id : '/api/domains', body, id ? 'PUT' : 'POST').then(function(r) { 
    if (r) { closeM('dm'); toast('资产已更新'); loadD(); loadStats(); } 
  });
}

function delD(id) { if (!confirm('确定删除此域名资产？')) return; post('/api/domains/'+id, null, 'DELETE').then(function(r){ if(r){ toast('已删除'); loadD(); loadStats(); } }); }

// --- Cloudflare 相关界面逻辑 ---
function renderCF() {
  var g = document.getElementById('cfg'); g.innerHTML = CF.map(function(a) {
    return '<div class="sc" style="text-align:left"><div><strong>' + a.name + '</strong></div>'
      + '<div style="font-size:12px;color:#94a3b8;margin:5px 0 15px">' + a.cfAccountName + '</div>'
      + '<div style="display:flex;gap:8px"><button class="btn bp" style="padding:8px 18px" onclick="openSync(\'' + a.id + '\')">同步</button>'
      + '<button class="btn bs" style="padding:8px 18px" onclick="delCF(\'' + a.id + '\')">解绑</button></div></div>';
  }).join('');
}
function openCFM() { val('cfn',''); val('cft',''); openM('cfm'); }
function saveCF() {
  var btn = document.getElementById('cfbtn'); btn.textContent = '验证中...'; btn.disabled = true;
  post('/api/cf-accounts', { name: gval('cfn'), apiToken: gval('cft') }).then(function(r) { 
    btn.textContent = '开始绑定'; btn.disabled = false; 
    if (r) { closeM('cfm'); toast('绑定成功'); loadCF(); } 
  });
}
function delCF(id) { if (!confirm('确定解绑此账号？')) return; post('/api/cf-accounts/'+id, null, 'DELETE').then(function(r){ if(r){ toast('已解绑'); loadCF(); } }); }

function openSync(cfId) {
  curCFId = cfId; show('slding'); hide('sbody'); document.getElementById('sftr').style.display = 'none'; openM('sm');
  post('/api/cf-preview', { cfAccountId: cfId }).then(function(r) {
    hide('slding'); if (!r) return; show('sbody'); document.getElementById('sftr').style.display = 'flex';
    setText('ssum', '找到 ' + r.total + ' 个资产');
    document.getElementById('slist').innerHTML = r.domains.map(function(d){ 
      return '<div style="padding:15px;border-bottom:1px solid #f1f5f9;font-size:14px;font-weight:700">' + d.name + (d.exists ? ' <small style="color:#94a3b8;margin-left:10px">(已存在)</small>' : '') + '</div>'; 
    }).join('');
  });
}
function doSync() { 
  post('/api/cf-sync', { cfAccountId: curCFId, mode: gval('smod') }).then(function(r) { 
    if (r) { closeM('sm'); toast('同步完成'); loadD(); loadStats(); } 
  }); 
}

// --- 普通账号相关逻辑 ---
function renderA() {
  var g = document.getElementById('acg'); g.innerHTML = A.map(function(a){
    return '<div class="sc" style="text-align:left"><div><strong>' + a.name + '</strong></div>'
      + '<div style="font-size:12px;color:#94a3b8;margin:5px 0 15px">' + (a.registrar||'普通账号') + '</div>'
      + '<div style="display:flex;gap:8px"><button class="btn bs" style="padding:8px 18px" onclick="editA(\'' + a.id + '\')">编辑</button>'
      + '<button class="btn bs" style="padding:8px 18px;color:#ef4444" onclick="delA(\'' + a.id + '\')">删除</button></div></div>';
  }).join('');
}
function openAM(a) { val('aid', a?a.id:''); val('aname', a?a.name:''); val('areg', a?a.registrar||'':''); val('aurl', a?a.loginUrl||'':''); openM('acm'); }
function editA(id){ var a=A.find(function(x){return x.id===id;}); if(a) openAM(a); }
function saveA() { 
  var id=gval('aid'); 
  var body={name:gval('aname'),registrar:gval('areg'),loginUrl:gval('aurl')}; 
  post(id?'/api/accounts/'+id:'/api/accounts',body,id?'PUT':'POST').then(function(r){if(r){closeM('acm');toast('成功');loadA();}}); 
}
function delA(id){if(!confirm('确定删除？'))return;post('/api/accounts/'+id,null,'DELETE').then(function(r){if(r){toast('已删除');loadA();}});}

// --- 系统操作 ---
function saveTg() { post('/api/telegram', { botToken: gval('tgtok'), chatId: gval('tgcid') }).then(function(r){ if(r) toast('保存成功'); }); }
function check() { post('/api/check').then(function(r){ if(r) toast('手动检查已触发'); }); }

// --- 通用工具 ---
document.getElementById('rts').onclick = function(e) { 
  var t=e.target.closest('.rt'); if(t) t.className='rt'+(t.className.indexOf(' on')>=0?'':' on'); 
};
function openM(id){ document.getElementById(id).classList.add('on'); }
function closeM(id){ document.getElementById(id).classList.remove('on'); }

function toast(msg) {
  var el=document.createElement('div'); el.className='ti'; el.textContent=msg;
  document.getElementById('toast').appendChild(el); 
  setTimeout(function(){ el.style.opacity='0'; setTimeout(function(){ el.remove(); },500); }, 2500);
}

function get(url) { return fetch(url).then(function(r) { if (r.status===401){location.reload();return null;} return r.json(); }); }
function post(url, body, method) {
  return fetch(url, { 
    method: method||'POST', headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined 
  }).then(function(r) { if (r.status===401){location.reload();return null;} return r.json(); });
}
function gval(id){ return document.getElementById(id).value; }
function val(id,v){ document.getElementById(id).value=v||''; }
function setText(id,v){ document.getElementById(id).textContent=v; }
function show(id){ document.getElementById(id).style.display='block'; }
function hide(id){ document.getElementById(id).style.display='none'; }
function esc(s){ return String(s||'').replace(/[<>&"']/g, function(m){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;','\'':'&#39;'}[m]; }); }

// 自动登录检查
fetch('/api/stats').then(function(r) { if (r.ok) { document.getElementById('login').style.display = 'none'; document.getElementById('app').style.display = 'block'; init(); } });
</script>
</body>
</html>`; }
