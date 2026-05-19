import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

const NOTE_TOPS = [
  '01. Inbox',
  '02. Literature Notes',
  '03. Permanent Notes',
  '04. Projects',
  '05. Areas',
  '06. Resources',
  '07. Archive',
  '08. Templates',
];

const ALLOWED_TYPES = {
  '01. Inbox': ['Raw수집', 'Raw'],
  '02. Literature Notes': ['문헌노트', 'Literature Note'],
  '03. Permanent Notes': ['영구노트', 'Permanent Note'],
  '04. Projects': ['프로젝트노트', 'Project Note'],
  '05. Areas': ['영역노트', 'Area Note'],
  '06. Resources': ['운영가이드', '지도', '카탈로그', 'Operating Guide', 'Map', 'Catalog'],
  '07. Archive': ['보관노트', 'Archive Note'],
  '08. Templates': ['Raw수집', '문헌노트', '영구노트', '프로젝트노트', '영역노트', '보관노트', '운영가이드', '지도', '카탈로그', 'Raw', 'Literature Note', 'Permanent Note', 'Project Note', 'Area Note', 'Archive Note', 'Operating Guide', 'Map', 'Catalog'],
};

const FORBIDDEN_PATTERNS = [
  /자동화도구/,
  /자동화 도구/,
  /\/Users\/[^/\s]+/,
  /\/private\//,
  /token:/i,
  /secret:/i,
  /password:/i,
  /sig=/,
];

const BASE_FIELD_SETS = [
  ['유형', '상태', '문서화렌즈', '지식성숙도', '작성일', '수정일', '수집채널', '영역', '태그'],
  ['type', 'status', 'documentationLens', 'knowledgeMaturity', 'created', 'updated', 'captureChannel', 'area', 'tags'],
];

const NAV_FIELD_SETS = [
  ['주제범위', '영향범위', '검증필요도', '권장탐색깊이', '상위허브'],
  ['topicScope', 'impactScope', 'verificationNeed', 'recommendedSearchDepth', 'parentHub'],
];

const DAILY_FIELD_SETS = [
  ['보고유형', '보고일', '작성자', '팀', '관련프로젝트', '민감정보검사'],
  ['reportType', 'reportDate', 'author', 'team', 'relatedProjects', 'sensitivityCheck'],
];

const RAW_INGEST_STATES = [
  '수집됨',
  '검토중',
  '승격완료',
  '보류',
  '폐기',
  '보관완료',
  'captured',
  'reviewing',
  'promoted',
  'held',
  'discarded',
  'archived',
];

const DAILY_ROOTS = [
  'ko/01. Inbox/01-01. Raw/01-01-02. 일간 리포트',
  'en/01. Inbox/01-01. Raw/01-01-02. Daily Reports',
  '01. Inbox/01-01. Raw/01-01-02. 일간 리포트',
  '01. Inbox/01-01. Raw/01-01-02. Daily Reports',
];

export function parseToolOptions(argv = []) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options._.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    const inlineEqualsIndex = arg.indexOf('=');
    if (inlineEqualsIndex !== -1) {
      options[arg.slice(2, inlineEqualsIndex)] = arg.slice(inlineEqualsIndex + 1);
      continue;
    }
    const rawKey = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      options[rawKey] = true;
      continue;
    }
    options[rawKey] = next;
    index += 1;
  }
  return options;
}

export function resolveToolLanguage(root, options = {}) {
  return options.language || options.lang || process.env.OMW_WIKI_LANGUAGE || (existsSync(path.join(root, 'en')) ? 'en' : undefined);
}

export function createRawIngestReport({ root, language }) {
  const rawRoots = [
    language && `${language}/01. Inbox/01-01. Raw`,
    '01. Inbox/01-01. Raw',
  ].filter(Boolean).filter((item) => {
    const rawRootPath = path.join(root, item);
    if (!existsSync(rawRootPath)) return false;
    assertSafeExistingDirectory(root, rawRootPath, 'Raw root');
    return true;
  });
  const rows = rawRoots.flatMap((rawRoot) => markdownFiles(path.join(root, rawRoot)).map((file) => {
    const text = readFileSync(file, 'utf8');
    const { frontmatter } = splitFrontmatter(text);
    return {
      path: rel(root, file),
      state: frontmatter['ingest상태'] || frontmatter.ingestState || label(language, 'unspecified'),
      target: frontmatter['ingest대상'] || frontmatter.ingestTarget || frontmatter.target || label(language, 'unspecified'),
      processedAt: frontmatter['처리일'] || frontmatter.processedAt || '',
    };
  })).sort((a, b) => a.path.localeCompare(b.path));

  const lines = [`# ${label(language, 'rawTitle')}`, '', `- ${label(language, 'total')}: ${rows.length}`];
  for (const state of [...RAW_INGEST_STATES, '미지정', 'unspecified']) {
    const count = rows.filter((row) => row.state === state).length;
    if (count > 0) lines.push(`- ${state}: ${count}`);
  }
  lines.push('', `| ${label(language, 'state')} | ${label(language, 'target')} | ${label(language, 'processedAt')} | ${label(language, 'note')} |`, '|---|---|---|---|');
  for (const row of rows) {
    lines.push(`| ${row.state} | ${row.target} | ${row.processedAt} | ${row.path} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function createDailyReportSummary({ root, language, date, team, author }) {
  const dailyRoots = [
    language && `${language}/01. Inbox/01-01. Raw/01-01-02. Daily Reports`,
    language && `${language}/01. Inbox/01-01. Raw/01-01-02. 일간 리포트`,
    '01. Inbox/01-01. Raw/01-01-02. Daily Reports',
    '01. Inbox/01-01. Raw/01-01-02. 일간 리포트',
  ].filter(Boolean).filter((item) => {
    const dailyRootPath = path.join(root, item);
    if (!existsSync(dailyRootPath)) return false;
    assertSafeExistingDirectory(root, dailyRootPath, 'Daily report root');
    return true;
  });

  const rows = dailyRoots.flatMap((dailyRoot) => markdownFiles(path.join(root, dailyRoot)).map((file) => {
    const text = readFileSync(file, 'utf8');
    const { frontmatter, body } = splitFrontmatter(text);
    if (!isDailyReport(file, frontmatter, root)) return null;
    const row = {
      path: rel(root, file),
      date: value(frontmatter, '보고일', 'reportDate', 'created'),
      author: value(frontmatter, '작성자', 'author'),
      team: value(frontmatter, '팀', 'team'),
      state: value(frontmatter, 'ingest상태', 'ingestState'),
      projects: toArray(value(frontmatter, '관련프로젝트', 'relatedProjects')).join(', '),
      blockers: [
        ...sectionLines(body, '막힌 점 / 지원 필요'),
        ...sectionLines(body, 'Blockers / Support Needed'),
      ],
      knowledge: [
        ...sectionLines(body, '지식화 후보'),
        ...sectionLines(body, 'Knowledge Candidates'),
      ],
    };
    if (date && row.date !== date) return null;
    if (team && row.team !== team) return null;
    if (author && row.author !== author) return null;
    return row;
  }).filter(Boolean)).sort((a, b) => a.path.localeCompare(b.path));

  const lines = [
    `# ${label(language, 'dailyTitle')}`,
    '',
    `- ${label(language, 'total')}: ${rows.length}`,
    `- ${label(language, 'dates')}: ${unique(rows.map((row) => row.date)).join(', ')}`,
    `- ${label(language, 'teams')}: ${unique(rows.map((row) => row.team)).join(', ')}`,
    '',
    `## ${label(language, 'byAuthor')}`,
    '',
    `| ${label(language, 'author')} | ${label(language, 'team')} | ${label(language, 'reportCount')} |`,
    '|---|---|---|',
  ];
  for (const item of groupedAuthorRows(rows)) {
    lines.push(`| ${item.author} | ${item.team} | ${item.count} |`);
  }
  lines.push('', `## ${label(language, 'reports')}`, '', `| ${label(language, 'reportDate')} | ${label(language, 'author')} | ${label(language, 'team')} | ${label(language, 'ingestState')} | ${label(language, 'projects')} | ${label(language, 'note')} |`, '|---|---|---|---|---|---|');
  for (const row of rows) {
    lines.push(`| ${row.date} | ${row.author} | ${row.team} | ${row.state} | ${row.projects} | ${row.path} |`);
  }

  const blockers = rows.flatMap((row) => row.blockers.map((item) => ({ row, item }))).filter(({ item }) => !['- 없음', '없음'].includes(item));
  if (blockers.length > 0) {
    lines.push('', `## ${label(language, 'blockers')}`, '');
    for (const { row, item } of blockers) lines.push(`- ${row.date} ${row.author}: ${item}`);
  }

  const knowledge = rows.flatMap((row) => row.knowledge.map((item) => ({ row, item }))).filter(({ item }) => !item.includes('입력 예정'));
  if (knowledge.length > 0) {
    lines.push('', `## ${label(language, 'knowledge')}`, '');
    for (const { row, item } of knowledge) lines.push(`- ${row.date} ${row.author}: ${item}`);
  }

  return `${lines.join('\n')}\n`;
}

export function validateWiki({ root }) {
  const failures = [];
  const languageRoots = ['en', 'ko'].filter((locale) => existsSync(path.join(root, locale)));
  if (languageRoots.length === 0) languageRoots.push('.');
  const noteFiles = allFiles(root, ['.md', '.json']).filter((file) => isNoteFile(root, file, languageRoots));
  const markdownNotes = allFiles(root, ['.md']).filter((file) => isNoteFile(root, file, languageRoots));
  for (const file of noteFiles) {
    const prefix = numberedParentPrefix(file);
    if (prefix && !path.basename(file).startsWith(`${prefix}-`)) {
      failures.push(`${rel(root, file)}: parent folder number requires filename prefix ${prefix}-`);
    }
  }
  for (const file of markdownNotes) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) failures.push(`${rel(root, file)}: forbidden pattern found: ${pattern.toString()}`);
    }
  }
  for (const file of markdownNotes) {
    const text = readFileSync(file, 'utf8');
    const { frontmatter, body, error } = splitFrontmatter(text);
    const relative = rel(root, file);
    if (error) {
      failures.push(`${relative}: ${error}`);
      continue;
    }
    const missing = fieldSetMissing(frontmatter, BASE_FIELD_SETS);
    if (missing.length > 0) failures.push(`${relative}: missing required frontmatter fields: ${missing.join(', ')}`);
    const top = noteRoot(root, file, languageRoots)?.top;
    const type = frontmatter['유형'] || frontmatter.type;
    if (type && ALLOWED_TYPES[top] && !ALLOWED_TYPES[top].includes(type)) {
      failures.push(`${relative}: type ${JSON.stringify(type)} is not allowed under ${top}`);
    }
    if (['03. Permanent Notes', '05. Areas', '06. Resources'].includes(top)) {
      const missingNav = fieldSetMissing(frontmatter, NAV_FIELD_SETS);
      if (missingNav.length > 0) failures.push(`${relative}: missing navigation fields: ${missingNav.join(', ')}`);
    }
    if (['Raw수집', 'Raw'].includes(type)) {
      const state = frontmatter['ingest상태'] || frontmatter.ingestState;
      if (!state) failures.push(`${relative}: Raw note requires ingest state`);
      else if (!RAW_INGEST_STATES.includes(state)) failures.push(`${relative}: invalid ingest state ${JSON.stringify(state)}`);
    }
    if (isDailyReport(file, frontmatter, root) && !relative.includes('/08. Templates/')) {
      const missingDaily = fieldSetMissing(frontmatter, DAILY_FIELD_SETS);
      if (missingDaily.length > 0) failures.push(`${relative}: missing daily report fields: ${missingDaily.join(', ')}`);
    }
    const overlap = intersection(wikiLinks(JSON.stringify(frontmatter)), wikiLinks(body));
    if (overlap.length > 0) failures.push(`${relative}: duplicate frontmatter/body links: ${overlap.join(', ')}`);
  }

  const names = markdownNoteNames(root, languageRoots);
  for (const file of markdownNotes.filter((item) => !rel(root, item).includes('/08. Templates/'))) {
    let inCode = false;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (line.startsWith('```')) inCode = !inCode;
      if (inCode) return;
      for (const target of wikiLinks(line)) {
        if (!names.has(norm(target))) failures.push(`${rel(root, file)}:${index + 1}: missing wiki link [[${target}]]`);
      }
    });
  }

  return { ok: failures.length === 0, failures };
}

function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: text, error: null };
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return { frontmatter: {}, body: text, error: 'frontmatter closing marker missing' };
  return {
    frontmatter: parseFrontmatterBlock(match[1]),
    body: text.slice(match[0].length),
    error: null,
  };
}

function parseFrontmatterBlock(block) {
  const data = {};
  let currentKey = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const item = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (item) {
      currentKey = item[1].trim();
      data[currentKey] = parseScalar(stripInlineComment(item[2].trim()));
    } else if (currentKey && line.trim().startsWith('- ')) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = data[currentKey] ? [data[currentKey]] : [];
      data[currentKey].push(parseScalar(stripInlineComment(line.trim().slice(2).trim())));
    }
  }
  return data;
}

function parseScalar(valueText) {
  if (valueText === '[]') return [];
  if (valueText.startsWith('[') && valueText.endsWith(']')) {
    return splitFlowArray(valueText.slice(1, -1)).map((item) => unquote(item.trim())).filter(Boolean);
  }
  return unquote(valueText);
}

function stripInlineComment(valueText) {
  let quote = null;
  for (let index = 0; index < valueText.length; index += 1) {
    const char = valueText[index];
    const previous = valueText[index - 1];
    if ((char === '"' || char === "'") && previous !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (char === '#' && !quote && (index === 0 || /\s/.test(previous))) {
      return valueText.slice(0, index).trimEnd();
    }
  }
  return valueText;
}

function splitFlowArray(valueText) {
  const items = [];
  let quote = null;
  let current = '';
  for (let index = 0; index < valueText.length; index += 1) {
    const char = valueText[index];
    const previous = valueText[index - 1];
    if ((char === '"' || char === "'") && previous !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (char === ',' && !quote) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items;
}

function unquote(valueText) {
  return valueText.replace(/^['"]|['"]$/g, '');
}

function markdownFiles(root) {
  return allFiles(root, ['.md']);
}

function allFiles(root, extensions) {
  const out = [];
  walk(root, extensions, out);
  return out;
}

function walk(dir, extensions, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    const relative = rel(process.cwd(), child);
    if (entry.isDirectory()) {
      if (['.git', '.omw', '.omx', '.obsidian', '.gitlab'].includes(entry.name)) continue;
      walk(child, extensions, out);
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase()) && !relative.includes(`${path.sep}.git${path.sep}`)) {
      out.push(child);
    }
  }
}

function assertSafeExistingDirectory(root, directoryPath, label) {
  const directoryStat = lstatSync(directoryPath);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${rel(root, directoryPath)}`);
  }
  if (!isInsidePath(realpathSync(root), realpathSync(directoryPath))) {
    throw new Error(`${label} must stay inside the wiki: ${rel(root, directoryPath)}`);
  }
}

function isInsidePath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sectionLines(body, heading) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return [];
  const collected = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const valueText = line.trim();
    if (valueText) collected.push(valueText);
  }
  return collected;
}

function value(frontmatter, ...keys) {
  for (const key of keys) {
    if (frontmatter[key] !== undefined && frontmatter[key] !== null) return frontmatter[key];
  }
  return '';
}

function toArray(item) {
  if (Array.isArray(item)) return item;
  if (!item) return [];
  return [String(item)];
}

function isDailyReport(file, frontmatter, root) {
  const relative = rel(root, file);
  return DAILY_ROOTS.some((dailyRoot) => relative.startsWith(`${dailyRoot}/`)) ||
    frontmatter['보고유형'] === '일간리포트' ||
    frontmatter.reportType === 'daily_report' ||
    frontmatter.rawType === 'daily_report';
}

function groupedAuthorRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.author}\0${row.team}`;
    grouped.set(key, { author: row.author, team: row.team, count: (grouped.get(key)?.count || 0) + 1 });
  }
  return [...grouped.values()].sort((a, b) => `${a.author}${a.team}`.localeCompare(`${b.author}${b.team}`));
}

function unique(items) {
  return [...new Set(items.filter(Boolean))].sort();
}

function label(language, key) {
  const labels = {
    en: {
      rawTitle: 'Raw Ingest Report',
      dailyTitle: 'Daily Report Summary',
      total: 'total',
      dates: 'dates',
      teams: 'teams',
      unspecified: 'unspecified',
      state: 'State',
      target: 'Target',
      processedAt: 'Processed at',
      note: 'Note',
      byAuthor: 'By Author',
      author: 'Author',
      team: 'Team',
      reportCount: 'Report count',
      reports: 'Reports',
      reportDate: 'Report date',
      ingestState: 'Ingest state',
      projects: 'Related projects',
      blockers: 'Blockers',
      knowledge: 'Knowledge Candidates',
    },
    ko: {
      rawTitle: 'Raw Ingest Report',
      dailyTitle: '일간 리포트 요약',
      total: 'total',
      dates: 'dates',
      teams: 'teams',
      unspecified: '미지정',
      state: '상태',
      target: '대상',
      processedAt: '처리일',
      note: '노트',
      byAuthor: 'By Author',
      author: '작성자',
      team: '팀',
      reportCount: '리포트 수',
      reports: 'Reports',
      reportDate: '보고일',
      ingestState: 'ingest상태',
      projects: '관련프로젝트',
      blockers: 'Blockers',
      knowledge: 'Knowledge Candidates',
    },
  };
  return (labels[language] || labels.en)[key];
}

function isNoteFile(root, file, languageRoots) {
  if (['README.md', 'AGENTS.md'].includes(rel(root, file))) return false;
  return Boolean(noteRoot(root, file, languageRoots));
}

function noteRoot(root, file, languageRoots) {
  const relative = norm(rel(root, file));
  for (const locale of languageRoots) {
    const prefix = locale === '.' ? '' : `${locale}/`;
    for (const top of NOTE_TOPS) {
      if (relative.startsWith(`${prefix}${top}/`)) return { locale, top };
    }
  }
  return null;
}

function numberedParentPrefix(file) {
  return path.basename(path.dirname(file)).match(/^(\d{2}(?:-\d{2})*)\. /)?.[1] || null;
}

function fieldSetMissing(frontmatter, sets) {
  return sets.map((fields) => fields.filter((field) => !Object.hasOwn(frontmatter, field))).sort((a, b) => a.length - b.length)[0] || [];
}

function wikiLinks(text) {
  return [...String(text).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((match) => match[1].trim()).filter(Boolean);
}

function markdownNoteNames(root, languageRoots) {
  const names = new Set();
  for (const file of allFiles(root, ['.md'])) {
    if (isNoteFile(root, file, languageRoots)) names.add(norm(path.basename(file, '.md')));
  }
  return names;
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return [...new Set(left.filter((item) => rightSet.has(item)))];
}

function norm(valueText) {
  return String(valueText).normalize('NFC');
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}
