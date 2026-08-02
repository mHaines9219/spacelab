/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** OpenRouter API key. When set, AI style search routes through the model; when unset,
   * it uses the offline local resolver. Read at build time — see resolver.ts. */
  readonly VITE_OPENROUTER_API_KEY?: string;
  /** Optional OpenRouter model slug, e.g. "openai/gpt-4o-mini" or "anthropic/claude-3.5-haiku". */
  readonly VITE_OPENROUTER_MODEL?: string;
  /** Optional site URL sent as OpenRouter's HTTP-Referer attribution header. */
  readonly VITE_OPENROUTER_REFERER?: string;

  /** Supabase project URL, e.g. "https://xxxx.supabase.co". Enables accounts + the
   * cloud portfolio. When either this or the anon key is unset, auth degrades to
   * "not configured" and the local editor still works — see supabase.ts. */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon/publishable key. Safe to ship in the browser; row-level security is
   * what actually protects data. Read at build time. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
