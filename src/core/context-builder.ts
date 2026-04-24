import type { ContradictionResult, Annotation, TieredResults, NodeResult, GraphNode } from '../types.js';

const DEFAULT_BUDGET = 10_000;

const OPEN = '[Engram: Prior project knowledge]\n';
const CLOSE = '\n[End Engram context]';

const GROUP_ORDER: Array<{ type: GraphNode['nodeType']; header: string }> = [
  { type: 'decision', header: 'Decisions' },
  { type: 'pattern', header: 'Findings' },
  { type: 'concept', header: 'Context' },
  { type: 'file', header: 'File Context' },
  { type: 'entity', header: 'Entities' },
];

function formatContradiction(c: ContradictionResult): string {
  return `⚠️ CONTRADICTION (${c.severity}): ${c.explanation}\nRecommendation: ${c.recommendation}\n\n`;
}

function formatAnnotations(annotations: Annotation[]): string {
  if (annotations.length === 0) return '';
  const lines = annotations.map(a => `- ${a.name}: ${a.description}`);
  return `📎 Related knowledge:\n${lines.join('\n')}\n`;
}

function extractSessionInfo(node: GraphNode): string {
  const episodes = node.metadata?.sourceEpisodes;
  if (!Array.isArray(episodes) || episodes.length === 0) return '';
  if (!episodes.every((e: unknown) => typeof e === 'string')) return '';
  return ` (sessions: ${episodes.join(', ')})`;
}

function summarizeFirstSentence(text: string): string {
  const periodIdx = text.indexOf('. ');
  if (periodIdx >= 0 && periodIdx < 100) {
    return text.slice(0, periodIdx + 1);
  }
  if (text.length <= 100) return text;
  return text.slice(0, 100);
}

function renderNodeEntry(nr: NodeResult, tier: 'high' | 'medium'): string {
  const sessions = extractSessionInfo(nr.node);
  if (tier === 'high') {
    return `- [high] ${nr.node.name}${sessions}\n  ${nr.node.description}\n`;
  }
  const summary = summarizeFirstSentence(nr.node.description);
  return `- [medium] ${nr.node.name}${sessions}\n  ${summary}\n`;
}

function renderGrouped(
  tieredResults: TieredResults,
  remaining: number,
): string {
  const highByType = new Map<GraphNode['nodeType'], NodeResult[]>();
  const medByType = new Map<GraphNode['nodeType'], NodeResult[]>();

  for (const nr of tieredResults.high) {
    const list = highByType.get(nr.node.nodeType) ?? [];
    list.push(nr);
    highByType.set(nr.node.nodeType, list);
  }
  for (const nr of tieredResults.medium) {
    const list = medByType.get(nr.node.nodeType) ?? [];
    list.push(nr);
    medByType.set(nr.node.nodeType, list);
  }

  let buf = '';
  for (const group of GROUP_ORDER) {
    const highNodes = highByType.get(group.type) ?? [];
    const medNodes = medByType.get(group.type) ?? [];
    if (highNodes.length === 0 && medNodes.length === 0) continue;

    const header = `## ${group.header}\n`;
    if (header.length > remaining) break;
    buf += header;
    remaining -= header.length;

    for (const nr of highNodes) {
      const entry = renderNodeEntry(nr, 'high');
      if (entry.length > remaining) break;
      buf += entry;
      remaining -= entry.length;
    }
    for (const nr of medNodes) {
      const entry = renderNodeEntry(nr, 'medium');
      if (entry.length > remaining) break;
      buf += entry;
      remaining -= entry.length;
    }
  }
  return buf;
}

export function buildContext(
  contradictions: ContradictionResult[],
  annotations: Annotation[],
  tieredResults: TieredResults,
  budget: number = DEFAULT_BUDGET,
): string {
  if (budget <= 0) return '';

  const hasContent = contradictions.length > 0 ||
    annotations.length > 0 ||
    tieredResults.high.length > 0 ||
    tieredResults.medium.length > 0;

  if (!hasContent) return '';

  let remaining = budget - OPEN.length - CLOSE.length;
  if (remaining <= 0) return '';

  let content = '';

  for (const c of contradictions) {
    const block = formatContradiction(c);
    if (block.length > remaining) break;
    content += block;
    remaining -= block.length;
  }

  const annotationBlock = formatAnnotations(annotations);
  if (annotationBlock.length <= remaining) {
    content += annotationBlock;
    remaining -= annotationBlock.length;
  }

  content += renderGrouped(tieredResults, remaining);

  return OPEN + content + CLOSE;
}
