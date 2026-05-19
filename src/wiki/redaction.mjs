export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/\/Users\/[^\s)'"`]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\/private\/[^\s)'"`]+/g, '[REDACTED_LOCAL_PATH]')
    .replace(/\b(session[_ -]?id):\s*[^\s]+/gi, '$1: [REDACTED_SESSION]')
    .replace(/\b(session[_ -]?id)\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/gi, '$1 [REDACTED_SESSION]')
    .replace(/(세션\s*ID)\s+(?!\[REDACTED_SESSION\](?:\s|$))[^\s]+/gi, '$1 [REDACTED_SESSION]')
    .replace(/\b(token|secret|password|api[_-]?key|access[_-]?key):\s*[^\s]+/gi, '$1: [REDACTED]')
    .replace(/\b(token|secret|password|api[_-]?key|access[_-]?key)\s+(?!\[REDACTED\](?:\s|$))[^\s]+/gi, '$1 [REDACTED]')
    .replace(/sig=[^&\s)'"`]+/gi, 'sig=[REDACTED]');
}

export function frontmatterScalar(value) {
  return redactSensitiveText(value)
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, '\\"')
    .trim();
}
