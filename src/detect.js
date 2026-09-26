'use strict';

// 量産ページの痕跡検出ロジック（画面・通信から独立した純粋関数）

const UNTITLED = '（無題）';
const UNEDITED_SEC = 120; // |created - last_edited| がこれ以内なら「未編集」
const MIN_SAME_TITLE = 5;
const MIN_UNEDITED = 5;
const MAX_MEDIAN_DAYS = 45;
const PERIODIC_SHARE = 0.7; // 中央値の 0.5〜1.5 倍に収まるギャップの割合
const UNEDITED_RATE_HIGH = 0.8;
const DAY_MS = 86400000;

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const DATE_PLACEHOLDER = '{日付}';

// 日付のあとに付く曜日: （土） (土) 土曜 土曜日
const WEEKDAY = '(?:\\s*(?:[（(][月火水木金土日]曜?日?[)）]|[月火水木金土日]曜日?))?';
const MONTH = '(?:0?[1-9]|1[0-2])';
const DAY = '(?:0?[1-9]|[12]\\d|3[01])';

// 長い形（年つき）から順に置き換える。短い形（9/26）が先に食い込まないようにするため
const DATE_PATTERNS = [
  // 2026-09-26 / 2026/09/26 / 2026.09.26
  new RegExp(`(?<!\\d)(?:19|20)\\d{2}([-/.])${MONTH}\\1${DAY}(?!\\d)${WEEKDAY}`, 'g'),
  // 2026年9月26日（土）
  new RegExp(`(?:(?:19|20)\\d{2}年\\s*)?${MONTH}月\\s*${DAY}日${WEEKDAY}`, 'g'),
  // 9/26 / 9-26
  new RegExp(`(?<![\\d/.-])${MONTH}[/-]${DAY}(?![\\d/.-])${WEEKDAY}`, 'g'),
];

function normalizeTitle(title) {
  let t = (title || '').trim();
  for (const pattern of DATE_PATTERNS) t = t.replace(pattern, DATE_PLACEHOLDER);
  t = t.trim();
  return t === '' ? UNTITLED : t;
}

function isUnedited(page) {
  const diff = Math.abs(Date.parse(page.created_time) - Date.parse(page.last_edited_time));
  return diff <= UNEDITED_SEC * 1000;
}

function periodLabel(medianDays) {
  if (medianDays < 1.5) return '毎日';
  if (medianDays < 10) return '毎週';
  if (medianDays < 21) return '隔週';
  if (medianDays <= MAX_MEDIAN_DAYS) return '毎月';
  return '不定期';
}

// 未編集ページの作成日時の隣接ギャップ（日）から周期性を判定する
function analyzePeriodicity(uneditedSorted) {
  const times = uneditedSorted.map((p) => Date.parse(p.created_time));
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY_MS);
  if (gaps.length === 0) return { medianGapDays: 0, periodic: false, periodicShare: 0 };

  const med = median(gaps);
  const inRange = gaps.filter((g) => g >= med * 0.5 && g <= med * 1.5).length;
  const share = inRange / gaps.length;
  // 中央値0（同時刻の一括作成）は「繰り返し」ではないので周期的とは見なさない
  const periodic = med > 0 && med <= MAX_MEDIAN_DAYS && share >= PERIODIC_SHARE;
  return { medianGapDays: med, periodic, periodicShare: share };
}

function judgeLevel(periodic, uneditedRate) {
  const manyUnedited = uneditedRate >= UNEDITED_RATE_HIGH;
  if (periodic && manyUnedited) return 'high';
  if (periodic || manyUnedited) return 'medium';
  return 'low';
}

function analyzeGroup(title, pages) {
  if (pages.length < MIN_SAME_TITLE) return null;
  const unedited = pages
    .filter(isUnedited)
    .sort((a, b) => Date.parse(a.created_time) - Date.parse(b.created_time));
  if (unedited.length < MIN_UNEDITED) return null;

  const uneditedRate = unedited.length / pages.length;
  const { medianGapDays, periodic, periodicShare } = analyzePeriodicity(unedited);

  return {
    title,
    total: pages.length,
    uneditedCount: unedited.length,
    uneditedRate,
    medianGapDays,
    periodic,
    periodicShare,
    level: judgeLevel(periodic, uneditedRate),
    periodLabel: periodic ? periodLabel(medianGapDays) : '不定期',
    firstCreated: unedited[0].created_time,
    lastCreated: unedited[unedited.length - 1].created_time,
    samples: unedited
      .slice(-3)
      .reverse()
      .map((p) => ({ id: p.id, url: p.url, created_time: p.created_time })),
  };
}

const LEVEL_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * 1つのDBの全ページから「量産っぽいグループ」を返す。
 * @param {{id:string,url:string,title:string,created_time:string,last_edited_time:string}[]} pages
 */
function detectSuspiciousGroups(pages) {
  const groups = new Map();
  for (const page of pages) {
    const key = normalizeTitle(page.title);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(page);
  }

  const found = [];
  for (const [title, list] of groups) {
    const result = analyzeGroup(title, list);
    if (result) found.push(result);
  }
  return found.sort(
    (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || b.total - a.total
  );
}

module.exports = {
  UNTITLED,
  DATE_PLACEHOLDER,
  LEVEL_ORDER,
  median,
  normalizeTitle,
  isUnedited,
  periodLabel,
  analyzePeriodicity,
  judgeLevel,
  detectSuspiciousGroups,
};
