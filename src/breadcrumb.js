'use strict';

// パンくず（ページ階層パス）の取得。同じ親を何度も引かないよう Map でキャッシュする。

const { pageTitle, plainText } = require('./notion');

const UNKNOWN_PARENT = '（見られない親ページ）';
const MAX_DEPTH = 20;

function createBreadcrumbResolver(client) {
  const cache = new Map(); // "type:id" -> { title: string|null, parent: object|null }

  async function loadNode(type, id) {
    const key = `${type}:${id}`;
    if (cache.has(key)) return cache.get(key);

    let node;
    try {
      if (type === 'page_id') {
        const page = await client.getPage(id);
        node = { title: pageTitle(page) || '（無題）', parent: page.parent };
      } else if (type === 'database_id') {
        const db = await client.getDatabase(id);
        node = { title: plainText(db.title) || '（無題のデータベース）', parent: db.parent };
      } else {
        // block_id: 列やトグルなど。名前は持たないので飛ばして上へ進む
        const block = await client.getBlock(id);
        node = { title: null, parent: block.parent };
      }
    } catch (err) {
      if (err && err.code === 'unauthorized') throw err;
      node = { title: UNKNOWN_PARENT, parent: null };
    }
    cache.set(key, node);
    return node;
  }

  function refOf(parent) {
    if (!parent) return null;
    if (parent.type === 'page_id') return { type: 'page_id', id: parent.page_id };
    if (parent.type === 'database_id') return { type: 'database_id', id: parent.database_id };
    if (parent.type === 'block_id') return { type: 'block_id', id: parent.block_id };
    return null; // workspace など
  }

  // 直近の親（ブロックは飛ばす）の名前。なければ null。
  async function parentName(parent) {
    let ref = refOf(parent);
    for (let depth = 0; ref && depth < MAX_DEPTH; depth++) {
      const node = await loadNode(ref.type, ref.id);
      if (node.title) return node.title;
      ref = refOf(node.parent);
    }
    return null;
  }

  // ルートから自分の1つ手前までの名前リスト
  async function ancestorNames(parent) {
    const names = [];
    let ref = refOf(parent);
    for (let depth = 0; ref && depth < MAX_DEPTH; depth++) {
      const node = await loadNode(ref.type, ref.id);
      if (node.title) names.unshift(node.title);
      ref = refOf(node.parent);
    }
    return names;
  }

  return { parentName, ancestorNames };
}

module.exports = { createBreadcrumbResolver, UNKNOWN_PARENT };
