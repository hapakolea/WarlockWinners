// One-click Telegram join for Whop buyers (Cloudflare Worker). Setup: join-worker/README.md
//
// GET /join?receipt_id=pay_...  -> checks the payment with Whop, returns a one-person invite link
// GET /join?email=you@x.com      -> fallback when the checkout redirect carried no receipt: finds an active member by email
// hourly cron                   -> records who joined with which link, removes members whose Whop membership ended
//
// Env: WHOP_API_KEY, TELEGRAM_BOT_TOKEN (secrets), TELEGRAM_CHANNEL_ID, ALLOWED_ORIGIN, WHOP_COMPANY_ID (vars), KV (KV namespace)

// shortcut: Whop's status list as documented; confirm against a real membership during the first test purchase
const VALID = ['active', 'trialing', 'canceling', 'completed'];
const LINK_HOURS = 24;

export default {
  async fetch(req, env) {
    const headers = { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'https://warlockwinners.com', 'Content-Type': 'application/json' };
    const url = new URL(req.url);
    if (url.pathname !== '/join') return new Response('{"error":"not_found"}', { status: 404, headers });
    const receipt = url.searchParams.get('receipt_id') || url.searchParams.get('payment_id') || '';
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const who = receipt || email;
    try {
      if (receipt) {
        if (!/^pay_[A-Za-z0-9]+$/.test(receipt)) return new Response('{"error":"bad_receipt"}', { status: 400, headers });
        return new Response(JSON.stringify(await join(env, `r:${receipt}`, () => memFromReceipt(env, receipt))), { headers });
      }
      if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(email)) return new Response('{"error":"bad_email"}', { status: 400, headers });
      // Email lookups can be guessed at, so cap them per visitor IP.
      const ip = req.headers.get('cf-connecting-ip') || 'unknown';
      const tries = Number(await env.KV.get(`rl:${ip}`)) || 0;
      if (tries >= 10) return new Response('{"error":"too_many_tries"}', { status: 429, headers });
      await env.KV.put(`rl:${ip}`, String(tries + 1), { expirationTtl: 3600 });
      return new Response(JSON.stringify(await join(env, `e:${email}`, () => memFromEmail(env, email))), { headers });
    } catch (e) {
      console.log('join failed', who, e.message);
      // detail names the failing call and HTTP status (never secrets) so problems can be read straight off the browser.
      return new Response(JSON.stringify({ error: e.code || 'server_error', ...(e.code ? {} : { detail: e.message.slice(0, 120) }) }), { status: e.status || 500, headers });
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};

function fail(code, status) {
  return Object.assign(new Error(code), { code, status });
}

async function whop(env, path) {
  const r = await fetch(`https://api.whop.com/api/v1${path}`, { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } });
  if (r.status === 404) return null;
  if (!r.ok) {
    console.log('whop error', path.split('?')[0], r.status, (await r.text()).slice(0, 300));
    throw new Error(`whop ${path.split('?')[0]} ${r.status}`); // no query string: keeps emails out of responses
  }
  return r.json();
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(`telegram ${method}: ${d.description}`);
  return d.result;
}

const isValid = (m) => !!m && VALID.includes(m.status);
const idOf = (x) => (typeof x === 'string' ? x : x?.id);

async function memFromReceipt(env, receipt) {
  const payment = await whop(env, `/payments/${receipt}`);
  if (!payment) throw fail('unknown_receipt', 404);
  const memId = idOf(payment.membership) || payment.membership_id;
  if (!memId) throw fail('no_membership', 409);
  return memId;
}

const list = (res) => (Array.isArray(res) ? res : res?.data || []);

async function memFromEmail(env, email) {
  // Needs a Whop key with member read + member email read; otherwise Whop hides emails and nothing matches.
  // Whop's member search takes the business ID as account_id (WHOP_COMPANY_ID, starts with biz_).
  const acct = env.WHOP_COMPANY_ID ? `&account_id=${encodeURIComponent(env.WHOP_COMPANY_ID)}` : '';
  const members = list(await whop(env, `/members?query=${encodeURIComponent(email)}${acct}`));
  const member = members.find((m) => [m.email, m.user?.email].some((e) => (e || '').toLowerCase() === email));
  if (!member) throw fail('no_member', 404);
  const ms = list(await whop(env, `/memberships?member_id=${encodeURIComponent(member.id)}`));
  const mem = ms.find(isValid) || ms[0];
  if (!mem) throw fail('no_membership', 409);
  return mem.id;
}

async function join(env, cacheKey, findMem) {
  const now = Math.floor(Date.now() / 1000);
  const cached = await env.KV.get(cacheKey, 'json');
  if (cached) {
    const m = await env.KV.get(`m:${cached.mem}`, 'json');
    if (m?.user_id) return { already: true };
    // Reloading the page within the link's lifetime returns the same link instead of minting new ones.
    // No m: record means the sweep removed them, so fall through to a fresh Whop check.
    if (m && cached.created + LINK_HOURS * 3600 > now + 300) return { link: cached.link };
  }

  const memId = await findMem();
  if (!isValid(await whop(env, `/memberships/${memId}`))) throw fail('inactive', 403);

  if (cached?.link) await tg(env, 'revokeChatInviteLink', { chat_id: env.TELEGRAM_CHANNEL_ID, invite_link: cached.link }).catch(() => {});
  const { invite_link: link } = await tg(env, 'createChatInviteLink', {
    chat_id: env.TELEGRAM_CHANNEL_ID, name: memId.slice(0, 32), member_limit: 1, expire_date: now + LINK_HOURS * 3600,
  });
  const prev = await env.KV.get(`m:${memId}`, 'json');
  await env.KV.put(cacheKey, JSON.stringify({ mem: memId, link, created: now }));
  await env.KV.put(`m:${memId}`, JSON.stringify({ link, user_id: prev?.user_id ?? null }));
  return { link };
}

async function sweep(env) {
  // 1. Record joins. Telegram keeps updates ~24h; the hourly cron stays well inside that.
  const offset = Number(await env.KV.get('offset')) || 0;
  let next = offset;
  for (const u of await tg(env, 'getUpdates', { offset, allowed_updates: ['chat_member'], timeout: 0 })) {
    next = u.update_id + 1;
    const cm = u.chat_member;
    const name = cm?.invite_link?.name;
    if (!cm || String(cm.chat.id) !== String(env.TELEGRAM_CHANNEL_ID) || cm.new_chat_member.status !== 'member' || !name?.startsWith('mem_')) continue;
    const m = await env.KV.get(`m:${name}`, 'json');
    if (m) await env.KV.put(`m:${name}`, JSON.stringify({ ...m, user_id: cm.new_chat_member.user.id }));
  }
  if (next !== offset) await env.KV.put('offset', String(next));

  // 2. Remove members whose Whop membership is no longer valid.
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'm:', cursor });
    for (const { name: key } of page.keys) {
      const memId = key.slice(2);
      let mem;
      try {
        mem = await whop(env, `/memberships/${memId}`);
      } catch (e) {
        console.log('skip, whop error', memId, e.message); // never kick on an API error
        continue;
      }
      if (isValid(mem)) continue;
      const m = await env.KV.get(key, 'json');
      if (m?.link) await tg(env, 'revokeChatInviteLink', { chat_id: env.TELEGRAM_CHANNEL_ID, invite_link: m.link }).catch(() => {});
      if (m?.user_id) {
        await tg(env, 'banChatMember', { chat_id: env.TELEGRAM_CHANNEL_ID, user_id: m.user_id });
        await tg(env, 'unbanChatMember', { chat_id: env.TELEGRAM_CHANNEL_ID, user_id: m.user_id, only_if_banned: true });
      }
      await env.KV.delete(key);
      console.log('removed', memId, mem?.status ?? 'not_found');
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
