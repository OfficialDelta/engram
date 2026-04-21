import { loadConfig } from './config.js';

export async function getEmbedding(
  texts: string[],
  config?: { provider?: string; apiKey?: string },
): Promise<number[][]> {
  const fileConfig = loadConfig();
  const provider = config?.provider ?? fileConfig.embedding.provider ?? 'voyage-3-lite';
  let url: string;
  let model: string;
  let apiKey: string | undefined;

  if (provider.startsWith('voyage')) {
    url = 'https://api.voyageai.com/v1/embeddings';
    model = provider;
    apiKey = config?.apiKey ?? fileConfig.embedding.apiKey ?? process.env.VOYAGE_API_KEY;
  } else {
    url = 'https://api.openai.com/v1/embeddings';
    model = provider === 'openai' ? 'text-embedding-3-small' : provider;
    apiKey = config?.apiKey ?? fileConfig.embedding.apiKey ?? process.env.OPENAI_API_KEY;
  }

  if (!apiKey) {
    throw new Error(`No API key provided for embedding provider "${provider}"`);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as { data: Array<{ embedding: number[] }> };
  if (!json.data?.length) {
    throw new Error('Embedding API returned malformed response: missing data[].embedding');
  }

  return json.data.map(d => d.embedding);
}
