export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\/Users\/[^\s)'"`]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\/private\/[^\s)'"`]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\bAuthorization:\s*Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+\.[A-Za-z0-9._~+/-]+\.[A-Za-z0-9._~+/-]+=*/g, 'Bearer [REDACTED_JWT]')
    .replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    .replace(/([?&](?:sig|signature|token|access_token|api_key|X-Amz-Signature)=)[^&\s)'"`]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(session[_ -]?id):\s*[^\s]+/gi, '$1: [REDACTED_SESSION]')
    .replace(/\b(session[_ -]?id)\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/gi, '$1 [REDACTED_SESSION]')
    .replace(/(세션\s*ID)\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/gi, '$1 [REDACTED_SESSION]')
    .replace(/\b(token|secret|password|api[_-]?key|access[_-]?key|access[_-]?token):\s*[^\s]+/gi, '$1: [REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key|access[_-]?key|access[_-]?token)\s+(?!\[REDACTED[A-Z_]*\](?:\s|$))[^\s]+/gi, '$1 [REDACTED]');
}

export function frontmatterScalar(value) {
  return redactSensitiveText(value)
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, '\\"')
    .trim();
}
