export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\/Users\/[^\s)'"`]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\/private\/[^\s)'"`]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_ANTHROPIC_KEY]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_OPENAI_KEY]')
    .replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, '[REDACTED_NPM_TOKEN]')
    .replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\bxapp-\d-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/+_-]+/g, '[REDACTED_SLACK_WEBHOOK]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]')
    .replace(/\b(Set-)?Cookie:\s*[^\r\n]+/gi, '$1Cookie: [REDACTED_COOKIE]')
    .replace(/\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+\.[A-Za-z0-9._~+/-]+\.[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED_JWT]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/([?&](?:sig|signature|token|access_token|api_key|X-Amz-Signature)=)[^&\s)'"`]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(session[_ -]?id):\s*[^\s]+/gi, '$1: [REDACTED_SESSION]')
    .replace(/\b(session[_ -]?id)\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/gi, '$1 [REDACTED_SESSION]')
    .replace(/(세션\s*ID)\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/gi, '$1 [REDACTED_SESSION]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|ACCESS[_-]?TOKEN|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|SESSION)[A-Za-z0-9_]*)\s*=\s*(["']?)(?!\[REDACTED[A-Z_]*\]\2(?:\s|$))[^\s'"`]+\2/gi, '$1=$2[REDACTED]$2')
    .replace(/\b(token|secret|password|api[_-]?key|access[_-]?key|access[_-]?token):\s*[^\s]+/gi, '$1: [REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key|access[_-]?key|access[_-]?token)\s+(?!\[REDACTED[A-Z_]*\](?:\s|$))[^\s]+/gi, '$1 [REDACTED]');
}

export function frontmatterScalar(value) {
  return redactSensitiveText(value)
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, '\\"')
    .trim();
}
