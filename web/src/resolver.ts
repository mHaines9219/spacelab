import { localStyleResolver, type StyleResolver } from "./styleSearch";
import { createLlmResolver } from "./llmResolver";

/**
 * The resolver the app actually uses. If an OpenRouter key is configured at build time it
 * routes through the model (which itself falls back to the local heuristic on any failure);
 * otherwise the app is the fully-offline local resolver. Either way the catalog panel and
 * the apply path are unchanged — the choice lives entirely here.
 *
 * Set the key in a gitignored `.env.local`:
 *   VITE_OPENROUTER_API_KEY=sk-or-...
 *   VITE_OPENROUTER_MODEL=openai/gpt-4o-mini   # optional; any OpenRouter model slug
 */
export const defaultResolver: StyleResolver = (() => {
  const apiKey = import.meta.env.VITE_OPENROUTER_API_KEY;
  if (!apiKey) return localStyleResolver;
  return createLlmResolver({
    apiKey,
    model: import.meta.env.VITE_OPENROUTER_MODEL,
    referer: import.meta.env.VITE_OPENROUTER_REFERER,
    title: "Spacelab",
  });
})();
