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
