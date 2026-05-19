import path from 'node:path';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { pathExists } from '../utils/fs.js';

const SCANNER_NAME = 'omw-contract-scanner';
const SCANNER_VERSION = 1;
const DEFAULT_WIKI_LANGUAGE = 'en';
const IGNORED_DIRS = new Set(['.git', '.hg', '.svn', '.omw', '.omx', '.obsidian', 'node_modules', '.DS_Store']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);

export async function scanWikiContract(wikiPath, options = {}) {
  const language = normalizeLanguage(options.language || options.wikiLanguage);
  const writeManaged = Boolean(options.writeManaged);
  const files = await inventoryMarkdownFiles(wikiPath);
  const directories = await inventoryDirectories(wikiPath);
  const profile = detectProfile(files, language, directories);
  const templates = detectTemplates(files, language);
  const search = detectSearch(files, language, profile, directories, templates);
  const raw = await detectRaw({ wikiPath, files, directories, templates, language, writeManaged });
  const rules = detectRules(files, language, profile);
  const daily = detectDaily(templates.daily_report, language);
  const frontmatter = detectFrontmatter(files);
  const capabilities = evaluateCapabilities({ files, raw, rules, daily, templates, search });

  return {
    schemaVersion: 2,
    generatedBy: SCANNER_NAME,
    generatedAt: new Date().toISOString(),
    defaultLanguage: DEFAULT_WIKI_LANGUAGE,
    language,
    wikiName: path.basename(wikiPath || '') || 'wiki',
    source: {
      profile: profile.name,
      confidence: profile.confidence,
      signals: profile.signals,
    },
    scanner: {
      name: SCANNER_NAME,
      version: SCANNER_VERSION,
      markdownFiles: files.length,
      selectedRoots: {
        search: search.root,
        raw: raw.root,
      },
      fallbacksApplied: raw.fallbacksApplied,
    },
    capabilities,
    frontmatter,
    rules,
    raw: {
      root: raw.root,
      noteTypes: raw.noteTypes,
      placeholder: raw.placeholder,
      sensitivityCheck: raw.sensitivityCheck,
      naming: raw.naming,
      types: raw.types,
      ingestStates: raw.ingestStates,
    },
    ingest: {
      pendingStates: raw.pendingStates,
      candidateTargets: detectCandidateTargets(files, search.root),
      ruleKeys: Object.keys(rules),
      approvalRequiredForPromotedNotes: true,
    },
    search,
    daily,
  };
}

async function inventoryMarkdownFiles(wikiPath) {
  const out = [];
  await walk(wikiPath, wikiPath, out);
  out.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return out;
}

async function inventoryDirectories(wikiPath) {
  const out = [];
  await walkDirectories(wikiPath, wikiPath, out);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function walk(root, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, fullPath, out);
      continue;
    }
    if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const text = await readFile(fullPath, 'utf8').catch(() => '');
    const relativePath = normalizePath(path.relative(root, fullPath));
    const signalText = stripFencedCodeBlocks(text);
    out.push({
      path: fullPath,
      relativePath,
      segments: relativePath.split('/'),
      text,
      frontmatter: parseFrontmatter(text),
      title: text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(relativePath, path.extname(relativePath)),
      headings: [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1].trim()),
      placeholders: new Set([...signalText.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)].map((match) => match[1])),
    });
  }
}

function stripFencedCodeBlocks(text) {
  const out = [];
  let fence = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const opener = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!fence && opener) {
      fence = { marker: opener[1][0], length: opener[1].length };
      continue;
    }
    if (fence) {
      const closer = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closer && closer[1][0] === fence.marker && closer[1].length >= fence.length) fence = null;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

async function walkDirectories(root, dir, out) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    out.push(normalizePath(path.relative(root, fullPath)));
    await walkDirectories(root, fullPath, out);
  }
}

function detectProfile(files, language, directories) {
  const paths = new Set(files.map((file) => file.relativePath));
  const hasLanguageRoot = files.some((file) => file.segments[0] === language);
  const hasBaseTemplates = files.some((file) => file.relativePath.includes('/08. Templates/'));
  const hasBaseResources = files.some((file) => file.relativePath.includes('/06. Resources/')) || directories.some((dir) => dir.startsWith(`${language}/06. Resources/`));
  if (hasLanguageRoot && hasBaseTemplates && hasBaseResources) {
    return { name: 'omw-base-wiki', confidence: 'high', signals: [`${language}/`, 'templates', 'resources'] };
  }
  const hasSchema = paths.has('AGENTS.md') || paths.has('CLAUDE.md') || files.some((file) => /(^|\/)(AGENTS|CLAUDE)\.mdx?$/i.test(file.relativePath));
  const hasRootIndex = paths.has('index.md') || paths.has('index.mdx');
  const hasWikiIndex = paths.has('wiki/index.md') || paths.has('wiki/index.mdx');
  const hasLog = files.some((file) => /(^|\/)log\.md$/i.test(file.relativePath));
  const hasSources = topLevelDirs(files, directories).some((dir) => /^(sources?|raw)$/i.test(dir));
  const hasWikiDir = topLevelDirs(files, directories).includes('wiki');
  if ((hasSchema && hasRootIndex && (hasLog || hasSources)) || (hasWikiDir && hasWikiIndex && (hasSchema || hasLog || hasSources))) {
    return { name: 'karpathy-llm-wiki', confidence: 'high', signals: ['schema-doc', hasWikiDir ? 'wiki/' : 'index.md', hasLog ? 'log.md' : 'sources/'] };
  }
  return { name: 'generic-markdown', confidence: files.length > 0 ? 'medium' : 'low', signals: files.length > 0 ? ['markdown-files'] : [] };
}

function detectSearch(files, language, profile, directories, templates = {}) {
  const dirs = topLevelDirs(files, directories);
  const paths = new Set(files.map((file) => file.relativePath));
  let root = '';
  if (dirs.includes(language)) root = language;
  else if (profile.name === 'karpathy-llm-wiki' && (paths.has('wiki/index.md') || paths.has('wiki/index.mdx'))) root = 'wiki';

  const excludeDirs = [...new Set([
    ...(!root ? dirs.filter((dir) => /^(sources?|raw)$/i.test(dir)) : []),
    ...directories.filter((dir) => (!root || dir.startsWith(`${root}/`)) && shouldExcludeContentDirFromSearch(dir, directories, files)).map((dir) => searchExcludeDir(dir, root)),
    ...detectedTemplateDirs(templates).map((dir) => searchExcludeDir(dir, root)),
  ])].filter(Boolean);

  return { root, excludeDirs };
}

async function detectRaw({ wikiPath, files, directories, templates, language, writeManaged }) {
  const hasRequestedLanguageRoot = hasLanguageRoot(files, directories, language);
  const templatePaths = new Set(Object.values(templates).map((file) => file.relativePath));
  const rawRoot = detectRawRootFromDirectories(directories, files, language, templatePaths) || detectRawRoot(files, language, hasRequestedLanguageRoot, templatePaths) || detectRawRootFromStrongMarkers(files, language, hasRequestedLanguageRoot, templatePaths) || '.omw/raw';
  const managed = rawRoot.startsWith('.omw/');
  const rawCandidates = detectRawCandidateFiles(files, language, rawRoot, templates, hasRequestedLanguageRoot);
  const noteTypes = detectRawNoteTypes(rawCandidates, language);
  const ingestStates = detectIngestStates(rawCandidates, language);
  const pendingStates = ingestStates.length > 0 ? ingestStates.slice(0, Math.min(2, ingestStates.length)) : defaultPendingStates(language);
  const sensitivityCheck = language === 'ko' ? '완료' : 'completed';
  const placeholder = language === 'ko' ? '- 입력 예정' : '- To be filled';
  const fallbacksApplied = [];
  const types = {};
  for (const key of ['daily_report', 'agent_session', 'discussion']) {
    const existingFolder = detectRawTypeFolderFromDirectories(directories, rawRoot, key) || detectRawTypeFolder(files, rawRoot, key);
    const folder = existingFolder || fallbackTypeFolder(key, language);
    const template = templates[key]?.relativePath || `.omw/templates/${key}.md`;
    if (!templates[key]) fallbacksApplied.push(`template:${key}`);
    if (!existingFolder) fallbacksApplied.push(`folder:${key}`);
    types[key] = {
      label: labelForType(key, language),
      folder,
      agentTemplate: template,
      humanTemplate: template,
      naming: key === 'daily_report'
        ? { memberFolderPattern: '{author}', reportFilePattern: language === 'ko' ? '{author}-{YYYYMMDD}. 일간 리포트.md' : '{author}-{YYYYMMDD}. Daily Report.md' }
        : {},
    };
  }
  if (templates.web_clip) {
    types.web_clip = { label: language === 'ko' ? '웹 클리퍼' : 'Web Clipper', folder: detectRawTypeFolderFromDirectories(directories, rawRoot, 'web_clip') || detectRawTypeFolder(files, rawRoot, 'web_clip') || fallbackTypeFolder('web_clip', language), templateKind: 'obsidian-web-clipper' };
  }
  if (writeManaged) {
    await ensureManagedRaw({ wikiPath, rawRoot, types, templates, language, noteType: noteTypes[0] || defaultRawNoteType(language), ingestState: pendingStates[0], sensitivityCheck });
  }
  return {
    root: rawRoot,
    noteTypes: noteTypes.length > 0 ? noteTypes : [defaultRawNoteType(language)],
    placeholder,
    sensitivityCheck,
    naming: { markdownFile: 'sequence. YYYY-MM-DD HHmm - title.md', dailyReportFile: 'author-YYYYMMDD.md', titleShouldPreferContentOverPlatform: true },
    types,
    ingestStates: ingestStates.length > 0 ? ingestStates : defaultIngestStates(language),
    pendingStates,
    fallbacksApplied: [...new Set(fallbacksApplied.concat(managed ? ['root:.omw/raw'] : []))],
  };
}

function detectRawRoot(files, language, hasRequestedLanguageRoot = false, templatePaths = new Set()) {
  const candidates = new Map();
  for (const file of files) {
    if (templatePaths.has(file.relativePath)) continue;
    if (!hasStrongRawMarker(file.frontmatter)) continue;
    for (let index = 0; index < file.segments.length - 1; index += 1) {
      const prefix = file.segments.slice(0, index + 1).join('/');
      const rawScore = scoreRawSegment(file.segments[index], language);
      const score = rawScore > 0 ? rawScore + (file.segments[0] === language ? 2 : 0) : 0;
      if (!rawRootMatchesLanguage(prefix, language, hasRequestedLanguageRoot)) continue;
      if (score > 0) candidates.set(prefix, (candidates.get(prefix) || 0) + score);
    }
  }
  return [...candidates.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || '';
}

function detectRawRootFromStrongMarkers(files, language, hasRequestedLanguageRoot = false, templatePaths = new Set()) {
  const candidates = new Map();
  for (const file of files) {
    if (templatePaths.has(file.relativePath)) continue;
    if (!hasStrongRawMarker(file.frontmatter)) continue;
    const root = inferRawRootFromMarkedFile(file);
    if (!root || !rawRootMatchesLanguage(root, language, hasRequestedLanguageRoot)) continue;
    const score = (file.segments[0] === language ? 2 : 0) + (file.frontmatter.rawType || file.frontmatter['raw유형'] ? 3 : 1);
    candidates.set(root, (candidates.get(root) || 0) + score);
  }
  return [...candidates.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]?.[0] || '';
}

function inferRawRootFromMarkedFile(file) {
  const dirSegments = file.segments.slice(0, -1);
  if (dirSegments.length === 0) return '';
  const rawType = normalizeComparable(file.frontmatter.rawType || file.frontmatter['raw유형'] || file.frontmatter.reportType || file.frontmatter['보고유형'] || '');
  if (dirSegments.length > 1 && rawType && rawTypeFolderLooksLike(dirSegments.at(-1), rawType)) {
    return dirSegments.slice(0, -1).join('/');
  }
  return dirSegments.join('/');
}

function rawTypeFolderLooksLike(folder, rawType) {
  const normalized = normalizeComparable(rawType);
  if (normalized === 'daily_report' || normalized === 'daily report' || normalized.includes('일간')) return rawTypeMatchesFolder('daily_report', folder);
  if (normalized === 'agent_session' || normalized === 'agent session' || normalized.includes('세션')) return rawTypeMatchesFolder('agent_session', folder);
  if (normalized === 'discussion' || normalized === 'meeting' || normalized.includes('회의') || normalized.includes('논의')) return rawTypeMatchesFolder('discussion', folder);
  if (normalized === 'web_clip' || normalized === 'web clipper' || normalized.includes('클리퍼')) return rawTypeMatchesFolder('web_clip', folder);
  return false;
}

function scoreRawSegment(segment) {
  const text = normalizeComparable(segment);
  let score = 0;
  if (/\braw\b/.test(text) || text.includes('raw')) score += 6;
  if (text.includes('inbox') || text.includes('수집')) score += 3;
  return score;
}

function detectRawRootFromDirectories(directories, files, language, templatePaths = new Set()) {
  const hasRequestedLanguageRoot = hasLanguageRoot(files, directories, language);
  const candidates = directories
    .map((dir) => {
      const rawScore = scoreRawSegment(path.basename(dir));
      return {
        dir,
        score: rawScore > 0 ? rawScore + (dir.split('/')[0] === language ? 2 : 0) : 0,
      };
    })
    .filter((candidate) => candidate.score > 0)
    .filter((candidate) => rawRootMatchesLanguage(candidate.dir, language, hasRequestedLanguageRoot))
    .filter((candidate) => hasRawRootEvidence(candidate.dir, directories, files, templatePaths))
    .sort((a, b) => b.score - a.score || a.dir.length - b.dir.length);
  return candidates[0]?.dir || '';
}

function hasLanguageRoot(files, directories, language) {
  return files.some((file) => file.segments[0] === language) || directories.some((dir) => dir.split('/')[0] === language);
}

function rawRootMatchesLanguage(rawRoot, language, hasRequestedLanguageRoot) {
  if (!hasRequestedLanguageRoot) return true;
  const first = rawRoot.split('/')[0];
  if (first === language) return true;
  return !isLanguageSegment(first);
}

function isLanguageSegment(segment) {
  return /^[a-z]{2}(?:[-_][a-z0-9]+)?$/i.test(String(segment || ''));
}

function hasRawRootEvidence(rawRoot, directories, files, templatePaths = new Set()) {
  const rootDepth = rawRoot.split('/').length;
  const hasTypedChild = directories.some((dir) =>
    dir.startsWith(`${rawRoot}/`) &&
    dir.split('/').length === rootDepth + 1 &&
    ['daily_report', 'agent_session', 'discussion', 'web_clip'].some((key) => rawTypeMatchesFolder(key, path.basename(dir))));
  if (hasTypedChild && isCanonicalRawRootName(path.basename(rawRoot))) return true;
  return files.some((file) =>
    !templatePaths.has(file.relativePath) &&
    file.relativePath.startsWith(`${rawRoot}/`) &&
    hasStrongRawMarker(file.frontmatter));
}

function isCanonicalRawRootName(name) {
  const text = normalizeComparable(name);
  return /(^|\s|\.)raw$/.test(text) || text.includes('수집');
}

function isSearchExcludedContentDir(name) {
  const text = normalizeComparable(stripNumericPrefix(name));
  return text === 'raw' || text === 'source' || text === 'sources' || text.includes('수집');
}

function shouldExcludeContentDirFromSearch(dir, directories, files) {
  const name = normalizeComparable(stripNumericPrefix(path.basename(dir)));
  if (name === 'source' || name === 'sources') return true;
  return isSearchExcludedContentDir(path.basename(dir)) && hasRawRootEvidence(dir, directories, files);
}

function stripNumericPrefix(name) {
  return String(name || '').trim().replace(/^\d+(?:[-.]\d+)*\.\s*/, '');
}

function searchExcludeDir(dir, searchRoot) {
  if (searchRoot && dir.startsWith(`${searchRoot}/`)) return dir.slice(searchRoot.length + 1);
  return dir;
}

function detectedTemplateDirs(templates = {}) {
  return [...new Set(Object.values(templates).map(templateRootDir).filter(Boolean))];
}

function templateRootDir(file) {
  const index = file.segments.findIndex((segment) => /templates?|템플릿/i.test(segment));
  if (index !== -1) return file.segments.slice(0, index + 1).join('/');
  return file.segments.slice(0, -1).join('/');
}

function detectTemplates(files, language) {
  const candidates = {};
  for (const file of files) {
    if (!file.placeholders.has('body') && !file.placeholders.has('title')) continue;
    if (!looksLikeTemplateFile(file)) continue;
    const key = classifyTemplate(file);
    if (!key) continue;
    const current = candidates[key];
    if (!current || scoreTemplate(file, key, language) > scoreTemplate(current, key, language)) candidates[key] = file;
  }
  return candidates;
}

function looksLikeTemplateFile(file) {
  const pathText = file.relativePath.toLowerCase();
  if (/templates?|템플릿/.test(pathText)) return true;
  return hasRawTemplateMarker(file.frontmatter) && Object.values(file.frontmatter).some((value) => /\{\{.+\}\}/.test(String(value)));
}

function classifyTemplate(file) {
  const text = `${file.relativePath}\n${file.title}\n${Object.entries(file.frontmatter).map(([key, value]) => `${key}:${value}`).join('\n')}`.toLowerCase();
  if (file.placeholders.has('reportDate') || file.placeholders.has('author') || text.includes('daily_report') || text.includes('일간')) return 'daily_report';
  if (text.includes('discussion') || text.includes('meeting') || text.includes('회의') || text.includes('논의')) return 'discussion';
  if (text.includes('web clipper') || text.includes('웹 클리퍼')) return 'web_clip';
  if (text.includes('agent') || text.includes('session') || text.includes('에이전트') || text.includes('세션') || file.placeholders.has('workspace') || file.placeholders.has('capturedAt')) return 'agent_session';
  if (file.placeholders.has('rawType')) return 'agent_session';
  return '';
}

function scoreTemplate(file, key, language) {
  let score = 0;
  if (file.segments[0] === language) score += 20;
  if (/templates?|템플릿/i.test(file.relativePath)) score += 5;
  if (file.placeholders.has('body')) score += 3;
  if (file.placeholders.has('title')) score += 2;
  if (key === 'daily_report' && file.placeholders.has('reportDate')) score += 5;
  if (key === 'agent_session' && file.placeholders.has('workspace')) score += 4;
  return score;
}

function detectRawTypeFolder(files, rawRoot, key) {
  const dirs = new Set(files.filter((file) => file.relativePath.startsWith(`${rawRoot}/`)).map((file) => file.segments.slice(0, file.segments.length - 1).join('/')));
  const rootDepth = rawRoot ? rawRoot.split('/').length : 0;
  const matches = [...dirs].filter((dir) => dir.split('/').length === rootDepth + 1 && rawTypeMatchesFolder(key, path.basename(dir)));
  return matches[0] ? path.basename(matches[0]) : '';
}

function detectRawTypeFolderFromDirectories(directories, rawRoot, key) {
  const rootDepth = rawRoot ? rawRoot.split('/').length : 0;
  const matches = directories
    .filter((dir) => dir.startsWith(`${rawRoot}/`) && dir.split('/').length === rootDepth + 1)
    .filter((dir) => rawTypeMatchesFolder(key, path.basename(dir)));
  return matches[0] ? path.basename(matches[0]) : '';
}

function rawTypePattern(key) {
  if (key === 'daily_report') return /daily|report|일간|리포트/;
  if (key === 'agent_session') return /agent|session|에이전트|세션/;
  if (key === 'discussion') return /discussion|meeting|회의|논의/;
  if (key === 'web_clip') return /clip|web|클리퍼/;
  return /$a/;
}

function rawTypeMatchesFolder(key, folder) {
  return rawTypePattern(key).test(normalizeComparable(folder));
}

async function ensureManagedRaw({ wikiPath, rawRoot, types, templates, language, noteType, ingestState, sensitivityCheck }) {
  await mkdir(path.join(wikiPath, rawRoot), { recursive: true });
  for (const type of Object.values(types)) {
    if (type.folder) await mkdir(path.join(wikiPath, rawRoot, type.folder), { recursive: true });
    if (type.agentTemplate?.startsWith('.omw/templates/') && !templates[path.basename(type.agentTemplate, '.md')]) {
      const templatePath = path.join(wikiPath, type.agentTemplate);
      if (!(await pathExists(templatePath))) {
        await mkdir(path.dirname(templatePath), { recursive: true });
        await writeFile(templatePath, fallbackTemplate(path.basename(type.agentTemplate, '.md'), { language, noteType, ingestState, sensitivityCheck }));
      }
    }
  }
}

function fallbackTemplate(type, { language, noteType, ingestState, sensitivityCheck }) {
  if (type === 'daily_report') {
    return [
      '---',
      `type: ${noteType}`,
      'rawType: daily_report',
      'reportType: daily_report',
      'reportDate: {{reportDate}}',
      'author: {{author}}',
      'team: {{team}}',
      `ingestState: ${ingestState}`,
      `sensitivityCheck: {{sensitivityCheck}}`,
      '---',
      '',
      '# {{title}}',
      '',
      language === 'ko' ? '## 오늘 한 일' : '## Work Completed',
      '',
      '{{body}}',
      '',
    ].join('\n');
  }
  return [
    '---',
    `type: ${noteType}`,
    `rawType: ${type}`,
    `ingestState: ${ingestState}`,
    'capturedAt: {{capturedAt}}',
    'platform: {{platform}}',
    'workspace: {{workspace}}',
    'branch: {{branch}}',
    `sensitivityCheck: {{sensitivityCheck}}`,
    '---',
    '',
    '# {{title}}',
    '',
    '{{body}}',
    '',
  ].join('\n');
}

function detectDaily(template, language) {
  const sections = template
    ? template.headings
      .filter((heading) => !heading.includes('{{') && !/ingest|review|검토/i.test(heading))
      .map((heading) => ({ key: dailyKey(heading), heading: heading.startsWith('## ') ? heading : `## ${heading}`, aliases: [heading] }))
    : [];
  return {
    titlePattern: language === 'ko' ? '{reportDate} {author} 일간 리포트' : '{reportDate} {author} Daily Report',
    placeholder: language === 'ko' ? '- 입력 예정' : '- To be filled',
    sensitivityCheck: language === 'ko' ? '완료' : 'completed',
    channel: { manual: 'manual', automated: 'llm-tool' },
    sections: sections.length > 0 ? sections : defaultDailySections(language),
    placeholders: language === 'ko' ? ['- 입력 예정', '- 없음', '입력 예정', '없음'] : ['- To be filled', '- None', 'To be filled', 'None'],
  };
}

function detectRules(files, language, profile) {
  const rules = {};
  const ruleFiles = files.filter((file) => isRuleCandidateFile(file, language));
  const add = (key, file) => {
    if (file && !rules[key]) rules[key] = { label: file.title, path: file.relativePath };
  };
  add('agentKnowledge', findRule(ruleFiles, /agent|codex|claude|에이전트/i, language));
  add('noteWriting', findRule(ruleFiles, /note writing|writing rules|노트 작성|작성 규칙/i, language));
  add('wikiOperation', findRule(ruleFiles, /wiki operating|operation|procedure|운영|절차/i, language));
  add('rawOperation', findRule(ruleFiles, /raw|capture|ingest|수집|원시/i, language));
  add('knowledgeMap', findRule(ruleFiles, /knowledge map|index|map|지식 지도|지도/i, language));
  add('searchProperties', findRule(ruleFiles, /property|catalog|schema|frontmatter|카탈로그|속성/i, language));
  add('aiPlatform', findRule(ruleFiles, /ai tool|ai platform|tool integration|ai 도구|ai 플랫폼|도구 연동/i, language));
  add('areaCatalog', findRule(ruleFiles, /area catalog|knowledge area|영역 카탈로그|지식 영역/i, language));
  if (profile.name === 'karpathy-llm-wiki') {
    const agentKnowledge = files.find((file) => /(^|\/)(AGENTS|CLAUDE)\.mdx?$/i.test(file.relativePath));
    const knowledgeMap = files.find((file) => /(^|\/)wiki\/index\.mdx?$/i.test(file.relativePath)) || files.find((file) => /(^|\/)index\.mdx?$/i.test(file.relativePath));
    const wikiOperation = files.find((file) => /(^|\/)(README|log)\.mdx?$/i.test(file.relativePath));
    if (agentKnowledge) rules.agentKnowledge = { label: agentKnowledge.title, path: agentKnowledge.relativePath };
    if (knowledgeMap) rules.knowledgeMap = { label: knowledgeMap.title, path: knowledgeMap.relativePath };
    if (wikiOperation) rules.wikiOperation = { label: wikiOperation.title, path: wikiOperation.relativePath };
  }
  return rules;
}

function isRuleCandidateFile(file, language) {
  if (/(^|\/)(AGENTS|CLAUDE)\.mdx?$/i.test(file.relativePath)) return true;
  const scoped = file.segments[0] === language;
  const pathText = file.relativePath.toLowerCase();
  if (scoped && /resources|guides|rules|catalogs|maps|가이드|규칙|카탈로그|지도/.test(pathText)) return true;
  return /(^|\/)(rules?|guides?|resources?|catalogs?|maps?|가이드|규칙|카탈로그|지도)(\/|$)/i.test(file.relativePath);
}

function findRule(files, pattern, language) {
  return files
    .map((file) => ({ file, score: scoreRule(file, pattern, language) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.file.relativePath.localeCompare(b.file.relativePath))[0]?.file;
}

function scoreRule(file, pattern, language) {
  let score = 0;
  if (file.segments[0] === language) score += 20;
  if (/resources|guides|rules|가이드|규칙/i.test(file.relativePath)) score += 4;
  if (pattern.test(file.relativePath)) score += 10;
  if (pattern.test(file.title)) score += 10;
  if (pattern.test(file.text.slice(0, 1000))) score += 1;
  return score;
}

function detectFrontmatter(files) {
  const keys = new Set(files.flatMap((file) => Object.keys(file.frontmatter)));
  return {
    typeKeys: filterKeys(keys, [/^type$/i, /^유형$/]),
    rawTypeKeys: filterKeys(keys, [/^rawType$/i, /^raw유형$/]),
    stateKeys: filterKeys(keys, [/^ingestState$/i, /^ingest상태$/, /^status$/i, /^상태$/]),
    targetKeys: filterKeys(keys, [/^ingestTarget$/i, /^ingest대상$/, /^target$/i]),
    sensitivityKeys: filterKeys(keys, [/sensitivity/i, /민감/]),
  };
}

function filterKeys(keys, patterns) {
  const matched = [...keys].filter((key) => patterns.some((pattern) => pattern.test(key)));
  return matched.length > 0 ? matched : patterns[0].source.includes('type') ? ['type'] : [];
}

function detectRawCandidateFiles(files, language, rawRoot, templates, hasRequestedLanguageRoot = false) {
  const templatePaths = new Set(Object.values(templates).map((file) => file.relativePath));
  const managedFallback = rawRoot.startsWith('.omw/');
  const rawRootCandidates = files.filter((file) => file.relativePath.startsWith(`${rawRoot}/`));
  if (rawRootCandidates.length > 0) return rawRootCandidates;
  const candidates = files.filter((file) =>
    templatePaths.has(file.relativePath) ||
    (!managedFallback && hasStrongRawMarker(file.frontmatter)));
  const templateCandidates = candidates.filter((file) => templatePaths.has(file.relativePath));
  if (templateCandidates.length > 0) return templateCandidates;
  const scoped = candidates.filter((file) => file.segments[0] === language);
  if (scoped.length > 0) return scoped;
  return hasRequestedLanguageRoot ? [] : candidates;
}

function hasStrongRawMarker(frontmatter = {}) {
  return [
    frontmatter.rawType ||
    frontmatter['raw유형'] ||
    frontmatter.reportType ||
    frontmatter['보고유형'],
  ].some(isConcreteValue);
}

function hasRawTemplateMarker(frontmatter = {}) {
  return Boolean(
    frontmatter.rawType ||
    frontmatter['raw유형'] ||
    frontmatter.reportType ||
    frontmatter['보고유형'],
  );
}

function detectRawNoteTypes(files, language) {
  const scoped = files.filter((file) => file.segments[0] === language);
  const source = scoped.some((file) => file.frontmatter.type || file.frontmatter['유형']) ? scoped : files;
  return [...new Set(source.map((file) => file.frontmatter.type || file.frontmatter['유형']).filter(isConcreteValue))];
}

function detectIngestStates(files, language) {
  const scoped = files.filter((file) => file.segments[0] === language);
  const source = scoped.some((file) => file.frontmatter.ingestState || file.frontmatter['ingest상태'] || file.frontmatter.status || file.frontmatter['상태']) ? scoped : files;
  const explicit = [...new Set(source.map((file) => file.frontmatter.ingestState || file.frontmatter['ingest상태']).filter(isConcreteValue))];
  if (explicit.length > 0) return orderIngestStates(explicit);
  return orderIngestStates([...new Set(source.map((file) => file.frontmatter.status || file.frontmatter['상태']).filter(isConcreteValue))]);
}

function isConcreteValue(value) {
  return Boolean(value && !/^\s*\{\{.+\}\}\s*$/.test(String(value)));
}

function orderIngestStates(states) {
  const preferred = ['captured', 'new', 'reviewing', '수집됨', '신규', '검토중', '검토 중'];
  return [...states].sort((a, b) => stateRank(a, preferred) - stateRank(b, preferred));
}

function stateRank(state, preferred) {
  const index = preferred.findIndex((candidate) => candidate.toLowerCase() === String(state).toLowerCase());
  return index === -1 ? preferred.length : index;
}

function detectCandidateTargets(files, searchRoot) {
  const dirs = new Set();
  for (const file of files) {
    if (searchRoot && !file.relativePath.startsWith(`${searchRoot}/`)) continue;
    const dir = file.segments.slice(0, Math.min(file.segments.length - 1, searchRoot ? 2 : 1)).join('/');
    if (dir && !/templates?|raw|sources?/i.test(dir)) dirs.add(dir);
  }
  return [...dirs].slice(0, 12);
}

function evaluateCapabilities({ files, raw, rules, daily, templates, search }) {
  const searchReady = files.length > 0;
  const captureReady = Boolean(raw.root && raw.types.agent_session?.agentTemplate);
  const dailyReady = Boolean(raw.types.daily_report?.agentTemplate && daily.sections?.length);
  const queueReady = Boolean(raw.root && raw.noteTypes?.length && raw.pendingStates?.length);
  return {
    search: { ready: searchReady, mode: search.root ? 'scoped' : 'root', issues: searchReady ? [] : ['No Markdown files were detected'] },
    capture: { ready: captureReady, mode: templates.agent_session ? 'detected' : 'generated-fallback', issues: captureReady ? [] : ['agent_session template was not detected'] },
    queue: { ready: queueReady, mode: 'frontmatter', issues: queueReady ? [] : ['Raw note type or pending state was not detected'] },
    ingest: { ready: queueReady, mode: Object.keys(rules).length > 0 ? 'rules-backed' : 'minimal', issues: queueReady ? [] : ['Raw queue is not ready'] },
    daily: { ready: dailyReady, mode: templates.daily_report ? 'detected' : 'generated-fallback', issues: dailyReady ? [] : ['daily_report template was not detected'] },
    rules: { ready: Object.keys(rules).length > 0, mode: Object.keys(rules).length > 0 ? 'detected' : 'missing', issues: Object.keys(rules).length > 0 ? [] : ['No operating rule documents were detected'] },
    templates: { ready: captureReady, mode: Object.keys(templates).length > 0 ? 'detected' : 'generated-fallback', issues: [] },
  };
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (item) data[item[1].trim()] = item[2].trim();
  }
  return data;
}

function topLevelDirs(files, directories = []) {
  const dirs = new Set();
  for (const dir of directories) {
    const segment = dir.split('/')[0];
    if (segment) dirs.add(segment);
  }
  for (const file of files) {
    if (file.segments.length > 1 && file.segments[0]) dirs.add(file.segments[0]);
  }
  return [...dirs];
}

function directoriesMatching(files, pattern) {
  const dirs = new Set();
  for (const file of files) {
    for (let index = 0; index < file.segments.length - 1; index += 1) {
      const dir = file.segments.slice(0, index + 1).join('/');
      if (pattern.test(file.segments[index])) dirs.add(dir);
    }
  }
  return [...dirs];
}

function dailyKey(heading) {
  const text = String(heading || '').toLowerCase();
  if (text.includes('progress') || text.includes('ongoing') || text.includes('진행')) return 'inProgress';
  if (text.includes('block') || text.includes('지원') || text.includes('막힌')) return 'blockers';
  if (text.includes('decision') || text.includes('결정')) return 'decisions';
  if (text.includes('knowledge') || text.includes('지식')) return 'knowledge';
  if (text.includes('tomorrow') || text.includes('next') || text.includes('내일')) return 'tomorrow';
  return 'work';
}

function defaultDailySections(language) {
  if (language === 'ko') {
    return [
      { key: 'work', heading: '## 오늘 한 일', aliases: ['오늘 한 일'] },
      { key: 'inProgress', heading: '## 진행 중', aliases: ['진행 중'] },
      { key: 'blockers', heading: '## 막힌 점 / 지원 필요', aliases: ['막힌 점', '지원 필요'] },
      { key: 'decisions', heading: '## 결정 후보', aliases: ['결정 후보'] },
      { key: 'knowledge', heading: '## 지식 후보', aliases: ['지식 후보'] },
      { key: 'tomorrow', heading: '## 내일 계획', aliases: ['내일 계획'] },
    ];
  }
  return [
    { key: 'work', heading: '## Work Completed', aliases: ['Work Completed', 'Today'] },
    { key: 'inProgress', heading: '## In Progress', aliases: ['In Progress', 'Ongoing Work'] },
    { key: 'blockers', heading: '## Blockers / Support Needed', aliases: ['Blockers', 'Support Needed'] },
    { key: 'decisions', heading: '## Decision Candidates', aliases: ['Decision Candidates'] },
    { key: 'knowledge', heading: '## Knowledge Candidates', aliases: ['Knowledge Candidates'] },
    { key: 'tomorrow', heading: '## Tomorrow Plan', aliases: ['Tomorrow Plan', 'Next Plan'] },
  ];
}

function fallbackTypeFolder(key, language) {
  if (key === 'daily_report') return language === 'ko' ? 'daily_reports' : 'daily_reports';
  if (key === 'agent_session') return 'agent_sessions';
  if (key === 'discussion') return 'discussions';
  if (key === 'web_clip') return 'web_clips';
  return key;
}

function labelForType(key, language) {
  const labels = {
    ko: { daily_report: '일간 리포트', agent_session: '에이전트 세션', discussion: '회의 및 논의' },
    en: { daily_report: 'Daily Reports', agent_session: 'Agent Sessions', discussion: 'Discussions' },
  };
  return labels[language]?.[key] || labels.en[key] || key;
}

function defaultRawNoteType(language) {
  return language === 'ko' ? 'Raw수집' : 'Raw';
}

function defaultPendingStates(language) {
  return language === 'ko' ? ['수집됨', '검토중'] : ['captured', 'reviewing'];
}

function defaultIngestStates(language) {
  return language === 'ko' ? ['수집됨', '검토중', '승격완료', '보류', '폐기', '보관완료'] : ['captured', 'reviewing', 'promoted', 'held', 'discarded', 'archived'];
}

function normalizeLanguage(value) {
  return String(value || DEFAULT_WIKI_LANGUAGE).trim().toLowerCase();
}

function normalizePath(value) {
  return String(value || '').split(path.sep).join('/').normalize('NFC');
}

function normalizeComparable(value) {
  return String(value || '').normalize('NFC').trim().toLowerCase();
}
