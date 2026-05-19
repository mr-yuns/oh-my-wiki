import { buildWikiStatus, normalizeWikiLanguage, refreshWikiContract } from '../wiki/contract.mjs';
import { captureRawNote } from '../wiki/capture.mjs';
import { ensureWikiSearchIndex, searchWiki } from '../wiki/search.mjs';
import { createIngestPreview, listRawQueue } from '../wiki/ingest.mjs';
import { createDailyReport } from '../wiki/daily.mjs';
import { createDailyReportSummary, createRawIngestReport, validateWiki } from '../wiki/reports.mjs';

export async function runWikiCommand({ subcommand, config, options = {}, stdinText = '' }) {
  const command = subcommand || 'status';
  if (command === 'status') {
    return wikiStatus({ config, options });
  }
  if (command === 'init') {
    return wikiInit({ config, options });
  }
  if (command === 'capture') {
    return wikiCapture({ config, options, stdinText });
  }
  if (command === 'search') {
    return wikiSearch({ config, options });
  }
  if (command === 'queue') {
    return wikiQueue({ config, options });
  }
  if (command === 'ingest') {
    return wikiIngest({ config, options });
  }
  if (command === 'daily') {
    return wikiDaily({ config, options, stdinText });
  }
  if (command === 'report-raw-ingest') {
    return wikiReportRawIngest({ config, options });
  }
  if (command === 'report-daily') {
    return wikiReportDaily({ config, options });
  }
  if (command === 'validate') {
    return wikiValidate({ config, options });
  }
  if (command === 'contract') {
    return wikiContract({ config, options });
  }
  if (command === 'refresh') {
    return wikiRefresh({ config, options });
  }
  throw new Error(`Unknown wiki command: ${command}`);
}

async function wikiInit({ config, options }) {
  const { initializeWiki } = await import('./init.mjs');
  const result = await initializeWiki({ config, options });
  if (options.json) {
    return { exitCode: result.ok ? 0 : 1, output: `${JSON.stringify(result, null, 2)}\n` };
  }
  const lines = [
    'OMW Wiki init',
    `- wiki: ${result.wikiPath}`,
    `- language: ${result.language}`,
    `- created wiki directory: ${result.createdWiki ? 'yes' : 'no'}`,
    `- copied base wiki: ${result.copiedBaseWiki ? 'yes' : 'no'}`,
    `- contract: ${result.contractPath}`,
  ];
  if (result.contractCreated) lines.push('- contract created: yes');
  if (result.contractUpdated) lines.push('- contract updated: yes');
  if (result.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of result.issues) lines.push(`- ${issue}`);
  } else {
    lines.push('', 'OMW wiki is initialized.');
  }
  return { exitCode: result.ok ? 0 : 1, output: `${lines.join('\n')}\n` };
}

async function wikiReportRawIngest({ config, options }) {
  const result = await createRawIngestReport({ config, options });
  return { exitCode: result.ok ? 0 : 1, output: result.output };
}

async function wikiReportDaily({ config, options }) {
  const result = await createDailyReportSummary({ config, options });
  return { exitCode: result.ok ? 0 : 1, output: result.output };
}

async function wikiValidate({ config, options }) {
  const result = await validateWiki({ config, options });
  if (options.json) {
    return { exitCode: result.ok ? 0 : 1, output: `${JSON.stringify(result, null, 2)}\n` };
  }
  if (result.ok) {
    const label = result.mode === 'base-wiki' ? 'base wiki' : 'wiki contract';
    return { exitCode: 0, output: `OK: ${label} validation passed\n` };
  }
  const label = result.mode === 'base-wiki' ? 'base wiki' : 'wiki contract';
  return { exitCode: 1, output: `${label} validation failed:\n- ${result.failures.join('\n- ')}\n` };
}

async function wikiRefresh({ config, options }) {
  const target = options.target || options.mode || options._?.[0] || 'all';
  if (!['all', 'contract', 'index'].includes(target)) {
    throw new Error('Usage: omw wiki refresh [--target all|contract|index] [--dry-run] [--json]');
  }
  const dryRun = Boolean(options['dry-run']);

  const refreshed = {
    contract: false,
    index: false,
  };
  const issues = [];
  let contractResult = null;
  let indexResult = null;

  if (target === 'all' || target === 'contract') {
    contractResult = await refreshWikiContract(config?.wikiPath || '', { language: resolveCommandLanguage(config, options), dryRun });
    refreshed.contract = Boolean(contractResult.refreshed);
    issues.push(...(contractResult.issues || []));
  }

  if (target === 'all' || target === 'index') {
    indexResult = dryRun ? { ok: true, dryRun: true, refreshed: false, indexPath: null, issues: [] } : await ensureWikiSearchIndex({ config });
    refreshed.index = Boolean(indexResult.ok && !dryRun);
    issues.push(...(indexResult.issues || []));
  }

  const status = await buildWikiStatus(config);
  issues.push(...(status.issues || []));
  const ok = dryRun
    ? [contractResult, indexResult].filter(Boolean).every((item) => item.ok)
    : issues.length === 0;
  const result = {
    ok,
    target,
    dryRun,
    refreshed,
    contract: contractResult,
    index: indexResult,
    status,
    issues: [...new Set(issues)],
  };

  if (options.json) {
    return { exitCode: result.ok ? 0 : 1, output: `${JSON.stringify(result, null, 2)}\n` };
  }

  const lines = ['OMW Wiki refresh', `- target: ${target}`];
  if (dryRun) lines.push('- dry run: yes');
  lines.push(`- contract: ${refreshed.contract ? 'refreshed' : 'skipped'}`);
  if (contractResult?.dryRun) lines.push(`- contract changes: ${contractResult.changes.length}`);
  lines.push(`- index: ${refreshed.index && !dryRun ? `refreshed (${indexResult.indexPath})` : 'skipped'}`);
  if (result.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of result.issues) lines.push(`- ${issue}`);
  }
  return { exitCode: result.ok ? 0 : 1, output: `${lines.join('\n')}\n` };
}

async function wikiContract({ config, options }) {
  let refreshResult = null;
  if (options.refresh) {
    refreshResult = await refreshWikiContract(config?.wikiPath || '', { language: resolveCommandLanguage(config, options), dryRun: Boolean(options['dry-run']) });
    if (!refreshResult.ok) {
      const output = options.json ? `${JSON.stringify(refreshResult, null, 2)}\n` : `Wiki contract refresh failed:\n- ${refreshResult.issues.join('\n- ')}\n`;
      return { exitCode: 1, output };
    }
  }
  const status = await buildWikiStatus(config);
  const ok = refreshResult?.dryRun ? refreshResult.ok : status.ok;
  if (options.validate) {
    const validation = status.contractValidation || { ok: false, issues: ['wiki contract is not loaded'] };
    const result = {
      ok: status.contractExists && validation.ok,
      path: status.contractPath,
      schemaVersion: status.contract?.schemaVersion || null,
      validation,
      issues: validation.issues,
    };
    if (options.json) {
      return { exitCode: result.ok ? 0 : 1, output: `${JSON.stringify(result, null, 2)}\n` };
    }
    if (result.ok) return { exitCode: 0, output: `OK: wiki contract validation passed\n` };
    return { exitCode: 1, output: `wiki contract validation failed:\n- ${result.issues.join('\n- ')}\n` };
  }
  if (options.explain) {
    const explanation = explainWikiContract(status);
    if (options.json) {
      return { exitCode: status.ok ? 0 : 1, output: `${JSON.stringify(explanation, null, 2)}\n` };
    }
    return { exitCode: status.ok ? 0 : 1, output: `${renderContractExplanation(explanation)}\n` };
  }
  if (options.json) {
    return { exitCode: ok ? 0 : 1, output: `${JSON.stringify({ ...status, ok, refreshed: Boolean(refreshResult?.refreshed), refresh: refreshResult }, null, 2)}\n` };
  }
  const lines = ['OMW Wiki contract'];
  if (refreshResult?.refreshed) lines.push('- refreshed: yes');
  if (refreshResult?.dryRun) {
    lines.push('- dry run: yes');
    lines.push(`- changes: ${refreshResult.changes.length}`);
  }
  lines.push(`- path: ${status.contractExists ? status.contractPath : '(missing)'}`);
  lines.push(`- valid: ${status.ok ? 'yes' : 'no'}`);
  lines.push(`- rules: ${status.rules?.length || 0}`);
  lines.push(`- raw types: ${status.raw.types.length}`);
  if (status.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of status.issues) lines.push(`- ${issue}`);
  }
  return { exitCode: ok ? 0 : 1, output: `${lines.join('\n')}\n` };
}

function explainWikiContract(status) {
  const contract = status.contract || {};
  return {
    ok: status.ok,
    path: status.contractPath,
    schemaVersion: contract.schemaVersion || null,
    language: status.language,
    profile: contract.source?.profile || 'unknown',
    search: {
      root: status.search.root || '.',
      excludes: status.search.excludeDirs || [],
      backend: 'auto',
    },
    raw: {
      root: status.raw.root || '',
      ambiguities: contract.raw?.ambiguities || [],
      types: status.raw.types.map((type) => ({
        key: type.key,
        folder: type.folder,
        template: type.template,
      })),
    },
    ingest: {
      pendingStates: contract.ingest?.pendingStates || contract.raw?.ingestStates || [],
      approvalRequiredForPromotedNotes: contract.ingest?.approvalRequiredForPromotedNotes !== false,
    },
    understanding: contract.understanding || {
      score: 0,
      complete: false,
      missingDimensions: [],
      handoff: { recommended: true, workflow: 'wiki-deep-interview', prompt: 'Refresh the wiki contract before write-oriented wiki workflows.' },
    },
    capabilities: contract.capabilities || {},
    issues: status.issues || [],
  };
}

function renderContractExplanation(explanation) {
  const lines = [
    'OMW Wiki contract explanation',
    `- path: ${explanation.path || '(missing)'}`,
    `- schema version: ${explanation.schemaVersion || '(unknown)'}`,
    `- language: ${explanation.language}`,
    `- profile: ${explanation.profile}`,
    `- search root: ${explanation.search.root}`,
    `- search excludes: ${explanation.search.excludes.join(', ') || '(none)'}`,
    `- raw root: ${explanation.raw.root || '(missing)'}`,
  ];
  if (explanation.raw.ambiguities?.length > 0) {
    lines.push('- raw ambiguities:');
    for (const item of explanation.raw.ambiguities) {
      const score = Number.isInteger(item.score) ? ` score=${item.score}` : '';
      lines.push(`  - ${item.root}${score}`);
    }
  }
  lines.push('- raw types:');
  for (const type of explanation.raw.types) {
    lines.push(`  - ${type.key}: ${type.folder || '(missing)'} via ${type.template || '(missing template)'}`);
  }
  lines.push(`- ingest pending states: ${explanation.ingest.pendingStates.join(', ') || '(none)'}`);
  lines.push(`- promoted-note approval: ${explanation.ingest.approvalRequiredForPromotedNotes ? 'required' : 'not required'}`);
  lines.push(`- understanding: ${explanation.understanding.score}%${explanation.understanding.complete ? ' complete' : ' incomplete'}`);
  if (explanation.understanding.handoff?.recommended) {
    const handoff = explanation.understanding.handoff;
    lines.push(`- handoff: ${handoff.workflow || 'wiki-deep-interview'}`);
    if (handoff.prompt) lines.push(`- handoff prompt: ${handoff.prompt}`);
    const missingDimensions = explanation.understanding.missingDimensions || [];
    if (missingDimensions.length > 0) {
      lines.push('- missing dimensions:');
      for (const item of missingDimensions) {
        const label = item.label ? ` (${item.label})` : '';
        const reason = item.reason ? `: ${item.reason}` : '';
        lines.push(`  - ${item.key}${label}${reason}`);
        if (item.question) lines.push(`    question: ${item.question}`);
      }
    }
  }
  if (explanation.issues.length > 0) {
    lines.push('', 'Issues:');
    for (const issue of explanation.issues) lines.push(`- ${issue}`);
  }
  return lines.join('\n');
}

function renderUnderstandingNotice(notice) {
  if (!notice?.requiresClarification) return [];
  const lines = [
    '',
    'Contract understanding:',
    `- score: ${notice.score}%`,
    `- handoff: ${notice.workflow}`,
  ];
  if (notice.prompt) lines.push(`- prompt: ${notice.prompt}`);
  return lines;
}

async function wikiDaily({ config, options, stdinText }) {
  const result = await createDailyReport({
    config,
    author: options.author,
    team: options.team,
    date: options.date,
    body: stdinText || options.body || '',
    options: {
      dryRun: Boolean(options['dry-run']),
      platform: options.platform || 'manual',
    },
  });
  if (options.json || options['dry-run']) return { exitCode: 0, output: `${JSON.stringify(result, null, 2)}\n` };
  const verb = result.action === 'updated' ? 'Updated' : result.action === 'unchanged' ? 'Unchanged' : 'Created';
  const lines = [`${verb} daily report Raw: ${result.relativePath}`, ...renderUnderstandingNotice(result.contractUnderstanding)];
  return { exitCode: 0, output: `${lines.join('\n')}\n` };
}

async function wikiQueue({ config, options }) {
  const result = await listRawQueue({ config });
  if (options.json) {
    return { exitCode: 0, output: `${JSON.stringify(result, null, 2)}\n` };
  }
  const lines = ['Wiki Raw queue', `- total: ${result.total}`];
  for (const item of result.items) lines.push(`- ${item.relativePath} [${item.state}]`);
  return { exitCode: 0, output: `${lines.join('\n')}\n` };
}

async function wikiIngest({ config, options }) {
  const rawRef = options._?.[0] || options.raw || '';
  const result = await createIngestPreview({
    config,
    rawRef,
    options: {
      writeDraft: Boolean(options['write-draft']),
      overwriteDraft: Boolean(options['overwrite-draft']),
      promote: Boolean(options.promote),
      target: options.target,
      overwritePromote: Boolean(options['overwrite-promote']),
    },
  });
  if (options.json) return { exitCode: 0, output: `${JSON.stringify(result, null, 2)}\n` };
  const lines = [
    'Wiki ingest preview',
    `- raw: ${result.rawRelativePath}`,
    `- title: ${result.title}`,
    `- write performed: ${result.writePerformed ? 'yes' : 'no'}`,
    ...(result.relativePath ? [`- draft: ${result.relativePath}`] : []),
    ...(result.promotion?.relativePath ? [`- promoted: ${result.promotion.relativePath}`] : []),
    ...(result.promotion?.template ? [`- promotion template: ${result.promotion.template}`] : []),
    `- next: ${result.review.instruction}`,
  ];
  if (result.rules?.length > 0) {
    lines.push('', 'Rule notes:');
    for (const rule of result.rules) lines.push(`- ${rule.path}`);
  }
  if (result.excerpt) {
    lines.push('', 'Raw excerpt:', result.excerpt);
  }
  lines.push(...renderUnderstandingNotice(result.contractUnderstanding));
  return { exitCode: 0, output: `${lines.join('\n')}\n` };
}

async function wikiSearch({ config, options }) {
  const query = options._?.join(' ') || options.query || '';
  const result = await searchWiki({
    config,
    query,
    limit: Number.parseInt(options.limit || '20', 10),
    backend: options.backend || 'auto',
    filters: {
      type: options.type,
      status: options.status,
      path: options.path,
    },
    sort: options.sort || 'relevance',
  });
  if (options.json) {
    return {
      exitCode: 0,
      output: `${JSON.stringify(result, null, 2)}\n`,
    };
  }
  const activeFilters = Object.entries(result.filters || {}).filter(([, value]) => value);
  const lines = [
    `Wiki search: ${result.query}`,
    `- backend: ${result.backend}`,
    `- total: ${result.total}`,
    ...(result.unfilteredTotal !== result.total ? [`- ${result.unfilteredTotalExact === false ? 'unfiltered candidates' : 'unfiltered total'}: ${result.unfilteredTotal}`] : []),
    ...(activeFilters.length > 0 ? [`- filters: ${activeFilters.map(([key, value]) => `${key}=${value}`).join(', ')}`] : []),
    ...(result.sort && result.sort !== 'relevance' ? [`- sort: ${result.sort}`] : []),
    ...(result.fallbackReason ? [`- fallback: ${result.fallbackReason}`] : []),
  ];
  for (const item of result.results) {
    lines.push(`- ${item.relativePath}${item.title ? ` - ${item.title}` : ''}`);
    if (item.excerpt) lines.push(`  ${item.excerpt}`);
  }
  return {
    exitCode: 0,
    output: `${lines.join('\n')}\n`,
  };
}

async function wikiStatus({ config, options }) {
  const status = await buildWikiStatus(config);
  if (options.json) {
    return {
      exitCode: status.ok ? 0 : 1,
      output: `${JSON.stringify(status, null, 2)}\n`,
    };
  }
  const lines = [];
  lines.push('OMW Wiki status');
  lines.push(`- configured: ${status.configured ? 'yes' : 'no'}`);
  lines.push(`- path: ${status.wikiPath || '(not configured)'}`);
  lines.push(`- contract: ${status.contractExists ? status.contractPath : '(missing)'}`);
  lines.push(`- raw root: ${status.raw.rootPath || '(unknown)'}${status.raw.rootExists ? ' (exists)' : ''}`);
  if (status.raw.types.length > 0) {
    lines.push('- raw types:');
    for (const type of status.raw.types) {
      lines.push(`  - ${type.key}: ${type.folderPath || type.folder}${type.exists ? ' (exists)' : ' (missing)'}`);
    }
  }
  if (status.rules?.length > 0) {
    lines.push('- rule notes:');
    for (const rule of status.rules) {
      lines.push(`  - ${rule.key}: ${rule.path}${rule.exists ? ' (exists)' : ' (missing)'}`);
    }
  }
  if (status.issues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of status.issues) lines.push(`- ${issue}`);
  }
  return {
    exitCode: status.ok ? 0 : 1,
    output: `${lines.join('\n')}\n`,
  };
}

async function wikiCapture({ config, options, stdinText }) {
  const result = await captureRawNote({
    config,
    type: options.type || 'agent_session',
    title: options.title,
    body: stdinText || options.body || '',
    options: {
      dryRun: Boolean(options['dry-run']),
      includeContent: Boolean(options['include-content']),
      platform: options.platform || 'manual',
      workspace: options.workspace || '',
      branch: options.branch || '',
      capturedAt: options['captured-at'],
    },
  });
  if (options.json || options['dry-run']) {
    return {
      exitCode: 0,
      output: `${JSON.stringify(result, null, 2)}\n`,
    };
  }
  const lines = [`Captured Raw note: ${result.path}`, ...renderUnderstandingNotice(result.contractUnderstanding)];
  return {
    exitCode: 0,
    output: `${lines.join('\n')}\n`,
  };
}

function resolveCommandLanguage(config, options = {}) {
  return normalizeWikiLanguage(options.language || options.lang || config?.wikiLanguage || 'en');
}
