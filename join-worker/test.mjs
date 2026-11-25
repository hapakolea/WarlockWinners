// Run: node join-worker/test.mjs   (no network: fakes Whop, Telegram and KV)
import assert from 'node:assert/strict';
import worker from './worker.js';
// Run the cron the way Cloudflare does: scheduled() hands its work to ctx.waitUntil.
const sweep = async (env) => { let p; await worker.scheduled({}, env, { waitUntil: (x) => (p = x) }); await p; };

const kv = new Map();
const KV = {
  get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
  put: async (k, v) => void kv.set(k, v),
  delete: async (k) => void kv.delete(k),
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
};
const env = { KV, WHOP_API_KEY: 'k', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHANNEL_ID: '-100', ALLOWED_ORIGIN: 'https://warlockwinners.com' };

const payments = { pay_good: { id: 'pay_good', membership: { id: 'mem_1' } }, pay_lapsed: { id: 'pay_lapsed', membership: { id: 'mem_2' } } };
const memberships = { mem_1: { status: 'active' }, mem_2: { status: 'expired' }, mem_3: { status: 'active' } };
let updates = [], calls = [], whopDown = false, links = 0;

globalThis.fetch = async (url, opts = {}) => {
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.startsWith('https://api.whop.com/api/v1/')) {
    assert.equal(opts.headers.Authorization, 'Bearer k');
    if (whopDown) return res({}, 500);
    if (url.includes('/members?query=')) {
      const q = decodeURIComponent(url.split('query=')[1]);
      return res({ data: q === 'fan@example.com' ? [{ id: 'mber_9', user: { email: 'Fan@Example.com' } }, { id: 'mber_x', user: { email: 'fan@example.com.au' } }] : [] });
    }
    if (url.includes('/memberships?member_id=')) return res({ data: url.endsWith('mber_9') ? [{ id: 'mem_old', status: 'expired' }, { id: 'mem_3', status: 'active' }] : [] });
    const [, kind, id] = url.replace('https://api.whop.com/api/v1/', '/').split('/');
    const obj = (kind === 'payments' ? payments : memberships)[id];
    return obj ? res(obj) : res({}, 404);
  }
  const method = url.split('/').pop();
  const body = JSON.parse(opts.body);
  calls.push([method, body]);
  if (method === 'createChatInviteLink') return res({ ok: true, result: { invite_link: `https://t.me/+L${++links}` } });
  if (method === 'getUpdates') return res({ ok: true, result: updates.filter((u) => u.update_id >= body.offset) });
  return res({ ok: true, result: true });
};
const get = async (q) => {
  const r = await worker.fetch(new Request(`https://w.dev/join?${q}`), env);
  return [r.status, await r.json(), r.headers.get('Access-Control-Allow-Origin')];
};

// valid buyer gets a one-person link named after their membership
let [status, body, cors] = await get('receipt_id=pay_good');
assert.deepEqual([status, body, cors], [200, { link: 'https://t.me/+L1' }, 'https://warlockwinners.com']);
const create = calls.find((c) => c[0] === 'createChatInviteLink')[1];
assert.equal(create.member_limit, 1);
assert.equal(create.name, 'mem_1');

// reloading the page returns the same link, no new one minted
[status, body] = await get('receipt_id=pay_good');
assert.deepEqual(body, { link: 'https://t.me/+L1' });
assert.equal(links, 1);

// bad input, unknown receipt, lapsed membership
assert.equal((await get('receipt_id=nope'))[0], 400);
assert.deepEqual((await get('receipt_id=pay_missing')).slice(0, 2), [404, { error: 'unknown_receipt' }]);
assert.deepEqual((await get('receipt_id=pay_lapsed')).slice(0, 2), [403, { error: 'inactive' }]);
assert.equal((await worker.fetch(new Request('https://w.dev/other'), env)).status, 404);

// sweep records the join from the link name
updates = [{ update_id: 7, chat_member: { chat: { id: -100 }, new_chat_member: { status: 'member', user: { id: 42 } }, invite_link: { name: 'mem_1' } } }];
await sweep(env);
assert.equal((await KV.get('m:mem_1', 'json')).user_id, 42);
assert.equal(await KV.get('offset'), '8');

// once joined, the page says "already in" instead of a dead link
assert.deepEqual((await get('receipt_id=pay_good'))[1], { already: true });

// Whop outage: nobody is kicked
whopDown = true; calls = [];
await sweep(env);
assert.ok(!calls.some((c) => c[0] === 'banChatMember'));
assert.ok(kv.has('m:mem_1'));

// membership ends: kicked (ban + unban, not a permanent ban), link revoked, record removed
whopDown = false; memberships.mem_1.status = 'canceled'; calls = [];
await sweep(env);
assert.deepEqual(calls.filter((c) => c[0] !== 'getUpdates').map((c) => c[0]), ['revokeChatInviteLink', 'banChatMember', 'unbanChatMember']);
assert.equal(calls.find((c) => c[0] === 'banChatMember')[1].user_id, 42);
assert.ok(!kv.has('m:mem_1'));

// and their old receipt can't mint a new link
assert.deepEqual((await get('receipt_id=pay_good')).slice(0, 2), [403, { error: 'inactive' }]);
// email fallback (no receipt in the redirect): exact, case-insensitive match; picks the active membership
calls = [];
let [st, bd] = await get('email=' + encodeURIComponent(' FAN@example.com '));
assert.equal(st, 200); assert.ok(bd.link);
assert.equal(calls.find((c) => c[0] === 'createChatInviteLink')[1].name, 'mem_3');
assert.deepEqual((await get('email=fan@example.com'))[1], bd, 'reload returns same link');
assert.deepEqual((await get('email=nobody@example.com')).slice(0, 2), [404, { error: 'no_member' }]);
assert.equal((await get('email=not-an-email'))[0], 400);
assert.equal((await get(''))[0], 400);
let last; for (let i = 0; i < 8; i++) last = await get('email=nobody@example.com');
assert.deepEqual(last.slice(0, 2), [429, { error: 'too_many_tries' }], 'email lookups are rate limited');
console.log('ok');
