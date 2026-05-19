import { open, stat } from 'node:fs/promises';

const MAX_TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_LINES = 80;
const MAX_EXTRACTED_CHARS = 20000;

export async function readTranscriptText(transcriptPath) {
  if (!transcriptPath) {
    return '';
  }

  const raw = await readTranscriptTail(transcriptPath);
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const extracted = [];

  for (const line of lines.slice(-MAX_TRANSCRIPT_LINES)) {
    try {
      extracted.push(...extractStrings(JSON.parse(line)));
    } catch {
      extracted.push(line);
    }
  }

  return extracted.join('\n').slice(-MAX_EXTRACTED_CHARS);
}

async function readTranscriptTail(transcriptPath) {
  const fileStat = await stat(transcriptPath);
  const start = Math.max(0, fileStat.size - MAX_TRANSCRIPT_TAIL_BYTES);
  const length = fileStat.size - start;
  const handle = await open(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
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
