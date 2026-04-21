import type { StrengthParams } from '../types.js';

export function computeStrength(params: StrengthParams): number {
  const frequency = Math.log2(1 + params.sourceEpisodeCount);
  const recency = Math.exp(-0.1 * params.sessionsWithoutReinforcement);
  const outcomeConsistency = params.totalEpisodes === 0 ? 0.5 : params.successfulEpisodes / params.totalEpisodes;
  const causalImportance = params.causallyImportant ? 1.5 : 1.0;
  return Math.min(Math.max(frequency * recency * outcomeConsistency * causalImportance, 0), 1);
}
