import { readFile } from 'node:fs/promises';

export async function readTranscriptText(transcriptPath) {
  if (!transcriptPath) {
    return '';
  }

  const raw = await readFile(transcriptPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const extracted = [];

  for (const line of lines.slice(-80)) {
    try {
      extracted.push(...extractStrings(JSON.parse(line)));
    } catch {
      extracted.push(line);
    }
  }

  return extracted.join('\n').slice(-20000);
}

function extractStrings(value) {
  if (typeof value === 'string') {
    return usefulString(value) ? [value] : [];
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractStrings);
  }

  const picked = [];
  for (const [key, child] of Object.entries(value)) {
    if (['content', 'text', 'message', 'summary', 'role', 'type'].includes(key)) {
      picked.push(...extractStrings(child));
    }
  }
  return picked;
}

function usefulString(value) {
  return value.trim().length >= 2 && !value.startsWith('data:');
}
