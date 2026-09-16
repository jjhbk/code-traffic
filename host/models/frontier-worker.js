const { OpenAICompatibleClient } = require('./clients');

const client = new OpenAICompatibleClient({
  model: process.env.SIGNAL_BOX_FRONTIER_MODEL || 'gpt-4o-mini',
  baseUrl: process.env.SIGNAL_BOX_FRONTIER_BASE_URL || 'https://api.openai.com/v1',
  apiKey: process.env.SIGNAL_BOX_FRONTIER_API_KEY,
});

process.on('message', async ({ id, payload }) => {
  try {
    const result = await client.complete(payload);
    process.send?.({ id, result });
  } catch (error) {
    process.send?.({ id, error: error.message });
  }
});
