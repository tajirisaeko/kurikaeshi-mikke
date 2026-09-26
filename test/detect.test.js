'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectSuspiciousGroups, periodLabel, median, normalizeTitle } = require('../src/detect');

const DAY = 86400000;
const START = Date.parse('2025-01-01T09:00:00Z');

// gapDays 間隔で count 件のページを作る。editAfterSec だけ後に編集されたことにする
function makePages({ count, gapDays, title = '', editAfterSec = 0, jitter = () => 0, prefix = 'p' }) {
  return Array.from({ length: count }, (_, i) => {
    const created = START + i * gapDays * DAY + jitter(i) * DAY;
    return {
      id: `${prefix}${i}`,
      url: `https://notion.so/${prefix}${i}`,
      title,
      created_time: new Date(created).toISOString(),
      last_edited_time: new Date(created + editAfterSec * 1000).toISOString(),
    };
  });
}

test('実績ケース: 無題233件・間隔1.42日の量産DBは「高・毎日」で検出される', () => {
  const pages = makePages({ count: 233, gapDays: 1.42, title: '' });
  const [hit, ...rest] = detectSuspiciousGroups(pages);
  assert.equal(rest.length, 0);
  assert.equal(hit.title, '（無題）');
  assert.equal(hit.total, 233);
  assert.equal(hit.uneditedCount, 233);
  assert.equal(hit.level, 'high');
  assert.equal(hit.periodLabel, '毎日');
  assert.ok(Math.abs(hit.medianGapDays - 1.42) < 0.01);
});

test('毎日人が編集する日記DB（タイトルが日付・全部編集済み）は検出されない', () => {
  const pages = Array.from({ length: 200 }, (_, i) => {
    const created = START + i * DAY;
    return {
      id: `d${i}`, url: '', title: `2025-日記 ${i}`,
      created_time: new Date(created).toISOString(),
      last_edited_time: new Date(created + 3 * 3600 * 1000).toISOString(),
    };
  });
  assert.deepEqual(detectSuspiciousGroups(pages), []);
});

test('同じタイトルでも全部編集済みなら検出されない', () => {
  const pages = makePages({ count: 30, gapDays: 1, title: '日記', editAfterSec: 600 });
  assert.deepEqual(detectSuspiciousGroups(pages), []);
});

test('同一タイトルが4件以下なら検出されない', () => {
  assert.deepEqual(detectSuspiciousGroups(makePages({ count: 4, gapDays: 7, title: '週報' })), []);
});

test('未編集が4件しかなければ検出されない（総数は5件以上でも）', () => {
  const pages = [
    ...makePages({ count: 4, gapDays: 7, title: '週報', prefix: 'a' }),
    ...makePages({ count: 3, gapDays: 7, title: '週報', editAfterSec: 999, prefix: 'b' }),
  ];
  assert.deepEqual(detectSuspiciousGroups(pages), []);
});

test('未編集の境界: 120秒はセーフ、121秒はアウト', () => {
  const ok = makePages({ count: 5, gapDays: 7, title: 'A', editAfterSec: 120 });
  const ng = makePages({ count: 5, gapDays: 7, title: 'A', editAfterSec: 121 });
  assert.equal(detectSuspiciousGroups(ok).length, 1);
  assert.equal(detectSuspiciousGroups(ng).length, 0);
});

test('毎週・隔週・毎月のラベル', () => {
  const cases = [[7, '毎週'], [14, '隔週'], [30, '毎月']];
  for (const [gap, label] of cases) {
    const [hit] = detectSuspiciousGroups(makePages({ count: 12, gapDays: gap, title: 'x' }));
    assert.equal(hit.periodLabel, label, `${gap}日間隔`);
    assert.equal(hit.level, 'high');
  }
});

test('周期的だが未編集率が80%未満なら「中」', () => {
  const pages = [
    ...makePages({ count: 10, gapDays: 7, title: 'T', prefix: 'u' }),
    // 未編集ページの周期に混ざらないよう、編集済みを4件足す（未編集率 10/14 ≒ 71%）
    ...makePages({ count: 4, gapDays: 3, title: 'T', editAfterSec: 3600, prefix: 'e' }),
  ];
  const [hit] = detectSuspiciousGroups(pages);
  assert.equal(hit.level, 'medium');
  assert.equal(hit.periodic, true);
});

test('未編集率は高いが周期がバラバラなら「中」・不定期', () => {
  const gaps = [1, 30, 2, 60, 3, 90, 1, 45];
  let t = START;
  const pages = [0, ...gaps].map((g, i) => {
    t += g * DAY;
    const iso = new Date(t).toISOString();
    return { id: `r${i}`, url: '', title: 'ばらばら', created_time: iso, last_edited_time: iso };
  });
  const [hit] = detectSuspiciousGroups(pages);
  assert.equal(hit.periodic, false);
  assert.equal(hit.level, 'medium');
  assert.equal(hit.periodLabel, '不定期');
});

test('周期も未編集率も足りなければ「低」', () => {
  const gaps = [1, 30, 2, 60, 3, 90, 1, 45, 1, 70];
  let t = START;
  const pages = gaps.map((g, i) => {
    t += g * DAY;
    const iso = new Date(t).toISOString();
    return { id: `l${i}`, url: '', title: '低', created_time: iso, last_edited_time: iso };
  });
  // 編集済みを混ぜて未編集率を下げる（未編集10 / 全体15 = 67%）
  pages.push(...makePages({ count: 5, gapDays: 2, title: '低', editAfterSec: 9999, prefix: 'z' }));
  const [hit] = detectSuspiciousGroups(pages);
  assert.equal(hit.level, 'low');
});

test('同時刻に一括作成されたページ（間隔0）は繰り返しとは見なさない', () => {
  const pages = makePages({ count: 20, gapDays: 0, title: 'インポート' });
  const [hit] = detectSuspiciousGroups(pages);
  assert.equal(hit.periodic, false);
});

test('タイトルの前後の空白は無視し、空タイトルは「（無題）」に集約される', () => {
  const pages = [
    ...makePages({ count: 3, gapDays: 1, title: '', prefix: 'a' }),
    ...makePages({ count: 3, gapDays: 1, title: '   ', prefix: 'b' }).map((p) => ({
      ...p, created_time: new Date(Date.parse(p.created_time) + 3 * DAY).toISOString(),
      last_edited_time: new Date(Date.parse(p.created_time) + 3 * DAY).toISOString(),
    })),
  ];
  const [hit] = detectSuspiciousGroups(pages);
  assert.equal(hit.title, '（無題）');
  assert.equal(hit.total, 6);
});

test('結果は 高 → 中 → 低、同じ疑い度なら件数の多い順', () => {
  const pages = [
    ...makePages({ count: 8, gapDays: 7, title: '小', prefix: 's' }),
    ...makePages({ count: 40, gapDays: 7, title: '大', prefix: 'b' }),
  ];
  assert.deepEqual(detectSuspiciousGroups(pages).map((g) => g.title), ['大', '小']);
});

test('periodLabel の境界', () => {
  assert.equal(periodLabel(1.49), '毎日');
  assert.equal(periodLabel(1.5), '毎週');
  assert.equal(periodLabel(9.99), '毎週');
  assert.equal(periodLabel(10), '隔週');
  assert.equal(periodLabel(20.9), '隔週');
  assert.equal(periodLabel(21), '毎月');
  assert.equal(periodLabel(45), '毎月');
  assert.equal(periodLabel(45.1), '不定期');
});

test('median: 奇数・偶数', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

// ---------- 日付タイトルの正規化 ----------

test('normalizeTitle: 日付表現は {日付} に置き換わる', () => {
  const cases = [
    ['2026-09-26', '{日付}'],
    ['2026/09/26', '{日付}'],
    ['2026.09.26', '{日付}'],
    ['2026/9/6', '{日付}'],
    ['2026年9月26日', '{日付}'],
    ['2026年9月26日（土）', '{日付}'],
    ['2026年9月26日(土曜日)', '{日付}'],
    ['2026-09-26 土曜日', '{日付}'],
    ['9/26', '{日付}'],
    ['9-26', '{日付}'],
    ['9月26日', '{日付}'],
    ['週報 9/19', '週報 {日付}'],
    ['週報 9/26', '週報 {日付}'],
    ['{日付} の振り返り', '{日付} の振り返り'],
    ['2026-09-23 日記', '{日付} 日記'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizeTitle(input), expected, input);
  }
});

test('normalizeTitle: 日付でないものは変えない', () => {
  for (const t of ['議事録', 'Vol.3', '第2回 打ち合わせ', 'v1.2.3', '2026', '13/45', '会議 100-200']) {
    assert.equal(normalizeTitle(t), t, t);
  }
});

test('日付だけのタイトルが未編集で周期的に溜まっていたら検出される（{日付} として1グループ）', () => {
  const pages = makePages({ count: 30, gapDays: 1, title: '' }).map((p, i) => {
    const d = new Date(Date.parse(p.created_time));
    return { ...p, title: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` };
  });
  const [hit, ...rest] = detectSuspiciousGroups(pages);
  assert.equal(rest.length, 0);
  assert.equal(hit.title, '{日付}');
  assert.equal(hit.total, 30);
  assert.equal(hit.level, 'high');
  assert.equal(hit.periodLabel, '毎日');
});

test('毎日日付タイトルを付けて中身も書いている日記DBは、未編集条件で弾かれる', () => {
  const pages = makePages({ count: 60, gapDays: 1, title: '', editAfterSec: 1800 }).map((p) => {
    const d = new Date(Date.parse(p.created_time));
    return { ...p, title: `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}` };
  });
  assert.deepEqual(detectSuspiciousGroups(pages), []);
});

test('「週報 9/19」「週報 9/26」のように日付だけ違うタイトルは同じグループになる', () => {
  const pages = makePages({ count: 8, gapDays: 7, title: '' }).map((p) => {
    const d = new Date(Date.parse(p.created_time));
    return { ...p, title: `週報 ${d.getMonth() + 1}/${d.getDate()}` };
  });
  const [hit] = detectSuspiciousGroups(pages);
  assert.equal(hit.title, '週報 {日付}');
  assert.equal(hit.total, 8);
  assert.equal(hit.periodLabel, '毎週');
});
