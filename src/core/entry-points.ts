import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EntryPoint } from '../types.js';

const FILE_PATH_PATTERN = /(?:^|\s|['"`(])(\.\/?(?:[\w.-]+\/)*[\w.-]+\.\w{1,10})(?=['"`)\s,]|$)|(?:^|\s|['"`(])((?:[\w@.-]+\/)+[\w.-]+\.\w{1,10})(?=['"`)\s,]|$)|(?:^|\s|['"`(])(\/(?:[\w.-]+\/)+[\w.-]+\.\w{1,10})(?=['"`)\s,]|$)/gm;
const CONCEPT_PATTERN = /(?:[`'"]([\w][\w ./-]{1,60}[\w])['"`])/g;

export function extractEntryPoints(prompt: string): EntryPoint[] {
  const entryPoints: EntryPoint[] = [];
  const seenValues = new Set<string>();

  for (const match of prompt.matchAll(FILE_PATH_PATTERN)) {
    const filePath = match[1] ?? match[2] ?? match[3];
    if (filePath && !seenValues.has(filePath)) {
      seenValues.add(filePath);
      entryPoints.push({ type: 'file', value: filePath });
    }
  }

  for (const match of prompt.matchAll(CONCEPT_PATTERN)) {
    const concept = match[1];
    if (concept && !seenValues.has(concept) && !concept.includes('/')) {
      seenValues.add(concept);
      entryPoints.push({ type: 'name', value: concept });
    }
  }

  return entryPoints;
}

export function getRecentFileEntryPoints(dataDir: string): EntryPoint[] {
  try {
    const eventsDir = join(dataDir, 'events');
    const files = readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
    if (files.length === 0) return [];

    const sorted = files
      .map(f => ({ name: f, path: join(eventsDir, f) }))
      .sort((a, b) => {
        try {
          const aStat = readFileSync(a.path, 'utf-8');
          const bStat = readFileSync(b.path, 'utf-8');
          const aLines = aStat.trim().split('\n');
          const bLines = bStat.trim().split('\n');
          const aLast = JSON.parse(aLines[aLines.length - 1]!) as { timestamp?: string };
          const bLast = JSON.parse(bLines[bLines.length - 1]!) as { timestamp?: string };
          return (bLast.timestamp ?? '').localeCompare(aLast.timestamp ?? '');
        } catch {
          return 0;
        }
      });

    const mostRecent = sorted[0];
    if (!mostRecent) return [];

    const content = readFileSync(mostRecent.path, 'utf-8');
    const filePaths = new Set<string>();

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; filePath?: string };
        if (event.type === 'file_write' && event.filePath) {
          filePaths.add(event.filePath);
        }
      } catch {
        // skip malformed lines
      }
    }

    return [...filePaths].map(value => ({ type: 'file' as const, value }));
  } catch {
    return [];
  }
}
