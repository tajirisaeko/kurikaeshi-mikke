'use strict';

// ワークスペース全体のスキャン: DB列挙 → 各DBのページ取得 → 検出 → 親ページ名の解決

const { detectSuspiciousGroups, LEVEL_ORDER } = require('./detect');
const { CancelledError } = require('./notion');

/**
 * @param {object} opts
 * @param {ReturnType<import('./notion').createClient>} opts.client
 * @param {ReturnType<import('./breadcrumb').createBreadcrumbResolver>} opts.resolver
 * @param {(p: object) => void} [opts.onProgress]
 */
async function runScan({ client, resolver, onProgress = () => {} }) {
  onProgress({ phase: 'listing' });
  const databases = await client.listDatabases();

  const results = [];
  const skipped = [];
  let totalPages = 0;

  for (let i = 0; i < databases.length; i++) {
    const db = databases[i];
    const base = { phase: 'scanning', dbIndex: i + 1, dbTotal: databases.length, dbTitle: db.title };
    onProgress({ ...base, pagesFetched: 0 });

    let pages;
    try {
      pages = await client.queryAllPages(db.id, (n) => onProgress({ ...base, pagesFetched: n }));
    } catch (err) {
      // 認証エラーとキャンセルは全体を止める。それ以外はそのDBだけ飛ばして続ける
      if (err instanceof CancelledError || err.code === 'unauthorized') throw err;
      skipped.push({ dbId: db.id, dbTitle: db.title, reason: err.message });
      continue;
    }

    totalPages += pages.length;
    for (const group of detectSuspiciousGroups(pages)) {
      results.push({ ...group, dbId: db.id, dbTitle: db.title, dbUrl: db.url, dbParent: db.parent });
    }
  }

  // 親ページ名は「怪しいDB」だけ解決する（DBが多い環境での律速を避ける）
  onProgress({ phase: 'resolving' });
  const parentNames = new Map();
  for (const r of results) {
    if (!parentNames.has(r.dbId)) parentNames.set(r.dbId, await resolver.parentName(r.dbParent));
  }
  for (const r of results) {
    r.parentName = parentNames.get(r.dbId) || null; // dbParent は「詳細を見る」で使うので残す
  }

  results.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.total - a.total
  );

  return {
    results,
    skipped,
    stats: { databases: databases.length, pages: totalPages },
    scannedAt: new Date().toISOString(),
  };
}

module.exports = { runScan };
