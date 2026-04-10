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

// ─── AUTH LOGIC ──────────────────────────────────────────
async function doLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return ok({ error: '请求格式错误' }, 400); }
  const pw = env.ADMIN_PASSWORD || 'admin123';
  if (!body.password || body.password !== pw) return ok({ error: '密码错误' }, 401);
  const token = await makeToken(pw);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': `dm_auth=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800` },
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

// ─── ROUTER LOGIC ────────────────────────────────────────
async function route(request, env, path) {
  const m = request.method;
  const json = () => request.json().catch(() => ({}));

  if (path === '/api/logout' && m === 'POST') return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'dm_auth=; Path=/; Max-Age=0' } });
  if (path === '/api/stats') return ok(await getStats(env));
  if (path === '/api/whois' && m === 'POST') return handleWhois(await json());
  if (path === '/api/ssl' && m === 'POST') return handleSSL(await json());
  if (path === '/api/restore' && m === 'POST') return handleRestore(await json(), env);

  if (path === '/api/domains') {
    if (m === 'GET') return ok(await getDomains(env));
    if (m === 'POST') return ok(await addDomain(await json(), env));
  }
  if (path === '/api/domains/bulk-delete' && m === 'POST') return ok(await bulkDelDomains(await json(), env));

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

  if (path === '/api/free-links') {
    if (m === 'GET') {
      let list = await kget(env, 'free_links');
      if (list.length === 0 && !(await kgetStr(env, 'free_links_init'))) {
        list = [
          { id: uid(), name: 'EU.ORG', url: 'https://nic.eu.org/', desc: '老牌免费域名，支持NS托管。', createdAt: now() },
          { id: uid(), name: 'ClouDNS', url: 'https://www.cloudns.net/', desc: '提供免费子域名，支持常规解析。', createdAt: now() },
          { id: uid(), name: 'PP.UA', url: 'https://nic.pp.ua/', desc: '免费乌克兰域名，需要绑定TG。', createdAt: now() },
          { id: uid(), name: 'L53.net', url: 'https://l53.net/', desc: '提供公益免费二级域名注册。', createdAt: now() }
        ];
        await kput(env, 'free_links', list); await env.KV.put('free_links_init', '1');
      }
      return ok(list);
    }
    if (m === 'POST') {
      const b = await json(); const list = await kget(env, 'free_links');
      const l = { id: uid(), name: b.name.trim(), url: b.url.trim(), desc: b.desc || '', createdAt: now() };
      list.push(l); await kput(env, 'free_links', list); return ok(l);
    }
  }
  const lid = (path.match(/^\/api\/free-links\/(.+)$/) || [])[1];
  if (lid) {
    if (m === 'PUT') {
       const b = await json(); const list = await kget(env, 'free_links'); const i = list.findIndex(x => x.id === lid);
       if(i > -1) { list[i] = { ...list[i], name: b.name.trim(), url: b.url.trim(), desc: b.desc || '' }; await kput(env, 'free_links', list); return ok(list[i]); }
       return ok({error: 'Not found'}, 404);
    }
    if (m === 'DELETE') return ok(await delById(env, 'free_links', lid));
  }

  if (path === '/api/notify') {
    if (m === 'GET') { 
      const c = await getNotifyCfg(env); 
      return ok({ type: c.type || 'pushplus', tgChatId: c.tgChatId || '', tgBotToken: c.tgBotToken ? '***' : '', pushplusToken: c.pushplusToken ? '***' : '', barkKey: c.barkKey ? '***' : '', emailApi: c.emailApi || '', emailTo: c.emailTo || '' }); 
    }
    if (m === 'POST') return saveNotify(await json(), env, request);
  }

  if (path === '/api/check' && m === 'POST') {
    const c = await getNotifyCfg(env);
    if (c.type === 'pushplus' && !c.pushplusToken) return ok({error: '请填写 PushPlus Token'}, 400);
    if (c.type === 'bark' && !c.barkKey) return ok({error: '请填写 Bark Device Key'}, 400);
    if (c.type === 'tg' && (!c.tgBotToken || !c.tgChatId)) return ok({error: '请填写 Telegram 配置'}, 400);
    if (c.type === 'email' && !c.emailApi) return ok({error: '请填写 Webhook API'}, 400);
    try {
      await sendNotify(env, '✅ 通道测试成功', '系统已成功连接到此通知渠道！');
      await env.KV.delete('last_check'); await dailyCheck(env);
      return ok({ ok: true, msg: '测试消息已发送' });
    } catch(err) { return ok({ error: '推送失败: ' + err.message }, 400); }
  }

  return ok({ error: 'Not Found' }, 404);
}

// ─── KV CORE ─────────────────────────────────────────────
async function kget(env, key) { if (!env.KV) return []; try { return JSON.parse(await env.KV.get(key) || '[]'); } catch { return []; } }
async function kput(env, key, val) { if (!env.KV) throw new Error('KV 未绑定'); await env.KV.put(key, JSON.stringify(val)); }
async function kgetStr(env, key, def = '') { if (!env.KV) return def; try { return await env.KV.get(key) || def; } catch { return def; } }

// ─── DATA HANDLING ───────────────────────────────────────
async function handleRestore(b, env) {
  if(!b || typeof b !== 'object') return ok({error: '数据格式无效'}, 400);
  try {
    if (Array.isArray(b.domains)) await kput(env, 'domains', b.domains);
    if (Array.isArray(b.accounts)) await kput(env, 'accounts', b.accounts);
    if (Array.isArray(b.cf_accounts)) await kput(env, 'cf_accounts', b.cf_accounts);
    if (Array.isArray(b.free_links)) await kput(env, 'free_links', b.free_links);
    return ok({ok: true, msg: '恢复成功'});
  } catch (e) { return ok({error: '错误: ' + e.message}, 500); }
}

async function handleWhois(b) {
  if (!b.domain) return ok({ error: '域名为空' }, 400);
  try {
    const r = await fetch('https://rdap.org/domain/' + b.domain, { headers: { accept: 'application/rdap+json' } });
    if (!r.ok) return ok({ error: '无法解析，可能不支持该后缀' }, 400);
    const data = await r.json(); let exp = '', reg = '', registrar = '';
    (data.events || []).forEach(e => { if (e.eventAction === 'expiration') exp = e.eventDate.split('T')[0]; if (e.eventAction === 'registration') reg = e.eventDate.split('T')[0]; });
    (data.entities || []).forEach(e => { if (e.roles && e.roles.includes('registrar') && e.vcardArray) { const fn = e.vcardArray[1].find(v => v[0] === 'fn'); if (fn) registrar = fn[3]; } });
    return ok({ ok: true, exp, reg, registrar });
  } catch (e) { return ok({ error: '解析失败: ' + e.message }, 500); }
}

async function handleSSL(b) {
  if (!b.domain) return ok({ error: '缺少域名' }, 400);
  try {
    const r = await fetch(`https://networkcalc.com/api/security/certificate/${b.domain}`); const data = await r.json();
    if(data && data.status === 'OK' && data.certificate) {
      const validTo = new Date(data.certificate.valid_to); const daysLeft = Math.floor((validTo - new Date()) / 86400000);
      return ok({ ok: true, days: daysLeft, issuer: data.certificate.issuer.split(',')[0].replace('CN=','') });
    }
    return ok({ error: '探测不到证书' }, 400);
  } catch(e) { return ok({ error: '嗅探受阻' }, 500); }
}

async function getDomains(env) {
  const [domains, accs, cfAccs] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  const nm = {}; [...accs, ...cfAccs].forEach(a => { nm[a.id] = a.name; });
  return domains.map(d => ({ ...d, accountName: nm[d.accountId] || '—', daysLeft: days(d.expiryDate) })).sort((a, b) => a.daysLeft - b.daysLeft);
}

async function addDomain(b, env) {
  const list = await kget(env, 'domains');
  const d = { id: uid(), name: b.name.trim().toLowerCase(), accountId: b.accountId || '', registrar: b.registrar || '', registrarUrl: b.registrarUrl || '', registeredAt: b.registeredAt || '', expiryDate: b.expiryDate, autoRenew: !!b.autoRenew, monitor: !!b.monitor, price: Number(b.price) || 0, tags: b.tags || '', reminderDays: b.reminderDays || [1, 15, 30, 90, 180], notes: b.notes || '', source: b.source || 'manual', createdAt: now() };
  list.push(d); await kput(env, 'domains', list); return d;
}

async function updDomain(id, b, env) {
  const list = await kget(env, 'domains'); const i = list.findIndex(d => d.id === id);
  list[i] = { ...list[i], ...b, price: Number(b.price) || 0, id, updatedAt: now() }; await kput(env, 'domains', list); return list[i];
}
async function delById(env, key, id) { const list = await kget(env, key); await kput(env, key, list.filter(x => x.id !== id)); return { ok: true }; }

async function bulkDelDomains(b, env) {
  if (!b.ids || !Array.isArray(b.ids)) return ok({ error: '参数错误' }, 400);
  const list = await kget(env, 'domains'); const idSet = new Set(b.ids);
  await kput(env, 'domains', list.filter(x => !idSet.has(x.id))); return { ok: true, deleted: b.ids.length };
}

async function addAcc(b, env) {
  const list = await kget(env, 'accounts');
  const a = { id: uid(), name: b.name.trim(), registrar: b.registrar || '', email: b.email || '', loginUrl: b.loginUrl || '', notes: b.notes || '', createdAt: now() };
  list.push(a); await kput(env, 'accounts', list); return a;
}
async function updAcc(id, b, env) {
  const list = await kget(env, 'accounts'); const i = list.findIndex(a => a.id === id);
  list[i] = { ...list[i], ...b, id }; await kput(env, 'accounts', list); return list[i];
}

// ─── CLOUDFLARE SYNC ─────────────────────────────────────
async function addCF(b, env) {
  const v = await cfApi('/accounts?per_page=1', b.apiToken);
  if (!v.success) return ok({ error: 'Token 无效' }, 400);
  const list = await kget(env, 'cf_accounts');
  const a = { id: uid(), name: b.name.trim(), apiToken: b.apiToken.trim(), cfAccountId: v.result?.[0]?.id || '', cfAccountName: v.result?.[0]?.name || '', type: 'cloudflare', createdAt: now() };
  list.push(a); await kput(env, 'cf_accounts', list); return ok({ ...a, apiToken: '***' });
}

async function previewCF(b, env) {
  const cf = (await kget(env, 'cf_accounts')).find(a => a.id === b.cfAccountId); const r = await fetchCFDomains(cf);
  if (!r.ok) return ok({ error: r.error }, 400);
  const existing = new Set((await kget(env, 'domains')).map(d => d.name));
  const out = r.domains.map(d => ({ ...d, exists: existing.has(d.name) }));
  return ok({ domains: out, total: out.length, newCount: out.filter(d => !d.exists).length });
}

async function syncCF(b, env) {
  const cf = (await kget(env, 'cf_accounts')).find(a => a.id === b.cfAccountId); const r = await fetchCFDomains(cf);
  if (!r.ok) return ok({ error: r.error }, 400);
  const domains = await kget(env, 'domains'); const nm = new Map(domains.map((d, i) => [d.name, i]));
  const selectedSet = b.selectedDomains ? new Set(b.selectedDomains) : null;
  let added = 0, updated = 0, skipped = 0;
  
  for (const d of r.domains) {
    if (selectedSet && !selectedSet.has(d.name)) { skipped++; continue; }
    if (nm.has(d.name)) {
      if (b.mode === 'all') { const i = nm.get(d.name); domains[i] = { ...domains[i], expiryDate: d.expiryDate || domains[i].expiryDate, autoRenew: d.autoRenew, source: d.source, updatedAt: now() }; updated++; } else skipped++;
    } else {
      domains.push({ id: uid(), name: d.name, accountId: cf.id, registrar: 'Cloudflare', registrarUrl: 'https://dash.cloudflare.com/' + cf.cfAccountId + '/domains', registeredAt: d.registeredAt, expiryDate: d.expiryDate, autoRenew: d.autoRenew, monitor: false, price: 0, tags: 'CF托管', reminderDays: [1, 15, 30, 90, 180], notes: '', source: d.source, createdAt: now() });
      added++;
    }
  }
  await kput(env, 'domains', domains); return ok({ ok: true, added, updated, skipped, total: r.domains.length });
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
    return { ok: true, domains: out };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function cfApi(path, token) { const r = await fetch('https://api.cloudflare.com/client/v4' + path, { headers: { Authorization: 'Bearer ' + token } }); return r.json(); }

async function getStats(env) {
  const [d, a, c] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  let cost30 = 0, costYear = 0;
  d.forEach(x => { const p = Number(x.price) || 0; costYear += p; const dl = days(x.expiryDate); if (dl >= 0 && dl <= 30) cost30 += p; });
  return { ok: true, kvBound: !!env.KV, total: d.length, accounts: a.length + c.length, cfDomains: d.filter(x => x.source && x.source.startsWith('cf')).length, expired: d.filter(x => days(x.expiryDate) < 0).length, expiring7: d.filter(x => { const v = days(x.expiryDate); return v >= 0 && v <= 7; }).length, expiring30: d.filter(x => { const v = days(x.expiryDate); return v >= 0 && v <= 30; }).length, cost30, costYear };
}

// ─── NOTIFICATION SYSTEM ─────────────────────────────────
async function getNotifyCfg(env) {
  let c = await kgetStr(env, 'notify_config', '');
  if (!c) { let old = JSON.parse(await kgetStr(env, 'telegram_config', '{}')); return { type: old.botToken ? 'tg' : 'pushplus', tgBotToken: old.botToken||'', tgChatId: old.chatId||'' }; }
  return JSON.parse(c);
}

async function saveNotify(b, env, request) {
  const c = await getNotifyCfg(env); c.type = b.type;
  if (b.tgChatId !== undefined) c.tgChatId = b.tgChatId;
  if (b.tgBotToken && b.tgBotToken !== '***') c.tgBotToken = b.tgBotToken.trim().replace(/^bot/i, '');
  if (b.pushplusToken && b.pushplusToken !== '***') c.pushplusToken = b.pushplusToken.trim();
  if (b.barkKey && b.barkKey !== '***') c.barkKey = b.barkKey.trim();
  if (b.emailApi !== undefined) c.emailApi = b.emailApi.trim();
  if (b.emailTo !== undefined) c.emailTo = b.emailTo.trim();
  
  if (c.type === 'tg' && c.tgBotToken) await fetch('https://api.telegram.org/bot' + c.tgBotToken + '/setWebhook?url=' + new URL(request.url).origin + '/api/telegram/webhook');
  await kput(env, 'notify_config', c); return ok({ ok: true });
}

async function sendNotify(env, title, text, buttons = null) {
  const c = await getNotifyCfg(env);
  
  if (c.type === 'pushplus' && c.pushplusToken) {
    let mdText = text; 
    if (buttons) mdText += '\n\n**直达链接:**\n' + buttons.map(row => row.map(btn => `[${btn.text}](${btn.url})`).join(' | ')).join('\n');
    const res = await fetch('http://www.pushplus.plus/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: c.pushplusToken, title, content: mdText, template: 'markdown' }) });
    const rJson = await res.json(); if(rJson.code !== 200) throw new Error(rJson.msg || 'PushPlus 报错');
  } 
  else if (c.type === 'bark' && c.barkKey) {
    let key = c.barkKey.replace('https://api.day.app/', '').split('/')[0]; let plainText = text.replace(/`/g, '').replace(/\*/g, ''); 
    let urlParam = (buttons && buttons[0] && buttons[0][0]) ? `?url=${encodeURIComponent(buttons[0][0].url)}` : '';
    const res = await fetch(`https://api.day.app/${key}/${encodeURIComponent(title)}/${encodeURIComponent(plainText)}${urlParam}`);
    const rJson = await res.json(); if(rJson.code !== 200) throw new Error(rJson.message || 'Bark 异常');
  } 
  else if (c.type === 'email' && c.emailApi) {
    let mdText = text; if (buttons) mdText += '\n\n' + buttons.map(row => row.map(btn => `${btn.text}: ${btn.url}`).join(' | ')).join('\n');
    let res;
    if (c.emailApi.includes('[title]')) res = await fetch(c.emailApi.replace(/\[title\]/g, encodeURIComponent(title)).replace(/\[text\]/g, encodeURIComponent(mdText)).replace(/\[to\]/g, encodeURIComponent(c.emailTo || '')));
    else res = await fetch(c.emailApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: c.emailTo, subject: title, text: mdText }) });
    if(!res.ok) throw new Error(`Webhook 响应异常: ${res.status}`);
  } 
  else if (c.type === 'tg' && c.tgBotToken && c.tgChatId) {
    // 降级为纯文本，防止 HTML 转义错误导致发信失败
    const cleanText = String(text).replace(/<[^>]*>?/gm, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const body = { chat_id: String(c.tgChatId).trim(), text: `📢 ${title}\n\n${cleanText}`, disable_web_page_preview: true };
    
    if (buttons && buttons.length) {
      buttons.forEach(row => { row.forEach(btn => { if (btn.url && !btn.url.startsWith('http')) btn.url = 'https://' + btn.url; }); });
      body.reply_markup = { inline_keyboard: buttons };
    }
    
    const tgToken = c.tgBotToken.trim().replace(/^bot/i, '');
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const rJson = await res.json();
    if (!rJson.ok) throw new Error(`Telegram API 拦截: ${rJson.description}`);
  }
}

async function dailyCheck(env) {
  const today = new Date().toDateString();
  if (await kgetStr(env, 'last_check', '') === today) return;
  await env.KV.put('last_check', today);
  
  const domains = await kget(env, 'domains');
  const notify = domains.filter(d => { const v = days(d.expiryDate); return (d.reminderDays || [1, 15, 30, 90, 180]).includes(v) || v < 0; });
  if (notify.length > 0) {
    const buttons = [];
    const lines = notify.map(d => { 
      const v = days(d.expiryDate); 
      let lineText = (v < 0 ? '🔴' : v <= 1 ? '🆘' : v <= 7 ? '🟠' : '🟡') + ' ' + d.name + ' — ' + dstr(d.expiryDate) + '\n   ' + (d.registrar || '未知');
      if (d.registrarUrl) {
        buttons.push([{ text: `💳 续费: ${d.name}`, url: d.registrarUrl }]);
        lineText += `\n   🔗 续费链接: ${d.registrarUrl}`;
      }
      return lineText; 
    }).join('\n\n');
    await sendNotify(env, '⚠️ 域名续约提醒', lines, buttons);
  }
  
  const monitorList = domains.filter(d => d.monitor);
  if(monitorList.length > 0) {
    const down = [];
    for(const md of monitorList) {
      try {
        const controller = new AbortController(); const timeoutId = setTimeout(() => controller.abort(), 5000);
        const url = md.name.startsWith('http') ? md.name : 'http://' + md.name;
        const r = await fetch(url, { signal: controller.signal, redirect: 'follow' }); clearTimeout(timeoutId);
        if(r.status >= 500) down.push({name: md.name, status: `HTTP ${r.status}`});
      } catch(e) { down.push({name: md.name, status: '连接超时'}); }
    }
    if(down.length > 0) {
      const lines = down.map(x => `🔴 ${x.name} -> ${x.status}`).join('\n');
      await sendNotify(env, '🚨 网站宕机告警', '您开启监控的站点出现异常：\n\n' + lines);
    }
  }
}

async function handleWebhook(request, env) {
  const u = await request.json().catch(() => ({})); const msg = u.message; if (!msg) return ok({ ok: true });
  const cid = msg.chat.id, txt = (msg.text || '').trim(); const c = await getNotifyCfg(env);
  
  async function replyTg(text, buttons = null) {
    if(!c.tgBotToken) return;
    const cleanText = String(text).replace(/<[^>]*>?/gm, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const body = { chat_id: cid, text: cleanText, disable_web_page_preview: true };
    if (buttons && buttons.length) { buttons.forEach(row => { row.forEach(btn => { if (btn.url && !btn.url.startsWith('http')) btn.url = 'https://' + btn.url; }); }); body.reply_markup = { inline_keyboard: buttons }; }
    const tgToken = c.tgBotToken.trim().replace(/^bot/i, '');
    await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  
  if (txt === '/start') { await replyTg('🌐 域名机器人在线\n/domains 所有域名\n/expiring 即将到期\n/check 立即检查'); } 
  else if (txt === '/domains') {
    const lines = (await kget(env, 'domains')).sort((a, b) => days(a.expiryDate) - days(b.expiryDate)).map(d => d.name + ' — ' + dstr(d.expiryDate)).join('\n');
    await replyTg('🌐 所有域名\n\n' + (lines || '暂无'));
  } 
  else if (txt === '/expiring') {
    const exp = (await kget(env, 'domains')).filter(d => days(d.expiryDate) <= 30).sort((a, b) => days(a.expiryDate) - days(b.expiryDate));
    if (!exp.length) await replyTg('✅ 30天内无到期');
    else {
      const buttons = [];
      const lines = exp.map(d => {
        let lineStr = emoji(days(d.expiryDate)) + ' ' + d.name + ' — ' + dstr(d.expiryDate);
        if (d.registrarUrl) {
          buttons.push([{ text: `💳 续费: ${d.name}`, url: d.registrarUrl }]);
          lineStr += `\n   🔗 ${d.registrarUrl}`;
        }
        return lineStr;
      }).join('\n\n');
      await replyTg('⏰ 30天内即将到期\n\n' + lines, buttons);
    }
  } else if (txt === '/check') { 
    await env.KV.delete('last_check'); await dailyCheck(env); await replyTg('✅ 检查与推送完成'); 
  }
  return ok({ ok: true });
}

// ─── HELPERS ─────────────────────────────────────────────
function days(s) { if (!s) return 9999; const e = new Date(s), n = new Date(); e.setHours(0,0,0,0); n.setHours(0,0,0,0); return Math.round((e-n)/86400000); }
function dstr(s) { const d = days(s); return d === 9999 ? '未填写' : d < 0 ? '已过期' + Math.abs(d) + '天' : d > 10000 ? '永久有效' : d + '天后'; }
function emoji(d) { return d < 0 ? '🔴' : d <= 7 ? '🟠' : d <= 30 ? '🟡' : '🟢'; }
function uid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function ok(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }); }
function html(body) { return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); }

// ─── FRONTEND HTML/CSS ───────────────────────────────────
function getHTML() { 
  return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Domain Pro - 清新资产管理</title>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;700;900&display=swap" rel="stylesheet">
<style>
:root { --primary: #4CAF50; --secondary: #03A9F4; --accent: #FFEB3B; --grad: linear-gradient(180deg, #87CEEB 0%, #E0F7FA 100%); --bg: #F9FBE7; --text: #2E402F; --radius: 20px; --shadow: 0 12px 35px rgba(76,175,80,0.08); }
body.dark-mode { --bg: #0F172A; --text: #E2E8F0; --grad: linear-gradient(180deg, #0B1120 0%, #1E293B 100%); --shadow: 0 10px 30px rgba(0,0,0,0.8); --primary: #81C784; --secondary: #4FC3F7; }
body.dark-mode header, body.dark-mode .tw, body.dark-mode .sc, body.dark-mode .md, body.dark-mode #cat-chat { background: #1E293B; border-color: #334155; }
body.dark-mode th, body.dark-mode td, body.dark-mode input.fi, body.dark-mode textarea.fta, body.dark-mode select.fsel { background: #0F172A; color: #e2e8f0; border-color: #334155; }
body.dark-mode .tw-h, body.dark-mode td, body.dark-mode th { border-bottom-color: #334155; }
body.dark-mode .bx, body.dark-mode .bs { background: #334155; color: #cbd5e1; }
body.dark-mode .tag { background: rgba(79,70,229,0.2); color: #818cf8; }
body.dark-mode .nav-cloud { background: rgba(30,41,59,0.8); color: #4FC3F7; }

* { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Nunito', system-ui, sans-serif; }
body { background: var(--bg); color: var(--text); overflow-x: hidden; transition: background 0.4s, color 0.4s; }

.page { display: none; }
.page.a { display: block; animation: bounceIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
@keyframes bounceIn { from { opacity: 0; transform: translateY(20px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

header { height: 60px; display: flex; align-items: center; justify-content: space-between; padding: 0 5%; position: fixed; top: 0; width: 100%; z-index: 1000; transition: 0.3s; }
.logo { font-size: 24px; font-weight: 900; color: var(--primary); cursor: pointer; letter-spacing: -0.5px; text-shadow: 0 2px 10px rgba(255,255,255,0.8); }
.logo span { color: var(--secondary); }

.hero { width: 100%; height: 450px; background: var(--grad); display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; overflow: hidden; }
.hero::before { content:''; position:absolute; bottom:-50px; left:-10%; width:60%; height:150px; background:#C5E1A5; border-radius:50%; z-index:1; }
.hero::after { content:''; position:absolute; bottom:-70px; right:-10%; width:70%; height:180px; background:#AED581; border-radius:50%; z-index:1; }
body.dark-mode .hero::before { background: #1E293B; } body.dark-mode .hero::after { background: #0F172A; }

.nav-cloud { position: absolute; background: rgba(255,255,255,0.85); border-radius: 50px; padding: 12px 28px; font-weight: 900; color: var(--secondary); font-size: 16px; box-shadow: 0 8px 25px rgba(0,0,0,0.08); cursor: pointer; backdrop-filter: blur(10px); transition: all 0.3s cubic-bezier(0.175,0.885,0.32,1.275); display: flex; align-items: center; z-index: 5; animation: floatCloud 25s linear infinite alternate; }
.nav-cloud:hover { transform: scale(1.15) translateY(-5px) !important; background: #fff; color: var(--primary); box-shadow: 0 15px 35px rgba(76,175,80,0.3); z-index: 10; }
.nav-cloud.active { background: var(--primary); color: #fff; box-shadow: 0 10px 30px rgba(76,175,80,0.4); }
@keyframes floatCloud { 0% { transform: translateX(0) translateY(0); } 100% { transform: translateX(30px) translateY(-10px); } }

.hero h1 { font-size: 54px; font-weight: 900; color: #fff; z-index: 2; margin-bottom: 10px; text-shadow: 0 4px 15px rgba(0,0,0,0.2); position: relative; cursor: pointer; transition: 0.3s; }
.hero h1:hover { transform: scale(1.05); text-shadow: 0 4px 25px rgba(255,255,255,0.6); }
.hero p { font-size: 16px; font-weight: 700; color: #fff; z-index: 2; opacity: 0.9; background: rgba(0,0,0,0.1); padding: 5px 15px; border-radius: 20px; }

main { max-width: 1200px; margin: -80px auto 60px; padding: 0 20px; position: relative; z-index: 10; }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 20px; margin-bottom: 35px; }
.sc { background: #fff; border-radius: 40px; padding: 30px; box-shadow: var(--shadow); text-align: center; border: 2px solid transparent; transition: all 0.3s cubic-bezier(0.175,0.885,0.32,1.275); }
.sc.clickable { cursor: pointer; }
.sc.clickable:hover { transform: translateY(-8px) scale(1.02); box-shadow: 0 20px 40px rgba(76,175,80,0.15); border-color: #E8F5E9; }
.sc.active { border: 3px solid var(--primary); background: #F1F8E9; }

.sn { font-size: 46px; font-weight: 900; color: var(--primary); letter-spacing: -2px; }
.sl { font-size: 13px; color: #78909C; font-weight: 800; margin-top: 5px; }

.tw { background: #fff; border-radius: 35px; box-shadow: var(--shadow); overflow: hidden; }
.tw-h { padding: 30px 35px; border-bottom: 2px dashed #F1F8E9; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 15px; }

table { width: 100%; border-collapse: collapse; }
th { background: #FAFAFA; padding: 18px 35px; text-align: left; font-size: 12px; color: #90A4AE; font-weight: 800; letter-spacing: 1px; }
td { padding: 22px 35px; border-bottom: 1px solid #F5F5F5; font-size: 15px; font-weight: 700; }
tr:hover td { background: #F9FBE7; }
body.dark-mode tr:hover td { background: rgba(255,255,255,0.03); }

input[type="checkbox"] { width: 20px; height: 20px; accent-color: var(--primary); cursor: pointer; border-radius: 6px; }

.cp-btn { cursor: pointer; opacity: 0.3; transition: 0.2s; font-size: 18px; margin-left: 8px; display: inline-flex; align-items: center; }
.cp-btn:hover { opacity: 1; transform: scale(1.2) rotate(5deg); }

.dn { color: var(--text); font-weight: 900; font-size: 16px; display: flex; align-items: center; }
.dn a { color: inherit; text-decoration: none; border-bottom: 2px solid transparent; transition: 0.2s; }
.dn a:hover { color: var(--secondary); border-color: var(--secondary); }

.b { padding: 6px 14px; border-radius: 50px; font-size: 12px; font-weight: 800; display: inline-block; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
.bg { background: #E8F5E9; color: #2E7D32; border: 1px solid #C8E6C9; }
.bw { background: #FFF9C4; color: #F57F17; border: 1px solid #FFF59D; }
.br { background: #FFEBEE; color: #C62828; border: 1px solid #FFCDD2; }
.bx { background: #F5F5F5; color: #607D8B; border: 1px solid #E0E0E0; box-shadow: none; }

.tag { background: #E1F5FE; color: #0277BD; border-radius: 50px; padding: 4px 10px; font-size: 11px; margin-right: 6px; display: inline-block; margin-top: 8px; font-weight: 800; border: 1px solid #B3E5FC; }

.btn { padding: 12px 26px; border-radius: 50px; font-size: 14px; font-weight: 800; cursor: pointer; border: none; transition: 0.3s cubic-bezier(0.175,0.885,0.32,1.275); display: inline-flex; align-items: center; gap: 8px; }
.btn.bp { background: var(--primary); color: #fff; box-shadow: 0 6px 15px rgba(76,175,80,0.3); }
.btn.bp:hover { background: #43A047; transform: translateY(-3px); box-shadow: 0 8px 20px rgba(76,175,80,0.4); }
.btn.bs { background: #fff; color: #455A64; border: 2px solid #E0E0E0; }
.btn.bs:hover { border-color: var(--secondary); color: var(--secondary); transform: translateY(-3px); }
.btn.b-del { background: #FF5252; color: #fff; }

#login { position: fixed; inset: 0; background: var(--grad); z-index: 2000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.login-hills { position: absolute; bottom: -100px; width: 150%; height: 40vh; background: #AED581; border-radius: 50% 50% 0 0; z-index: 0; }
.login-hills-2 { position: absolute; bottom: -50px; left: -20%; width: 100%; height: 35vh; background: #81C784; border-radius: 50% 50% 0 0; z-index: 0; }
.lbox { width: 420px; text-align: center; z-index: 1; padding: 50px 40px; border-radius: 40px; background: rgba(255,255,255,0.9); backdrop-filter: blur(20px); box-shadow: 0 20px 50px rgba(0,0,0,0.1); position: relative; }
.login-avatar { width: 110px; height: 110px; margin: 0 auto 20px; background: var(--accent); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 50px; box-shadow: 0 10px 25px rgba(255,235,59,0.5); animation: float 4s ease-in-out infinite; }

#lpw { width: 100%; padding: 18px; margin-bottom: 20px; outline: none; font-size: 16px; text-align: center; background: #F5F5F5; border: 2px solid #E0E0E0; color: var(--text); border-radius: 50px; transition: 0.3s; font-weight: 700; }
#lpw:focus { border-color: var(--primary); background: #fff; box-shadow: 0 0 0 4px rgba(76,175,80,0.1); }

.mo { position: fixed; inset: 0; background: rgba(0,0,0,0.4); backdrop-filter: blur(5px); z-index: 3000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: 0.3s; padding: 20px; }
.mo.on { opacity: 1; pointer-events: auto; }
.md { background: #fff; width: 100%; max-width: 650px; border-radius: 40px; padding: 45px; box-shadow: 0 25px 50px rgba(0,0,0,0.2); max-height: 90vh; overflow-y: auto; transform: scale(0.9); transition: 0.3s cubic-bezier(0.175,0.885,0.32,1.275); }
.mo.on .md { transform: scale(1); }

.fg { margin-bottom: 22px; }
.fl { display: block; font-size: 13px; font-weight: 800; color: #546E7A; margin-bottom: 10px; }
.fi, .fsel, .fta { width: 100%; padding: 15px 20px; background: #F9FBE7; border: 2px solid #F1F8E9; border-radius: 20px; outline: none; font-size: 15px; font-weight: 700; color: var(--text); transition: 0.3s; }
.fi:focus, .fta:focus, .fsel:focus { border-color: var(--primary); background: #fff; box-shadow: 0 4px 15px rgba(76,175,80,0.1); }

.rts { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.rt { padding: 10px 18px; background: #F5F5F5; border-radius: 50px; font-size: 13px; font-weight: 800; cursor: pointer; color: #78909C; border: 2px solid transparent; transition: 0.2s; }
.rt.on { background: #E8F5E9; color: var(--primary); border-color: var(--primary); }

.ti { background: #333; color: #fff; padding: 16px 30px; border-radius: 50px; font-size: 15px; font-weight: 800; margin-top: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }

/* 🐱 赛博狸花猫与左侧控制菜单 (终极修复版：加入隐形 Padding 热区防断触) */
#cat-container { 
  position: fixed; bottom: -10px; right: 10px; z-index: 5000; 
  display: flex; flex-direction: column; align-items: center; 
  transition: transform 1s cubic-bezier(0.25,1,0.5,1); 
  padding: 40px 10px 0 130px; 
}
#cat-bubble { background: var(--accent); padding: 15px 25px; border-radius: 30px; box-shadow: 0 10px 25px rgba(255,235,59,0.3); font-size: 15px; font-weight: 900; color: #333; margin-bottom: 15px; opacity: 0; transform: translateY(10px); transition: 0.3s; position: relative; pointer-events: none; border: 3px solid #FFF59D; }
#cat-bubble::after { content: ''; position: absolute; bottom: -12px; left: 50%; transform: translateX(-50%); border-width: 12px 10px 0; border-style: solid; border-color: var(--accent) transparent transparent transparent; z-index: 2; }
#cat-bubble::before { content: ''; position: absolute; bottom: -16px; left: 50%; transform: translateX(-50%); border-width: 14px 12px 0; border-style: solid; border-color: #FFF59D transparent transparent transparent; z-index: 1; }

#cat-svg { width: 140px; height: auto; display: block; animation: floatCat 3s ease-in-out infinite; cursor: pointer; filter: drop-shadow(0 15px 20px rgba(0,0,0,0.15)); transition: transform 0.3s cubic-bezier(0.175,0.885,0.32,1.275); }
#cat-svg:hover { transform: scale(1.1) rotate(-5deg); }
@keyframes floatCat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-15px); } }

/* 独立且严谨对齐的菜单按钮样式，包含在热区内 */
#cat-actions {
  position: absolute; left: 10px; bottom: 25px; display: flex; flex-direction: column; gap: 8px; opacity: 0; pointer-events: none; transition: 0.3s; transform: translateX(10px); align-items: center; 
}
#cat-container:hover #cat-actions, #cat-actions:hover { opacity: 1; pointer-events: auto; transform: translateX(0); }

.cat-btn { 
  width: 100px; height: 38px; background: #fff; color: #455A64; border: 2px solid #E0E0E0; border-radius: 50px; font-size: 13px; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 4px 10px rgba(0,0,0,0.08); transition: 0.2s; padding: 0; 
}
.cat-btn:hover { border-color: var(--primary); color: var(--primary); transform: scale(1.05); }
.cat-btn-feed { background: #FFF9C4; color: #F57F17; border-color: #FFF59D; }
.cat-btn-feed:hover { border-color: #F57F17; color: #E65100; }

/* AI 聊天窗 */
#cat-chat { display: none; position: absolute; bottom: 120%; right: 20px; width: 340px; background: #fff; border-radius: 30px; box-shadow: 0 20px 50px rgba(0,0,0,0.15); border: 3px solid var(--accent); overflow: hidden; z-index: 5002; transform-origin: bottom right; animation: popChat 0.3s cubic-bezier(0.175,0.885,0.32,1.275); }
@keyframes popChat { from { opacity: 0; transform: scale(0.5); } to { opacity: 1; transform: scale(1); } }
.chat-head { background: var(--accent); color: #333; padding: 15px 20px; font-size: 16px; font-weight: 900; display: flex; justify-content: space-between; align-items: center; }
.chat-body { height: 250px; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; background: #FAFAFA; font-size: 14px; font-weight: 700; }
.chat-msg { padding: 12px 18px; border-radius: 20px; max-width: 85%; line-height: 1.5; word-wrap: break-word; }
.msg-ai { background: #fff; border: 2px solid #F5F5F5; align-self: flex-start; border-bottom-left-radius: 4px; box-shadow: 0 4px 10px rgba(0,0,0,0.02); }
.msg-user { background: var(--primary); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; box-shadow: 0 4px 10px rgba(76,175,80,0.3); }
.chat-input-area { display: flex; border-top: 1px solid #e2e8f0; background: #fff; }
#chat-input { flex: 1; border: none; padding: 15px 20px; outline: none; font-size: 14px; font-weight: 700; }
.chat-send { background: none; border: none; color: var(--primary); font-weight: 900; padding: 0 20px; cursor: pointer; transition: 0.2s; }

.floating-heart { position: absolute; font-size: 24px; z-index: 5001; animation: floatUp 1s ease-out forwards; pointer-events: none; }
@keyframes floatUp { 0% { opacity: 1; transform: translateY(0) scale(1); } 100% { opacity: 0; transform: translateY(-60px) scale(1.5); } }

#term { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 45vh; background: rgba(15,23,42,0.95); backdrop-filter: blur(10px); color: #22c55e; font-family: monospace; z-index: 9999; padding: 20px; overflow-y: auto; border-bottom: 3px solid #22c55e; box-shadow: 0 20px 50px rgba(0,0,0,0.5); font-size: 14px; }
#term-out { margin-bottom: 10px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
#term-in-wrap { display: flex; align-items: center; }
#term-in { background: transparent; border: none; color: #22c55e; outline: none; flex: 1; font-family: monospace; font-size: 14px; }

@media (max-width: 768px) {
  header { padding: 0 20px; }
  nav { display: none; }
  .stats { grid-template-columns: 1fr 1fr; }
  td:nth-child(2), th:nth-child(2) { display: none; }
  .md { padding: 25px; }
  #cat-svg { width: 120px; }
  #cat-actions { left: -90px; top: -10px; }
  #cat-chat { width: 280px; right: 0; }
  .lbox { width: 90%; padding: 40px 25px; }
}
</style>
</head>
<body>

<div id="login">
  <div class="login-hills"></div><div class="login-hills-2"></div>
  <div class="lbox">
    <div class="login-avatar">🌱</div>
    <h2 style="color:var(--primary)">DOMAIN PRO</h2>
    <p class="subtitle">自然清新 · 极客管理</p>
    <div id="kwarn" style="display:none; color:#fca5a5; margin-bottom:15px; font-size:13px; font-weight:bold; background:rgba(239, 68, 68, 0.2); padding:10px; border-radius:10px;">⚠️ KV 未绑定，数据无法保存</div>
    <input type="password" id="lpw" placeholder="输入口令唤醒系统">
    <button class="btn bp" id="lbtn" style="width:100%; justify-content:center; padding:18px; font-size:16px;">进入草地</button>
    <div id="lerr" style="color:#FF5252; margin-top:15px; font-size:14px; font-weight:800"></div>
  </div>
</div>

<div id="app" style="display:none">
<header>
  <div class="logo" onclick="goHome()" title="返回首页 / 刷新数据">Domain <span>Pro</span></div>
  <div>
    <button class="btn bs" style="padding:8px 15px; font-size:12px;" onclick="toggleDarkMode()" id="theme-btn" title="切换模式">🌙</button>
    <button class="btn bs" style="padding:8px 15px; font-size:12px; background:#FFEBEE; color:#C62828;" onclick="logout()">退出</button>
  </div>
</header>

<div class="hero">
  <!-- 四朵云交互主导航 -->
  <div id="nc0" class="nav-cloud active" style="top: 80px; left: 12%;" onclick="goto(0)">🌿 我的资产</div>
  <div id="nc1" class="nav-cloud" style="top: 150px; right: 18%; animation-delay: -5s;" onclick="goto(1)">🔗 账号绑定</div>
  <div id="nc2" class="nav-cloud" style="top: 240px; left: 15%; animation-delay: -2s;" onclick="goto(2)">🔔 告警通知</div>
  <div id="nc3" class="nav-cloud" style="top: 60px; right: 22%; animation-delay: -8s;" onclick="goto(3)">🎁 免费资源</div>

  <h1 id="hero-title" onclick="changeTitle()" title="点击切换句子">让资产管理，自然呼吸</h1>
  <p>Domain Asset Management System</p>
</div>

<main>
  <div id="kval" style="display:none; background:#fee2e2; border:1px solid #f87171; color:#991b1b; padding:20px; border-radius:var(--radius); margin-bottom:30px; font-size:14px; box-shadow:var(--shadow);">
    <strong style="font-size:16px; display:block; margin-bottom:5px;">⚠️ KV Namespace 未绑定</strong>请前往 Worker Settings 绑定 KV Namespace。
  </div>

  <div class="stats">
    <div class="sc clickable active" id="card-all" onclick="setFilter('all')"><div class="sn" id="st">0</div><div class="sl">总资产数</div></div>
    <div class="sc clickable" id="card-cf" onclick="setFilter('cf')"><div class="sn" id="sc" style="color:#03A9F4">0</div><div class="sl">云端托管</div></div>
    <div class="sc clickable" id="card-exp" onclick="setFilter('exp')"><div class="sn" id="se" style="color:#FF5252">0</div><div class="sl">已过期</div></div>
    <div class="sc clickable" id="card-30" onclick="setFilter('30')"><div class="sn" id="s3" style="color:#FF9800">0</div><div class="sl">即将到期</div></div>
    <div class="sc clickable" id="card-cost30" onclick="setFilter('cost30')"><div class="sn" id="s-cost30" style="color:#4CAF50">0</div><div class="sl">本月待续费(¥)</div></div>
    <div class="sc clickable" id="card-costyr" onclick="setFilter('costyr')"><div class="sn" id="s-costyr" style="color:#9C27B0">0</div><div class="sl">年度总成本(¥)</div></div>
  </div>

  <div id="p0" class="page a">
    <div class="tw">
      <div class="tw-h">
        <h3 style="font-weight:900; font-size:22px; color:var(--text)" id="list-title">资产节点清单</h3>
        <div style="display:flex; gap:12px; flex-wrap:wrap">
          <button class="btn b-del" id="btn-bulk-del" style="display:none;" onclick="bulkDelete()">🗑️ 删除 (<span id="sel-cnt">0</span>)</button>
          <input type="file" id="restore-file" style="display:none" accept=".json" onchange="doRestoreJSON(event)">
          <button class="btn bs" onclick="document.getElementById('restore-file').click()">📤 还原</button>
          <button class="btn bs" onclick="exportJSON()">💾 备份</button>
          <button class="btn bs" onclick="exportCSV()">⬇️ CSV</button>
          <button class="btn bs" onclick="copyFilteredList()">📋 复制列表</button>
          <button class="btn bs" onclick="feelLucky()" style="background:#FFF9C4; color:#F57F17; border-color:#FFF59D;">🎲 随便逛逛</button>
          <button class="btn bs" onclick="openBulkM()">📦 批量导入</button>
          <button class="btn bp" onclick="openDM()">+ 手动添加</button>
        </div>
      </div>
      <div style="padding: 20px 35px; border-bottom: 1px solid #F5F5F5; display:flex; gap:10px; align-items:center;">
         <span style="font-size:20px; color:#A5D6A7;">🔍</span>
         <input id="dsq" placeholder="输入名称或标签搜索..." oninput="filterD()" style="border:none; background:none; outline:none; font-size:16px; width:100%; font-weight:800; color:inherit;">
      </div>
      <div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th style="width:40px; padding-right:10px;"><input type="checkbox" id="selAll" onclick="toggleAll(this)"></th>
              <th style="cursor:pointer;" onclick="toggleSort('name')">域名与进度 <span id="sort-name" style="color:var(--primary);"></span></th>
              <th>注册商 / 账号</th><th>状态</th>
              <th style="cursor:pointer;" onclick="toggleSort('daysLeft')">到期日期 <span id="sort-daysLeft" style="color:var(--primary);">⬇</span></th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="dtb"></tbody>
        </table>
      </div>
      <div id="demp" style="display:none; padding:100px; text-align:center; color:#B0BEC5; font-size:16px; font-weight:800;">这里空空如也，连一根草都没有长出来呢~</div>
    </div>
  </div>

  <div id="p1" class="page">
    <div class="tw" style="padding:50px">
      <div style="display:flex; justify-content:space-between; margin-bottom:30px; align-items:center;">
        <h3 style="font-size:22px;">Cloudflare 账号绑定</h3><button class="btn bp" onclick="openCFM()">+ 绑定新 API</button>
      </div>
      <div class="stats" id="cfg" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"></div>
      <div style="display:flex; justify-content:space-between; margin:50px 0 30px; align-items:center;">
        <h3 style="font-size:22px;">其他注册商账号</h3><button class="btn bs" onclick="openAM()">+ 新增账号</button>
      </div>
      <div id="acg" class="stats" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"></div>
    </div>
  </div>

  <div id="p2" class="page">
    <div class="tw" style="padding:60px; max-width:700px; margin:0 auto;">
      <h3 style="margin-bottom:35px; font-size:24px; text-align:center;">系统告警与推送设置</h3>
      <div class="fg">
        <label class="fl">选择通知渠道</label>
        <select id="ntype" class="fsel" onchange="switchNotify()">
          <option value="pushplus">🟢 PushPlus 微信推送 (推荐)</option>
          <option value="bark">🍎 Bark 苹果推送</option>
          <option value="email">📧 万能 Webhook / 邮件 API</option>
          <option value="tg">✈️ Telegram 机器人</option>
        </select>
      </div>
      <div id="cfg-tg" class="ncfg" style="display:none;">
        <div class="fg"><label class="fl">BOT TOKEN</label><input class="fi" id="tgtok" placeholder="从 @BotFather 获取"></div>
        <div class="fg"><label class="fl">CHAT ID</label><input class="fi" id="tgcid" placeholder="私聊机器人获取"></div>
        <div style="font-size:13px; color:#ef4444; line-height:1.6; font-weight:700">* 若测试失败，屏幕下方会直接弹出 Telegram 官方的具体拦截原因红字提示。</div>
      </div>
      <div id="cfg-pushplus" class="ncfg" style="display:none;"><div class="fg"><label class="fl">PUSHPLUS TOKEN</label><input class="fi" id="pptok" placeholder="填写 PushPlus Token"></div></div>
      <div id="cfg-bark" class="ncfg" style="display:none;"><div class="fg"><label class="fl">BARK DEVICE KEY</label><input class="fi" id="barkkey" placeholder="例如：qAXXXXXX"></div></div>
      <div id="cfg-email" class="ncfg" style="display:none;"><div class="fg"><label class="fl">API URL (Webhook / Serverless URL)</label><input class="fi" id="emailapi" placeholder="如：https://api.xxx.com/send"></div><div class="fg"><label class="fl">接收方邮箱 (选填)</label><input class="fi" id="emailto" placeholder="如：123456@qq.com"></div></div>
      <div style="display:flex; gap:15px; margin-top:30px; justify-content:center;"><button class="btn bs" id="btn-test-notify" onclick="checkNotify()">发送测试告警</button><button class="btn bp" onclick="saveNotifyCfg()">保存配置</button></div>
    </div>
  </div>

  <div id="p3" class="page">
    <div class="tw" style="padding:50px">
      <div style="display:flex; justify-content:space-between; margin-bottom:30px; align-items:center;">
        <h3 style="font-size:22px;">免费域名资源池</h3><button class="btn bp" onclick="openLM()">+ 添加新资源</button>
      </div>
      <div class="stats" id="link-grid" style="grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));"></div>
    </div>
  </div>
</main>
</div>

<!-- 弹窗：配置域名资产 -->
<div class="mo" id="dm"><div class="md">
  <h3 style="margin-bottom:30px; font-size:24px; color:var(--primary)" id="dmt">配置域名资产</h3>
  <input type="hidden" id="did">
  <div class="fg"><label class="fl">域名地址 *</label><div style="display:flex; gap:10px;"><input class="fi" id="dname" placeholder="例如: example.com"><button class="btn bs" type="button" onclick="autoWhois()" style="padding:0 20px;">⚡ 提取信息</button></div></div>
  
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:20px">
    <div><label class="fl">注册商</label><input class="fi" id="dreg" placeholder="如：Namesilo"></div>
    <div><label class="fl">控制台链接</label><input class="fi" id="dregurl" placeholder="如：https://dash.cloudflare.com"></div>
  </div>
  
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:20px">
    <div><label class="fl">注册日期</label><input class="fi" type="date" id="dreg2"></div>
    <div><label class="fl">到期日期 *</label><input class="fi" type="date" id="dexp"><div style="display:flex; gap:8px; margin-top:10px;"><button type="button" class="rt" onclick="addExpYears(1)">+1年</button><button type="button" class="rt" onclick="addExpYears(3)">+3年</button><button type="button" class="rt" onclick="addExpYears(10)">+10年</button></div></div>
  </div>

  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:20px">
    <div><label class="fl">续费金额 (每年 ¥)</label><input class="fi" type="number" id="dprice" placeholder="例如：60"></div>
    <div><label class="fl">分类标签</label><input class="fi" id="dtags" placeholder="用逗号隔开，如：博客,吃灰"></div>
  </div>

  <div class="fg"><label class="fl">关联账号</label><select class="fsel" id="dacc"></select></div>
  <div class="fg"><label class="fl">到期提前提醒天数</label><div class="rts" id="rts"><div class="rt on" data-d="180">180天</div><div class="rt on" data-d="90">90天</div><div class="rt on" data-d="30">30天</div><div class="rt on" data-d="15">15天</div><div class="rt on" data-d="1">1天</div></div></div>
  <div class="fg" style="background:#F1F8E9; padding:15px; border-radius:20px;"><label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-weight:800; color:#2E7D32"><input type="checkbox" id="dar"> 已经在注册商处开启自动续费</label></div>
  <div class="fg" style="background:#FFEBEE; padding:15px; border-radius:20px;"><label style="display:flex; align-items:center; gap:10px; cursor:pointer; font-weight:800; color:#C62828;"><input type="checkbox" id="dmon"> 开启每日存活监控 (宕机立刻微信告警)</label></div>
  <div class="fg"><label class="fl">备注信息</label><textarea class="fta" id="dnotes" rows="2" placeholder="写点什么..."></textarea></div>
  <div style="display:flex; justify-content: flex-end; gap:15px; margin-top:35px"><button class="btn bs" onclick="closeM('dm')">取消</button><button class="btn bp" onclick="saveD()">确认保存</button></div>
</div></div>

<!-- 批量智能导入弹窗 -->
<div class="mo" id="bm"><div class="md" style="max-height:85vh; display:flex; flex-direction:column;">
  <h3 style="margin-bottom:20px; font-size:24px; color:var(--primary)">批量智能导入</h3>
  
  <div id="bm-step1">
    <div style="font-size:14px; color:#546E7A; margin-bottom:20px; background: #F1F8E9; padding:15px; border-radius:20px; line-height: 1.6;">
      <span style="font-size:16px;">💡</span> <strong>智能解析增强：</strong>支持单行或<strong>多行混合</strong>数据（如从表格直接复制），系统会自动提取其中的域名、日期及链接。提取后将为您展示列表供您<strong>二次勾选确认</strong>。
    </div>
    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:20px;">
      <div class="fg" style="margin:0"><label class="fl">默认注册商</label><input class="fi" id="breg" placeholder="例如：eu.cc"></div>
      <div class="fg" style="margin:0"><label class="fl">默认控制台链接</label><input class="fi" id="burl" placeholder="如：https://..."></div>
    </div>
    <textarea class="fta" id="btext" rows="7" placeholder="粘贴列表文本，如：&#10;test.com 2026-05-12 https://dash.cloudflare.com&#10;030707.eu.cc&#10;2026-03-28&#10;2027-03-28&#10;(系统会自动提取每行内的域名、日期和网页链接)" style="font-family:monospace; line-height: 1.6;"></textarea>
    <div style="display:flex; justify-content: flex-end; gap:15px; margin-top:20px">
      <button class="btn bs" onclick="closeM('bm')">取消</button>
      <button class="btn bp" id="bbtn-parse" onclick="parseBulk()">分析并提取</button>
    </div>
  </div>

  <div id="bm-step2" style="display:none; flex:1; flex-direction:column;">
    <div style="font-size:14px; font-weight:bold; margin-bottom:10px; color:var(--primary);">请勾选要导入的记录：</div>
    <div style="border:2px solid #F1F8E9; border-radius:20px; overflow:hidden; flex:1; display:flex; flex-direction:column; min-height: 250px;">
      <div style="padding:10px 15px; background:#F9FBE7; font-size:13px; font-weight:bold; display:flex; justify-content:space-between; color:#546E7A; border-bottom:1px solid #F1F8E9;">
        <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
          <input type="checkbox" id="bulk-sync-all" checked onchange="toggleAllBulkSync(this)" style="accent-color:var(--primary)"> 全选/取消全选
        </label>
        <span>解析结果 (到期时间)</span>
      </div>
      <div id="bulk-list" style="overflow-y:auto; padding:5px 0; flex:1; max-height:40vh;"></div>
    </div>
    <div style="display:flex; justify-content: flex-end; gap:15px; margin-top:20px">
      <button class="btn bs" onclick="backToBulkStep1()">返回修改</button>
      <button class="btn bp" id="bbtn-save" onclick="saveBulkSelected()">确认导入选中项</button>
    </div>
  </div>

</div></div>

<!-- 其他小弹窗 -->
<div class="mo" id="cfm"><div class="md"><h3 style="margin-bottom:25px">绑定 Cloudflare</h3><div class="fg"><label class="fl">备注名称</label><input class="fi" id="cfn"></div><div class="fg"><label class="fl">API Token</label><input class="fi" id="cft"></div><button class="btn bp" id="cfbtn" style="width:100%; justify-content:center; margin-top:15px" onclick="saveCF()">连接并绑定</button></div></div>

<!-- 包含复选框的 CF 云端同步弹窗 -->
<div class="mo" id="sm"><div class="md">
  <h3 id="smt" style="margin-bottom:25px">云端同步</h3>
  <div id="slding" style="padding:40px 20px; text-align:center; font-weight:800; font-size:18px;">☁️ 正在与云端通讯...</div>
  <div id="sbody" style="display:none">
    <div id="ssum" style="margin:20px 0; font-weight:800; color:var(--primary); font-size:16px;"></div>
    <div style="border:2px solid #F1F8E9; border-radius:20px; overflow:hidden;">
      <div style="padding:10px 15px; background:#F9FBE7; font-size:12px; font-weight:bold; display:flex; justify-content:space-between; color:#546E7A; border-bottom:1px solid #F1F8E9;">
        <label style="cursor:pointer; display:flex; align-items:center; gap:5px;">
          <input type="checkbox" id="cf-sync-all" checked onchange="toggleAllCFSync(this)" style="accent-color:var(--primary)"> 全选/取消
        </label>
        <span>状态</span>
      </div>
      <div id="slist" style="max-height:250px; overflow-y:auto; padding:5px 0;"></div>
    </div>
    <div class="fg" style="margin-top:25px">
      <label class="fl">同步规则</label>
      <select id="smod" class="fsel"><option value="new">仅导入新增 (安全)</option><option value="all">强制覆写更新已有记录</option></select>
    </div>
  </div>
  <div id="sftr" style="margin-top:30px; display:none; justify-content:flex-end; gap:15px">
    <button class="btn bs" onclick="closeM('sm')">取消</button>
    <button class="btn bp" id="sbtn" onclick="doSync()">确认执行同步</button>
  </div>
</div></div>

<div class="mo" id="acm"><div class="md"><h3 style="margin-bottom:25px" id="amt">普通账号管理</h3><input type="hidden" id="aid"><div class="fg"><label class="fl">备注名称 *</label><input class="fi" id="aname"></div><div class="fg"><label class="fl">所属注册商</label><input class="fi" id="areg"></div><div class="fg"><label class="fl">登录地址</label><input class="fi" id="aurl"></div><div class="fg"><label class="fl">关联邮箱</label><input class="fi" id="aemail"></div><button class="btn bp" style="width:100%; justify-content:center; margin-top:15px" onclick="saveA()">保存信息</button></div></div>
<div class="mo" id="lm"><div class="md"><h3 style="margin-bottom:25px" id="lmt">免费资源入库</h3><input type="hidden" id="lid"><div class="fg"><label class="fl">资源名称 *</label><input class="fi" id="lname"></div><div class="fg"><label class="fl">直达网址 *</label><input class="fi" id="lurl"></div><div class="fg"><label class="fl">申请心得或限制</label><textarea class="fta" id="ldesc" rows="3"></textarea></div><button class="btn bp" style="width:100%; justify-content:center; margin-top:15px" onclick="saveL()">保存进库</button></div></div>

<div id="toast"></div>

<!-- ========================================== -->
<!-- ⚠️ 丢失的猫猫与 DOM 结构在这里补回来了！ -->
<!-- ========================================== -->
<div id="cat-container">
  <div id="cat-bubble">载入中喵~</div>
  
  <div id="cat-actions">
    <!-- 使用完全等宽对齐的样式，移除冗余类名 -->
    <button class="cat-btn" onclick="toggleChat(event)">💬 聊天</button>
    <button class="cat-btn" onclick="toggleRoam(event)">🐾 散步</button>
    <button class="cat-btn cat-btn-feed" onclick="feedCat(event)">🔋 喂食</button>
    <button class="cat-btn" onclick="patrolCat(event)">🏃 巡逻</button>
  </div>
  
  <div id="cat-chat">
    <div class="chat-head"><span>🐱 喵管家 (<span id="cat-level-display">见习生</span>)</span><span style="cursor:pointer; font-size:20px;" onclick="toggleChat(event)">×</span></div>
    <div style="display:flex; gap:8px; padding:12px 15px; overflow-x:auto; background:#FFFDE7; border-bottom:1px solid #FFF59D;" id="chat-prompts">
       <button class="b bx" style="background:#fff; border:1px solid #FFF59D; cursor:pointer; font-size:12px;" onclick="sendQuick('资产统计')">📊 统计</button>
       <button class="b bx" style="background:#fff; border:1px solid #FFF59D; cursor:pointer; font-size:12px;" onclick="sendQuick('吃灰')">🔍 找吃灰</button>
       <button class="b bx" style="background:#fff; border:1px solid #FFF59D; cursor:pointer; font-size:12px;" onclick="sendQuick('起名')">✨ 起名</button>
       <button class="b bx" style="background:#fff; border:1px solid #FFF59D; cursor:pointer; font-size:12px;" onclick="sendQuick('算卦')">🔮 算卦</button>
    </div>
    <div class="chat-body" id="chat-body"><div class="chat-msg msg-ai">你好喵！我是这里的管家，需要帮忙吗？</div></div>
    <div class="chat-input-area"><input type="text" id="chat-input" placeholder="输入你想说的话..." onkeydown="if(event.key==='Enter') sendChat()"><button class="chat-send" onclick="sendChat()">发送</button></div>
  </div>
  
  <svg id="cat-svg" viewBox="0 0 200 200" onclick="onCatClick()">
    <!-- 猫尾巴 -->
    <g><path d="M 150 170 Q 190 170 180 130 Q 170 100 190 80" stroke="#FFB74D" stroke-width="16" stroke-linecap="round" fill="none" /><animateTransform attributeName="transform" type="rotate" values="0 150 170; 10 150 170; 0 150 170" dur="2.5s" repeatCount="indefinite" /></g>
    <!-- 身体和脚 -->
    <path d="M 40 200 Q 40 120 100 120 Q 160 120 160 200 Z" fill="#FFE082"/>
    <path d="M 50 140 Q 70 150 60 170 M 150 140 Q 130 150 140 170 M 45 165 Q 65 175 55 190" stroke="#FF9800" stroke-width="4" stroke-linecap="round" fill="none" opacity="0.5"/>
    <path d="M 60 200 Q 60 140 100 140 Q 140 140 140 200 Z" fill="#FFF8E1"/> 
    <!-- 头 -->
    <circle cx="100" cy="90" r="60" fill="#FFE082"/>
    <!-- 耳朵 -->
    <polygon points="50,50 30,0 80,35" fill="#FFB74D"/> <polygon points="55,45 40,15 75,35" fill="#FFCC80"/>
    <polygon points="150,50 170,0 120,35" fill="#FFB74D"/> <polygon points="145,45 160,15 125,35" fill="#FFCC80"/>
    <!-- 额头花纹 -->
    <path d="M 80 50 L 90 75 L 100 60 L 110 75 L 120 50" stroke="#FF9800" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.6"/>
    <!-- 胡须 -->
    <line x1="45" y1="90" x2="60" y2="95" stroke="#FF9800" stroke-width="3" stroke-linecap="round" opacity="0.5"/> <line x1="42" y1="105" x2="58" y2="105" stroke="#FF9800" stroke-width="3" stroke-linecap="round" opacity="0.5"/>
    <line x1="155" y1="90" x2="140" y2="95" stroke="#FF9800" stroke-width="3" stroke-linecap="round" opacity="0.5"/> <line x1="158" y1="105" x2="142" y2="105" stroke="#FF9800" stroke-width="3" stroke-linecap="round" opacity="0.5"/>
    <!-- 眼睛 -->
    <circle cx="75" cy="95" r="14" fill="#3E2723"/> <circle cx="78" cy="92" r="5" fill="#fff"/>
    <circle cx="125" cy="95" r="14" fill="#3E2723"/> <circle cx="122" cy="92" r="5" fill="#fff"/>
    <!-- 嘴巴鼻子 -->
    <path d="M 95 110 Q 100 115 105 110" stroke="#3E2723" stroke-width="3" fill="none" stroke-linecap="round"/>
    <polygon points="98,110 102,110 100,113" fill="#EF5350"/>
    <circle cx="65" cy="155" r="12" fill="#FFB74D"/> <circle cx="135" cy="155" r="12" fill="#FFB74D"/>
    <!-- 进化皮肤 -->
    <path id="cat-crown" style="display:none;" d="M80,35 L90,5 L100,20 L110,5 L120,35 Z" fill="#FFCA28" stroke="#F57F17" stroke-width="2" filter="drop-shadow(0 5px 5px rgba(0,0,0,0.2))"/>
    <g id="cat-glasses" style="display:none;">
      <rect x="52" y="78" width="46" height="24" rx="10" fill="#212121"/> <rect x="102" y="78" width="46" height="24" rx="10" fill="#212121"/>
      <line x1="95" y1="90" x2="105" y2="90" stroke="#212121" stroke-width="5"/>
    </g>
  </svg>
</div>

<!-- 极客终端 Terminal -->
<div id="term">
  <div id="term-out">DOMAIN PRO OS - Cyber Terminal v1.0<br>Type 'help' for commands. (Press ~ to close)<br><br></div>
  <div id="term-in-wrap"><span>root@cyber-node:~#&nbsp;</span><input id="term-in" autocomplete="off"></div>
</div>
<!-- ========================================== -->


<script>
var D=[], A=[], CF=[], L=[], curCFId=null;
var parsedBulkRecords = []; // 存储批量提取出的对象
var currentFilter = 'all', sortCol = 'daysLeft', sortAsc = true;
var catFood = parseInt(localStorage.getItem('catFood')) || 0; 
var isRoaming = false, roamInterval;

const titlePool = [
  "让资产管理，自然呼吸",
  "种下一颗域名，收获一片森林",
  "你的数字花园，生机盎然",
  "告别吃灰，域名不再流浪",
  "赛博空间，也能长出绿叶",
  "极客与自然，完美的交响"
];
function changeTitle() {
  const el = document.getElementById('hero-title');
  el.style.opacity = 0; el.style.transform = 'scale(0.95)';
  setTimeout(function() {
    el.innerText = titlePool[Math.floor(Math.random() * titlePool.length)];
    el.style.opacity = 1; el.style.transform = 'scale(1)';
  }, 300);
}
setTimeout(changeTitle, 100);

if(localStorage.getItem('theme') === 'dark') { document.body.classList.add('dark-mode'); document.getElementById('theme-btn').innerText = '☀️'; }
function toggleDarkMode() {
  var d = document.body.classList.toggle('dark-mode'); localStorage.setItem('theme', d ? 'dark' : 'light');
  document.getElementById('theme-btn').innerText = d ? '☀️' : '🌙'; showCatMsg(d ? "夜色真美喵~ 🌙" : "今天阳光明媚喵~ ☀️");
}

function setErr(msg){ document.getElementById('lerr').textContent = msg || ''; }
function setBtn(txt, dis){ var b=document.getElementById('lbtn'); b.textContent=txt; b.disabled=!!dis; }

document.getElementById('lbtn').onclick = function() {
  var pw = document.getElementById('lpw').value; if (!pw) return setErr('请填写口令');
  setBtn('探索中...', true);
  fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) })
  .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, d: d }; }); })
  .then(function(res) {
    if (res.ok) { document.getElementById('login').style.display = 'none'; document.getElementById('app').style.display = 'block'; init(); } 
    else { setErr(res.d.error || '口令错误'); setBtn('进入草地', false); }
  }).catch(function(e) { setErr('网络迷路了'); setBtn('进入草地', false); });
};
document.getElementById('lpw').onkeydown = function(e) { if (e.key === 'Enter') document.getElementById('lbtn').click(); };

function logout() { fetch('/api/logout', { method: 'POST' }).finally(function() { location.reload(); }); }

function init() { 
  loadAll(); updateCatLevel();
  fetch('/api/health').then(function(r){ return r.json(); }).then(function(d){ if (!d.kv) document.getElementById('kval').style.display = 'block'; }).catch(function(){});
}

function loadAll() { loadStats(); loadD().then(checkCat); loadA(); loadCF(); loadNotifyCfg(); loadL(); }

function loadStats() { 
  get('/api/stats').then(function(r) { 
    if (r) { setText('st', r.total); setText('se', r.expired); setText('s3', r.expiring30); setText('sc', r.cfDomains); setText('s-cost30', r.cost30); setText('s-costyr', r.costYear); }
  }); 
}
function loadD() { return get('/api/domains').then(function(r) { D = r ||[]; filterD(); updateAccSel(); }); }
function loadA() { get('/api/accounts').then(function(r) { A = r ||[]; renderA(); updateAccSel(); }); }
function loadCF() { get('/api/cf-accounts').then(function(r) { CF = r ||[]; renderCF(); updateAccSel(); }); }
function loadL() { get('/api/free-links').then(function(r) { L = r ||[]; renderL(); }); }

function exportCSV() {
  if (!D || D.length === 0) return toast('没数据可导呀', 'e');
  var csv = '域名,注册商,所属账号,到期日期,状态,自动续费\n';
  for (var i = 0; i < D.length; i++) {
    var d = D[i]; var status = d.daysLeft < 0 ? '已过期' : d.daysLeft > 10000 ? '永久有效' : d.daysLeft + '天后'; var accName = d.accountName === '—' ? '未关联' : d.accountName;
    csv += d.name + ',' + (d.registrar || '—') + ',' + accName + ',' + (d.expiryDate || '—') + ',' + status + ',' + (d.autoRenew ? '是' : '否') + '\n';
  }
  var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' }); var link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'domain_assets.csv'; link.click();
  showCatMsg("CSV 导出成功！存在本地更安心喵~");
}
function exportJSON() {
  var blob = new Blob([JSON.stringify({ exportDate: new Date().toISOString(), domains: D, accounts: A, cf_accounts: CF, free_links: L }, null, 2)], { type: 'application/json' });
  var link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'domain_pro_backup.json'; link.click(); showCatMsg("JSON 完美备份成功！");
}
function doRestoreJSON(e) {
  var file = e.target.files[0]; if(!file) return; var reader = new FileReader();
  reader.onload = function(ev) {
    try {
      if(!confirm('⚠️ 警告：这会抹除当前所有数据并覆盖！继续吗？')) { e.target.value=''; return; }
      post('/api/restore', JSON.parse(ev.target.result)).then(function(r) { if(r) { toast('还原成功！'); showCatMsg('数据时光倒流成功喵！'); loadAll(); } e.target.value=''; });
    } catch(err) { toast('文件解析失败', 'e'); e.target.value=''; }
  };
  reader.readAsText(file);
}

function copyFilteredList() {
  var q = document.getElementById('dsq').value.toLowerCase();
  var arr = D.filter(function(d) {
    if (q && d.name.indexOf(q) < 0 && (!d.tags || d.tags.toLowerCase().indexOf(q) < 0)) return false;
    if (currentFilter === 'cf') return d.source && d.source.indexOf('cf') === 0; if (currentFilter === 'exp') return d.daysLeft < 0; if (currentFilter === '30') return d.daysLeft >= 0 && d.daysLeft <= 30;
    if (currentFilter === 'cost30') return d.daysLeft >= 0 && d.daysLeft <= 30 && d.price > 0; if (currentFilter === 'costyr') return d.price > 0; return true; 
  });
  if(arr.length === 0) return toast('列表是空的，没法复制', 'e');
  var txt = arr.map(function(d){ return d.name; }).join('\n');
  if (navigator.clipboard) { navigator.clipboard.writeText(txt).then(function(){ showCatMsg("📋 复制了 " + arr.length + " 个域名喵！"); toast('已复制'); }).catch(function(){ toast('复制被拦截', 'e'); }); }
  else { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); toast('已复制'); }
}

function feelLucky() {
  if(!D.length) return showCatMsg("没域名怎么逛！", true);
  var rd = D[Math.floor(Math.random() * D.length)]; showCatMsg("🎲 开启传送门：前往【" + rd.name + "】"); window.open('http://' + rd.name, '_blank');
}
function catWhois(domain) {
  showCatMsg('🕵️ 悄悄查【' + domain + '】的底细...');
  post('/api/whois', {domain: domain}).then(function(r) { if(r && r.ok) showCatMsg('【' + domain + '】底细：\n注册商: ' + (r.registrar||'神秘人') + '\n到期: ' + (r.exp||'未知')); else showCatMsg('查不到这小家伙喵！', true); });
}
function pingDomain(domain) { showCatMsg('⚡ 模拟 Ping 测试中...'); setTimeout(function() { showCatMsg('【' + domain + '】活跃中！\n延迟: ' + (Math.random() * 40 + 10).toFixed(1) + ' ms'); }, 1200); }

var catQuotes =["代码千行，常备份喵~", "安心摸鱼吧，我在这里盯着！🐟", "今天也是元气满满的一天喵~ 🌻"];
function updateCatLevel() {
  document.getElementById('cat-level-display').innerText = catFood < 5 ? '见习生' : catFood < 20 ? '熟练工' : catFood < 50 ? '总管家' : '神级主子';
  document.getElementById('cat-crown').style.display = D.length >= 20 ? 'block' : 'none'; document.getElementById('cat-glasses').style.display = catFood >= 50 ? 'block' : 'none';
}
function showCatMsg(txt, isAlert) {
  var b = document.getElementById('cat-bubble'); b.innerText = txt; b.style.color = isAlert ? '#FF5252' : '#2E7D32'; b.style.opacity = '1'; b.style.transform = 'translateY(0)';
  clearTimeout(window.catTimer); window.catTimer = setTimeout(function() { b.style.opacity = '0'; b.style.transform = 'translateY(10px)'; }, 5000);
}
function toggleRoam(e) {
  if(e) e.stopPropagation(); isRoaming = !isRoaming; var cb = document.getElementById('cat-container'), svg = document.getElementById('cat-svg');
  if (isRoaming) {
    showCatMsg("🐾 出门踏青啦！"); document.getElementById('cat-actions').style.display = 'none'; document.getElementById('cat-chat').style.display = 'none';
    cb.style.bottom = 'auto'; cb.style.right = 'auto'; cb.style.left = (window.innerWidth - 200) + 'px'; cb.style.top = (window.innerHeight - 200) + 'px';
    roamInterval = setInterval(function(){
      var nx = Math.random() * (window.innerWidth - 180), ny = Math.random() * (window.innerHeight - 180), cx = parseFloat(cb.style.left) || 0;
      svg.style.transform = (nx < cx) ? 'scaleX(-1)' : 'scaleX(1)'; cb.style.transition = 'all 3s ease-in-out'; cb.style.left = nx + 'px'; cb.style.top = ny + 'px';
    }, 3500);
  } else {
    clearInterval(roamInterval); cb.style.transition = 'all 0.8s'; cb.style.left = ''; cb.style.top = ''; cb.style.bottom = '-10px'; cb.style.right = '10px'; svg.style.transform = 'scaleX(1)';
    showCatMsg("回小窝咯喵~"); setTimeout(function(){ document.getElementById('cat-actions').style.display = 'flex'; }, 800);
  }
}
function toggleChat(e) { if(e) e.stopPropagation(); var c = document.getElementById('cat-chat'); c.style.display = c.style.display === 'block' ? 'none' : 'block'; }
function sendQuick(t) { document.getElementById('chat-input').value = t; sendChat(); }
function sendChat() {
  var i = document.getElementById('chat-input'), m = i.value.trim(); if(!m) return;
  appendChat('user', m); i.value = '';
  setTimeout(function(){
    var q=m.toLowerCase(), r="听不懂喵，可以点上面按钮哦~";
    if (q.includes('统计')) r = "当前总计管控 " + D.length + " 个资产！";
    if (q.includes('起名')) { var p = ['green','tree','sky','cloud','leaf'], s = ['ops','net','hub','zone'], e = ['.io','.me','.co']; r = "这个名字很清新：【" + p[Math.floor(Math.random()*p.length)]+s[Math.floor(Math.random()*s.length)]+e[Math.floor(Math.random()*e.length)] + "】"; }
    if (q.includes('吃灰')) { var u = D.filter(function(x){ return !x.tags; }); r = u.length ? "抓到 "+u.length+" 个没标签的吃灰域名，快去整理！" : "都很干净，没有吃灰资产喵~"; }
    if (q.includes('跑') || q.includes('步')) { setTimeout(toggleRoam, 1000); r = "好耶，出去玩！"; }
    if (q.includes('算卦')) r = "点列表里的 🔮 按钮就能算命啦！";
    appendChat('ai', r);
  }, 600);
}
function appendChat(role, text) {
  var b = document.getElementById('chat-body'), el = document.createElement('div');
  el.className = 'chat-msg ' + (role === 'ai' ? 'msg-ai' : 'msg-user'); el.innerText = text; b.appendChild(el); b.scrollTop = b.scrollHeight;
}
let catClickCount = 0, catClickTimer;
function onCatClick() {
  if (isRoaming) return toggleRoam(); catClickCount++; clearTimeout(catClickTimer);
  if (catClickCount >= 6) {
    showCatMsg("别摸头啦，毛要秃了！😾", true); var svg = document.getElementById('cat-svg'); svg.style.animation = 'none'; svg.style.transform = 'scale(1.1) translateY(-20px)';
    setTimeout(function() { svg.style.transform = ''; svg.style.animation = 'floatCat 3s ease-in-out infinite'; catClickCount = 0; }, 2000);
  } else { showCatMsg(Math.random() > 0.7 ? "肚子饱饱，心情好好 (罐头:"+catFood+")" : catQuotes[Math.floor(Math.random() * catQuotes.length)]); }
  catClickTimer = setTimeout(function() { catClickCount = 0; }, 1500);
}
function checkCat() { updateCatLevel(); if(D.filter(function(d){return d.daysLeft<=30}).length>0) showCatMsg("警报！有绿植快枯萎了(域名快到期)！", true); }
function feedCat(e) { e.stopPropagation(); catFood++; localStorage.setItem('catFood', catFood); updateCatLevel(); showCatMsg("好吃！干劲满满！⚡"); }
function patrolCat(e) {
  e.stopPropagation(); var cb = document.getElementById('cat-container'), ac = document.getElementById('cat-actions'); ac.style.display = 'none';
  showCatMsg("巡视领地中... 🏃"); cb.style.transform = 'translateX(-70vw) scaleX(-1)';
  setTimeout(function(){
    cb.style.transform = 'translateX(-70vw) scaleX(1)'; showCatMsg("发现几只虫子，已被我消灭！ 🐛");
    setTimeout(function(){ cb.style.transform = 'translateX(0) scaleX(1)'; showCatMsg("巡逻完毕，天下太平！"); setTimeout(function(){ ac.style.display = 'flex'; checkCat(); }, 1500); }, 2000);
  }, 1500);
}
function appraiseDomain(domain) { var val = Math.abs(domain.split('').reduce(function(a,b){a=((a<<5)-a)+b.charCodeAt(0);return a&a},0))%888888; showCatMsg('🔮【'+domain+'】估值: ¥'+val+'，好兆头！'); }
function checkSSL(domain) { showCatMsg('查SSL证书... 🔒'); post('/api/ssl', {domain:domain}).then(function(r) { if(r&&r.ok) showCatMsg('证书剩 '+r.days+' 天\n颁发: '+r.issuer); else showCatMsg('可能没开HTTPS',true); }); }
function showQR(domain) {
  var div = document.createElement('div');
  div.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); z-index:9999; background:#fff; padding:20px; border-radius:30px; box-shadow:0 20px 50px rgba(0,0,0,0.2); text-align:center; cursor:pointer;';
  div.innerHTML = '<h4 style="margin-bottom:15px; color:#2E7D32;">' + domain + '</h4><img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=http://' + domain + '" style="border-radius:15px;"><p style="font-size:12px; color:#999; margin-top:10px;">点击关闭</p>';
  div.onclick = function(){ div.remove(); }; document.body.appendChild(div); showCatMsg('传送门生成完毕！📱');
}
function copyTxt(txt) { navigator.clipboard.writeText(txt).then(function(){ toast('复制成功'); }); }

function toggleSort(col) {
  if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; }
  document.getElementById('sort-name').innerText = ''; document.getElementById('sort-daysLeft').innerText = '';
  document.getElementById('sort-'+col).innerText = sortAsc ? '⬇' : '⬆'; filterD();
}

function setFilter(type) {
  currentFilter = type; document.querySelectorAll('.sc.clickable').forEach(function(el) { el.classList.remove('active'); }); document.getElementById('card-' + type).classList.add('active');
  var tm = { 'all': '资产节点清单', 'cf': '云端托管节点', 'exp': '失效终端', '30': '即将到期节点', 'cost30': '💸 本月待续费清单', 'costyr': '💎 所有付费域名' };
  document.getElementById('list-title').innerText = tm[type] || '清单'; filterD();
}

function filterD() {
  var q = document.getElementById('dsq').value.toLowerCase();
  var f = D.filter(function(d) {
    if (q && d.name.indexOf(q) < 0 && (!d.tags || d.tags.toLowerCase().indexOf(q) < 0)) return false;
    if (currentFilter === 'cf') return d.source && d.source.indexOf('cf') === 0; if (currentFilter === 'exp') return d.daysLeft < 0; if (currentFilter === '30') return d.daysLeft >= 0 && d.daysLeft <= 30;
    if (currentFilter === 'cost30') return d.daysLeft >= 0 && d.daysLeft <= 30 && d.price > 0; if (currentFilter === 'costyr') return d.price > 0; return true; 
  });
  if((currentFilter === 'cost30' || currentFilter === 'costyr') && f.length === 0) toast('未发现填写了金额的记录~');
  f.sort(function(a, b) { var va = a[sortCol], vb = b[sortCol]; return sortAsc ? (sortCol==='name'?va.localeCompare(vb):(va-vb)) : (sortCol==='name'?vb.localeCompare(va):(vb-va)); });
  renderD(f);
}

function toggleAll(el) { document.querySelectorAll('.dsel').forEach(function(cb) { cb.checked = el.checked; }); updateSel(); }
function updateSel() {
  var cnt = document.querySelectorAll('.dsel:checked').length, allCnt = document.querySelectorAll('.dsel').length;
  document.getElementById('sel-cnt').innerText = cnt; document.getElementById('btn-bulk-del').style.display = cnt > 0 ? 'inline-flex' : 'none';
  document.getElementById('selAll').checked = (cnt === allCnt && allCnt > 0);
}

function bulkDelete() {
  var ids = Array.from(document.querySelectorAll('.dsel:checked')).map(function(cb) { return cb.value; });
  if(!ids.length || !confirm('🚨 确定永久拔掉这 ' + ids.length + ' 棵草吗？')) return;
  var btn = document.getElementById('btn-bulk-del'); btn.innerHTML = '清理中...'; btn.disabled = true;
  post('/api/domains/bulk-delete', { ids: ids }, 'POST').then(function(r){ btn.disabled = false; if(r) { toast('清理成功'); document.getElementById('selAll').checked = false; loadD(); loadStats(); } });
}

function switchNotify() { var t = gval('ntype'); ['tg','pushplus','bark','email'].forEach(function(k){hide('cfg-'+k);}); show('cfg-' + t); }
function loadNotifyCfg() { get('/api/notify').then(function(r) { if(r){ val('ntype', r.type || 'pushplus'); switchNotify(); val('tgcid', r.tgChatId); val('emailapi', r.emailApi); val('emailto', r.emailTo); if(r.tgBotToken) val('tgtok','***'); if(r.pushplusToken) val('pptok','***'); if(r.barkKey) val('barkkey','***'); } }); }

// ⚠️ 修复：捕获 TG 等测试通知的报错并展示
function checkNotify() { 
  var btn = document.getElementById('btn-test-notify');
  var oldTxt = btn.innerText;
  btn.innerText = '发信测试中...'; btn.disabled = true;
  
  post('/api/notify', { type: gval('ntype'), tgBotToken: gval('tgtok'), tgChatId: gval('tgcid'), pushplusToken: gval('pptok'), barkKey: gval('barkkey'), emailApi: gval('emailapi'), emailTo: gval('emailto') }).then(function(r){ 
    if(r) {
      fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
      .then(function(res) {
        if(res.status === 401) { location.reload(); return; }
        return res.json().then(function(d){
          btn.innerText = oldTxt; btn.disabled = false;
          if(!res.ok) { toast(d.error || '推送失败，请检查配置', 'e'); }
          else { toast('测试请求已发出，请留意接收'); }
        });
      })
      .catch(function(e){ btn.innerText = oldTxt; btn.disabled = false; toast('网络异常', 'e'); });
    } else { btn.innerText = oldTxt; btn.disabled = false; }
  }); 
}

function saveNotifyCfg() { post('/api/notify', { type: gval('ntype'), tgBotToken: gval('tgtok'), tgChatId: gval('tgcid'), pushplusToken: gval('pptok'), barkKey: gval('barkkey'), emailApi: gval('emailapi'), emailTo: gval('emailto') }).then(function(r){ if(r) toast('保存成功'); }); }

function goto(n) { 
  [0,1,2,3].forEach(function(i){ 
    var p = document.getElementById('p'+i); 
    if(p) p.className = 'page' + (i===n?' a':''); 
    var nc = document.getElementById('nc'+i);
    if(nc) { if(i===n) nc.classList.add('active'); else nc.classList.remove('active'); }
  }); 
}
function goHome() { goto(0); setFilter('all'); loadAll(); toast('数据已刷新'); }

function renderD(list) {
  var tb = document.getElementById('dtb'); document.getElementById('selAll').checked = false; updateSel(); 
  if (!list.length) { tb.innerHTML = ''; show('demp'); return; } hide('demp');
  tb.innerHTML = list.map(function(d) {
    var dl = d.daysLeft, bc = dl < 0 ? 'br' : dl <= 30 ? 'bw' : 'bg', bt = dl < 0 ? '已过期' : dl > 10000 ? '永久' : dl + ' 天后', disp = dl > 10000 ? '永久有效' : (d.expiryDate || '—');
    var pct = dl < 0 ? 0 : dl > 365 ? 100 : (dl / 365 * 100), pbColor = dl < 0 ? '#FF5252' : dl <= 30 ? '#FF9800' : '#4CAF50';
    var pb = '<div style="height:5px; width:100%; background:#F5F5F5; border-radius:10px; margin-top:10px; overflow:hidden;"><div style="height:100%; width:'+pct+'%; background:'+pbColor+'; border-radius:10px; transition:1s;"></div></div>';
    var srcBadge = d.source === 'cf_registrar' ? '<span class="tag">☁ CF注册</span>' : d.source === 'cf_zone' ? '<span class="tag" style="opacity:0.8">☁ CF托管</span>' : '';
    var tags = (d.tags||'').split(',').filter(function(x){return x.trim()}).map(function(x){return '<span class="tag">#'+x.trim()+'</span>'}).join('');
    var mon = d.monitor ? '<span title="监控中" style="margin-right:5px">🩺</span>' : '';
    
    return '<tr><td><input type="checkbox" class="dsel" value="' + d.id + '" onchange="updateSel()"></td><td>'
      + '<div class="dn">' + mon + '<a href="http://' + d.name + '" target="_blank">' + d.name + '</a> <span class="cp-btn" onclick="copyTxt(\''+d.name+'\')">📋</span> <span class="cp-btn" onclick="pingDomain(\''+d.name+'\')">⚡</span> <span class="cp-btn" onclick="catWhois(\''+d.name+'\')">ℹ️</span> <span class="cp-btn" onclick="showQR(\''+d.name+'\')">📱</span> <span class="cp-btn" onclick="checkSSL(\''+d.name+'\')">🔒</span> <span class="cp-btn" onclick="appraiseDomain(\''+d.name+'\')">🔮</span></div><div style="margin-top:8px">' + srcBadge + tags + '</div>' + pb + '</td>'
      + '<td><div style="font-size:13px; color:#78909C; margin-bottom:5px">' + (d.registrarUrl?'<a href="'+d.registrarUrl+'" target="_blank" style="color:var(--secondary);text-decoration:none;">'+(d.registrar||'控制台')+'↗</a>':(d.registrar||'—')) + '</div><span class="b bx">' + (d.accountName || '无') + '</span> <span class="b" style="background:#E8F5E9; color:#2E7D32;">¥' + (d.price || 0) + '</span></td>'
      + '<td><span class="b ' + bc + '">' + bt + '</span></td><td style="color:#78909C;">' + disp + '</td>'
      + '<td><div style="display:flex;gap:5px"><button class="nb" style="color:var(--primary)" onclick="editD(\'' + d.id + '\')">✏️</button><button class="nb" style="color:#FF5252" onclick="delD(\'' + d.id + '\')">🗑️</button></div></td></tr>';
  }).join('');
}

// ─── ⚠️ 批量导入重构：分为“文本提取”和“勾选确认”两步 ───
function openBulkM() { 
  val('btext', ''); val('breg', ''); val('burl', ''); 
  document.getElementById('bm-step1').style.display = 'block';
  document.getElementById('bm-step2').style.display = 'none';
  openM('bm'); 
}

function parseBulk() {
  var txt = gval('btext');
  if(!txt.trim()) return toast('请先粘贴列表内容', 'e');
  
  var ls = txt.split('\n'), cr = null; 
  parsedBulkRecords = []; // 清空之前的解析结果
  
  for(var i=0; i<ls.length; i++) {
    var l = ls[i].trim(); 
    if(!l) continue;
    
    var um = l.match(/(https?:\/\/[^\s]+)/ig);
    var lu = l.replace(/(https?:\/\/[^\s]+)/ig, ' ');
    var dm = lu.match(/([a-zA-Z0-9\u4e00-\u9fa5-]+\.)+[a-zA-Z]{2,}/);
    
    if(dm) { 
      if(cr && cr.n) parsedBulkRecords.push(cr); 
      cr = { n: dm[0].toLowerCase(), d: [], u: '', p: false }; 
    }
    
    if(cr) {
      var dts = l.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g) || [];
      dts.forEach(function(d){ 
        var p = d.replace(/[年月\/]/g,'-').replace(/日/g,'').split('-'); 
        cr.d.push(p[0] + '-' + p[1].padStart(2,'0') + '-' + p[2].padStart(2,'0')); 
      });
      if(um && !cr.u) cr.u = um[0]; 
      if(/永久|永不过期/.test(l)) cr.p = true;
    }
  }
  if(cr && cr.n) parsedBulkRecords.push(cr);
  
  if (parsedBulkRecords.length === 0) return toast('未识别到有效的域名和日期', 'e');
  
  var defReg = gval('breg').trim();
  var defUrl = gval('burl').trim();
  
  // 渲染二次确认复选列表
  var listHtml = parsedBulkRecords.map(function(r, index) {
    var ed = '', rd = ''; 
    if (r.d.length > 1) r.d.sort();
    if (r.p) { 
      ed = '2099-12-31'; 
      if (r.d.length > 0) rd = r.d[0]; 
    } else { 
      if (r.d.length >= 2) { 
        rd = r.d[0]; ed = r.d[r.d.length-1]; 
      } else if (r.d.length === 1) { 
        ed = r.d[0]; 
      } 
    }
    // 将计算出的最终日期和参数挂载在对象上
    r.parsedExp = ed;
    r.parsedReg = rd;
    r.finalUrl = r.u || defUrl;
    r.finalReg = defReg || '未知/批量';
    
    var expDisplay = ed ? ed : '<span style="color:#FF5252">无日期</span>';
    
    return '<div style="padding:10px 15px; border-bottom:1px solid #F5F5F5; font-size:14px; font-weight:700; display:flex; justify-content:space-between; align-items:center;">' +
           '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">' +
           '<input type="checkbox" class="bulk-sync-cb" value="' + index + '" checked style="accent-color:var(--primary)"> ' +
           '<span>' + r.n + '</span></label>' +
           '<span style="color:#90A4AE; font-size:13px">' + expDisplay + '</span></div>';
  }).join('');
  
  document.getElementById('bulk-list').innerHTML = listHtml;
  document.getElementById('bm-step1').style.display = 'none';
  document.getElementById('bm-step2').style.display = 'flex'; // 进入步骤二
}

function toggleAllBulkSync(el) {
  document.querySelectorAll('.bulk-sync-cb').forEach(function(cb){ cb.checked = el.checked; });
}

function backToBulkStep1() {
  document.getElementById('bm-step1').style.display = 'block';
  document.getElementById('bm-step2').style.display = 'none';
}

async function saveBulkSelected() {
  var cbs = document.querySelectorAll('.bulk-sync-cb:checked');
  if(cbs.length === 0) return toast('请至少勾选一项以导入', 'e');
  
  var btn = document.getElementById('bbtn-save'); 
  btn.innerHTML = '导入中...'; btn.disabled = true;
  
  var added = 0;
  for (var i=0; i<cbs.length; i++) {
     var idx = parseInt(cbs[i].value);
     var r = parsedBulkRecords[idx];
     
     if(!r.parsedExp) continue; // 无有效日期则忽略
     
     await post('/api/domains', {
       name: r.n, 
       expiryDate: r.parsedExp, 
       registeredAt: r.parsedReg, 
       registrar: r.finalReg, 
       registrarUrl: r.finalUrl, 
       autoRenew: false, 
       monitor: false, 
       price: 0, 
       tags: '批量导入', 
       source: 'bulk'
     });
     added++;
  }
  
  btn.innerHTML = '确认导入选中项'; btn.disabled = false; 
  closeM('bm'); 
  toast('成功导入 ' + added + ' 个资产！'); 
  loadD(); loadStats();
}

function updateAccSel() { document.getElementById('dacc').innerHTML = '<option value="">无关联</option>' + A.concat(CF).map(function(a){ return '<option value="' + a.id + '">' + a.name + '</option>'; }).join(''); }

function openDM(d) {
  setText('dmt', d ? '修改属性' : '种植新资产'); val('did', d ? d.id : ''); val('dname', d ? d.name : ''); 
  val('dreg', d ? d.registrar : ''); val('dregurl', d ? d.registrarUrl : ''); 
  val('dprice', d ? d.price : ''); val('dtags', d ? d.tags : ''); val('dreg2', d ? d.registeredAt : '');
  var nd = new Date(); nd.setFullYear(nd.getFullYear() + 1); var defExp = nd.getFullYear() + '-' + String(nd.getMonth()+1).padStart(2,'0') + '-' + String(nd.getDate()).padStart(2,'0');
  val('dexp', d ? d.expiryDate : defExp); val('dacc', d ? d.accountId : ''); val('dnotes', d ? d.notes : '');
  var rem = d ? (d.reminderDays ||[1, 15, 30, 90, 180]) :[1, 15, 30, 90, 180];
  document.querySelectorAll('.rt').forEach(function(t) { if(t.dataset.d) t.className = 'rt' + (rem.indexOf(+t.dataset.d) >= 0 ? ' on' : ''); });
  document.getElementById('dar').checked = d ? !!d.autoRenew : false; document.getElementById('dmon').checked = d ? !!d.monitor : false; openM('dm');
}
function editD(id) { openDM(D.find(function(x){return x.id===id;})); }

function saveD() {
  var id = gval('did'), rem =[]; document.querySelectorAll('.rt.on').forEach(function(t){ if(t.dataset.d) rem.push(+t.dataset.d); });
  post(id ? '/api/domains/'+id : '/api/domains', { name: gval('dname'), registrar: gval('dreg'), registrarUrl: gval('dregurl'), price: gval('dprice'), tags: gval('dtags'), accountId: gval('dacc'), registeredAt: gval('dreg2'), expiryDate: gval('dexp'), autoRenew: document.getElementById('dar').checked, monitor: document.getElementById('dmon').checked, notes: gval('dnotes'), reminderDays: rem }, id ? 'PUT' : 'POST').then(function(r) { if (r) { closeM('dm'); toast('保存成功'); loadD(); loadStats(); } });
}
function delD(id) { if (confirm('彻底删除？')) post('/api/domains/'+id, null, 'DELETE').then(function(r){ if(r){ toast('已删除'); loadD(); loadStats(); } }); }
function autoWhois() { post('/api/whois', { domain: gval('dname').trim() }).then(function(r) { if(r && r.ok) { val('dexp', r.exp); val('dreg2', r.reg); val('dreg', r.registrar); toast('成功提取'); showCatMsg("信息抓取成功喵！", false); } }); }

function renderCF() { document.getElementById('cfg').innerHTML = CF.map(function(a) { return '<div class="sc" style="text-align:left; border-top:4px solid #4FC3F7;"><strong>☁️ ' + a.name + '</strong><br><span style="font-size:12px;color:#78909C">' + a.cfAccountName + '</span><div style="margin-top:15px; display:flex; gap:10px;"><button class="btn bp" onclick="openSync(\'' + a.id + '\')">↻ 同步</button><button class="btn bs" onclick="delCF(\'' + a.id + '\')">断开</button></div></div>'; }).join(''); }
function openCFM() { val('cfn',''); val('cft',''); openM('cfm'); }
function saveCF() { post('/api/cf-accounts', { name: gval('cfn'), apiToken: gval('cft') }).then(function(r) { if(r) { closeM('cfm'); loadCF(); } }); }
function delCF(id) { if (confirm('断开？')) post('/api/cf-accounts/'+id, null, 'DELETE').then(function(r){ if(r) loadCF(); }); }

function toggleAllCFSync(el) {
  document.querySelectorAll('.cf-sync-cb').forEach(function(cb){ cb.checked = el.checked; });
}
function openSync(cfId) {
  curCFId = cfId; var cf = CF.find(function(a){return a.id===cfId;}); setText('smt', '同步 Cloudflare: ' + (cf ? cf.name : ''));
  show('slding'); hide('sbody'); document.getElementById('sftr').style.display = 'none'; openM('sm');
  post('/api/cf-preview', { cfAccountId: cfId }).then(function(r) {
    hide('slding'); if (!r || r.error) { toast(r?.error || '请求受阻', 'e'); return; } 
    show('sbody'); document.getElementById('sftr').style.display = 'flex';
    document.getElementById('ssum').innerHTML = '扫描到 <strong>' + r.total + '</strong> 个网关节点，包含 <strong>' + r.newCount + '</strong> 个新节点。';
    
    document.getElementById('slist').innerHTML = r.domains.map(function(d){ 
      return '<div style="padding:10px 15px; border-bottom:1px solid #F5F5F5; font-size:14px; font-weight:700; display:flex; justify-content:space-between; align-items:center;">' +
             '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">' +
             '<input type="checkbox" class="cf-sync-cb" value="' + d.name + '" checked style="accent-color:var(--primary)"> ' +
             '<span>' + d.name + '</span></label>' +
             '<span style="color:#90A4AE; font-size:13px">' +
             (d.exists ? '<span class="tag" style="margin:0 5px 0 0">已存在</span>' : '') +
             (d.expiryDate || '永久有效') + '</span></div>'; 
    }).join('');
  });
}
function doSync() { 
  var cbs = document.querySelectorAll('.cf-sync-cb:checked');
  if(cbs.length === 0) return toast('请至少勾选一个要同步的域名', 'e');
  var selected = Array.from(cbs).map(function(cb){ return cb.value; });

  var btn = document.getElementById('sbtn'); btn.textContent = '数据传输中...'; btn.disabled = true;
  post('/api/cf-sync', { cfAccountId: curCFId, mode: gval('smod'), selectedDomains: selected }).then(function(r) { 
    btn.textContent = '确认执行同步'; btn.disabled = false; 
    if (r) { closeM('sm'); toast('同步完成！新增 ' + r.added + '，覆写 ' + r.updated); loadD(); loadStats(); showCatMsg('云端数据拉取完毕喵~'); } 
  }); 
}

function renderA() { document.getElementById('acg').innerHTML = A.map(function(a){ return '<div class="sc" style="text-align:left; border-top:4px solid #81C784;"><strong>' + a.name + '</strong><br><span style="font-size:12px;color:#78909C">' + (a.registrar||'未知') + '</span><div style="margin-top:15px; display:flex; gap:10px;"><button class="btn bs" onclick="delA(\'' + a.id + '\')">🗑️</button></div></div>'; }).join(''); }
function openAM() { val('aid',''); val('aname',''); val('areg',''); val('aurl',''); val('aemail',''); openM('acm'); }
function saveA() { post('/api/accounts', {name: gval('aname'), registrar: gval('areg')}).then(function(r){if(r){closeM('acm');loadA();}}); }
function delA(id) { if(confirm('删除？')) post('/api/accounts/'+id, null, 'DELETE').then(function(r){if(r) loadA();}); }

function renderL() { document.getElementById('link-grid').innerHTML = L.map(function(l) { return '<div class="sc" style="text-align:left; border-top:4px solid #FFEB3B;"><strong>🎁 ' + l.name + '</strong><p style="font-size:13px;color:#546E7A;margin:8px 0;">' + (l.desc||'暂无心得') + '</p><div style="margin-top:15px; display:flex; gap:10px;"><a href="' + l.url + '" target="_blank" class="btn bp" style="text-decoration:none;">前往白嫖</a><button class="btn bs" onclick="delL(\'' + l.id + '\')">移除</button></div></div>'; }).join(''); }
function openLM() { val('lid',''); val('lname',''); val('lurl',''); val('ldesc',''); openM('lm'); }
function saveL() { var id=gval('lid'); post(id?'/api/free-links/'+id:'/api/free-links', {name: gval('lname'), url: gval('lurl'), desc: gval('ldesc')}, id?'PUT':'POST').then(function(r){if(r){closeM('lm');loadL();}}); }
function delL(id) { if(confirm('删除资源？')) post('/api/free-links/'+id, null, 'DELETE').then(function(r){if(r) loadL();}); }

document.addEventListener('keydown', function(e) { 
  if(e.code === 'Backquote' && document.getElementById('app').style.display !== 'none') { 
    e.preventDefault(); var t = document.getElementById('term'); 
    if(t.style.display === 'none'){ t.style.display = 'block'; document.getElementById('term-in').focus(); } else { t.style.display = 'none'; } 
  } 
});
document.getElementById('term-in').onkeydown = function(e) {
  if(e.key === 'Enter') {
    var v = e.target.value.trim(); e.target.value = ''; var out = document.getElementById('term-out');
    out.innerHTML += 'root:~# ' + String(v).replace(/[<>&"']/g,'*') + '<br>';
    if(v === 'clear') out.innerHTML = ''; else if(v === 'ls') out.innerHTML += D.map(function(x){ return x.name; }).join('<br>')+'<br>'; else if(v) out.innerHTML += 'Command not found<br>';
    document.getElementById('term').scrollTop = document.getElementById('term').scrollHeight;
  }
};

document.getElementById('rts').onclick = function(e) { var t=e.target.closest('.rt'); if(t) t.className='rt'+(t.className.includes('on')?'':' on'); };
function openM(id){ document.getElementById(id).classList.add('on'); } function closeM(id){ document.getElementById(id).classList.remove('on'); }
document.querySelectorAll('.mo').forEach(function(m){ m.onclick=function(e){ if(e.target===m) m.classList.remove('on'); }; });
function toast(m, t) { var el=document.createElement('div'); el.className='ti'; el.style.background=t==='e'?'#FF5252':'#2E7D32'; el.textContent=m; document.getElementById('toast').appendChild(el); setTimeout(function(){el.remove();}, 3000); }

// HTTP 错误透传给 Toast 提示
function get(url) { return fetch(url).then(function(r){ return r.status===401?location.reload():r.json(); }).catch(function(){return null;}); }
function post(url, b, m) { 
  return fetch(url, {method:m||'POST', headers:{'Content-Type':'application/json'}, body:b?JSON.stringify(b):null})
  .then(function(r){
    if(r.status===401) { location.reload(); return null; }
    return r.json().then(function(d){
      if(!r.ok && url !== '/api/check'){ toast(d.error||'发生错误','e'); return null; }
      return d;
    });
  }).catch(function(){return null;}); 
}

function gval(id){ return document.getElementById(id).value; } function val(id,v){ document.getElementById(id).value=v||''; } function setText(id,v){ document.getElementById(id).textContent=v; } function show(id){ document.getElementById(id).style.display='block'; } function hide(id){ document.getElementById(id).style.display='none'; }
function addExpYears(y) { var b=new Date(gval('dexp')||gval('dreg2')||new Date()); b.setFullYear(b.getFullYear()+y); val('dexp', b.getFullYear()+'-'+String(b.getMonth()+1).padStart(2,'0')+'-'+String(b.getDate()).padStart(2,'0')); }

fetch('/api/stats').then(function(r) { if (r.ok) { document.getElementById('login').style.display = 'none'; document.getElementById('app').style.display = 'block'; init(); } });
</script>
</body>
</html>`; }
