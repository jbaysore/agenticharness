// List prices in US dollars per million tokens. They are used only to weigh
// one model's tokens against another's when deciding whether handing work to a
// worker is cheaper; nothing is billed from them. Reported by third-party price
// trackers on the date below, not read from the providers' own pages.
export const PRICES_AS_OF = "2026-10-09";
const LIST = {
  claude: [
    [/fable-5-1/, 10, 50],
    [/opus-5-5/, 4, 20],
    [/opus-5$/, 5, 25],
    [/sonnet-5-5|sonnet-5$/, 2, 10],
    [/haiku-5-5/, 0.1, 0.5],
    [/haiku-4-5/, 1, 5],
  ],
  codex: [
    [/^gpt-6\.1-sol$/, 2, 10],
    [/^gpt-6-sol$/, 2, 10],
    [/^gpt-6-astra$/, 10, 50],
    [/^gpt-6-luna$/, 0.1, 0.5],
  ],
};

// A model with no known price is never compared, so nothing is delegated to
// it or away from it on a guess.
export function modelPrice(provider, model) {
  const name = model?.resolvedModel ?? model?.id ?? "",
    found = LIST[provider]?.find(([pattern]) => pattern.test(name));
  return found ? { input: found[1], output: found[2] } : null;
}
export function priceOf(providers, { provider, model }) {
  return modelPrice(
    provider,
    providers
      .find((p) => p.id === provider)
      ?.models?.find((m) => m.id === model),
  );
}
// Dollars for a number of input and output tokens at a model's list price.
export const cost = (price, input, output) =>
  (input * price.input + output * price.output) / 1e6;
