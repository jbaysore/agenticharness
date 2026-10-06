// Credentials remain in the providers' own stores. Never read or proxy OAuth tokens.
// Do not inherit API credentials, model gateways, SDK switches, or paid fallbacks.
export function subscriptionEnvironment(source = process.env) {
  const env = {};
  const blocked =
    /^(OPENAI_|CODEX_(?!HOME$)|ANTHROPIC_|CLAUDE_CODE_|CURSOR_|AWS_|AZURE_|GOOGLE_|VERTEX_|BEDROCK_|NODE_OPTIONS$)/i;
  for (const [key, value] of Object.entries(source)) {
    if (!blocked.test(key) && value !== undefined) env[key] = value;
  }
  return env;
}
