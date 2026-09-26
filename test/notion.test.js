'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, assertReadOnly, NotionError, CancelledError } = require('../src/notion');
const { createBreadcrumbResolver } = require('../src/breadcrumb');
const { runScan } = require('../src/scanner');

const ID = 'a'.repeat(32);
const jsonRes = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
});

function fakeTime() {
  const state = { t: 0, sleeps: [] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms) => { state.sleeps.push(ms); state.t += ms; },
  };
}

test('読み取り専用ガード: 書き込み系APIは拒否される', () => {
  assert.throws(() => assertReadOnly('PATCH', `/v1/pages/${ID}`));
  assert.throws(() => assertReadOnly('POST', '/v1/pages'));
  assert.throws(() => assertReadOnly('DELETE', `/v1/blocks/${ID}`));
  assert.throws(() => assertReadOnly('POST', `/v1/blocks/${ID}/children`));
  assert.doesNotThrow(() => assertReadOnly('POST', '/v1/search'));
  assert.doesNotThrow(() => assertReadOnly('POST', `/v1/databases/${ID}/query`));
  assert.doesNotThrow(() => assertReadOnly('GET', `/v1/pages/${ID}`));
});

test('リクエストに Notion-Version と Bearer トークンが付く', async () => {
  const calls = [];
  const time = fakeTime();
  const client = createClient({
    token: 'ntn_abc', ...time,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return jsonRes(200, { name: 'bot', bot: { workspace_name: 'WS' } }); },
  });
  const me = await client.getMe();
  assert.deepEqual(me, { botName: 'bot', workspaceName: 'WS' });
  assert.equal(calls[0].init.headers['Notion-Version'], '2022-06-28');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ntn_abc');
});

test('350msスロットル: 連続リクエストの間隔が空く', async () => {
  const time = fakeTime();
  const client = createClient({ token: 't', ...time, fetchImpl: async () => jsonRes(200, {}) });
  await client.getMe();
  await client.getMe();
  await client.getMe();
  // 2回目・3回目の前に350msずつ待つ
  assert.deepEqual(time.state.sleeps, [350, 350]);
});

test('429 は Retry-After を尊重して再試行する', async () => {
  const time = fakeTime();
  let n = 0;
  const client = createClient({
    token: 't', ...time,
    fetchImpl: async () => (++n === 1 ? jsonRes(429, {}, { 'retry-after': '3' }) : jsonRes(200, { name: 'x' })),
  });
  await client.getMe();
  assert.equal(n, 2);
  assert.ok(time.state.sleeps.includes(3000));
});

test('5xx は指数バックオフで再試行する', async () => {
  const time = fakeTime();
  let n = 0;
  const client = createClient({
    token: 't', ...time,
    fetchImpl: async () => (++n <= 3 ? jsonRes(503, {}) : jsonRes(200, { name: 'x' })),
  });
  await client.getMe();
  assert.equal(n, 4);
  const backoffs = time.state.sleeps.filter((ms) => ms >= 1000);
  assert.deepEqual(backoffs, [1000, 2000, 4000]);
});

test('401 は再試行せず、わかりやすいエラーになる', async () => {
  const time = fakeTime();
  let n = 0;
  const client = createClient({
    token: 't', ...time,
    fetchImpl: async () => { n++; return jsonRes(401, { code: 'unauthorized', message: 'nope' }); },
  });
  await assert.rejects(client.getMe(), (err) => err instanceof NotionError && err.code === 'unauthorized');
  assert.equal(n, 1);
});

test('キャンセルすると CancelledError になる', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createClient({ token: 't', signal: controller.signal, ...fakeTime(), fetchImpl: async () => jsonRes(200, {}) });
  await assert.rejects(client.getMe(), CancelledError);
});

test('listDatabases / queryAllPages はページネーションをたどる', async () => {
  const time = fakeTime();
  const bodies = [];
  const client = createClient({
    token: 't', ...time,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push({ url, body });
      if (url.endsWith('/v1/search')) {
        return body.start_cursor
          ? jsonRes(200, { results: [{ object: 'database', id: 'd2', title: [], url: 'u2', parent: {} }], has_more: false })
          : jsonRes(200, { results: [{ object: 'database', id: 'd1', title: [{ plain_text: 'DB1' }], url: 'u1', parent: {} }], has_more: true, next_cursor: 'c1' });
      }
      return body.start_cursor
        ? jsonRes(200, { results: [{ id: 'p2', url: 'x2', created_time: 'c', last_edited_time: 'e', properties: {} }], has_more: false })
        : jsonRes(200, { results: [{ id: 'p1', url: 'x1', created_time: 'c', last_edited_time: 'e',
            properties: { 名前: { type: 'title', title: [{ plain_text: 'ab' }, { plain_text: 'c' }] }, 他: { type: 'rich_text' } } }],
            has_more: true, next_cursor: 'c2' });
    },
  });
  const dbs = await client.listDatabases();
  assert.deepEqual(dbs.map((d) => [d.id, d.title]), [['d1', 'DB1'], ['d2', '（無題のデータベース）']]);
  assert.deepEqual(bodies[0].body.filter, { property: 'object', value: 'database' });

  const pages = await client.queryAllPages(ID);
  assert.deepEqual(pages.map((p) => [p.id, p.title]), [['p1', 'abc'], ['p2', '']]);
  const q = bodies.find((b) => b.url.includes('/query'));
  assert.deepEqual(q.body.sorts, [{ timestamp: 'created_time', direction: 'ascending' }]);
});

test('パンくず: 親をたどってフルパスを作り、同じ親はキャッシュする', async () => {
  const P = (c) => c.repeat(32);
  const pages = {
    [P('b')]: { properties: { title: { type: 'title', title: [{ plain_text: 'のんちゃん作' }] } }, parent: { type: 'page_id', page_id: P('a') } },
    [P('a')]: { properties: { title: { type: 'title', title: [{ plain_text: 'H O M E' }] } }, parent: { type: 'workspace', workspace: true } },
  };
  let getCount = 0;
  const client = {
    getPage: async (id) => { getCount++; return pages[id]; },
    getBlock: async () => { throw new Error('unused'); },
    getDatabase: async () => { throw new Error('unused'); },
  };
  const resolver = createBreadcrumbResolver(client);
  const parent = { type: 'page_id', page_id: P('b') };

  assert.equal(await resolver.parentName(parent), 'のんちゃん作');
  assert.deepEqual(await resolver.ancestorNames(parent), ['H O M E', 'のんちゃん作']);
  assert.equal(getCount, 2); // 2ページ分だけ。2回目以降はキャッシュ
});

test('パンくず: ブロックは飛ばして上のページ名を返す / 見られない親は目印を出す', async () => {
  const P = (c) => c.repeat(32);
  const client = {
    getBlock: async () => ({ parent: { type: 'page_id', page_id: P('a') } }),
    getPage: async (id) => {
      if (id === P('a')) return { properties: { t: { type: 'title', title: [{ plain_text: '親' }] } }, parent: { type: 'workspace' } };
      throw new NotionError('見つからない', { status: 404, code: 'object_not_found' });
    },
    getDatabase: async () => { throw new Error('unused'); },
  };
  const resolver = createBreadcrumbResolver(client);
  assert.equal(await resolver.parentName({ type: 'block_id', block_id: P('c') }), '親');
  assert.equal(await resolver.parentName({ type: 'page_id', page_id: P('z') }), '（見られない親ページ）');
});

test('スキャン全体: 量産DBだけが出て、親ページ名が付く。読めないDBは飛ばして続ける', async () => {
  const DAY = 86400000;
  const base = Date.parse('2025-03-01T00:00:00Z');
  const mass = Array.from({ length: 30 }, (_, i) => {
    const iso = new Date(base + i * DAY).toISOString();
    return { id: `m${i}`, url: `u${i}`, title: '', created_time: iso, last_edited_time: iso };
  });
  const normal = Array.from({ length: 30 }, (_, i) => {
    const iso = new Date(base + i * DAY).toISOString();
    return { id: `n${i}`, url: '', title: `日記${i}`, created_time: iso, last_edited_time: new Date(base + i * DAY + 3600000).toISOString() };
  });
  const client = {
    listDatabases: async () => [
      { id: 'db-mass', title: '量産DB', url: 'https://notion.so/mass', parent: { type: 'page_id', page_id: 'pp' } },
      { id: 'db-diary', title: '日記', url: '', parent: { type: 'workspace' } },
      { id: 'db-broken', title: '壊れたDB', url: '', parent: { type: 'workspace' } },
    ],
    queryAllPages: async (id) => {
      if (id === 'db-mass') return mass;
      if (id === 'db-diary') return normal;
      throw new NotionError('サーバーエラー', { status: 500, code: 'internal_server_error' });
    },
  };
  const resolver = { parentName: async () => 'HOME' };
  const events = [];
  const out = await runScan({ client, resolver, onProgress: (p) => events.push(p.phase) });

  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].dbTitle, '量産DB');
  assert.equal(out.results[0].parentName, 'HOME');
  assert.equal(out.results[0].level, 'high');
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].dbTitle, '壊れたDB');
  assert.deepEqual(out.stats, { databases: 3, pages: 60 });
  assert.equal(events[0], 'listing');
  assert.equal(events.at(-1), 'resolving');
});
