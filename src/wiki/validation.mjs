export function assertRawNoteSafety(note, context = 'Raw note') {
  const text = String(note || '');
  const issues = [];
  const frontmatter = parseFrontmatter(text);
  const hasRawType = Boolean(frontmatter.type || frontmatter['유형']);
  const hasRawMarker = Boolean(frontmatter.rawType || frontmatter['raw유형'] || frontmatter.ingestState || frontmatter['ingest상태'] || frontmatter.reportType || frontmatter['리포트유형']);
  const sensitivityCheck = frontmatter.sensitivityCheck || valueForKey(frontmatter, (key) => /sensitivity/i.test(key) || key.includes('민감')) || '';
  const hasSensitivityCheck = String(sensitivityCheck).trim() !== '';
  if (!hasRawType || !hasRawMarker) issues.push('missing Raw frontmatter metadata');
  if (!hasSensitivityCheck) issues.push('missing completed sensitivity check');
  if (/session[_ -]?id\s*[:=]\s*(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/i.test(text)) {
    issues.push('session id must not be stored');
  }
  if (/session[_ -]?id\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/i.test(text)) {
    issues.push('session id must not be stored');
  }
  if (/세션\s*ID\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/i.test(text)) {
    issues.push('session id must not be stored');
  }
  if (/\/Users\/[^\s)'"`]+|\/private\/[^\s)'"`]+/.test(text)) issues.push('local filesystem paths must be redacted');
  if (issues.length > 0) {
    throw new Error(`${context} breaks wiki operating rules: ${issues.join('; ')}`);
  }
}

function valueForKey(data, predicate) {
  return Object.entries(data).find(([key]) => predicate(key))?.[1];
}

function parseFrontmatter(text) {
  const match = String(text || '').match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([^:#][^:]*):\s*(.*)$/);
    if (item) data[item[1].trim()] = item[2].trim();
  }
  return data;
}
