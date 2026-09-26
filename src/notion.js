'use strict';

// Notion API クライアント（読み取り専用）
// - 350msスロットル
// - 429 / 5xx / 通信エラーは Retry-After を尊重した指数バックオフで再試行

const API_BASE = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';
const MAX_RETRIES = 6;

class NotionError extends Error {
  constructor(message, { status = 0, code = 'unknown' } = {}) {
    super(message);
    this.name = 'NotionError';
    this.status = status;
    this.code = code;
  }
}

class CancelledError extends Error {
  constructor() {
    super('キャンセルしました');
    this.name = 'CancelledError';
  }
}

// 書き込み系のAPIを絶対に呼ばないための許可リスト
const ID = '[0-9a-fA-F-]{32,36}';
const ALLOWED = [
  ['GET', /^\/v1\/users\/me$/],
  ['GET', new RegExp(`^/v1/pages/${ID}$`)],
  ['GET', new RegExp(`^/v1/databases/${ID}$`)],
  ['GET', new RegExp(`^/v1/blocks/${ID}$`)],
  ['POST', /^\/v1\/search$/],
  ['POST', new RegExp(`^/v1/databases/${ID}/query$`)],
];

function assertReadOnly(method, path) {
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) {
    throw new Error(`読み取り専用のため、このAPIは呼べません: ${method} ${path}`);
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function plainText(richText) {
  return (richText || []).map((t) => t.plain_text || '').join('');
}

function pageTitle(page) {
  const props = page.properties || {};
  return Object.values(props)
    .filter((p) => p && p.type === 'title')
    .map((p) => plainText(p.title))
    .join('');
}

function friendlyMessage(status, body) {
  if (status === 401) return 'トークンが正しくないようです。コピーし直して貼り付けてみてください。';
  if (status === 403) return 'このトークンには、その操作をする権限がありません。';
  if (status === 404) return 'ページが見つからないか、インテグレーションに接続されていません。';
  return (body && body.message) || `Notion APIでエラーが起きました（${status}）`;
}

function createClient({
  token,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = Date.now,
  throttleMs = 350,
  signal,
} = {}) {
  let nextSlot = 0;

  function checkCancelled() {
    if (signal && signal.aborted) throw new CancelledError();
  }

  async function waitForSlot() {
    const wait = nextSlot - now();
    nextSlot = Math.max(now(), nextSlot) + throttleMs;
    if (wait > 0) await sleep(wait);
  }

  function retryDelay(res, attempt) {
    const retryAfter = res && Number(res.headers.get('retry-after'));
    if (retryAfter > 0) return retryAfter * 1000;
    return Math.min(30000, 1000 * 2 ** attempt);
  }

  async function request(method, path, body) {
    assertReadOnly(method, path);

    for (let attempt = 0; ; attempt++) {
      checkCancelled();
      await waitForSlot();
      checkCancelled();

      let res;
      try {
        res = await fetchImpl(API_BASE + path, {
          method,
          signal,
          headers: {
            Authorization: `Bearer ${token}`,
            'Notion-Version': NOTION_VERSION,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (err) {
        checkCancelled();
        if (attempt >= MAX_RETRIES) {
          throw new NotionError('Notionに接続できませんでした。ネットワークを確認してみてください。', {
            code: 'network',
          });
        }
        await sleep(Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }

      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(retryDelay(res, attempt));
        continue;
      }

      let errBody = null;
      try {
        errBody = await res.json();
      } catch (_) {
        /* 本文なし */
      }
      throw new NotionError(friendlyMessage(res.status, errBody), {
        status: res.status,
        code: (errBody && errBody.code) || 'http_error',
      });
    }
  }

  // --- 公開メソッド ---

  async function getMe() {
    const me = await request('GET', '/v1/users/me');
    return {
      botName: me.name || 'インテグレーション',
      workspaceName: (me.bot && me.bot.workspace_name) || null,
    };
  }

  // ワークスペース内（インテグレーションに接続済み）の全DB
  async function listDatabases() {
    const dbs = [];
    let cursor;
    do {
      const res = await request('POST', '/v1/search', {
        filter: { property: 'object', value: 'database' },
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const db of res.results) {
        if (db.object !== 'database') continue;
        dbs.push({
          id: db.id,
          title: plainText(db.title) || '（無題のデータベース）',
          url: db.url,
          parent: db.parent,
        });
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return dbs;
  }

  // DBの全ページ（作成順）。必要な項目だけに絞って返す。
  async function queryAllPages(databaseId, onProgress) {
    const pages = [];
    let cursor;
    do {
      const res = await request('POST', `/v1/databases/${databaseId}/query`, {
        page_size: 100,
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      for (const p of res.results) {
        pages.push({
          id: p.id,
          url: p.url,
          title: pageTitle(p),
          created_time: p.created_time,
          last_edited_time: p.last_edited_time,
        });
      }
      if (onProgress) onProgress(pages.length);
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    return pages;
  }

  return {
    getMe,
    listDatabases,
    queryAllPages,
    getPage: (id) => request('GET', `/v1/pages/${id}`),
    getDatabase: (id) => request('GET', `/v1/databases/${id}`),
    getBlock: (id) => request('GET', `/v1/blocks/${id}`),
  };
}

module.exports = {
  API_BASE,
  NOTION_VERSION,
  NotionError,
  CancelledError,
  assertReadOnly,
  plainText,
  pageTitle,
  createClient,
};
