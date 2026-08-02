/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OpenRouter API key. When set, AI style search routes through the model; when unset,
   * it uses the offline local resolver. Read at build time — see resolver.ts. */
  readonly VITE_OPENROUTER_API_KEY?: string;
  /** Optional OpenRouter model slug, e.g. "openai/gpt-4o-mini" or "anthropic/claude-3.5-haiku". */
  readonly VITE_OPENROUTER_MODEL?: string;
  /** Optional site URL sent as OpenRouter's HTTP-Referer attribution header. */
  readonly VITE_OPENROUTER_REFERER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
