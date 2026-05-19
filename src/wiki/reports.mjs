import {
  createDailyReportSummary as createBaseDailyReportSummary,
  createRawIngestReport as createBaseRawIngestReport,
  validateWiki as validateBaseWiki,
} from '../../.wiki/scripts/_wiki-tools.mjs';
import { buildWikiStatus } from './contract.mjs';

export async function createRawIngestReport({ config, options = {} }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error('Wiki is not configured. Run omw setup first.');
  return {
    ok: true,
    output: createBaseRawIngestReport({
      root: status.wikiPath,
      language: resolveLanguage(status, options),
    }),
  };
}

export async function createDailyReportSummary({ config, options = {} }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error('Wiki is not configured. Run omw setup first.');
  return {
    ok: true,
    output: createBaseDailyReportSummary({
      root: status.wikiPath,
      language: resolveLanguage(status, options),
      date: options.date,
      team: options.team,
      author: options.author,
    }),
  };
}

export async function validateWiki({ config }) {
  const status = await buildWikiStatus(config);
  if (!status.configured) throw new Error('Wiki is not configured. Run omw setup first.');
  const root = status.wikiPath;
  const result = validateBaseWiki({ root });
  return {
    ...result,
    root,
  };
}

function resolveLanguage(status, options) {
  return options.language || options.lang || status.language || status.contract?.language || 'en';
}
