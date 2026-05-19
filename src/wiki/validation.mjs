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
  issues.push(...storedSecretIssues(text));
  if (issues.length > 0) {
    throw new Error(`${context} breaks wiki operating rules: ${issues.join('; ')}`);
  }
}

export function storedSecretIssues(note) {
  const text = String(note || '');
  const issues = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) issues.push('private keys must not be stored');
  if (/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(text)) issues.push('GitHub tokens must not be stored');
  if (/\bsk-ant-[A-Za-z0-9_-]{20,}\b/.test(text)) issues.push('Anthropic API keys must not be stored');
  if (/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/.test(text)) issues.push('OpenAI API keys must not be stored');
  if (/\bnpm_[A-Za-z0-9]{20,}\b/.test(text)) issues.push('npm tokens must not be stored');
  if (/\bxox[abprs]-[A-Za-z0-9-]{10,}\b|\bxapp-\d-[A-Za-z0-9-]{10,}\b/.test(text)) issues.push('Slack tokens must not be stored');
  if (/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+_-]+/.test(text)) issues.push('Slack webhooks must not be stored');
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) issues.push('AWS access keys must not be stored');
  if (/\b(Set-)?Cookie:\s+(?!\[REDACTED_COOKIE\](?:\s|$))[^\r\n]+/i.test(text)) issues.push('cookie headers must not be stored');
  if (/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(text)) issues.push('JWTs must not be stored');
  if (/\bAuthorization:\s*Bearer\s+(?!\[REDACTED\](?:\s|$))[A-Za-z0-9._~+/-]+=*/i.test(text)) issues.push('bearer tokens must not be stored');
  if (/[?&](?:sig|signature|token|access_token|api_key|X-Amz-Signature)=(?!\[REDACTED\](?:[&\s)'"`]|$))[^&\s)'"`]+/i.test(text)) {
    issues.push('signed URL query secrets must not be stored');
  }
  if (/\b[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|SESSION)[A-Za-z0-9_]*\s*=\s*(["']?)(?!\[REDACTED[A-Z_]*\]\1(?:\s|$))[^\s'"`]+\1/i.test(text)) {
    issues.push('environment-style secrets must not be stored');
  }
  return issues;
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
