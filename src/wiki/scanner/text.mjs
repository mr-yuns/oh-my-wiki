import path from 'node:path';

export function normalizePath(value) {
  return String(value || '').split(path.sep).join('/').normalize('NFC');
}

export function normalizeComparable(value) {
  return String(value || '').normalize('NFC').trim().toLowerCase();
}
