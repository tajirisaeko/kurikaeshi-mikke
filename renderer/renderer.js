'use strict';

// Notion由来の文字列は必ず textContent で入れる（HTMLとして解釈させない）

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    el.append(child.nodeType ? child : document.createTextNode(child));
  }
  return el;
}

const INTEGRATIONS_URL = 'https://www.notion.so/profile/integrations';
const LEVEL_TEXT = { high: '疑い度：高', medium: '疑い度：中', low: '疑い度：低' };

let lastData = null;

// ---------- 画面切り替え ----------

function showScreen(name) {
  $('screen-setup').hidden = name !== 'setup';
  $('screen-main').hidden = name !== 'main';
  $('connection').hidden = name !== 'main';
}

function showConnection(status) {
  const who = status.workspaceName ? `${status.workspaceName} に接続中` : 'Notionに接続中';
  $('connection-label').textContent = `✅ ${who}`;
}

// ---------- 接続 ----------

async function onConnect(event) {
  event.preventDefault();
  const errorEl = $('setup-error');
  errorEl.hidden = true;
  $('btn-connect').disabled = true;
  $('btn-connect').textContent = '確認中…';

  const res = await window.api.connect($('token-input').value);

  $('btn-connect').disabled = false;
  $('btn-connect').textContent = '接続する';
  if (!res.ok) {
    errorEl.textContent = res.error;
    errorEl.hidden = false;
    return;
  }
  $('token-input').value = '';
  showConnection(res);
  showScreen('main');
}

async function onDisconnect() {
  await window.api.disconnect();
  lastData = null;
  $('results').hidden = true;
  showScreen('setup');
}

// ---------- スキャン ----------

function setScanning(on) {
  $('btn-scan').hidden = on;
  $('btn-cancel').hidden = !on;
  $('progress').hidden = !on;
}

function renderProgress(p) {
  const fill = $('bar-fill');
  const text = $('progress-text');
  if (p.phase === 'listing') {
    fill.className = 'bar-fill indeterminate';
    text.textContent = 'データベースを探しています…';
  } else if (p.phase === 'scanning') {
    fill.className = 'bar-fill';
    fill.style.width = `${Math.round(((p.dbIndex - 1) / p.dbTotal) * 100)}%`;
    text.textContent = `${p.dbIndex} / ${p.dbTotal} 個目：「${p.dbTitle}」を読んでいます（${p.pagesFetched}件）`;
  } else if (p.phase === 'resolving') {
    fill.className = 'bar-fill';
    fill.style.width = '100%';
    text.textContent = '親ページの名前を調べています…';
  }
}

async function onScan() {
  $('scan-error').hidden = true;
  $('results').hidden = true;
  setScanning(true);
  renderProgress({ phase: 'listing' });

  const off = window.api.onProgress(renderProgress);
  const res = await window.api.startScan();
  off();
  setScanning(false);

  if (res.cancelled) {
    return showScanError('スキャンをやめました。');
  }
  if (!res.ok) {
    if (res.code === 'unauthorized') {
      await window.api.disconnect();
      showScreen('setup');
      const errorEl = $('setup-error');
      errorEl.textContent = res.error;
      errorEl.hidden = false;
      return;
    }
    return showScanError(res.error);
  }
  lastData = res;
  renderResults();
}

function showScanError(message) {
  const el = $('scan-error');
  el.textContent = message;
  el.hidden = false;
}

// ---------- 結果 ----------

const fmtDate = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};

function externalLink(url, label) {
  return h('a', {
    href: url,
    class: 'link',
    onclick: (e) => {
      e.preventDefault();
      window.api.openExternal(url);
    },
  }, label);
}

function renderItem(r) {
  const detail = h('div', { class: 'item-detail', hidden: '' });
  const detailBtn = h('button', { class: 'btn', type: 'button' }, '詳細を見る');
  let loaded = false;

  detailBtn.addEventListener('click', async () => {
    if (loaded) {
      detail.hidden = !detail.hidden;
      detailBtn.textContent = detail.hidden ? '詳細を見る' : '詳細を閉じる';
      return;
    }
    detailBtn.disabled = true;
    detailBtn.textContent = '調べています…';
    const res = await window.api.fullPath({ dbId: r.dbId, dbTitle: r.dbTitle, parent: r.dbParent });
    detailBtn.disabled = false;

    detail.replaceChildren(
      h('div', { class: 'crumbs' },
        h('b', {}, '場所：'),
        res.ok ? res.path.join(' › ') : `パスを取れませんでした（${res.error}）`),
      h('div', {},
        h('b', {}, '最近の未編集ページ：'),
        h('ul', {}, r.samples.map((s) =>
          h('li', {}, externalLink(s.url, `${fmtDate(s.created_time)} に作成`))))));
    detail.hidden = false;
    loaded = true;
    detailBtn.textContent = '詳細を閉じる';
  });

  const where = r.parentName ? `${r.dbTitle}（${r.parentName}）` : r.dbTitle;
  const pct = Math.round(r.uneditedRate * 100);

  return h('article', { class: 'card item' },
    h('div', { class: 'item-top' },
      h('span', { class: `badge badge-${r.level}` }, LEVEL_TEXT[r.level]),
      h('span', { class: 'tag' }, r.periodLabel),
      h('span', { class: 'item-title' }, `「${r.title}」`)),
    h('div', { class: 'item-db' }, `📚 ${where}`),
    h('ul', { class: 'item-facts' },
      h('li', {}, h('b', {}, `${r.total}件`), ` のうち `, h('b', {}, `${r.uneditedCount}件`), ` が未編集（${pct}%）`),
      h('li', {}, `作成の間隔：中央値 ${r.medianGapDays.toFixed(1)}日`),
      h('li', {}, `${fmtDate(r.firstCreated)} 〜 ${fmtDate(r.lastCreated)}`)),
    h('div', { class: 'item-actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => window.api.openExternal(r.dbUrl) }, 'Notionで開く'),
      detailBtn),
    detail);
}

function renderResults() {
  const { results, skipped, stats } = lastData;
  const showLow = $('show-low').checked;
  const visible = results.filter((r) => showLow || r.level !== 'low');
  const hiddenLow = results.length - visible.length;

  $('results').hidden = false;
  $('results-title').textContent = visible.length
    ? `量産っぽいものが ${visible.length} 件みつかりました`
    : '量産っぽいものは見つかりませんでした';
  $('results-summary').textContent =
    `${stats.databases}個のデータベース・${stats.pages}ページを調べました` +
    (hiddenLow ? `（疑い度「低」${hiddenLow}件は非表示）` : '');

  $('results-list').replaceChildren(...visible.map(renderItem));

  const empty = $('results-empty');
  empty.hidden = visible.length > 0;
  if (stats.databases === 0) {
    empty.textContent =
      'データベースが1つも見えませんでした。Notionでページの「…」→「接続」から、このインテグレーションを追加できているか確かめてみてください。';
  } else {
    empty.textContent = '今のところ、繰り返しで増え続けているデータベースは見当たりません 🌿';
  }

  $('skipped').hidden = skipped.length === 0;
  if (skipped.length) {
    $('skipped-title').textContent = `読み込めなかったデータベースが ${skipped.length} 件あります`;
    $('skipped-list').replaceChildren(...skipped.map((s) => h('li', {}, `${s.dbTitle}：${s.reason}`)));
  }
}

// ---------- 起動 ----------

async function init() {
  $('version').textContent = `くりかえしみっけ v${await window.api.version()}`;

  $('token-form').addEventListener('submit', onConnect);
  $('btn-toggle-token').addEventListener('click', () => {
    const input = $('token-input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('btn-toggle-token').textContent = show ? '隠す' : '表示';
  });
  $('btn-open-integrations').addEventListener('click', () => window.api.openExternal(INTEGRATIONS_URL));
  $('btn-disconnect').addEventListener('click', onDisconnect);
  $('btn-scan').addEventListener('click', onScan);
  $('btn-cancel').addEventListener('click', () => window.api.cancelScan());
  $('show-low').addEventListener('change', () => lastData && renderResults());

  const status = await window.api.status();
  if (status.hasToken) {
    showConnection(status);
    showScreen('main');
  } else {
    showScreen('setup');
  }
}

init();
