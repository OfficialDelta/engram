import type { ContradictionResult, Annotation, TieredResults, NodeResult } from '../types.js';

const DEFAULT_BUDGET = 10_000;

function formatContradiction(c: ContradictionResult): string {
  return `⚠️ CONTRADICTION (${c.severity}): ${c.explanation}\nRecommendation: ${c.recommendation}\n\n`;
}

function formatAnnotations(annotations: Annotation[]): string {
  if (annotations.length === 0) return '';
  const lines = annotations.map(a => `- ${a.name}: ${a.description}`);
  return `📎 Related knowledge:\n${lines.join('\n')}\n`;
}

function appendTiered(
  buf: string,
  remaining: number,
  nodes: NodeResult[],
  mode: 'full' | 'truncated' | 'name-only',
): { buf: string; remaining: number } {
  for (const nr of nodes) {
    let entry: string;
    if (mode === 'name-only') {
      entry = `${nr.node.name}\n`;
    } else {
      entry = `${nr.node.name}: ${nr.node.description}\n`;
    }

    if (mode === 'truncated' && entry.length > remaining) {
      entry = entry.slice(0, Math.max(0, remaining - 1)) + '\n';
    }

    if (entry.length > remaining) break;

    buf += entry;
    remaining -= entry.length;
    if (remaining <= 0) break;
  }
  return { buf, remaining };
}

export function buildContext(
  contradictions: ContradictionResult[],
  annotations: Annotation[],
  tieredResults: TieredResults,
  budget: number = DEFAULT_BUDGET,
): string {
  if (budget <= 0) return '';

  let result = '';

  for (const c of contradictions) {
    result += formatContradiction(c);
  }

  const annotationBlock = formatAnnotations(annotations);
  result += annotationBlock;

  let remaining = budget - result.length;
  if (remaining <= 0) return result;

  let updated = appendTiered(result, remaining, tieredResults.high, 'full');
  result = updated.buf;
  remaining = updated.remaining;
  if (remaining <= 0) return result;

  updated = appendTiered(result, remaining, tieredResults.medium, 'truncated');
  result = updated.buf;
  remaining = updated.remaining;
  if (remaining <= 0) return result;

  updated = appendTiered(result, remaining, tieredResults.low, 'name-only');
  result = updated.buf;

  return result;
}
