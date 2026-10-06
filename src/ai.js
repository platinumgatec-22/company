// Short Arabic texts written by the digital employees (notes, captions, report summaries).
// Uses Claude when ANTHROPIC_API_KEY is set; otherwise (or on any error) the given fallback text.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

async function write({ system, prompt, fallback }) {
  if (!client) return fallback;
  try {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      // If the model declines, the API retries on a fallback model instead of returning nothing.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (res.stop_reason === 'refusal') return fallback;
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || fallback;
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.error(`AI ${err.status ?? ''}: ${err.message}`);
    else console.error(`AI: ${err.message}`);
    return fallback;
  }
}

module.exports = { write, aiEnabled: Boolean(client) };
