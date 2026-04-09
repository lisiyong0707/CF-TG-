/**
 * Domain Manager Pro (融合版)
 * 后端：增加 WHOIS解析 + 多通道通知(微信/Bark/TG/Email) + 批量删除 + 免费域名收藏网址管理
 * 前端：智能解析 + 赛博狸花猫AI(段位养成+自由跑动) + CSV导出 + 多行混合数据导入 + 【新增】免费域名导航板块
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
    const[p, s] = token.split('.');
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
  const cid = (path.match(/^\/api\/cf-accounts\/(.+)$/) ||[])[1];
  if (cid && m === 'DELETE') return ok(await delById(env, 'cf_accounts', cid));

  if (path === '/api/cf-preview' && m === 'POST') return previewCF(await json(), env);
  if (path === '/api/cf-sync' && m === 'POST') return syncCF(await json(), env);

  // 🚀 新增免费域名资源路由
  if (path === '/api/free-links') {
    if (m === 'GET') {
      let list = await kget(env, 'free_links');
      // 如果为空则注入内置初始化数据
      if (list.length === 0 && !(await kgetStr(env, 'free_links_init'))) {
        list =[
          { id: uid(), name: 'EU.ORG', url: 'https://nic.eu.org/', desc: '老牌免费域名，支持NS托管，人工审核较慢。', createdAt: now() },
          { id: uid(), name: 'ClouDNS', url: 'https://www.cloudns.net/', desc: '提供免费子域名，支持常规解析，秒下发。', createdAt: now() },
          { id: uid(), name: 'PP.UA', url: 'https://nic.pp.ua/', desc: '免费乌克兰域名，需要绑定TG或银行卡验证。', createdAt: now() },
          { id: uid(), name: 'L53.net', url: 'https://l53.net/', desc: '提供公益免费二级域名注册，国内直连较快。', createdAt: now() }
        ];
        await kput(env, 'free_links', list);
        await env.KV.put('free_links_init', '1');
      }
      return ok(list);
    }
    if (m === 'POST') {
      const b = await json();
      const list = await kget(env, 'free_links');
      const l = { id: uid(), name: b.name.trim(), url: b.url.trim(), desc: b.desc || '', createdAt: now() };
      list.push(l); await kput(env, 'free_links', list); return ok(l);
    }
  }
  const lid = (path.match(/^\/api\/free-links\/(.+)$/) ||[])[1];
  if (lid) {
    if (m === 'PUT') {
       const b = await json();
       const list = await kget(env, 'free_links');
       const i = list.findIndex(x => x.id === lid);
       if(i > -1) { 
         list[i] = { ...list[i], name: b.name.trim(), url: b.url.trim(), desc: b.desc || '' }; 
         await kput(env, 'free_links', list); return ok(list[i]); 
       }
       return ok({error: 'Not found'}, 404);
    }
    if (m === 'DELETE') return ok(await delById(env, 'free_links', lid));
  }

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
    
    try {
      await sendNotify(env, '✅ 通道测试成功', '喵~ 你的极客资产管控系统已成功连接到通知渠道！');
      await env.KV.delete('last_check');
      await dailyCheck(env);
      return ok({ ok: true, msg: '测试消息已发送' });
    } catch(err) {
      return ok({ error: '推送失败: ' + err.message }, 400);
    }
  }

  return ok({ error: 'Not Found' }, 404);
}

// ── KV ───────────────────────────────────────────────────────────────────────

async function kget(env, key) {
  if (!env.KV) return[];
  try { return JSON.parse(await env.KV.get(key) || '[]'); } catch { return[]; }
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
    (data.events ||[]).forEach(e => {
      if (e.eventAction === 'expiration') exp = e.eventDate.split('T')[0];
      if (e.eventAction === 'registration') reg = e.eventDate.split('T')[0];
    });
    (data.entities ||[]).forEach(e => {
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
  const[domains, accs, cfAccs] = await Promise.all([kget(env, 'domains'), kget(env, 'accounts'), kget(env, 'cf_accounts')]);
  const nm = {};[...accs, ...cfAccs].forEach(a => { nm[a.id] = a.name; });
  return domains.map(d => ({ ...d, accountName: nm[d.accountId] || '—', daysLeft: days(d.expiryDate) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}

async function addDomain(b, env) {
  const list = await kget(env, 'domains');
  const d = { id: uid(), name: b.name.trim().toLowerCase(), accountId: b.accountId || '', registrar: b.registrar || '', registrarUrl: b.registrarUrl || '', registeredAt: b.registeredAt || '', expiryDate: b.expiryDate, autoRenew: !!b.autoRenew, reminderDays: b.reminderDays ||[1, 15, 30, 90, 180], notes: b.notes || '', source: b.source || 'manual', createdAt: now() };
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
  const nm = new Map(domains.map((d, i) =>[d.name, i]));
  let added = 0, updated = 0, skipped = 0;
  for (const d of r.domains) {
    if (nm.has(d.name)) {
      if (b.mode === 'all') { const i = nm.get(d.name); domains[i] = { ...domains[i], expiryDate: d.expiryDate || domains[i].expiryDate, autoRenew: d.autoRenew, source: d.source, updatedAt: now() }; updated++; }
      else skipped++;
    } else {
      domains.push({ id: uid(), name: d.name, accountId: cf.id, registrar: 'Cloudflare', registrarUrl: 'https://dash.cloudflare.com/' + cf.cfAccountId + '/domains', registeredAt: d.registeredAt, expiryDate: d.expiryDate, autoRenew: d.autoRenew, reminderDays:[1, 15, 30, 90, 180], notes: '', source: d.source, createdAt: now() });
      added++;
    }
  }
  await kput(env, 'domains', domains);
  return ok({ ok: true, added, updated, skipped, total: r.domains.length });
}

async function fetchCFDomains(cf) {
  try {
    const out =[];
    if (cf.cfAccountId) {
      const reg = await cfApi('/accounts/' + cf.cfAccountId + '/registrar/domains?per_page=200', cf.apiToken);
      if (reg.success) for (const d of reg.result ||[]) out.push({ name: d.name, registeredAt: (d.created_at || '').split('T')[0], expiryDate: (d.expires_at || '').split('T')[0], autoRenew: !!d.auto_renew, source: 'cf_registrar' });
    }
    const zones = await cfApi('/zones?per_page=200', cf.apiToken);
    if (zones.success) {
      const s = new Set(out.map(d => d.name));
      for (const z of zones.result ||[]) if (!s.has(z.name)) out.push({ name: z.name, registeredAt: (z.created_on || '').split('T')[0], expiryDate: '', autoRenew: false, source: 'cf_zone' });
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
  if (!c) { 
    let old = JSON.parse(await kgetStr(env, 'telegram_config', '{}'));
    return { type: old.botToken ? 'tg' : 'pushplus', tgBotToken: old.botToken||'', tgChatId: old.chatId||'' };
  }
  return JSON.parse(c);
}

async function saveNotify(b, env, request) {
  const c = await getNotifyCfg(env);
  c.type = b.type;
  if (b.tgChatId !== undefined) c.tgChatId = b.tgChatId;
  
  if (b.tgBotToken && b.tgBotToken !== '***') {
    c.tgBotToken = b.tgBotToken.trim().replace(/^bot/i, '');
  }
  if (b.pushplusToken && b.pushplusToken !== '***') c.pushplusToken = b.pushplusToken.trim();
  if (b.barkKey && b.barkKey !== '***') c.barkKey = b.barkKey.trim();
  if (b.emailApi !== undefined) c.emailApi = b.emailApi.trim();
  if (b.emailTo !== undefined) c.emailTo = b.emailTo.trim();

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
  
  if (c.type === 'pushplus') {
    if (!c.pushplusToken) throw new Error('未填写 PushPlus Token');
    let mdText = text;
    if (buttons) {
      mdText += '\n\n**直达链接:**\n' + buttons.map(row => row.map(btn => `[${btn.text}](${btn.url})`).join(' | ')).join('\n');
    }
    const res = await fetch('http://www.pushplus.plus/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: c.pushplusToken, title, content: mdText, template: 'markdown' })
    });
    const rJson = await res.json();
    if(rJson.code !== 200) throw new Error(rJson.msg || 'PushPlus 接口报错');
  } 
  else if (c.type === 'bark') {
    if (!c.barkKey) throw new Error('未填写 Bark Device Key');
    let key = c.barkKey.replace('https://api.day.app/', '').split('/')[0];
    let plainText = text.replace(/`/g, '').replace(/\*/g, ''); 
    let urlParam = '';
    if (buttons && buttons[0] && buttons[0][0]) urlParam = `?url=${encodeURIComponent(buttons[0][0].url)}`;
    const res = await fetch(`https://api.day.app/${key}/${encodeURIComponent(title)}/${encodeURIComponent(plainText)}${urlParam}`);
    const rJson = await res.json();
    if(rJson.code !== 200) throw new Error(rJson.message || 'Bark 接口返回错误');
  }
  else if (c.type === 'email') {
    if (!c.emailApi) throw new Error('未填写 Webhook API 地址');
    let mdText = text;
    if (buttons) {
      mdText += '\n\n' + buttons.map(row => row.map(btn => `${btn.text}: ${btn.url}`).join(' | ')).join('\n');
    }
    let res;
    if (c.emailApi.includes('[title]') || c.emailApi.includes('[text]')) {
      let url = c.emailApi
        .replace(/\[title\]/g, encodeURIComponent(title))
        .replace(/\[text\]/g, encodeURIComponent(mdText))
        .replace(/\[to\]/g, encodeURIComponent(c.emailTo || ''));
      res = await fetch(url);
    } else {
      res = await fetch(c.emailApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: c.emailTo, subject: title, text: mdText })
      });
    }
    if(!res.ok) throw new Error(`Webhook 响应异常状态码: ${res.status}`);
  } 
  else if (c.type === 'tg') {
    if (!c.tgBotToken || !c.tgChatId) {
      throw new Error('未配置 Telegram Bot Token 或 Chat ID');
    }
    let safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const htmlText = safeText.replace(/`(.*?)`/g, '<code>$1</code>').replace(/\*(.*?)\*/g, '<b>$1</b>');
    
    if (buttons && buttons.length) {
      buttons.forEach(row => {
        row.forEach(btn => {
          if (btn.url && !btn.url.startsWith('http')) {
            btn.url = 'https://' + btn.url;
          }
        });
      });
    }

    const body = { chat_id: c.tgChatId, text: `<b>${safeTitle}</b>\n\n${htmlText}`, parse_mode: 'HTML' };
    if (buttons && buttons.length) body.reply_markup = { inline_keyboard: buttons };
    
    const res = await fetch('https://api.telegram.org/bot' + c.tgBotToken + '/sendMessage', { 
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) 
    });
    
    const rJson = await res.json();
    if (!rJson.ok) {
      throw new Error(`Telegram API 返回拦截: ${rJson.description}`);
    }
  } else {
    throw new Error('未设置有效的通知渠道');
  }
}

async function dailyCheck(env) {
  const today = new Date().toDateString();
  if (await kgetStr(env, 'last_check', '') === today) return;
  await env.KV.put('last_check', today);
  
  const notify = (await kget(env, 'domains')).filter(d => { 
    const v = days(d.expiryDate); 
    return (d.reminderDays ||[1, 15, 30, 90, 180]).includes(v) || v < 0; 
  });
  
  if (!notify.length) return;
  
  const buttons =[];
  const lines = notify.map(d => { 
    const v = days(d.expiryDate); 
    if (d.registrarUrl) {
      buttons.push([{ text: `💳 续费: ${d.name}`, url: d.registrarUrl }]);
    }
    return (v < 0 ? '🔴' : v <= 1 ? '🆘' : v <= 7 ? '🟠' : '🟡') + ' `' + d.name + '` — ' + dstr(d.expiryDate) + '\n   ' + (d.registrar || '未知注册商'); 
  }).join('\n\n');
  
  await sendNotify(env, '⚠️ 域名续约提醒', lines, buttons);
}

async function handleWebhook(request, env) {
  const u = await request.json().catch(() => ({}));
  const msg = u.message; if (!msg) return ok({ ok: true });
  const cid = msg.chat.id, txt = (msg.text || '').trim();
  const c = await getNotifyCfg(env);
  
  async function replyTg(text, buttons = null) {
    if(!c.tgBotToken) return;
    let safeText = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const htmlText = safeText.replace(/`(.*?)`/g, '<code>$1</code>').replace(/\*(.*?)\*/g, '<b>$1</b>');
    const body = { chat_id: cid, text: htmlText, parse_mode: 'HTML' };
    
    if (buttons && buttons.length) {
      buttons.forEach(row => {
        row.forEach(btn => {
          if (btn.url && !btn.url.startsWith('http')) {
            btn.url = 'https://' + btn.url;
          }
        });
      });
      body.reply_markup = { inline_keyboard: buttons };
    }
    await fetch('https://api.telegram.org/bot' + c.tgBotToken + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  if (txt === '/start') {
    await replyTg('🌐 *域名管理机器人*\n\n你的 Chat ID: `' + cid + '`\n\n/domains — 所有域名\n/expiring — 即将到期\n/check — 立即检查');
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
      const buttons =[];
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

// ── HTML ──────────────────────────────────────────────────────────────────────

function getHTML() { return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DOMAIN PRO - 极客资产管理</title>
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
body { background: var(--bg); color: var(--text); font-family: -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; overflow-x: hidden; }

.page { display: none; }
.page.a { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

header { 
  height: 70px; background: rgba(255,255,255,0.9); backdrop-filter: blur(15px);
  display: flex; align-items: center; justify-content: space-between; 
  padding: 0 5%; position: fixed; top: 0; width: 100%; z-index: 1000; box-shadow: 0 2px 10px rgba(0,0,0,0.05);
}

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

input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }

.cp-btn { cursor:pointer; opacity:0.3; transition:0.2s; font-size:14px; margin-left:6px; user-select: none; }
.cp-btn:hover { opacity:1; transform:scale(1.2); }

.dn { font-weight: 800; color: #0f172a; font-family: monospace; display: flex; align-items: center; }
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

/* ==== 酷炫赛博极客登录页 CSS ==== */
#login { 
  position: fixed; inset: 0; background: #0f172a; z-index: 2000; 
  display: flex; align-items: center; justify-content: center; overflow: hidden; 
}
.bg-animation { position: absolute; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.blob { position: absolute; filter: blur(90px); border-radius: 50%; animation: floatBlob 20s infinite alternate ease-in-out; opacity: 0.5; }
.blob-1 { top: -10%; left: -10%; width: 50vw; height: 50vw; background: #3b8eea; animation-delay: 0s; }
.blob-2 { bottom: -20%; right: -10%; width: 60vw; height: 60vw; background: #8b5cf6; animation-delay: -5s; }
.blob-3 { top: 40%; left: 40%; width: 40vw; height: 40vw; background: #ec4899; animation-delay: -10s; }
@keyframes floatBlob { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(10vw, 10vh) scale(1.2); } }

.lbox { 
  width: 420px; text-align: center; z-index: 1; padding: 50px 40px; border-radius: 30px;
  background: rgba(30, 41, 59, 0.6); backdrop-filter: blur(25px); -webkit-backdrop-filter: blur(25px);
  border: 1px solid rgba(255, 255, 255, 0.1); box-shadow: 0 30px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1);
  position: relative; overflow: hidden;
}
.lbox::before {
  content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
  background: linear-gradient(to bottom, transparent, rgba(59,142,234,0.1), transparent);
  transform: rotate(45deg); animation: scanline 6s linear infinite; pointer-events: none;
}
@keyframes scanline { 0% { transform: translateY(-100%) rotate(45deg); } 100% { transform: translateY(100%) rotate(45deg); } }

.login-avatar { width: 100px; height: 100px; margin: 0 auto 20px; animation: glow 3s infinite; filter: drop-shadow(0 10px 15px rgba(59,142,234,0.5)); }
.lbox h2 { font-size: 32px; font-weight: 900; color: #fff; margin-bottom: 5px; letter-spacing: 1px; }
.lbox p.subtitle { color: #94a3b8; font-size: 13px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; margin-bottom: 30px; }

#lpw { 
  width: 100%; padding: 18px; margin-bottom: 15px; outline: none; font-size: 16px; text-align: center;
  background: rgba(15, 23, 42, 0.5); border: 2px solid rgba(255,255,255,0.1); color: #fff; 
  border-radius: 16px; transition: all 0.3s; box-shadow: inset 0 2px 10px rgba(0,0,0,0.2);
}
#lpw:focus { border-color: #3b8eea; background: rgba(15, 23, 42, 0.8); box-shadow: 0 0 20px rgba(59,142,234,0.3), inset 0 2px 10px rgba(0,0,0,0.2); }
#lpw::placeholder { color: #64748b; }
.lbox .btn.bp { background: linear-gradient(135deg, #3b8eea, #6366f1); border: none; box-shadow: 0 10px 20px rgba(59,142,234,0.3); font-size: 15px; padding: 18px; border-radius: 16px; margin-top: 10px; }
.lbox .btn.bp:hover { transform: translateY(-3px); box-shadow: 0 15px 25px rgba(59,142,234,0.5); }

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

/* 🐱 赛博狸花猫管家 & 自由奔跑控制 CSS */
#cat-container { 
  position: fixed; bottom: -10px; right: -10px; z-index: 5000; 
  display: flex; flex-direction: column; align-items: center; 
  transition: transform 1.5s cubic-bezier(0.25, 1, 0.5, 1);
}
#cat-bubble { 
  background: #fff; padding: 10px 18px; border-radius: 15px; 
  box-shadow: 0 5px 25px rgba(0,0,0,0.15); font-size: 13px; font-weight: 800; 
  color: var(--primary); margin-bottom: 10px; opacity: 0; transform: translateY(10px); 
  transition: 0.3s; position: relative; pointer-events: none; white-space: nowrap; border: 2px solid #f1f5f9; 
}
#cat-bubble::after { content: ''; position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%); border-width: 8px 8px 0; border-style: solid; border-color: #fff transparent transparent transparent; z-index:2; }
#cat-bubble::before { content: ''; position: absolute; bottom: -11px; left: 50%; transform: translateX(-50%); border-width: 9px 9px 0; border-style: solid; border-color: #f1f5f9 transparent transparent transparent; z-index:1; }

#cat-svg { 
  width: 160px; height: auto; display: block; 
  animation: floatCat 4s ease-in-out infinite; cursor: pointer;
  filter: drop-shadow(0 15px 25px rgba(0,0,0,0.2));
  transition: transform 0.3s ease;
}
@keyframes floatCat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }

#cat-actions {
  position: absolute; left: -100px; top: 10px; 
  display: flex; flex-direction: column; gap: 8px; opacity: 0; pointer-events: none;
  transition: 0.3s; transform: translateX(20px);
}
#cat-container:hover #cat-actions, #cat-actions:hover { opacity: 1; pointer-events: auto; transform: translateX(0); }
.cat-btn { 
  background: #fff; border: 2px solid #f1f5f9; border-radius: 12px; padding: 8px 12px; 
  font-size: 12px; font-weight: 800; cursor: pointer; box-shadow: 0 4px 15px rgba(0,0,0,0.1); 
  color: var(--text); transition: 0.2s; white-space: nowrap;
}
.cat-btn:hover { border-color: var(--primary); color: var(--primary); transform: scale(1.05); }

/* 喵管家 AI 对话框 */
#cat-chat {
  display: none; position: absolute; bottom: 110%; right: 20px; 
  width: 320px; background: #fff; border-radius: 20px; 
  box-shadow: 0 15px 40px rgba(0,0,0,0.2); border: 2px solid var(--primary);
  overflow: hidden; z-index: 5002; transform-origin: bottom right;
  animation: popChat 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}
@keyframes popChat { from { opacity: 0; transform: scale(0.5); } to { opacity: 1; transform: scale(1); } }
.chat-head { background: var(--primary); color: #fff; padding: 12px 15px; font-size: 14px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
.chat-body { height: 220px; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; background: #f8fafc; font-size: 13px; }
.chat-msg { padding: 10px 14px; border-radius: 15px; max-width: 85%; line-height: 1.5; word-wrap: break-word; }
.msg-ai { background: #fff; border: 1px solid #e2e8f0; align-self: flex-start; border-bottom-left-radius: 4px; box-shadow: 0 2px 5px rgba(0,0,0,0.02); }
.msg-user { background: var(--primary); color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; box-shadow: 0 2px 5px rgba(59,142,234,0.3); }
.chat-input-area { display: flex; border-top: 1px solid #e2e8f0; background: #fff; }
#chat-input { flex: 1; border: none; padding: 12px 15px; outline: none; font-size: 13px; }
.chat-send { background: none; border: none; color: var(--primary); font-weight: bold; padding: 0 15px; cursor: pointer; transition: 0.2s; }
.chat-send:hover { transform: scale(1.1); }

.floating-heart { position: absolute; font-size: 20px; z-index: 5001; animation: floatUp 1s ease-out forwards; pointer-events: none; }
@keyframes floatUp { 0% { opacity: 1; transform: translateY(0) scale(1); } 100% { opacity: 0; transform: translateY(-50px) scale(1.5); } }

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

<div id="cat-container">
  <div id="cat-bubble">系统载入中喵~</div>
  
  <div id="cat-actions">
    <button class="cat-btn" onclick="toggleChat(event)">💬 AI 问答</button>
    <button class="cat-btn" onclick="toggleRoam(event)">🐾 自由漫步</button>
    <button class="cat-btn" onclick="feedCat(event)">🔋 充能罐头</button>
    <button class="cat-btn" onclick="patrolCat(event)">🏃 巡逻节点</button>
  </div>

  <div id="cat-chat">
    <div class="chat-head">
      <span>🐱 喵管家 (<span id="cat-level-display">实习巡检员</span>)</span>
      <span style="cursor:pointer; font-size:16px;" onclick="toggleChat(event)">×</span>
    </div>
    <!-- AI 快捷指令胶囊 -->
    <div style="display:flex; gap:5px; padding:8px 12px; overflow-x:auto; border-bottom:1px solid #e2e8f0; background:#f8fafc;" id="chat-prompts">
       <button class="b bx" style="cursor:pointer; border:1px solid #e2e8f0; white-space:nowrap;" onclick="sendQuick('即将过期')">⏰ 即将过期?</button>
       <button class="b bx" style="cursor:pointer; border:1px solid #e2e8f0; white-space:nowrap;" onclick="sendQuick('资产统计')">📊 资产统计</button>
       <button class="b bx" style="cursor:pointer; border:1px solid #e2e8f0; white-space:nowrap;" onclick="sendQuick('免费域名')">🆓 免费域名</button>
       <button class="b bx" style="cursor:pointer; border:1px solid #e2e8f0; white-space:nowrap;" onclick="sendQuick('云端托管')">☁️ 云端托管</button>
       <button class="b bx" style="cursor:pointer; border:1px solid #e2e8f0; white-space:nowrap;" onclick="sendQuick('去散步')">🐾 遛猫</button>
    </div>
    <div class="chat-body" id="chat-body">
      <div class="chat-msg msg-ai">你好喵！我是本系统的赛博狸花猫助理。点击上方的快捷标签，或者直接问我关于“过期时间”、“统计总数”的信息哦~</div>
    </div>
    <div class="chat-input-area">
      <input type="text" id="chat-input" placeholder="输入问题敲回车..." onkeydown="if(event.key==='Enter') sendChat()">
      <button class="chat-send" onclick="sendChat()">发送</button>
    </div>
  </div>

  <!-- 重新设计的：赛博狸花猫 (Dragon Li) 带有虎斑纹路 -->
  <svg id="cat-svg" viewBox="0 0 200 200" onclick="onCatClick()">
    <g>
      <path d="M 150 170 Q 190 170 180 130 Q 170 100 190 80" stroke="#8b7355" stroke-width="15" stroke-linecap="round" fill="none" />
      <path d="M 150 170 Q 190 170 180 130 Q 170 100 190 80" stroke="#3e2723" stroke-width="15" stroke-dasharray="10 15" stroke-linecap="round" fill="none" />
      <animateTransform attributeName="transform" type="rotate" values="0 150 170; 12 150 170; 0 150 170" dur="2s" repeatCount="indefinite" />
    </g>
    <path d="M 40 200 Q 40 120 100 120 Q 160 120 160 200 Z" fill="#8b7355"/>
    <path d="M 50 140 Q 70 150 60 170 M 150 140 Q 130 150 140 170 M 45 165 Q 65 175 55 190" stroke="#3e2723" stroke-width="4" stroke-linecap="round" fill="none"/>
    <path d="M 60 200 Q 60 140 100 140 Q 140 140 140 200 Z" fill="#f5f5f4"/> 
    <circle cx="100" cy="90" r="60" fill="#8b7355"/>
    <polygon points="50,50 30,0 80,35" fill="#8b7355"/>
    <polygon points="55,45 40,15 75,35" fill="#f5f5f4"/>
    <polygon points="150,50 170,0 120,35" fill="#8b7355"/>
    <polygon points="145,45 160,15 125,35" fill="#f5f5f4"/>
    <path d="M 80 50 L 90 75 L 100 60 L 110 75 L 120 50" stroke="#3e2723" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <line x1="45" y1="90" x2="60" y2="95" stroke="#3e2723" stroke-width="4" stroke-linecap="round"/>
    <line x1="42" y1="105" x2="58" y2="105" stroke="#3e2723" stroke-width="4" stroke-linecap="round"/>
    <line x1="155" y1="90" x2="140" y2="95" stroke="#3e2723" stroke-width="4" stroke-linecap="round"/>
    <line x1="158" y1="105" x2="142" y2="105" stroke="#3e2723" stroke-width="4" stroke-linecap="round"/>
    <circle cx="75" cy="95" r="12" fill="#1e293b"/>
    <circle cx="78" cy="92" r="4" fill="#fff"/>
    <circle cx="125" cy="95" r="12" fill="#1e293b"/>
    <circle cx="122" cy="92" r="4" fill="#fff"/>
    <rect x="55" y="80" width="40" height="25" rx="5" fill="rgba(59,142,234,0.3)" stroke="#3b8eea" stroke-width="3"/>
    <rect x="105" y="80" width="40" height="25" rx="5" fill="rgba(59,142,234,0.3)" stroke="#3b8eea" stroke-width="3"/>
    <line x1="95" y1="92" x2="105" y2="92" stroke="#3b8eea" stroke-width="3"/>
    <path d="M 95 110 Q 100 115 105 110" stroke="#1e293b" stroke-width="3" fill="none" stroke-linecap="round"/>
    <polygon points="98,110 102,110 100,113" fill="#ef4444"/>
    <rect x="70" y="145" width="60" height="25" rx="4" fill="#1e293b" stroke="#334155" stroke-width="2"/>
    <text x="100" y="162" fill="#10b981" font-size="12" font-family="monospace" text-anchor="middle" font-weight="bold">.com</text>
    <circle cx="65" cy="155" r="12" fill="#8b7355"/>
    <circle cx="135" cy="155" r="12" fill="#8b7355"/>
  </svg>
</div>

<div id="login">
  <div class="bg-animation">
    <div class="blob blob-1"></div>
    <div class="blob blob-2"></div>
    <div class="blob blob-3"></div>
  </div>
  <div class="lbox">
    <div class="login-avatar">
      <svg viewBox="0 0 100 100">
        <defs>
          <linearGradient id="avatar-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#3b8eea"/><stop offset="100%" stop-color="#8b5cf6"/>
          </linearGradient>
          <filter id="glow-filter" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>
        <circle cx="50" cy="50" r="48" fill="none" stroke="url(#avatar-grad)" stroke-width="4" filter="url(#glow-filter)" stroke-dasharray="80 20" />
        <circle cx="50" cy="50" r="44" fill="url(#avatar-grad)" opacity="0.1"/>
        <g transform="scale(0.4) translate(25, 25)">
          <path d="M 40 200 Q 40 120 100 120 Q 160 120 160 200 Z" fill="#fff"/>
          <circle cx="100" cy="90" r="60" fill="#fff"/>
          <polygon points="50,50 30,0 80,35" fill="#fff"/>
          <polygon points="150,50 170,0 120,35" fill="#fff"/>
          <rect x="55" y="80" width="40" height="25" rx="5" fill="rgba(255,255,255,0.4)" stroke="#3b8eea" stroke-width="5"/>
          <rect x="105" y="80" width="40" height="25" rx="5" fill="rgba(255,255,255,0.4)" stroke="#3b8eea" stroke-width="5"/>
          <rect x="70" y="145" width="60" height="25" rx="4" fill="#3b8eea"/>
        </g>
      </svg>
    </div>
    <h2>DOMAIN PRO</h2>
    <p class="subtitle">Secure Cyber Terminal</p>
    <div id="kwarn" style="display:none; color:#fca5a5; margin-bottom:15px; font-size:13px; font-weight:bold; background:rgba(239, 68, 68, 0.2); padding:10px; border-radius:10px; border: 1px solid rgba(239, 68, 68, 0.3);">⚠️ KV 未绑定，数据无法保存</div>
    <input type="password" id="lpw" placeholder="输入超级管理员口令">
    <button class="btn bp" id="lbtn" style="width:100%; justify-content:center">Initialize Connection</button>
    <div id="lerr" style="color:#fca5a5; margin-top:15px; font-size:13px; font-weight:700"></div>
  </div>
</div>

<div id="app" style="display:none">
<header>
  <div class="logo" onclick="goHome()" title="返回首页 / 刷新数据">DOMAIN<span>PRO</span></div>
  <nav>
    <button class="nb a" id="nb0" onclick="goto(0)">所有资产</button>
    <button class="nb" id="nb1" onclick="goto(1)">账号管理</button>
    <button class="nb" id="nb2" onclick="goto(2)">通知设置</button>
    <button class="nb" id="nb3" onclick="goto(3)">免费域名</button>
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
          <button class="btn bs" onclick="exportCSV()">⬇️ 导出CSV</button>
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
              <th>域名与进度</th>
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

      <div id="cfg-tg" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">BOT TOKEN</label><input class="fi" id="tgtok" placeholder="从 @BotFather 获取"></div>
        <div class="fg"><label class="fl">CHAT ID</label><input class="fi" id="tgcid" placeholder="私聊机器人获取"></div>
        <div style="font-size:13px; color:#ef4444; line-height:1.6; font-weight:700">
          * 提醒：已升级为 HTML 安全解析模式，并会自动拦截第三方接口报错，如果下方测试失败，请检查填写内容。
        </div>
      </div>

      <div id="cfg-pushplus" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">PUSHPLUS TOKEN</label><input class="fi" id="pptok" placeholder="填写 PushPlus Token"></div>
        <div style="font-size:13px; color:#64748b; line-height:1.6">
          前往 <a href="http://www.pushplus.plus" target="_blank" style="color:var(--primary)">PushPlus 官网</a> 微信扫码登录即可免费获取专属 Token。
        </div>
      </div>

      <div id="cfg-bark" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">BARK DEVICE KEY</label><input class="fi" id="barkkey" placeholder="例如：qAXXXXXX"></div>
        <div style="font-size:13px; color:#64748b; line-height:1.6">
          在苹果 App Store 搜索下载 <b>Bark</b> 软件，打开 App 即可直接复制 Key 填入此处。
        </div>
      </div>

      <div id="cfg-email" class="ncfg" style="display:none; padding:15px; background:#f8fafc; border-radius:12px; margin-bottom:20px;">
        <div class="fg"><label class="fl">API URL (Webhook 地址)</label><input class="fi" id="emailapi" placeholder="如：https://api.xxx.com/send"></div>
        <div class="fg"><label class="fl">接收方标识 / 邮箱地址 (选填)</label><input class="fi" id="emailto" placeholder="如：123456@qq.com"></div>
        <div style="font-size:13px; color:#64748b; line-height:1.6">
          💡 <b>关于 Webhook：</b>默认 POST 发送 JSON 格式数据。若 URL 包含 [title] 等变量则使用 GET 替换触发。
        </div>
      </div>

      <div style="display:flex; gap:15px; margin-top:20px;">
        <button class="btn bp" onclick="saveNotifyCfg()">保存配置</button>
        <button class="btn bs" id="btn-test-notify" onclick="checkNotify()">触发手动测试推送</button>
      </div>
    </div>
  </div>

  <!-- 新增：免费域名导航页 -->
  <div id="p3" class="page">
    <div class="tw" style="padding:40px">
      <div style="display:flex; justify-content:space-between; margin-bottom:30px; align-items:center; flex-wrap:wrap; gap:10px;">
        <h3>免费域名资源汇总</h3>
        <button class="btn bp" onclick="openLM()">+ 新增资源网址</button>
      </div>
      <div class="stats" id="link-grid" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));"></div>
    </div>
  </div>

</main>
</div>

<!-- 弹窗集 -->
<div class="mo" id="dm"><div class="md">
  <h3 style="margin-bottom:25px" id="dmt">配置域名资产</h3>
  <input type="hidden" id="did">
  <div class="fg">
    <label class="fl">域名地址 *</label>
    <div style="display:flex; gap:10px;">
      <input class="fi" id="dname" placeholder="example.com">
      <button class="btn bs" id="btn-whois" type="button" onclick="autoWhois()" style="white-space:nowrap; padding: 0 15px;">⚡ 一键获取</button>
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
        <button type="button" class="rt" style="padding:4px 8px; font-size:11px;" onclick="addExpYears(10)">+10年</button>
      </div>
    </div>
  </div>
  <div class="fg"><label class="fl">所属账号关联</label><select class="fsel" id="dacc"></select></div>
  <div class="fg">
    <label class="fl">到期提醒节点 (提前天数)</label>
    <div class="rts" id="rts">
      <div class="rt on" data-d="180">180天</div><div class="rt on" data-d="90">90天</div><div class="rt on" data-d="30">30天</div><div class="rt on" data-d="15">15天</div><div class="rt on" data-d="1">1天</div>
    </div>
  </div>
  <div class="fg">
    <label style="display:flex; align-items:center; gap:10px; font-size:14px; cursor:pointer; font-weight:700">
      <input type="checkbox" id="dar" style="width:16px; height:16px; accent-color:var(--primary);"> 已开启注册商自动续费
    </label>
  </div>
  <div class="fg"><label class="fl">备注信息</label><textarea class="fta" id="dnotes" rows="2" placeholder="填写一些备注..."></textarea></div>
  <div style="display:flex; justify-content: flex-end; gap:12px; margin-top:30px">
    <button class="btn bs" onclick="closeM('dm')">取消</button>
    <button class="btn bp" onclick="saveD()">确认保存</button>
  </div>
</div></div>

<!-- 批量导入 (多行合并增强版) -->
<div class="mo" id="bm"><div class="md">
  <h3 style="margin-bottom:20px">批量智能导入</h3>
  <div style="font-size:13px; color:#64748b; margin-bottom:15px; background:#f8fafc; padding:15px; border-radius:12px; line-height: 1.6;">
    💡 <strong>智能解析增强：</strong>支持单行或<strong>多行混合</strong>数据（如从表格直接复制），系统会自动提取其中的域名、日期及链接。<br>
    * 也可在此处设置全局的默认注册商和默认直达网址。
  </div>
  <div style="display:grid; grid-template-columns: 1fr 1fr; gap:15px; margin-bottom:15px;">
    <div class="fg" style="margin:0"><label class="fl">默认注册商</label><input class="fi" id="breg" placeholder="例如：eu.cc"></div>
    <div class="fg" style="margin:0"><label class="fl">默认控制台链接</label><input class="fi" id="burl" placeholder="如：https://..."></div>
  </div>
  <textarea class="fta" id="btext" rows="8" placeholder="粘贴列表文本，如：&#10;test.com 2026-05-12 https://dash.cloudflare.com&#10;030707.eu.cc&#10;2026-03-28&#10;2027-03-28" style="font-family:monospace; line-height: 1.5;"></textarea>
  <div style="display:flex; justify-content: flex-end; gap:12px; margin-top:20px">
    <button class="btn bs" onclick="closeM('bm')">取消</button>
    <button class="btn bp" id="bbtn" onclick="saveBulk()">智能提取并导入</button>
  </div>
</div></div>

<div class="mo" id="cfm"><div class="md">
  <h3 style="margin-bottom:20px">绑定 Cloudflare 账号</h3>
  <div class="fg"><label class="fl">账号备注名称</label><input class="fi" id="cfn" placeholder="例如：主账号"></div>
  <div class="fg"><label class="fl">API Token</label><input class="fi" id="cft" placeholder="粘贴 Token"></div>
  <button class="btn bp" id="cfbtn" style="width:100%; justify-content:center; margin-top:10px" onclick="saveCF()">验证并开始绑定</button>
</div></div>

<div class="mo" id="sm"><div class="md">
  <h3 id="smt">域名同步</h3>
  <div id="slding" style="padding:40px 20px; text-align:center; color:#64748b; font-weight:700">⏳ 正在读取 Cloudflare 数据...</div>
  <div id="sbody" style="display:none">
    <div id="ssum" style="margin:20px 0; font-weight:700; color:var(--primary)"></div>
    <div id="slist" style="max-height:250px; overflow-y:auto; border:2px solid #f1f5f9; border-radius:12px; background:#f8fafc"></div>
    <div class="fg" style="margin-top:20px">
      <label class="fl">同步模式</label>
      <select id="smod" class="fsel"><option value="new">仅导入新增域名资产</option><option value="all">完全同步（包含更新已有）</option></select>
    </div>
  </div>
  <div id="sftr" style="margin-top:25px; display:none; justify-content:flex-end; gap:12px">
    <button class="btn bs" onclick="closeM('sm')">取消</button>
    <button class="btn bp" id="sbtn" onclick="doSync()">确认执行同步</button>
  </div>
</div></div>

<div class="mo" id="acm"><div class="md">
  <h3 style="margin-bottom:20px" id="amt">配置普通账号</h3>
  <input type="hidden" id="aid">
  <div class="fg"><label class="fl">账号备注名称 *</label><input class="fi" id="aname"></div>
  <div class="fg"><label class="fl">注册商名称</label><input class="fi" id="areg"></div>
  <div class="fg"><label class="fl">后台登录 URL</label><input class="fi" id="aurl"></div>
  <div class="fg"><label class="fl">邮箱绑定 (选填)</label><input class="fi" id="aemail"></div>
  <button class="btn bp" style="width:100%; justify-content:center; margin-top:10px" onclick="saveA()">保存账号信息</button>
</div></div>

<!-- 新增免费网址弹窗 -->
<div class="mo" id="lm"><div class="md">
  <h3 style="margin-bottom:20px" id="lmt">新增免费域名资源</h3>
  <input type="hidden" id="lid">
  <div class="fg"><label class="fl">资源名称 *</label><input class="fi" id="lname" placeholder="例如：EU.ORG"></div>
  <div class="fg"><label class="fl">直达链接 *</label><input class="fi" id="lurl" placeholder="https://..."></div>
  <div class="fg"><label class="fl">描述备注</label><textarea class="fta" id="ldesc" rows="3" placeholder="写点申请心得或限制条件..."></textarea></div>
  <button class="btn bp" style="width:100%; justify-content:center; margin-top:10px" onclick="saveL()">保存资源信息</button>
</div></div>

<div id="toast"></div>

<script>
var D=[], A=[], CF=[], L=[], curCFId=null;
var currentFilter = 'all'; 
var catFood = parseInt(localStorage.getItem('catFood')) || 0; 
var isRoaming = false;
var roamInterval;

function setErr(msg){ document.getElementById('lerr').textContent = msg || ''; }
function setBtn(txt, dis){ var b=document.getElementById('lbtn'); b.textContent=txt; b.disabled=!!dis; }

document.getElementById('lbtn').onclick = function() {
  var pw = document.getElementById('lpw').value;
  if (!pw) { setErr('请验证您的密钥'); return; }
  setBtn('正在验证节点...', true);
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
      setErr(res.d.error || '密钥校验失败'); 
      setBtn('Initialize Connection', false); 
    }
  }).catch(function(e) { setErr('连接服务中断'); setBtn('Initialize Connection', false); });
};
document.getElementById('lpw').onkeydown = function(e) { if (e.key === 'Enter') document.getElementById('lbtn').click(); };

function logout() { fetch('/api/logout', { method: 'POST' }).finally(function() { location.reload(); }); }

function init() { 
  loadAll(); 
  updateCatLevel();
  fetch('/api/health').then(function(r){ return r.json(); }).then(function(d){
    if (!d.kv) {
      var k1 = document.getElementById('kval'), k2 = document.getElementById('kwarn');
      if(k1) k1.style.display = 'block';
      if(k2) k2.style.display = 'block';
    }
  }).catch(function(){});
}

function loadAll() { 
  loadStats(); 
  loadD().then(checkCat); 
  loadA(); 
  loadCF(); 
  loadNotifyCfg(); 
  loadL();
}

function loadStats() { get('/api/stats').then(function(r) { if (r) { setText('st', r.total); setText('se', r.expired); setText('s3', r.expiring30); setText('sc', r.cfDomains); }}); }
function loadD() { return get('/api/domains').then(function(r) { D = r ||[]; filterD(); updateAccSel(); }); }
function loadA() { get('/api/accounts').then(function(r) { A = r ||[]; renderA(); updateAccSel(); }); }
function loadCF() { get('/api/cf-accounts').then(function(r) { CF = r ||[]; renderCF(); updateAccSel(); }); }
function loadL() { get('/api/free-links').then(function(r) { L = r ||[]; renderL(); }); }

function exportCSV() {
  if (!D || D.length === 0) return toast('当前暂无数据可导出', 'e');
  var csv = '域名,注册商,所属账号,到期日期,状态,自动续费\n';
  for (var i = 0; i < D.length; i++) {
    var d = D[i];
    var status = d.daysLeft < 0 ? '已过期' : d.daysLeft > 10000 ? '永久有效' : d.daysLeft + '天后';
    var accName = d.accountName === '—' ? '未关联' : d.accountName;
    csv += d.name + ',' + (d.registrar || '—') + ',' + accName + ',' + (d.expiryDate || '—') + ',' + status + ',' + (d.autoRenew ? '是' : '否') + '\n';
  }
  var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  var link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'domain_assets_export.csv';
  link.click();
  showCatMsg("数据已成功导出为 CSV 格式！记得妥善保管喵~");
}

var catQuotes =[
  "今天也是愉快敲击终端的一天喵~ 💻",
  "狸花猫的直觉告诉我，今天是个拿下的好日子喵！",
  "代码千行，记得常常备份数据喵~",
  "我在这里全天候监控，主人去安心摸鱼吧！🐟",
  "Hello World，我爱你一万年喵~ ❤️"
];

function updateCatLevel() {
  var levelStr = catFood < 5 ? '实习巡检员' : catFood < 20 ? '初级架构师' : catFood < 50 ? '高级安全专家' : '终极摸鱼神猫';
  var el = document.getElementById('cat-level-display');
  if(el) el.innerText = levelStr;
}

function showCatMsg(txt, isAlert) {
  var b = document.getElementById('cat-bubble');
  var cat = document.getElementById('cat-svg');
  b.innerText = txt;
  b.style.color = isAlert ? '#ef4444' : 'var(--primary)';
  b.style.opacity = '1';
  b.style.transform = 'translateY(0)';
  
  if(!isRoaming) {
    cat.style.transform = 'scale(0.9)';
    setTimeout(function(){ cat.style.transform = ''; }, 200);
  }
  
  clearTimeout(window.catTimer);
  window.catTimer = setTimeout(function() {
    b.style.opacity = '0';
    b.style.transform = 'translateY(10px)';
  }, 4000);
}

function toggleRoam(e) {
  if(e) e.stopPropagation();
  isRoaming = !isRoaming;
  var catBox = document.getElementById('cat-container');
  var svg = document.getElementById('cat-svg');
  
  if (isRoaming) {
    showCatMsg("开启自由跑动模式喵！🐾");
    document.getElementById('cat-actions').style.display = 'none';
    document.getElementById('cat-chat').style.display = 'none';
    
    catBox.style.bottom = 'auto';
    catBox.style.right = 'auto';
    catBox.style.left = (window.innerWidth - 200) + 'px';
    catBox.style.top = (window.innerHeight - 200) + 'px';
    
    roamInterval = setInterval(function(){
      var newX = Math.random() * (window.innerWidth - 180);
      var newY = Math.random() * (window.innerHeight - 180);
      var currentX = parseFloat(catBox.style.left) || 0;
      
      svg.style.transform = (newX < currentX) ? 'scaleX(-1)' : 'scaleX(1)';
      catBox.style.transition = 'all 3s ease-in-out';
      catBox.style.left = newX + 'px';
      catBox.style.top = newY + 'px';
    }, 3500);
  } else {
    clearInterval(roamInterval);
    catBox.style.transition = 'all 0.8s cubic-bezier(0.25, 1, 0.5, 1)';
    catBox.style.left = '';
    catBox.style.top = '';
    catBox.style.bottom = '-10px';
    catBox.style.right = '-10px';
    svg.style.transform = 'scaleX(1)';
    showCatMsg("巡航结束，我回基地啦喵！🐱");
    setTimeout(function(){ document.getElementById('cat-actions').style.display = 'flex'; }, 800);
  }
}

function toggleChat(e) {
  if(e) e.stopPropagation();
  var chat = document.getElementById('cat-chat');
  chat.style.display = chat.style.display === 'block' ? 'none' : 'block';
}

function sendQuick(text) {
  var input = document.getElementById('chat-input');
  input.value = text;
  sendChat();
}

function sendChat() {
  var input = document.getElementById('chat-input');
  var msg = input.value.trim();
  if(!msg) return;
  
  appendChat('user', msg);
  input.value = '';
  
  setTimeout(function(){
    var reply = generateAiReply(msg);
    appendChat('ai', reply);
  }, 600);
}

function appendChat(role, text) {
  var body = document.getElementById('chat-body');
  var el = document.createElement('div');
  el.className = 'chat-msg ' + (role === 'ai' ? 'msg-ai' : 'msg-user');
  el.innerText = text;
  body.appendChild(el);
  body.scrollTop = body.scrollHeight;
}

function generateAiReply(query) {
  query = query.toLowerCase();
  if (query.indexOf('过期') > -1 || query.indexOf('到期') > -1) {
    var exp =[];
    for(var i=0; i<D.length; i++) { if(D[i].daysLeft <= 30) exp.push(D[i]); }
    if(exp.length === 0) return "报告主人！经过扫描，目前没有30天内到期的资产，安全得很喵~ 🎉";
    var names =[];
    for(var j=0; j<exp.length; j++) names.push(exp[j].name);
    return "🚨 警报喵！我发现有 " + exp.length + " 个节点即将在30天内到期：\n" + names.join(', ') + "\n快去续费吧！";
  }
  if (query.indexOf('多少') > -1 || query.indexOf('总数') > -1 || query.indexOf('统计') > -1) {
    return "主人，您当前总计管控着 " + D.length + " 个终端节点资产，数据库一切正常喵！";
  }
  if (query.indexOf('cf') > -1 || query.indexOf('托管') > -1 || query.indexOf('云端') > -1) {
    var cf = 0;
    for(var k=0; k<D.length; k++) { if(D[k].source && D[k].source.indexOf('cf') === 0) cf++; }
    return "当前有 " + cf + " 个节点正安全地运行在 Cloudflare 边缘网络上喵~ ☁️";
  }
  if (query.indexOf('免费') > -1 || query.indexOf('白嫖') > -1) {
    return "主人，您已经在系统里收藏了 " + L.length + " 个免费域名资源喵！快去顶部【免费域名】板块看看吧~ 🤑";
  }
  if (query.indexOf('跑') > -1 || query.indexOf('步') > -1 || query.indexOf('动') > -1 || query.indexOf('遛') > -1) {
    setTimeout(toggleRoam, 1000);
    return "收到指令！切换运动形态，我去散步啦~ 🐾";
  }
  if (query.indexOf('吃') > -1 || query.indexOf('饿') > -1 || query.indexOf('鱼干') > -1 || query.indexOf('罐头') > -1) {
    feedCat({stopPropagation:function(){}});
    return "吧唧吧唧... 谢谢主人赐饭！满血复活喵呜~ 😋";
  }
  return "喵？我是一个本地执行的赛博狸花猫管家。你可以问我关于【到期资产】、【节点总数】、【免费域名】的问题，或者让我去【跑一跑】哦~";
}

function onCatClick() {
  if (isRoaming) { toggleRoam(); } 
  else { 
    if(Math.random() > 0.8) {
      showCatMsg("机体内蕴含了 " + catFood + " 罐高能猫条算力喵~ ⚡");
    } else {
      showCatMsg(catQuotes[Math.floor(Math.random() * catQuotes.length)]);
    }
  }
}

function checkCat() {
  var expCount = 0;
  for(var i=0; i<D.length; i++) { if(D[i].daysLeft <= 30) expCount++; }
  if (expCount > 0) {
    showCatMsg("极客警报！有 " + expCount + " 个节点快到期了喵！🆘", true);
  } else {
    setTimeout(function(){ showCatMsg("资产状态完美，可以继续编写 Bug 喵~ 💤"); }, 800);
  }
}

function feedCat(e) {
  e.stopPropagation();
  catFood++; localStorage.setItem('catFood', catFood); updateCatLevel();
  var heart = document.createElement('div');
  heart.className = 'floating-heart'; heart.innerText = '❤️';
  var rect = document.getElementById('cat-container').getBoundingClientRect();
  heart.style.left = (rect.left + rect.width / 2) + 'px'; heart.style.top = rect.top + 'px';
  document.body.appendChild(heart); setTimeout(function(){ heart.remove(); }, 1000);
  showCatMsg("能量补满！(充能 +1，当前算力罐头: " + catFood + " 个) ⚡");
}

function patrolCat(e) {
  e.stopPropagation();
  var catBox = document.getElementById('cat-container');
  var actions = document.getElementById('cat-actions');
  actions.style.display = 'none';
  showCatMsg("sudo start 巡逻程序，我出发啦喵~ 🏃");
  catBox.style.transform = 'translateX(-70vw) scaleX(-1)';
  setTimeout(function(){
    catBox.style.transform = 'translateX(-70vw) scaleX(1)';
    showCatMsg("盯—— 正在扫描网络节点... 🔍");
    setTimeout(function(){
      catBox.style.transform = 'translateX(0) scaleX(1)';
      showCatMsg("巡逻进程退出！跑得我好累喵~ 💦");
      setTimeout(function(){ actions.style.display = 'flex'; checkCat(); }, 1500);
    }, 2000);
  }, 1500);
}

function copyTxt(txt, id) {
  navigator.clipboard.writeText(txt).then(function(){
    var el = document.getElementById('cp-'+id);
    if(el) { el.innerText = '✅'; setTimeout(function(){ el.innerText = '📋'; }, 2000); }
    toast('已复制终端信息: ' + txt);
  });
}

function setFilter(type) {
  currentFilter = type;
  document.querySelectorAll('.sc.clickable').forEach(function(el) { el.classList.remove('active'); });
  document.getElementById('card-' + type).classList.add('active');
  var titleMap = { 'all': '资产节点清单', 'cf': '云端托管节点', 'exp': '失效终端', '30': '高危告警节点' };
  document.getElementById('list-title').innerText = titleMap[type] || '域名清单';
  filterD();
}

function filterD() {
  var q = document.getElementById('dsq').value.toLowerCase();
  var filtered = D.filter(function(d) {
    if (q && d.name.indexOf(q) < 0) return false;
    if (currentFilter === 'cf') return d.source && d.source.indexOf('cf') === 0;
    if (currentFilter === 'exp') return d.daysLeft < 0;
    if (currentFilter === '30') return d.daysLeft >= 0 && d.daysLeft <= 30;
    return true; 
  });
  renderD(filtered);
}

function toggleAll(el) { document.querySelectorAll('.dsel').forEach(function(cb) { cb.checked = el.checked; }); updateSel(); }
function updateSel() {
  var cnt = document.querySelectorAll('.dsel:checked').length;
  document.getElementById('sel-cnt').innerText = cnt;
  document.getElementById('btn-bulk-del').style.display = cnt > 0 ? 'inline-flex' : 'none';
  var allCnt = document.querySelectorAll('.dsel').length;
  document.getElementById('selAll').checked = (cnt === allCnt && allCnt > 0);
}

function bulkDelete() {
  var ids = Array.from(document.querySelectorAll('.dsel:checked')).map(function(cb) { return cb.value; });
  if(!ids.length || !confirm('🚨 确定永久擦除选中的 ' + ids.length + ' 个节点吗？')) return;
  var btn = document.getElementById('btn-bulk-del'); btn.innerHTML = '正在擦除...'; btn.disabled = true;
  post('/api/domains/bulk-delete', { ids: ids }, 'POST').then(function(r){
    btn.disabled = false; if(r) { toast('成功抹除了 ' + r.deleted + ' 个记录！'); document.getElementById('selAll').checked = false; loadD(); loadStats(); }
  });
}

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
    val('ntype', r.type || 'pushplus'); switchNotify();
    val('tgcid', r.tgChatId || ''); val('emailapi', r.emailApi || ''); val('emailto', r.emailTo || ''); 
    if (r.tgBotToken) document.getElementById('tgtok').placeholder = "已加密安全存储"; 
    if (r.pushplusToken) document.getElementById('pptok').placeholder = "已加密安全存储"; 
    if (r.barkKey) document.getElementById('barkkey').placeholder = "已加密安全存储"; 
  }); 
}

function checkNotify() {
  var btn = document.getElementById('btn-test-notify');
  var oldText = btn.innerText;
  btn.innerText = '正在测试...'; 
  btn.disabled = true;

  post('/api/notify', { 
    type: gval('ntype'), tgBotToken: gval('tgtok'), tgChatId: gval('tgcid'),
    pushplusToken: gval('pptok'), barkKey: gval('barkkey'), emailApi: gval('emailapi'), emailTo: gval('emailto')
  }).then(function(r){ 
    if(r) {
      post('/api/check').then(function(res){ 
        btn.innerText = oldText; btn.disabled = false;
        if(res) toast('测试请求已发出，请留意接收'); 
      }).catch(function(){ btn.innerText = oldText; btn.disabled = false; });
    } else {
      btn.innerText = oldText; btn.disabled = false;
    }
  });
}

function saveNotifyCfg() { 
  post('/api/notify', { 
    type: gval('ntype'), tgBotToken: gval('tgtok'), tgChatId: gval('tgcid'),
    pushplusToken: gval('pptok'), barkKey: gval('barkkey'), emailApi: gval('emailapi'), emailTo: gval('emailto')
  }).then(function(r){ if(r) toast('通知通道配置更新成功'); }); 
}

function goto(n) {
  for (var i=0; i<4; i++) {
    var p = document.getElementById('p' + i); var b = document.getElementById('nb' + i);
    if (p) p.className = 'page' + (i === n ? ' a' : '');
    if (b) b.className = 'nb' + (i === n ? ' a' : '');
  }
}

function goHome() { goto(0); setFilter('all'); loadAll(); toast('已从云端同步最新数据'); }

function renderD(list) {
  var tb = document.getElementById('dtb');
  document.getElementById('selAll').checked = false; updateSel(); 
  if (!list.length) { tb.innerHTML = ''; show('demp'); return; }
  hide('demp');
  tb.innerHTML = list.map(function(d) {
    var dl = d.daysLeft, bc = dl < 0 ? 'br' : dl <= 30 ? 'bw' : 'bg', bt = dl < 0 ? '已过期 ' + Math.abs(dl) + ' 天' : dl > 10000 ? '永久有效' : dl === 9999 ? '未填写' : dl + ' 天后';
    var dispDate = dl > 10000 ? '永久' : (d.expiryDate || '—');
    var pct = dl < 0 ? 0 : dl > 365 ? 100 : (dl / 365 * 100), pbColor = dl < 0 ? '#ef4444' : dl <= 30 ? '#f59e0b' : '#10b981';
    var pb = '<div style="height:4px; width:100%; background:#f1f5f9; border-radius:2px; margin-top:8px; overflow:hidden;"><div style="height:100%; width:'+pct+'%; background:'+pbColor+'; border-radius:2px; transition:1s;"></div></div>';
    var reg = d.registrarUrl ? '<a href="' + esc(d.registrarUrl) + '" target="_blank" style="color:var(--primary);text-decoration:none"><b>' + (d.registrar || '🔗 链接控制台') + ' ↗</b></a>' : (d.registrar || '—');
    var srcBadge = d.source === 'cf_registrar' ? '<span class="b bc">☁ CF 注册</span>' : d.source === 'cf_zone' ? '<span class="b bc" style="opacity:0.7">☁ CF 托管</span>' : '<span class="b bx">手动/导入</span>';

    return '<tr><td style="padding-right:10px;"><input type="checkbox" class="dsel" value="' + d.id + '" onchange="updateSel()"></td><td>'
      + '<div class="dn">' + d.name + ' <span class="cp-btn" id="cp-'+d.id+'" onclick="copyTxt(\''+d.name+'\', \''+d.id+'\')">📋</span></div><div style="margin-top:6px">' + srcBadge + '</div>' + pb + '</td>'
      + '<td><div style="font-size:13px; margin-bottom:4px">' + reg + '</div><span class="b bx" style="font-weight:600">' + (d.accountName || '未关联身份') + '</span></td>'
      + '<td><span class="b ' + bc + '">' + bt + '</span></td><td style="font-weight:700; color:#64748b; font-family:monospace">' + dispDate + '</td>'
      + '<td><div style="display:flex;gap:12px"><button class="nb" style="color:var(--primary); padding:5px" onclick="editD(\'' + d.id + '\')">✏️ 编辑</button>'
      + '<button class="nb" style="color:#ef4444; padding:5px" onclick="delD(\'' + d.id + '\')">🗑️ 删除</button></div></td></tr>';
  }).join('');
}

function updateAccSel() { document.getElementById('dacc').innerHTML = '<option value="">未关联</option>' + A.concat(CF).map(function(a){ return '<option value="' + a.id + '">' + a.name + '</option>'; }).join(''); }

function openDM(d) {
  setText('dmt', d ? '修改终端参数' : '添加新的终端节点');
  val('did', d ? d.id : ''); val('dname', d ? d.name : ''); val('dreg', d ? d.registrar||'' : ''); val('durl', d ? d.registrarUrl||'' : ''); val('dreg2', d ? d.registeredAt||'' : '');
  
  var nd = new Date(); nd.setFullYear(nd.getFullYear() + 1);
  var defExp = nd.getFullYear() + '-' + ('0' + (nd.getMonth() + 1)).slice(-2) + '-' + ('0' + nd.getDate()).slice(-2);
  
  val('dexp', d ? d.expiryDate||'' : defExp); 
  val('dacc', d ? d.accountId||'' : ''); val('dnotes', d ? d.notes||'' : '');
  var rem = d ? (d.reminderDays ||[1, 15, 30, 90, 180]) :[1, 15, 30, 90, 180];
  document.querySelectorAll('.rt').forEach(function(t) { if(t.innerHTML.indexOf('天') > -1) { t.className = 'rt' + (rem.indexOf(+t.dataset.d) >= 0 ? ' on' : ''); } });
  document.getElementById('dar').checked = d ? !!d.autoRenew : false; openM('dm');
}
function editD(id) { var d = D.find(function(x){return x.id===id;}); if(d) openDM(d); }
function saveD() {
  var id = gval('did'), rem =[]; document.querySelectorAll('.rt.on').forEach(function(t){ if(t.dataset.d) rem.push(+t.dataset.d); });
  post(id ? '/api/domains/'+id : '/api/domains', { name: gval('dname'), registrar: gval('dreg'), registrarUrl: gval('durl'), accountId: gval('dacc'), registeredAt: gval('dreg2'), expiryDate: gval('dexp'), autoRenew: document.getElementById('dar').checked, notes: gval('dnotes'), reminderDays: rem }, id ? 'PUT' : 'POST').then(function(r) { if (r) { closeM('dm'); toast('参数已更新并保存'); loadD(); loadStats(); } });
}
function delD(id) { if (!confirm('⚠️ 将彻底擦除该记录，是否继续？')) return; post('/api/domains/'+id, null, 'DELETE').then(function(r){ if(r){ toast('数据已擦除'); loadD(); loadStats(); } }); }

function autoWhois() {
  var d = gval('dname').trim(); if(!d) return toast('请先提供终端通信地址', 'e');
  var btn = document.getElementById('btn-whois'); btn.innerHTML = '⏳ 探测中...'; btn.disabled = true;
  post('/api/whois', { domain: d }).then(function(r) {
    btn.innerHTML = '⚡ 一键获取'; btn.disabled = false;
    if(r && r.ok) {
      if(r.exp) val('dexp', r.exp); if(r.reg) val('dreg2', r.reg); if(r.registrar) val('dreg', r.registrar);
      toast('已嗅探并填充参数！'); showCatMsg("网络探测完毕！参数回传成功喵~", false); 
    }
  });
}

// 免费网址模块功能
function renderL() {
  var g = document.getElementById('link-grid');
  if(!L.length) { g.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#94a3b8; padding:40px 0;">暂无记录，快去添加你的私藏资源吧~</div>'; return; }
  g.innerHTML = L.map(function(l){
    return '<div class="sc" style="text-align:left; border-top:4px solid #10b981; display:flex; flex-direction:column; justify-content:space-between;">'
      + '<div><div style="display:flex; justify-content:space-between; align-items:center;"><strong>' + l.name + '</strong><span class="b bg" style="font-size:10px">免费</span></div>'
      + '<div style="font-size:12px;color:#94a3b8;margin:10px 0 15px; line-height:1.5;">' + (l.desc||'暂无描述') + '</div></div>'
      + '<div style="display:flex;gap:8px"><a href="' + l.url + '" target="_blank" class="btn bp" style="padding:8px 10px; text-decoration:none; flex:1; justify-content:center;">🔗 直达注册</a>'
      + '<button class="btn bs" style="padding:8px 12px" onclick="editL(\'' + l.id + '\')">✏️</button>'
      + '<button class="btn bs" style="padding:8px 12px;color:#ef4444" onclick="delL(\'' + l.id + '\')">🗑️</button></div></div>';
  }).join('');
}
function openLM(l) { setText('lmt', l ? '修改资源信息' : '新增免费域名资源'); val('lid', l?l.id:''); val('lname', l?l.name:''); val('lurl', l?l.url:''); val('ldesc', l?l.desc:''); openM('lm'); }
function editL(id){ var l=L.find(function(x){return x.id===id;}); if(l) openLM(l); }
function saveL() { 
  var id=gval('lid'), name=gval('lname'), url=gval('lurl');
  if(!name || !url) return toast('名称和链接必填', 'e');
  post(id?'/api/free-links/'+id:'/api/free-links',{name:name,url:url,desc:gval('ldesc')},id?'PUT':'POST').then(function(r){if(r){closeM('lm');toast('资源已保存');loadL();}}); 
}
function delL(id){if(!confirm('确定删除该网址资源？'))return;post('/api/free-links/'+id,null,'DELETE').then(function(r){if(r){toast('已被移除');loadL();}});}

function openBulkM() { val('btext', ''); val('breg', ''); val('burl', ''); openM('bm'); }

// 🚀 核心重构：支持多行合并 + 智能链接嗅探
async function saveBulk() {
  var txt = gval('btext'), defReg = gval('breg').trim(), defUrl = gval('burl').trim(); 
  if(!txt.trim()) return toast('数据源为空', 'e');
  var lines = txt.split('\n'), btn = document.getElementById('bbtn'); 
  btn.innerHTML = '运算导入中...'; btn.disabled = true; 
  
  var records =[];
  var curRec = null;

  for(var i=0; i<lines.length; i++) {
    var line = lines[i].trim(); 
    if(!line) continue;
    
    var urlMatches = line.match(/(https?:\/\/[^\s]+)/ig);
    var lineNoUrl = line.replace(/(https?:\/\/[^\s]+)/ig, ' ');
    
    var domMatch = lineNoUrl.match(/([a-zA-Z0-9\u4e00-\u9fa5-]+\.)+[a-zA-Z]{2,}/); 
    if(domMatch) {
      if(curRec && curRec.name) records.push(curRec);
      curRec = { name: domMatch[0].toLowerCase(), dates:[], url: '', isPerm: false };
    }
    
    if(curRec) {
      var dateMatches = line.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g) ||[];
      dateMatches.forEach(function(d){ 
        var p = d.replace(/[年月\/]/g, '-').replace(/日/g, '').split('-'); 
        curRec.dates.push(p[0] + '-' + (p[1].length===1?'0'+p[1]:p[1]) + '-' + (p[2].length===1?'0'+p[2]:p[2]));
      });
      if(urlMatches && !curRec.url) curRec.url = urlMatches[0];
      if(/永久|永不过期/.test(line)) curRec.isPerm = true;
    }
  }
  if(curRec && curRec.name) records.push(curRec);

  var added = 0;
  for(var j=0; j<records.length; j++) {
    var rec = records[j];
    var expDate = '', regDate = '';
    
    if(rec.dates.length > 1) {
      rec.dates.sort(function(a,b){ return new Date(a) - new Date(b); });
    }
    
    if (rec.isPerm) { 
      expDate = '2099-12-31'; 
      if (rec.dates.length > 0) regDate = rec.dates[0]; 
    } else { 
      if (rec.dates.length >= 2) { 
        regDate = rec.dates[0]; 
        expDate = rec.dates[rec.dates.length - 1]; 
      } else if (rec.dates.length === 1) { 
        expDate = rec.dates[0]; 
      } 
    }
    if(!expDate) continue; 
    
    await post('/api/domains', { 
      name: rec.name, 
      expiryDate: expDate, 
      registeredAt: regDate, 
      registrar: defReg || '未知/批量导入', 
      registrarUrl: rec.url || defUrl, 
      autoRenew: false, 
      source: 'bulk' 
    }); 
    added++;
  }
  
  btn.innerHTML = '智能提取并导入'; btn.disabled = false; closeM('bm'); 
  toast('成功解析并导入 ' + added + ' 个极客资产！'); 
  loadD(); loadStats();
  if(added > 0) showCatMsg("一口气入库了 " + added + " 个节点喵！");
}

function renderCF() {
  var g = document.getElementById('cfg'), cnt = {}; D.forEach(function(d){ cnt[d.accountId] = (cnt[d.accountId]||0)+1; });
  g.innerHTML = CF.map(function(a) {
    return '<div class="sc" style="text-align:left; border-top:4px solid #f6821f"><div><strong>☁️ ' + a.name + '</strong></div><div style="font-size:12px;color:#94a3b8;margin:5px 0 15px">' + a.cfAccountName + '<br><span style="color:#f6821f; font-weight:700">承载 ' + (cnt[a.id]||0) + ' 个节点</span></div><div style="display:flex;gap:8px"><button class="btn bp" style="padding:8px 18px" onclick="openSync(\'' + a.id + '\')">↻ 云端同步</button><button class="btn bs" style="padding:8px 18px; color:#ef4444" onclick="delCF(\'' + a.id + '\')">断开连接</button></div></div>';
  }).join('');
}
function openCFM() { val('cfn',''); val('cft',''); openM('cfm'); }
function saveCF() {
  var btn = document.getElementById('cfbtn'); btn.textContent = '握手中...'; btn.disabled = true;
  post('/api/cf-accounts', { name: gval('cfn'), apiToken: gval('cft') }).then(function(r) { btn.textContent = '验证并开始绑定'; btn.disabled = false; if (r) { closeM('cfm'); toast('链路建立成功'); loadCF(); } });
}
function delCF(id) { if (!confirm('确定断开与此云端账号的连接？')) return; post('/api/cf-accounts/'+id, null, 'DELETE').then(function(r){ if(r){ toast('连接已断开'); loadCF(); } }); }
function openSync(cfId) {
  curCFId = cfId; var cf = CF.find(function(a){return a.id===cfId;}); setText('smt', '同步 Cloudflare: ' + (cf ? cf.name : ''));
  show('slding'); hide('sbody'); document.getElementById('sftr').style.display = 'none'; openM('sm');
  post('/api/cf-preview', { cfAccountId: cfId }).then(function(r) {
    hide('slding'); if (!r || r.error) { toast(r?.error || '请求受阻', 'e'); return; } 
    show('sbody'); document.getElementById('sftr').style.display = 'flex';
    document.getElementById('ssum').innerHTML = '扫描到 <strong>' + r.total + '</strong> 个网关节点，包含 <strong>' + r.newCount + '</strong> 个新节点。';
    document.getElementById('slist').innerHTML = r.domains.map(function(d){ return '<div style="padding:15px; border-bottom:1px solid #f1f5f9; font-size:14px; font-weight:700; display:flex; justify-content:space-between"><span>' + d.name + (d.exists ? ' <span class="b bx" style="font-size:10px">已存在</span>' : '') + '</span><span style="color:#94a3b8; font-weight:normal; font-family:monospace">' + (d.expiryDate || '永久有效') + '</span></div>'; }).join('');
  });
}
function doSync() { 
  var btn = document.getElementById('sbtn'); btn.textContent = '数据传输中...'; btn.disabled = true;
  post('/api/cf-sync', { cfAccountId: curCFId, mode: gval('smod') }).then(function(r) { btn.textContent = '确认执行同步'; btn.disabled = false; if (r) { closeM('sm'); toast('同步完成！新增 ' + r.added + '，覆写 ' + r.updated); loadD(); loadStats(); showCatMsg('云端数据拉取完毕喵~'); } }); 
}

function renderA() {
  var g = document.getElementById('acg'), cnt = {}; D.forEach(function(d){ cnt[d.accountId] = (cnt[d.accountId]||0)+1; });
  g.innerHTML = A.map(function(a){
    return '<div class="sc" style="text-align:left; border-top:4px solid var(--primary)"><div><strong>' + a.name + '</strong></div><div style="font-size:12px;color:#94a3b8;margin:5px 0 15px">' + (a.registrar||'未知服务商') + '<br><span style="color:var(--primary); font-weight:700">管理 ' + (cnt[a.id]||0) + ' 个节点</span></div><div style="display:flex;gap:8px"><button class="btn bs" style="padding:8px 18px" onclick="editA(\'' + a.id + '\')">✏️ 修改</button><button class="btn bs" style="padding:8px 18px;color:#ef4444" onclick="delA(\'' + a.id + '\')">删除</button></div></div>';
  }).join('');
}
function openAM(a) { setText('amt', a ? '修改身份凭证' : '配置服务商账号'); val('aid', a?a.id:''); val('aname', a?a.name:''); val('areg', a?a.registrar||'':''); val('aurl', a?a.loginUrl||'':''); val('aemail', a?a.email||'':''); openM('acm'); }
function editA(id){ var a=A.find(function(x){return x.id===id;}); if(a) openAM(a); }
function saveA() { var id=gval('aid'); post(id?'/api/accounts/'+id:'/api/accounts',{name:gval('aname'),registrar:gval('areg'),loginUrl:gval('aurl'),email:gval('aemail')},id?'PUT':'POST').then(function(r){if(r){closeM('acm');toast('凭证已保存');loadA();}}); }
function delA(id){if(!confirm('确定抹除该账号记录？'))return;post('/api/accounts/'+id,null,'DELETE').then(function(r){if(r){toast('已被移除');loadA();}});}

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

function get(url) { return fetch(url).then(function(r) { if (r.status===401){location.reload();return null;} return r.json(); }).catch(function(e){ toast('网络节点异常', 'e'); return null; }); }
function post(url, body, method) { return fetch(url, { method: method||'POST', headers: {'Content-Type':'application/json'}, body: body ? JSON.stringify(body) : undefined }).then(function(r) { return r.json().then(function(d) { if (r.status===401){location.reload();return null;} if (!r.ok){ toast(d.error||'操作中止', 'e'); return null; } return d; }); }).catch(function(e){ toast('网络交互受阻', 'e'); return null; }); }
function gval(id){ return document.getElementById(id).value; }
function val(id,v){ document.getElementById(id).value=v||''; }
function setText(id,v){ document.getElementById(id).textContent=v; }
function show(id){ document.getElementById(id).style.display='block'; }
function hide(id){ document.getElementById(id).style.display='none'; }
function esc(s){ return String(s||'').replace(/[<>&"']/g, function(m){ return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;','\'':'&#39;'}[m]; }); }

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
