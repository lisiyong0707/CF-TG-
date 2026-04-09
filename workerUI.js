/**
 * Domain Manager Pro (融合版)
 * 后端：增加 WHOIS解析 + 多通道通知(微信/Bark/TG/Email) + 批量删除接口
 * 前端：智能解析 + 文本批量导入 + Logo刷新 + 统计卡片过滤(分类) + 批量删除复选框
 */

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === '/api/health') {
        return ok({ kv: !!env.KV });
      }

      if (path === '/' || path === '/index.html') {
        return html(getHTML());
      }

      if (path === '/api/telegram/webhook' && request.method === 'POST') {
        return handleWebhook(request, env);
      }

      if (!path.startsWith('/api/')) {
        return new Response('Not Found', { status: 404 });
      }

      if (path === '/api/login' && request.method === 'POST') {
        return doLogin(request, env);
      }

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

// ── AUTH ─────────────────────────────────────────────────────────────────────

async function doLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return ok({ error: '请求格式错误' }, 400); }
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

// ── ROUTER ───────────────────────────────────────────────────────────────────

async function route(request, env, path) {
  const m = request.method;
  const json = () => request.json().catch(() => ({}));

  if (path === '/api/logout' && m === 'POST')
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'dm_auth=; Path=/; Max-Age=0' },
    });

  if (path === '/api/stats') return ok(await getStats(env));

  if (path === '/api/whois' && m === 'POST') return handleWhois(await json());

  if (path === '/api/domains') {
    if (m === 'GET') return ok(await getDomains(env));
    if (m === 'POST') return ok(await addDomain(await json(), env));
  }
  
  if (path === '/api/domains/bulk-delete' && m === 'POST') {
    return ok(await bulkDelDomains(await json(), env));
  }

  const did = (path.match(/^\/api\/domains\/(.+)$/) || [])[1];
  if (did && did !== 'bulk-delete') {
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

  if (path === '/api/notify') {
    if (m === 'GET') { 
      const c = await getNotifyCfg(env); 
      return ok({ 
        type: c.type || 'pushplus', tgChatId: c.tgChatId || '', 
        tgBotToken: c.tgBotToken ? '***' : '', 
        pushplusToken: c.pushplusToken ? '***' : '', 
        barkKey: c.barkKey ? '***' : '',
        emailApi: c.emailApi || '',
        emailTo: c.emailTo || ''
      }); 
    }
    if (m === 'POST') return saveNotify(await json(), env, request);
  }

  if (path === '/api/check' && m === 'POST') {
    const c = await getNotifyCfg(env);
    if (c.type === 'pushplus' && !c.pushplusToken) return ok({error: '请填写 PushPlus Token'}, 400);
    if (c.type === 'bark' && !c.barkKey) return ok({error: '请填写 Bark Device Key'}, 400);
    if (c.type === 'tg' && (!c.tgBotToken || !c.tgChatId)) return ok({error: '请填写 Telegram 配置'}, 400);
    if (c.type === 'email' && !c.emailApi) return ok({error: '请填写 Webhook / API URL'}, 400);
    
    await sendNotify(env, '✅ 通道测试成功', '你的域名管理系统已成功连接到通知渠道！');
    await env.KV.delete('last_check');
    await dailyCheck(env);
    return ok({ ok: true, msg: '测试消息已发送' });
  }

  return ok({ error: 'Not Found' }, 404);
}

// ── KV ───────────────────────────────────────────────────────────────────────

async function kget(env, key) {
  if (!env.KV) return [];
  try { return JSON.parse(await env.KV.get(key) || '[]'); } catch { return []; }
}
async function kput(env, key, val) {
  if (!env.KV) throw new Error('KV 未绑定：请添加 KV');
  await env.KV.put(key, JSON.stringify(val));
}
async function kgetStr(env, key, def = '') {
  if (!env.KV) return def;
  try { return await env.KV.get(key) || def; } catch { return def; }
}

// ── WHOIS / RDAP ─────────────────────────────────────────────────────────────
async function handleWhois(b) {
  if (!b.domain) return ok({ error: '域名为空' }, 400);
  try {
    const r = await fetch('https://rdap.org/domain/' + b.domain, { headers: { accept: 'application/rdap+json' } });
    if (!r.ok) return ok({ error: '无法通过公共 RDAP 提取信息，可能不支持该后缀，请手动填写' }, 400);
    const data = await r.json();
    let exp = '', reg = '', registrar = '';
    (data.events || []).forEach(e => {
      if (e.eventAction === 'expiration') exp = e.eventDate.split('T')[0];
      if (e.eventAction === 'registration') reg = e.eventDate.split('T')[0];
    });
    (data.entities || []).forEach(e => {
      if (e.roles && e.roles.includes('registrar') && e.vcardArray) {
        const fn = e.vcardArray[1].find(v => v[0] === 'fn');
        if (fn) registrar = fn[3];
      }
    });
    return ok({ ok: true, exp, reg, registrar });
  } catch (e) { return ok({ error: '网络解析失败: ' + e.message }, 500); }
}

// ── DOMAINS ──────────────────────────────────────────────────────────────────

async function getDomains(env) {
  const [domains, accs, cfAccs] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  const nm = {};
  [...accs, ...cfAccs].forEach(a => { nm[a.id] = a.name; });
  return domains.map(d => ({ ...d, accountName: nm[d.accountId] || '—', daysLeft: days(d.expiryDate) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

async function addDomain(b, env) {
  const list = await kget(env, 'domains');
  const d = { id: uid(), name: b.name.trim().toLowerCase(), accountId: b.accountId || '', registrar: b.registrar || '', registrarUrl: b.registrarUrl || '', registeredAt: b.registeredAt || '', expiryDate: b.expiryDate, autoRenew: !!b.autoRenew, reminderDays: b.reminderDays || [1, 15, 30, 90, 180], notes: b.notes || '', source: b.source || 'manual', createdAt: now() };
  list.push(d); await kput(env, 'domains', list); return d;
}

async function updDomain(id, b, env) {
  const list = await kget(env, 'domains');
  const i = list.findIndex(d => d.id === id);
  list[i] = { ...list[i], ...b, id, updatedAt: now() };
  await kput(env, 'domains', list); return list[i];
}

async function delById(env, key, id) {
  const list = await kget(env, key);
  await kput(env, key, list.filter(x => x.id !== id));
  return { ok: true };
}

async function bulkDelDomains(b, env) {
  if (!b.ids || !Array.isArray(b.ids)) return ok({ error: '参数错误' }, 400);
  const list = await kget(env, 'domains');
  const idSet = new Set(b.ids);
  await kput(env, 'domains', list.filter(x => !idSet.has(x.id)));
  return { ok: true, deleted: b.ids.length };
}

// ── ACCOUNTS ─────────────────────────────────────────────────────────────────

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

// ── CLOUDFLARE ───────────────────────────────────────────────────────────────

async function addCF(b, env) {
  const v = await cfApi('/accounts?per_page=1', b.apiToken);
  if (!v.success) return ok({ error: 'Token 无效: ' + (v.errors?.[0]?.message || '验证失败') }, 400);
  const list = await kget(env, 'cf_accounts');
  const a = { id: uid(), name: b.name.trim(), apiToken: b.apiToken.trim(), cfAccountId: v.result?.[0]?.id || '', cfAccountName: v.result?.[0]?.name || '', type: 'cloudflare', createdAt: now() };
  list.push(a); await kput(env, 'cf_accounts', list);
  return ok({ ...a, apiToken: '***' });
}

async function previewCF(b, env) {
  const cf = (await kget(env, 'cf_accounts')).find(a => a.id === b.cfAccountId);
  const r = await fetchCFDomains(cf);
  if (!r.ok) return ok({ error: r.error }, 400);
  const existing = new Set((await kget(env, 'domains')).map(d => d.name));
  const out = r.domains.map(d => ({ ...d, exists: existing.has(d.name) }));
  return ok({ domains: out, total: out.length, newCount: out.filter(d => !d.exists).length });
}

async function syncCF(b, env) {
  const cf = (await kget(env, 'cf_accounts')).find(a => a.id === b.cfAccountId);
  const r = await fetchCFDomains(cf);
  if (!r.ok) return ok({ error: r.error }, 400);
  const domains = await kget(env, 'domains');
  const nm = new Map(domains.map((d, i) => [d.name, i]));
  let added = 0, updated = 0, skipped = 0;
  for (const d of r.domains) {
    if (nm.has(d.name)) {
      if (b.mode === 'all') { const i = nm.get(d.name); domains[i] = { ...domains[i], expiryDate: d.expiryDate || domains[i].expiryDate, autoRenew: d.autoRenew, source: d.source, updatedAt: now() }; updated++; }
      else skipped++;
    } else {
      domains.push({ id: uid(), name: d.name, accountId: cf.id, registrar: 'Cloudflare', registrarUrl: 'https://dash.cloudflare.com/' + cf.cfAccountId + '/domains', registeredAt: d.registeredAt, expiryDate: d.expiryDate, autoRenew: d.autoRenew, reminderDays: [1, 15, 30, 90, 180], notes: '', source: d.source, createdAt: now() });
      added++;
    }
  }
  await kput(env, 'domains', domains);
  return ok({ ok: true, added, updated, skipped, total: r.domains.length });
}

async function fetchCFDomains(cf) {
  try {
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
    if (!out.length) return { ok: false, error: '未找到域名，请确认 Token 有 Zone:Read 权限' };
    return { ok: true, domains: out };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function cfApi(path, token) {
  const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: { Authorization: 'Bearer ' + token } });
  return r.json();
}

// ── STATS ─────────────────────────────────────────────────────────────────────

async function getStats(env) {
  const [d, a, c] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  return { ok: true, kvBound: !!env.KV, total: d.length, accounts: a.length + c.length, cfDomains: d.filter(x => x.source && x.source.startsWith('cf')).length, expired: d.filter(x => days(x.expiryDate) < 0).length, expiring7: d.filter(x => { const v = days(x.expiryDate); return v >= 0 && v <= 7; }).length, expiring30: d.filter(x => { const v = days(x.expiryDate); return v >= 0 && v <= 30; }).length, autoRenew: d.filter(x => x.autoRenew).length };
}

// ── MULTI-CHANNEL NOTIFY ───────────────────────────────────────────────────────

async function getNotifyCfg(env) {
  let c = await kgetStr(env, 'notify_config', '');
  if (!c) { // 兼容旧版 TG 配置
    let old = JSON.parse(await kgetStr(env, 'telegram_config', '{}'));
    return { type: old.botToken ? 'tg' : 'pushplus', tgBotToken: old.botToken||'', tgChatId: old.chatId||'' };
  }
  return JSON.parse(c);
}

async function saveNotify(b, env, request) {
  const c = await getNotifyCfg(env);
  c.type = b.type;
  if (b.tgChatId !== undefined) c.tgChatId = b.tgChatId;
  if (b.tgBotToken && b.tgBotToken !== '***') c.tgBotToken = b.tgBotToken;
  if (b.pushplusToken && b.pushplusToken !== '***') c.pushplusToken = b.pushplusToken;
  if (b.barkKey && b.barkKey !== '***') c.barkKey = b.barkKey;
  if (b.emailApi !== undefined) c.emailApi = b.emailApi;
  if (b.emailTo !== undefined) c.emailTo = b.emailTo;

  if (c.type === 'tg' && c.tgBotToken) {
    const url = new URL(request.url);
    const webhookUrl = url.origin + '/api/telegram/webhook';
    await fetch('https://api.telegram.org/bot' + c.tgBotToken + '/setWebhook?url=' + webhookUrl);
  }
  await kput(env, 'notify_config', c);
  return ok({ ok: true });
}

async function sendNotify(env, title, text, buttons = null) {
  const c = await getNotifyCfg(env);
  
  if (c.type === 'pushplus' && c.pushplusToken) {
    let mdText = text;
    if (buttons) {
      mdText += '\n\n**直达链接:**\n' + buttons.map(row => row.map(btn => `[${btn.text}](${btn.url})`).join(' | ')).join('\n');
    }
    await fetch('http://www.pushplus.plus/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: c.pushplusToken, title, content: mdText, template: 'markdown' })
    });
  } 
  else if (c.type === 'bark' && c.barkKey) {
    let key = c.barkKey.replace('https://api.day.app/', '').split('/')[0];
    let plainText = text.replace(/`/g, '').replace(/\*/g, ''); 
    let urlParam = '';
    if (buttons && buttons[0] && buttons[0][0]) urlParam = `?url=${encodeURIComponent(buttons[0][0].url)}`;
    await fetch(`https://api.day.app/${key}/${encodeURIComponent(title)}/${encodeURIComponent(plainText)}${urlParam}`);
  }
  else if (c.type === 'email' && c.emailApi) {
    let mdText = text;
    if (buttons) {
      mdText += '\n\n' + buttons.map(row => row.map(btn => `${btn.text}: ${btn.url}`).join(' | ')).join('\n');
    }
    if (c.emailApi.includes('[title]') || c.emailApi.includes('[text]')) {
      let url = c.emailApi
        .replace(/\[title\]/g, encodeURIComponent(title))
        .replace(/\[text\]/g, encodeURIComponent(mdText))
        .replace(/\[to\]/g, encodeURIComponent(c.emailTo || ''));
      await fetch(url);
    } else {
      await fetch(c.emailApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: c.emailTo, subject: title, text: mdText })
      });
    }
  } 
  else {
    if (c.tgBotToken && c.tgChatId) {
      const body = { chat_id: c.tgChatId, text: `*${title}*\n\n${text}`, parse_mode: 'Markdown' };
      if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
      await fetch('https://api.telegram.org/bot' + c.tgBotToken + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }
  }
}

async function dailyCheck(env) {
  const today = new Date().toDateString();
  if (await kgetStr(env, 'last_check', '') === today) return;
  await env.KV.put('last_check', today);
  
  const notify = (await kget(env, 'domains')).filter(d => { 
    const v = days(d.expiryDate); 
    return (d.reminderDays || [1, 15, 30, 90, 180]).includes(v) || v < 0; 
  });
  
  if (!notify.length) return;
  
  const buttons = [];
  const lines = notify.map(d => { 
    const v = days(d.expiryDate); 
    if (d.registrarUrl) {
      buttons.push([{ text: `💳 续费: ${d.name}`, url: d.registrarUrl }]);
    }
    return (v < 0 ? '🔴' : v <= 1 ? '🆘' : v <= 7 ? '🟠' : '🟡') + ' `' + d.name + '` — ' + dstr(d.expiryDate) + '\n   ' + (d.registrar || '未知注册商'); 
  }).join('\n\n');
  
  await sendNotify(env, '⚠️ 域名续约提醒', lines, buttons);
}

// 兼容 TG Bot 指令回调
async function handleWebhook(request, env) {
  const u = await request.json().catch(() => ({}));
  const msg = u.message; if (!msg) return ok({ ok: true });
  const cid = msg.chat.id, txt = (msg.text || '').trim();
  const c = await getNotifyCfg(env);
  
  async function replyTg(text, buttons = null) {
    if(!c.tgBotToken) return;
    const body = { chat_id: cid, text, parse_mode: 'Markdown' };
    if (buttons) body.reply_markup = { inline_keyboard: buttons };
    await fetch('https://api.telegram.org/bot' + c.tgBotToken + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  if (txt === '/start') {
    await replyTg('🌐 *域名管理机器人*\n\n你的 Chat ID: `' + cid + '`\n\n/domains — 所有域名\n/expiring — 即即将到期\n/check — 立即检查');
  } 
  else if (txt === '/domains') {
    const list = await kget(env, 'domains');
    const lines = list.sort((a, b) => days(a.expiryDate) - days(b.expiryDate)).map(d => emoji(days(d.expiryDate)) + ' `' + d.name + '` — ' + dstr(d.expiryDate)).join('\n');
    await replyTg('🌐 *所有域名*\n\n' + (lines || '暂无'));
  } 
  else if (txt === '/expiring') {
    const exp = (await kget(env, 'domains')).filter(d => days(d.expiryDate) <= 30).sort((a, b) => days(a.expiryDate) - days(b.expiryDate));
    if (!exp.length) await replyTg('✅ 30天内无到期');
    else {
      const buttons = [];
      const lines = exp.map(d => {
        if (d.registrarUrl) buttons.push([{ text: `💳 续费: ${d.name}`, url: d.registrarUrl }]);
        return emoji(days(d.expiryDate)) + ' `' + d.name + '` — ' + dstr(d.expiryDate);
      }).join('\n');
      await replyTg('⏰ *30天内到期*\n\n' + lines, buttons);
    }
  } 
  else if (txt === '/check') { 
    await env.KV.delete('last_check');
    await dailyCheck(env); 
    await replyTg('✅ 检查与推送完成'); 
  }
  return ok({ ok: true });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function days(s) { if (!s) return 9999; const e = new Date(s), n = new Date(); e.setHours(0,0,0,0); n.setHours(0,0,0,0); return Math.round((e-n)/86400000); }
function dstr(s) { const d = days(s); return d === 9999 ? '未填写' : d < 0 ? '已过期' + Math.abs(d) + '天' : d > 10000 ? '永久有效' : d + '天后'; }
function emoji(d) { return d < 0 ? '🔴' : d <= 7 ? '🟠' : d <= 30 ? '🟡' : '🟢'; }
function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function ok(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function html(body) { return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }

// ── HTML (采用 workerUI.js 风格) ───────────────────────────────────────────────────

function getHTML() { return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我爱你一万年 - 域名资产管理</title>
<style>
/* --- 样式变量 --- */
:root {
  --primary: #3b8eea; 
  --grad: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
  --bg: #f0f2f5; 
  --text: #1e293b; 
  --radius: 20px; 
  --shadow: 0 10px 30px rgba(0,0,0,0.05); 
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: var(--bg); color: var(--text); font-family: -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }

.page { display: none; }
.page.a { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

header { 
  height: 70px; background: rgba(255,255,255,0.9); backdrop-filter: blur(15px);
  display: flex; align-items: center; justify-content: space-between; 
  padding: 0 5%; position: fixed; top: 0; width: 100%; z-index: 1000; box-shadow: 0 2px 10px rgba(0,0,0,0.05);
}

/* 顶部交互式Logo */
.logo { font-size: 22px; font-weight: 900; color: var(--primary); letter-spacing: -1px; cursor: pointer; transition: all 0.2s; }
.logo:hover { opacity: 0.8; transform: scale(1.02); text-shadow: 0 2px 10px rgba(59,142,234,0.3); }

nav { display: flex; gap: 8px; background: #f1f5f9; padding: 5px; border-radius: 12px; }
.nb { background: none; border: none; padding: 8px 20px; border-radius: 10px; font-size: 13px; font-weight: 700; color: #64748b; cursor: pointer; transition: 0.2s; }
.nb.a { background: #fff; color: var(--primary); box-shadow: 0 2px 8px rgba(0,0,0,0.05); }

.hero { 
  width: 100%; height: 420px; background: var(--grad); 
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: white; text-align: center; padding-top: 50px;
}
.hero h1 { 
  font-size: 64px; font-weight: 900; letter-spacing: -2px; margin-bottom: 10px; 
  animation: glow 2.5s ease-in-out infinite; 
}
@keyframes glow {
  0% { text-shadow: 0 0 10px rgba(255,255,255,0.2); transform: scale(1); }
  50% { text-shadow: 0 0 30px rgba(255,255,255,0.8), 0 0 50px rgba(255,255,255,0.4); transform: scale(1.02); }
  100% { text-shadow: 0 0 10px rgba(255,255,255,0.2); transform: scale(1); }
}
.hero p { font-size: 18px; opacity: 0.8; letter-spacing: 6px; text-transform: uppercase; }

main { max-width: 1200px; margin: -100px auto 60px; padding: 0 20px; position: relative; z-index: 10; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 30px; }
.sc { background: #fff; border-radius: var(--radius); padding: 30px; box-shadow: var(--shadow); transition: 0.3s; text-align: center; }
/* 分类卡片交互样式 */
.sc.clickable { cursor: pointer; position: relative; border: 2px solid transparent; }
.sc.clickable:hover { transform: translateY(-5px); box-shadow: 0 15px 35px rgba(0,0,0,0.1); }
.sc.active { border: 2px solid var(--primary); background: #f0f7ff; }

.sn { font-size: 42px; font-weight: 900; color: var(--primary); }
.sl { font-size: 12px; color: #94a3b8; font-weight: 800; text-transform: uppercase; margin-top: 5px; }

.tw { background: #fff; border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden; }
.tw-h { padding: 25px 35px; border-bottom: 1px solid #f1f5f9; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }

table { width: 100%; border-collapse: collapse; }
th { background: #f8fafc; padding: 16px 35px; text-align: left; font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
td { padding: 20px 35px; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
tr:hover td { background: #fcfdfe; }

/* 复选框样式 */
input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }

.dn { font-weight: 800; color: #0f172a; font-family: monospace; }
.b { padding: 5px 12px; border-radius: 8px; font-size: 11px; font-weight: 800; display: inline-block; }
.bg { background: #dcfce7; color: #166534; }
.bw { background: #fef3c7; color: #92400e; }
.br { background: #fee2e2; color: #991b1b; }
.bx { background: #f1f5f9; color: #475569; }
.bc { background: rgba(246,130,31,0.1); color: #f6821f; border: 1px solid rgba(246,130,31,0.2); }

.btn { padding: 12px 24px; border-radius: 12px; font-size: 13px; font-weight: 800; cursor: pointer; border: none; transition: 0.2s; display: inline-flex; align-items: center; gap: 6px; }
.btn.bp { background: var(--primary); color: white; }
.btn.bs { background: #f1f5f9; color: #475569; }
.btn.b-del { background: #ef4444; color: white; }
.btn.b-del:hover { background: #dc2626; }
.btn:active { transform: scale(0.95); }

#login { position: fixed; inset: 0; background: #fff; z-index: 2000; display: flex; align-items: center; justify-content: center; }
.lbox { width: 400px; text-align: center; }
#lpw { width: 100%; padding: 18px; border: 2px solid #f1f5f9; border-radius: 15px; margin-bottom: 15px; outline: none; font-size: 18px; text-align: center; }

.mo { position: fixed; inset: 0; background: rgba(15,23,42,0.6); backdrop-filter: blur(8px); z-index: 3000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: 0.3s; padding: 20px; }
.mo.on { opacity: 1; pointer-events: auto; }
.md { background: #fff; width: 100%; max-width: 650px; border-radius: 30px; padding: 40px; box-shadow: 0 25px 50px rgba(0,0,0,0.3); max-height: 90vh; overflow-y: auto; }

.fg { margin-bottom: 20px; }
.fl { display: block; font-size: 11px; font-weight: 800; color: #64748b; margin-bottom: 8px; text-transform: uppercase; }
.fi, .fsel, .fta { width: 100%; padding: 14px; background: #f8fafc; border: 2px solid #f1f5f9; border-radius: 12px; outline: none; font-size: 14px; }
.fi:focus, .fta:focus, .fsel:focus { border-color: var(--primary); background: #fff; }

.rts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.rt { padding: 8px 15px; background: #f1f5f9; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; color: #64748b; border: none; }
.rt.on { background: var(--primary); color: #fff; }

#toast { position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 9999; }
.ti { background: #1e293b; color: #fff; padding: 14px 28px; border-radius: 50px; font-size: 14px; font-weight: 700; margin-top:10px; }

@media (max-width: 768px) {
  header { padding: 0 20px; }
  nav { display: none; }
  .stats { grid-template-columns: 1fr 1fr; }
  td:nth-child(2), th:nth-child(2) { display: none; }
  .md { padding: 25px; }
}
</style>
</head>
<body>

<!-- 登录界面 -->
<div id="login">
  <div class="lbox">
    <h2 style="font-size:32px; font-weight:900; margin-bottom:20px">Welcome Back</h2>
    <div id="kwarn" style="display:none; color:#ef4444; margin-bottom:15px; font-size:13px; font-weight:bold; background:#fee2e2; padding:10px; border-radius:10px;">⚠️ KV 未绑定，数据无法保存</div>
    <input type="password" id="lpw" placeholder="请输入管理员密码">
    <button class="btn bp" id="lbtn" style="width:100%; justify-content:center">登录管理后台</button>
    <div id="lerr" style="color:#ef4444; margin-top:15px; font-size:13px; font-weight:700"></div>
  </div>
</div>

<!-- 主程序界面 -->
<div id="app" style="display:none">
<header>
  <!-- 顶部图标返回首页并刷新 -->
  <div class="logo" onclick="goHome()" title="返回首页 / 刷新数据">DOMAIN<span>PRO</span></div>
  <nav>
    <button class="nb a" id="nb0" onclick="goto(0)">所有资产</button>
    <button class="nb" id="nb1" onclick="goto(1)">账号管理</button>
    <button class="nb" id="nb2" onclick="goto(2)">通知设置</button>
  </nav>
  <button class="nb" onclick="logout()">安全退出</button>
</header>

<div class="hero">
  <h1>我爱你一万年</h1>
  <p>DOMAIN ASSET MANAGEMENT SYSTEM</p>
</div>

<main>
  <div id="kval" style="display:none; background:#fee2e2; border:1px solid #f87171; color:#991b1b; padding:20px; border-radius:var(--radius); margin-bottom:30px; font-size:14px; box-shadow:var(--shadow);">
    <strong style="font-size:16px; display:block; margin-bottom:5px;">⚠️ KV Namespace 未绑定</strong>
    请前往 Worker Settings 绑定 KV Namespace，变量名填 <code>KV</code>。
  </div>

  <!-- 分类卡片支持点击筛选 -->
  <div class="stats">
    <div class="sc clickable active" id="card-all" onclick="setFilter('all')"><div class="sn" id="st">0</div><div class="sl">总域名资产</div></div>
    <div class="sc clickable" id="card-cf" onclick="setFilter('cf')"><div class="sn" id="sc" style="color:#f6821f">0</div><div class="sl">CF 托管域名</div></div>
    <div class="sc clickable" id="card-exp" onclick="setFilter('exp')"><div class="sn" id="se" style="color:#ef4444">0</div><div class="sl">已过期域名</div></div>
    <div class="sc clickable" id="card-30" onclick="setFilter('30')"><div class="sn" id="s3" style="color:#f59e0b">0</div><div class="sl">30天内到期</div></div>
  </div>

  <div id="p0" class="page a">
    <div class="tw">
      <div class="tw-h">
        <h3 style="font-weight:900" id="list-title">域名清单</h3>
        <div style="display:flex; gap:10px; flex-wrap:wrap">
          <button class="btn b-del" id="btn-bulk-del" style="display:none;" onclick="bulkDelete()">🗑️ 批量删除 (<span id="sel-cnt">0</span>)</button>
          <button class="btn bs" onclick="openBulkM()">📦 批量导入</button>
          <button class="btn bp" onclick="openDM()">+ 手动添加</button>
        </div>
      </div>
      <div style="padding: 15px 35px; background: #fcfdfe; border-bottom: 1px solid #f1f5f9; display:flex; gap:10px; align-items:center;">
         <span style="font-size:18px">🔍</span>
         <input id="dsq" placeholder="快速过滤当前类别的域名名称..." oninput="filterD()" style="border:none; background:none; outline:none; font-size:14px; width:100%; font-weight:600">
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th style="width:40px; padding-right:10px;"><input type="checkbox" id="selAll" onclick="toggleAll(this)" title="全选/取消全选"></th>
              <th>域名</th>
              <th>注册商 / 账号</th>
              <th>状态</th>
              <th>到期日期</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="dtb"></tbody>
        </table>
      </div>
      <div id="demp" style="display:none; padding:80px; text-align:center; color:#94a3b8">该分类下暂无录入资产</div>
    </div>
  </div>

  <div id="p1" class="page">
    <div class="tw" style="padding:40px">
      <div style="display:flex; justify-content:space-between; margin-bottom:30px; align-items:center; flex-wrap:wrap; gap:10px;">
        <h3>Cloudflare 账号绑定</h3>
        <button class="btn bp" onclick="openCFM()">+ 绑定新 API</button>
      </div>
      <div class="stats" id="cfg" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"></div>
      
      <div style="display:flex; justify-content:space-between; margin:40px 0 20px; align-items:center; flex-wrap:wrap; gap:10px;">
        <h3>其他注册商账号</h3>
        <button class="btn bs" onclick="openAM()">+ 新增账号</button>
      </div>
      <div id="acg" class="stats" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"></div>
    </div>
  </div>

  <div id="p2" class="page">
    <div class="tw" style="padding:50px; max-width:700px; margin:0 auto;">
      <h3 style="margin-bottom:30px">系统推送通知设置</h3>
      
      <div class="fg">
        <label class="fl">选择通知渠道</label>
        <select id="ntype" class="fsel" onchange="switchNotify()">
          <option value="pushplus">🟢 PushPlus 微信推送 (国内极力推荐)</option>
          <option value="bark">🍎 Bark 苹果原生推送 (iOS推荐)</option>
          <option value="email">📧 万能 Webhook / API (对接QQ邮箱/钉钉等)</option>
          <option value="tg">✈️ Telegram 机器人 (需代理)</option>
        </select>
      </div>

      <!-- Telegram -->
      <div id="cfg-tg" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">BOT TOKEN</label><input class="fi" id="tgtok" placeholder="从 @BotFather 获取"></div>
        <div class="fg"><label class="fl">CHAT ID</label><input class="fi" id="tgcid" placeholder="私聊机器人获取"></div>
      </div>

      <!-- PushPlus -->
      <div id="cfg-pushplus" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">PUSHPLUS TOKEN</label><input class="fi" id="pptok" placeholder="填写 PushPlus Token"></div>
        <div style="font-size:13px; color:#64748b; line-height:1.6">
          前往 <a href="http://www.pushplus.plus" target="_blank" style="color:var(--primary)">PushPlus 官网</a> 微信扫码登录即可免费获取专属 Token。<br>通知将会通过名为 “pushplus推送加” 的微信公众号直接发到你的微信上！
        </div>
      </div>

      <!-- Bark -->
      <div id="cfg-bark" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">BARK DEVICE KEY</label><input class="fi" id="barkkey" placeholder="例如：qAXXXXXX"></div>
        <div style="font-size:13px; color:#64748b; line-height:1.6">
          在苹果 App Store 搜索下载 <b>Bark</b> 软件，打开 App 即可直接复制 Key 填入此处，享受丝滑的 iOS 极速原生推送。
        </div>
      </div>

      <!-- 自定义 Webhook / Email -->
      <div id="cfg-email" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">API URL (Webhook 地址)</label><input class="fi" id="emailapi" placeholder="如：https://api.xxx.com/send"></div>
        <div class="fg"><label class="fl">接收方标识 / 邮箱地址 (选填)</label><input class="fi" id="emailto" placeholder="如：123456@qq.com"></div>
        <div style="font-size:13px; color:#64748b; line-height:1.6">
          💡 <b>关于 QQ 邮箱/自建系统对接：</b><br>
          由于 CF Workers 原生不支持直接通过 TCP 连接 SMTP 服务，你可以使用第三方 Webhook（如 Make.com / Server酱 等）或自己搭建一个简单的 PHP/Python 代理脚本进行消息转发。<br><br>
          👉 <b>标准 POST：</b> 默认直接向 API URL 推送 JSON 格式数据：<code>{"to":"邮箱","subject":"标题","text":"内容"}</code><br>
          👉 <b>智能 GET：</b> 如果 API URL 中包含 <code>[title]</code>、<code>[text]</code>、<code>[to]</code> 等特定字符，系统会自动使用 GET 请求并智能替换相应变量。
        </div>
      </div>

      <div style="display:flex; gap:15px; margin-top:20px;">
        <button class="btn bp" onclick="saveNotifyCfg()">保存配置</button>
        <button class="btn bs" onclick="check()">触发手动测试推送</button>
      </div>
    </div>
  </div>
</main>
</div>

<!-- 域名编辑/添加弹窗 -->
<div class="mo" id="dm"><div class="md">
  <h3 style="margin-bottom:25px" id="dmt">配置域名资产</h3>
  <input type="hidden" id="did">
  
  <div class="fg">
    <label class="fl">域名地址 *</label>
    <div style="display:flex; gap:10px;">
      <input class="fi" id="dname" placeholder="example.com">
      <button class="btn bs" id="btn-whois" type="button" onclick="autoWhois()" style="white-space:nowrap; padding: 0 15px;">⚡ 一键获取信息</button>
    </div>
  </div>
  
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:20px">
    <div><label class="fl">注册商</label><input class="fi" id="dreg" placeholder="如：阿里云,腾讯云"></div>
    <div><label class="fl">控制台直达链接</label><input class="fi" id="durl" placeholder="https://..."></div>
  </div>

  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:20px">
    <div><label class="fl">注册日期</label><input class="fi" type="date" id="dreg2"></div>
    <div>
      <label class="fl">到期日期 *</label>
      <input class="fi" type="date" id="dexp">
      <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
        <button type="button" class="rt" style="padding:4px 8px; font-size:11px;" onclick="addExpYears(1)">+1年</button>
        <button type="button" class="rt" style="padding:4px 8px; font-size:11px;" onclick="addExpYears(3)">+3年</button>
        <button type="button" class="rt" style="padding:4px 8px; font-size:11px;" onclick="addExpYears(5)">+5年</button>
        <button type="button" class="rt" style="padding:4px 8px; font-size:11px;" onclick="addExpYears(10)">+10年</button>
      </div>
    </div>
  </div>

  <div class="fg">
    <label class="fl">所属账号关联</label>
    <select class="fsel" id="dacc"></select>
  </div>

  <div class="fg">
    <label class="fl">到期提醒节点 (提前天数)</label>
    <div class="rts" id="rts">
      <div class="rt on" data-d="180">180天</div>
      <div class="rt on" data-d="90">90天</div>
      <div class="rt on" data-d="30">30天</div>
      <div class="rt on" data-d="15">15天</div>
      <div class="rt on" data-d="1">1天</div>
    </div>
  </div>

  <div class="fg">
    <label style="display:flex; align-items:center; gap:10px; font-size:14px; cursor:pointer; font-weight:700">
      <input type="checkbox" id="dar" style="width:16px; height:16px; accent-color:var(--primary);"> 已开启注册商自动续费
    </label>
  </div>

  <div class="fg">
    <label class="fl">备注信息</label>
    <textarea class="fta" id="dnotes" rows="2" placeholder="填写一些备注..."></textarea>
  </div>

  <div style="display:flex; justify-content: flex-end; gap:12px; margin-top:30px">
    <button class="btn bs" onclick="closeM('dm')">取消操作</button>
    <button class="btn bp" onclick="saveD()">确认保存</button>
  </div>
</div></div>

<!-- ===== 超强：文本批量导入弹窗 ===== -->
<div class="mo" id="bm"><div class="md">
  <h3 style="margin-bottom:20px">批量智能导入</h3>
  <div style="font-size:13px; color:#64748b; margin-bottom:15px; background:#f8fafc; padding:15px; border-radius:12px; line-height: 1.6;">
    💡 <strong>智能提取升级：</strong>支持提取中文域名(如 抱歉.cc.cd)；自动识别“永久有效/永不过期”；<br>
    支持 <strong>YYYY-MM-DD</strong>、<strong>YYYY/MM/DD</strong> 以及 <strong>YYYY年MM月DD日</strong> 多种格式。<br>
    直接将包含域名的多行列表粘贴到下方即可。
  </div>
  <div class="fg">
    <label class="fl">默认注册商 (选填，推荐填写)</label>
    <input class="fi" id="breg" placeholder="例如：CC.CD (此批次导入的域名统一加上此标签)">
  </div>
  <textarea class="fta" id="btext" rows="10" placeholder="直接粘贴控制台列表文本，例如：&#10;抱歉.cc.cd cc.cd 已解析 2025-12-04 永久有效&#10;mee.evv.me 0 2027年4月6日 20:01 已启用" style="font-family:monospace; line-height: 1.5;"></textarea>
  <div style="display:flex; justify-content: flex-end; gap:12px; margin-top:20px">
    <button class="btn bs" onclick="closeM('bm')">取消</button>
    <button class="btn bp" id="bbtn" onclick="saveBulk()">智能提取并导入</button>
  </div>
</div></div>

<!-- Cloudflare 绑定弹窗 -->
<div class="mo" id="cfm"><div class="md">
  <h3 style="margin-bottom:20px">绑定 Cloudflare 账号</h3>
  <div class="fg"><label class="fl">账号备注名称</label><input class="fi" id="cfn" placeholder="例如：我的主账号"></div>
  <div class="fg"><label class="fl">API Token</label><input class="fi" id="cft" placeholder="粘贴复制好的 Token"></div>
  <button class="btn bp" id="cfbtn" style="width:100%; justify-content:center; margin-top:10px" onclick="saveCF()">验证并开始绑定</button>
</div></div>

<!-- 同步数据弹窗 -->
<div class="mo" id="sm"><div class="md">
  <h3 id="smt">域名同步</h3>
  <div id="slding" style="padding:40px 20px; text-align:center; color:#64748b; font-weight:700">⏳ 正在读取 Cloudflare 数据...</div>
  <div id="sbody" style="display:none">
    <div id="ssum" style="margin:20px 0; font-weight:700; color:var(--primary)"></div>
    <div id="slist" style="max-height:250px; overflow-y:auto; border:2px solid #f1f5f9; border-radius:12px; background:#f8fafc"></div>
    <div class="fg" style="margin-top:20px">
      <label class="fl">同步模式</label>
      <select id="smod" class="fsel">
        <option value="new">仅导入新增域名资产</option>
        <option value="all">完全同步（包含更新已有域名的状态）</option>
      </select>
    </div>
  </div>
  <div id="sftr" style="margin-top:25px; display:none; justify-content:flex-end; gap:12px">
    <button class="btn bs" onclick="closeM('sm')">取消</button>
    <button class="btn bp" id="sbtn" onclick="doSync()">确认执行同步</button>
  </div>
</div></div>

<!-- 普通账号添加弹窗 -->
<div class="mo" id="acm"><div class="md">
  <h3 style="margin-bottom:20px" id="amt">配置普通账号</h3>
  <input type="hidden" id="aid">
  <div class="fg"><label class="fl">账号备注名称 *</label><input class="fi" id="aname" placeholder="如：阿里云主号"></div>
  <div class="fg"><label class="fl">注册商名称</label><input class="fi" id="areg" placeholder="Aliyun"></div>
  <div class="fg"><label class="fl">后台登录 URL</label><input class="fi" id="aurl" placeholder="https://..."></div>
  <div class="fg"><label class="fl">邮箱绑定 (选填)</label><input class="fi" id="aemail" placeholder="user@example.com"></div>
  <button class="btn bp" style="width:100%; justify-content:center; margin-top:10px" onclick="saveA()">保存账号信息</button>
</div></div>

<div id="toast"></div>

<script>
// --- 前端状态存储 ---
var D=[], A=[], CF=[], curCFId=null;
var currentFilter = 'all'; // 默认分类状态

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
document.getElementById('lpw').onkeydown = function(e) { if (e.key === 'Enter') document.getElementById('lbtn').click(); };

function logout() { fetch('/api/logout', { method: 'POST' }).finally(function() { location.reload(); }); }

function init() { 
  loadAll(); 
  fetch('/api/health').then(function(r){ return r.json(); }).then(function(d){
    if (!d.kv) {
      var k1 = document.getElementById('kval'), k2 = document.getElementById('kwarn');
      if(k1) k1.style.display = 'block';
      if(k2) k2.style.display = 'block';
    }
  }).catch(function(){});
}

function loadAll() { loadStats(); loadD(); loadA(); loadCF(); loadNotifyCfg(); }

function loadStats() { get('/api/stats').then(function(r) { if (r) { setText('st', r.total); setText('se', r.expired); setText('s3', r.expiring30); setText('sc', r.cfDomains); }}); }
function loadD() { get('/api/domains').then(function(r) { D = r || []; filterD(); updateAccSel(); }); }
function loadA() { get('/api/accounts').then(function(r) { A = r || []; renderA(); updateAccSel(); }); }
function loadCF() { get('/api/cf-accounts').then(function(r) { CF = r || []; renderCF(); updateAccSel(); }); }

// ===== 分类卡片过滤逻辑 =====
function setFilter(type) {
  currentFilter = type;
  document.querySelectorAll('.sc.clickable').forEach(function(el) { el.classList.remove('active'); });
  document.getElementById('card-' + type).classList.add('active');
  
  var titleMap = { 'all': '域名清单 (全部)', 'cf': '域名清单 (CF托管)', 'exp': '域名清单 (已过期)', '30': '域名清单 (30天内到期)' };
  document.getElementById('list-title').innerText = titleMap[type] || '域名清单';
  filterD();
}

function filterD() {
  var q = document.getElementById('dsq').value.toLowerCase();
  var filtered = D.filter(function(d) {
    // 匹配搜索框
    if (q && d.name.indexOf(q) < 0) return false;
    
    // 匹配分类卡片
    if (currentFilter === 'cf') {
      return d.source && d.source.startsWith('cf');
    } else if (currentFilter === 'exp') {
      return d.daysLeft < 0;
    } else if (currentFilter === '30') {
      return d.daysLeft >= 0 && d.daysLeft <= 30;
    }
    return true; // all
  });
  renderD(filtered);
}

// ===== 复选框与批量删除 =====
function toggleAll(el) {
  document.querySelectorAll('.dsel').forEach(function(cb) { cb.checked = el.checked; });
  updateSel();
}

function updateSel() {
  var cnt = document.querySelectorAll('.dsel:checked').length;
  document.getElementById('sel-cnt').innerText = cnt;
  document.getElementById('btn-bulk-del').style.display = cnt > 0 ? 'inline-flex' : 'none';
  
  var allCnt = document.querySelectorAll('.dsel').length;
  document.getElementById('selAll').checked = (cnt === allCnt && allCnt > 0);
}

function bulkDelete() {
  var ids = Array.from(document.querySelectorAll('.dsel:checked')).map(function(cb) { return cb.value; });
  if(!ids.length) return;
  if(!confirm('🚨 危险操作！\n确定要永久删除选中的 ' + ids.length + ' 个域名资产吗？\n此操作不可恢复！')) return;
  
  var btn = document.getElementById('btn-bulk-del');
  btn.innerHTML = '正在删除...'; btn.disabled = true;
  
  post('/api/domains/bulk-delete', { ids: ids }, 'POST').then(function(r){
    btn.disabled = false;
    if(r) { 
      toast('成功批量删除 ' + r.deleted + ' 个域名资产！'); 
      document.getElementById('selAll').checked = false;
      loadD(); loadStats(); 
    }
  });
}

// ===== 切换通知面板 =====
function switchNotify() {
  var t = gval('ntype');
  document.getElementById('cfg-tg').style.display = 'none';
  document.getElementById('cfg-pushplus').style.display = 'none';
  document.getElementById('cfg-bark').style.display = 'none';
  document.getElementById('cfg-email').style.display = 'none';
  document.getElementById('cfg-' + t).style.display = 'block';
}

function loadNotifyCfg() { 
  get('/api/notify').then(function(r) { 
    if (!r) return; 
    val('ntype', r.type || 'pushplus');
    switchNotify();
    val('tgcid', r.tgChatId || ''); 
    val('emailapi', r.emailApi || ''); 
    val('emailto', r.emailTo || ''); 
    if (r.tgBotToken) document.getElementById('tgtok').placeholder = "已加密安全存储"; 
    if (r.pushplusToken) document.getElementById('pptok').placeholder = "已加密安全存储"; 
    if (r.barkKey) document.getElementById('barkkey').placeholder = "已加密安全存储"; 
  }); 
}

function saveNotifyCfg() { 
  post('/api/notify', { 
    type: gval('ntype'), 
    tgBotToken: gval('tgtok'), tgChatId: gval('tgcid'),
    pushplusToken: gval('pptok'), barkKey: gval('barkkey'),
    emailApi: gval('emailapi'), emailTo: gval('emailto')
  }).then(function(r){ if(r) toast('通知配置保存成功'); }); 
}

function check() { 
  post('/api/check').then(function(r){ if(r) toast('手动测试推送已触发，请检查你的通知渠道'); }); 
}

function goto(n) {
  for (var i=0; i<3; i++) {
    var p = document.getElementById('p' + i); var b = document.getElementById('nb' + i);
    if (p) p.className = 'page' + (i === n ? ' a' : '');
    if (b) b.className = 'nb' + (i === n ? ' a' : '');
  }
}

// ===== Logo 触发返回与刷新 =====
function goHome() {
  goto(0);
  setFilter('all');
  loadAll();
  toast('已刷新所有面板数据');
}

function renderD(list) {
  var tb = document.getElementById('dtb');
  document.getElementById('selAll').checked = false;
  updateSel(); // 重置按钮状态
  
  if (!list.length) { tb.innerHTML = ''; show('demp'); return; }
  hide('demp');
  tb.innerHTML = list.map(function(d) {
    var dl = d.daysLeft; 
    var bc = dl < 0 ? 'br' : dl <= 30 ? 'bw' : 'bg'; 
    var bt = dl < 0 ? '已过期 ' + Math.abs(dl) + ' 天' : dl > 10000 ? '永久有效' : dl === 9999 ? '未填写' : dl + ' 天后';
    var dispDate = dl > 10000 ? '永久' : (d.expiryDate || '—');

    var reg = d.registrarUrl ? '<a href="' + esc(d.registrarUrl) + '" target="_blank" style="color:var(--primary);text-decoration:none"><b>' + (d.registrar || '🔗 控制台') + ' ↗</b></a>' : (d.registrar || '—');
    var srcBadge = d.source === 'cf_registrar' ? '<span class="b bc">☁ CF 注册</span>' : d.source === 'cf_zone' ? '<span class="b bc" style="opacity:0.7">☁ CF 托管</span>' : '<span class="b bx">手动/导入</span>';

    return '<tr>'
      + '<td style="padding-right:10px;"><input type="checkbox" class="dsel" value="' + d.id + '" onchange="updateSel()"></td>'
      + '<td><div class="dn">' + d.name + '</div><div style="margin-top:6px">' + srcBadge + '</div></td>'
      + '<td><div style="font-size:13px; margin-bottom:4px">' + reg + '</div><span class="b bx" style="font-weight:600">' + (d.accountName || '未关联账号') + '</span></td>'
      + '<td><span class="b ' + bc + '">' + bt + '</span></td>'
      + '<td style="font-weight:700; color:#64748b; font-family:monospace">' + dispDate + '</td>'
      + '<td><div style="display:flex;gap:12px">'
      + '<button class="nb" style="color:var(--primary); padding:5px" onclick="editD(\'' + d.id + '\')">✏️ 编辑</button>'
      + '<button class="nb" style="color:#ef4444; padding:5px" onclick="delD(\'' + d.id + '\')">🗑️ 删除</button>'
      + '</div></td></tr>';
  }).join('');
}

function updateAccSel() { var h = '<option value="">不关联账号</option>' + A.concat(CF).map(function(a){ return '<option value="' + a.id + '">' + a.name + '</option>'; }).join(''); document.getElementById('dacc').innerHTML = h; }

function openDM(d) {
  setText('dmt', d ? '编辑域名资产' : '添加域名资产');
  val('did', d ? d.id : ''); val('dname', d ? d.name : ''); val('dreg', d ? d.registrar||'' : '');
  val('durl', d ? d.registrarUrl||'' : ''); val('dreg2', d ? d.registeredAt||'' : '');
  val('dexp', d ? d.expiryDate||'' : ''); val('dacc', d ? d.accountId||'' : '');
  val('dnotes', d ? d.notes||'' : '');
  var rem = d ? (d.reminderDays || [1, 15, 30, 90, 180]) : [1, 15, 30, 90, 180];
  document.querySelectorAll('.rt').forEach(function(t) { if(t.innerHTML.indexOf('天') > -1) { t.className = 'rt' + (rem.indexOf(+t.dataset.d) >= 0 ? ' on' : ''); } });
  document.getElementById('dar').checked = d ? !!d.autoRenew : false; 
  openM('dm');
}
function editD(id) { var d = D.find(function(x){return x.id===id;}); if(d) openDM(d); }
function saveD() {
  var id = gval('did'), rem = []; document.querySelectorAll('.rt.on').forEach(function(t){ if(t.dataset.d) rem.push(+t.dataset.d); });
  var body = { name: gval('dname'), registrar: gval('dreg'), registrarUrl: gval('durl'), accountId: gval('dacc'), registeredAt: gval('dreg2'), expiryDate: gval('dexp'), autoRenew: document.getElementById('dar').checked, notes: gval('dnotes'), reminderDays: rem };
  post(id ? '/api/domains/'+id : '/api/domains', body, id ? 'PUT' : 'POST').then(function(r) { if (r) { closeM('dm'); toast('资产已更新'); loadD(); loadStats(); } });
}
function delD(id) { if (!confirm('确定删除此域名资产？')) return; post('/api/domains/'+id, null, 'DELETE').then(function(r){ if(r){ toast('已删除'); loadD(); loadStats(); } }); }

// ===== 自动提取 WHOIS / RDAP 信息 =====
function autoWhois() {
  var d = gval('dname').trim();
  if(!d) return toast('请先输入要提取的域名地址', 'e');
  var btn = document.getElementById('btn-whois');
  btn.innerHTML = '⏳ 获取中...'; btn.disabled = true;
  post('/api/whois', { domain: d }).then(function(r) {
    btn.innerHTML = '⚡ 一键获取信息'; btn.disabled = false;
    if(r && r.ok) {
      if(r.exp) val('dexp', r.exp);
      if(r.reg) val('dreg2', r.reg);
      if(r.registrar) val('dreg', r.registrar);
      toast('已智能填充域名信息！');
    }
  });
}

// ===== 超强批量导入逻辑 =====
function openBulkM() { val('btext', ''); val('breg', ''); openM('bm'); }

async function saveBulk() {
  var txt = gval('btext');
  var defReg = gval('breg').trim();
  if(!txt.trim()) return toast('内容不能为空', 'e');
  var lines = txt.split('\n');
  var btn = document.getElementById('bbtn');
  btn.innerHTML = '导入中...'; btn.disabled = true;
  var added = 0;

  for(var i=0; i<lines.length; i++) {
    var line = lines[i].trim();
    if(!line) continue;

    var domMatch = line.match(/([a-zA-Z0-9\u4e00-\u9fa5-]+\.)+[a-zA-Z]{2,}/);
    if(!domMatch) continue; 
    var domain = domMatch[0].toLowerCase();

    var dateRegex = /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g;
    var dates = line.match(dateRegex) || [];
    
    dates = dates.map(function(d){ 
      var clean = d.replace(/[年月\/]/g, '-').replace(/日/g, '');
      var parts = clean.split('-');
      var y = parts[0], m = parts[1], day = parts[2];
      return y + '-' + (m.length === 1 ? '0' + m : m) + '-' + (day.length === 1 ? '0' + day : day);
    });

    var expDate = '', regDate = '';
    var isPermanent = /永久|永不过期/.test(line);

    if (isPermanent) {
        expDate = '2099-12-31'; 
        if (dates.length > 0) regDate = dates[0]; 
    } else {
        if (dates.length >= 2) {
            regDate = dates[0]; expDate = dates[1]; 
        } else if (dates.length === 1) {
            expDate = dates[0]; 
        }
    }

    if(!expDate) continue; 

    await post('/api/domains', {
        name: domain,
        expiryDate: expDate,
        registeredAt: regDate,
        registrar: defReg || '未知/批量导入', 
        autoRenew: false,
        source: 'bulk'
    });
    added++;
  }

  btn.innerHTML = '智能提取并导入'; btn.disabled = false;
  closeM('bm');
  toast('成功解析并导入 ' + added + ' 个域名资产！');
  loadD(); loadStats();
}

// ===== Cloudflare & Accounts =====
function renderCF() {
  var g = document.getElementById('cfg'), cnt = {}; D.forEach(function(d){ cnt[d.accountId] = (cnt[d.accountId]||0)+1; });
  g.innerHTML = CF.map(function(a) {
    return '<div class="sc" style="text-align:left; border-top:4px solid #f6821f"><div><strong>☁️ ' + a.name + '</strong></div>'
      + '<div style="font-size:12px;color:#94a3b8;margin:5px 0 15px">' + a.cfAccountName + '<br><span style="color:#f6821f; font-weight:700">关联 ' + (cnt[a.id]||0) + ' 个域名</span></div>'
      + '<div style="display:flex;gap:8px"><button class="btn bp" style="padding:8px 18px" onclick="openSync(\'' + a.id + '\')">↻ 同步域名</button>'
      + '<button class="btn bs" style="padding:8px 18px; color:#ef4444" onclick="delCF(\'' + a.id + '\')">解绑</button></div></div>';
  }).join('');
}
function openCFM() { val('cfn',''); val('cft',''); openM('cfm'); }
function saveCF() {
  var btn = document.getElementById('cfbtn'); btn.textContent = '验证中...'; btn.disabled = true;
  post('/api/cf-accounts', { name: gval('cfn'), apiToken: gval('cft') }).then(function(r) { btn.textContent = '验证并开始绑定'; btn.disabled = false; if (r) { closeM('cfm'); toast('绑定成功'); loadCF(); } });
}
function delCF(id) { if (!confirm('解绑此账号？')) return; post('/api/cf-accounts/'+id, null, 'DELETE').then(function(r){ if(r){ toast('已解绑'); loadCF(); } }); }
function openSync(cfId) {
  curCFId = cfId; var cf = CF.find(function(a){return a.id===cfId;}); setText('smt', '同步 Cloudflare: ' + (cf ? cf.name : ''));
  show('slding'); hide('sbody'); document.getElementById('sftr').style.display = 'none'; openM('sm');
  post('/api/cf-preview', { cfAccountId: cfId }).then(function(r) {
    hide('slding'); if (!r || r.error) { toast(r?.error || '请求失败', 'e'); return; } 
    show('sbody'); document.getElementById('sftr').style.display = 'flex';
    document.getElementById('ssum').innerHTML = '扫描到 <strong>' + r.total + '</strong> 个域名，包含 <strong>' + r.newCount + '</strong> 个新域名。';
    document.getElementById('slist').innerHTML = r.domains.map(function(d){ return '<div style="padding:15px; border-bottom:1px solid #f1f5f9; font-size:14px; font-weight:700; display:flex; justify-content:space-between"><span>' + d.name + (d.exists ? ' <span class="b bx" style="font-size:10px">已存在</span>' : '') + '</span><span style="color:#94a3b8; font-weight:normal; font-family:monospace">' + (d.expiryDate || '无到期日') + '</span></div>'; }).join('');
  });
}
function doSync() { 
  var btn = document.getElementById('sbtn'); btn.textContent = '执行中...'; btn.disabled = true;
  post('/api/cf-sync', { cfAccountId: curCFId, mode: gval('smod') }).then(function(r) { btn.textContent = '确认执行同步'; btn.disabled = false; if (r) { closeM('sm'); toast('同步完成！新增 ' + r.added + ' 个，更新 ' + r.updated + ' 个'); loadD(); loadStats(); } }); 
}

function renderA() {
  var g = document.getElementById('acg'), cnt = {}; D.forEach(function(d){ cnt[d.accountId] = (cnt[d.accountId]||0)+1; });
  g.innerHTML = A.map(function(a){
    return '<div class="sc" style="text-align:left; border-top:4px solid var(--primary)"><div><strong>' + a.name + '</strong></div><div style="font-size:12px;color:#94a3b8;margin:5px 0 15px">' + (a.registrar||'未知') + '<br><span style="color:var(--primary); font-weight:700">关联 ' + (cnt[a.id]||0) + ' 个域名</span></div><div style="display:flex;gap:8px"><button class="btn bs" style="padding:8px 18px" onclick="editA(\'' + a.id + '\')">✏️ 编辑</button><button class="btn bs" style="padding:8px 18px;color:#ef4444" onclick="delA(\'' + a.id + '\')">删除</button></div></div>';
  }).join('');
}
function openAM(a) { setText('amt', a ? '编辑普通账号' : '配置普通账号'); val('aid', a?a.id:''); val('aname', a?a.name:''); val('areg', a?a.registrar||'':''); val('aurl', a?a.loginUrl||'':''); val('aemail', a?a.email||'':''); openM('acm'); }
function editA(id){ var a=A.find(function(x){return x.id===id;}); if(a) openAM(a); }
function saveA() { var id=gval('aid'), body={name:gval('aname'),registrar:gval('areg'),loginUrl:gval('aurl'),email:gval('aemail')}; post(id?'/api/accounts/'+id:'/api/accounts',body,id?'PUT':'POST').then(function(r){if(r){closeM('acm');toast('保存成功');loadA();}}); }
function delA(id){if(!confirm('确定删除？'))return;post('/api/accounts/'+id,null,'DELETE').then(function(r){if(r){toast('已删除');loadA();}});}

// ===== 系统与工具 =====

document.getElementById('rts').onclick = function(e) { var t=e.target.closest('.rt'); if(t && t.innerHTML.indexOf('天') > -1) { t.className='rt'+(t.className.indexOf(' on')>=0?'':' on'); }};
function openM(id){ document.getElementById(id).classList.add('on'); }
function closeM(id){ document.getElementById(id).classList.remove('on'); }
document.querySelectorAll('.mo').forEach(function(m){ m.onclick=function(e){ if(e.target===m) m.classList.remove('on'); }; });

function toast(msg, type) {
  var el=document.createElement('div'); el.className='ti'; 
  if(type === 'e') { el.style.backgroundColor = '#ef4444'; msg = '✗ ' + msg; } else { msg = '✓ ' + msg; }
  el.textContent=msg; document.getElementById('toast').appendChild(el); 
  setTimeout(function(){ el.style.opacity='0'; el.style.transform='translateX(-50%) translateY(20px)'; el.style.transition='0.3s'; setTimeout(function(){ el.remove(); },300); }, 2500);
}

function get(url) { return fetch(url).then(function(r) { if (r.status===401){location.reload();return null;} return r.json(); }).catch(function(e){ toast('网络请求失败', 'e'); return null; }); }
function post(url, body, method) { return fetch(url, { method: method||'POST', headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined }).then(function(r) { return r.json().then(function(d) { if (r.status===401){location.reload();return null;} if (!r.ok){ toast(d.error||'操作失败', 'e'); return null; } return d; }); }).catch(function(e){ toast('网络请求失败', 'e'); return null; }); }
function gval(id){ return document.getElementById(id).value; }
function val(id,v){ document.getElementById(id).value=v||''; }
function setText(id,v){ document.getElementById(id).textContent=v; }
function show(id){ document.getElementById(id).style.display='block'; }
function hide(id){ document.getElementById(id).style.display='none'; }
function esc(s){ return String(s||'').replace(/[<>&"']/g, function(m){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;','\'':'&#39;'}[m]; }); }

// 快捷增加年份
function addExpYears(years) {
  var expInput = document.getElementById('dexp'), regInput = document.getElementById('dreg2');
  var baseDateStr = expInput.value || regInput.value;
  var baseDate = baseDateStr ? new Date(baseDateStr) : new Date();
  baseDate.setFullYear(baseDate.getFullYear() + years);
  var y = baseDate.getFullYear(), m = String(baseDate.getMonth() + 1).padStart(2, '0'), d = String(baseDate.getDate()).padStart(2, '0');
  expInput.value = y + '-' + m + '-' + d;
}

fetch('/api/stats').then(function(r) { if (r.ok) { document.getElementById('login').style.display = 'none'; document.getElementById('app').style.display = 'block'; init(); } });
</script>
</body>
</html>`; }
