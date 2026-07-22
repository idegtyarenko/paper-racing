/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Short commit SHA of the build. */
declare const __COMMIT__: string;
/** Build time, epoch milliseconds. */
declare const __BUILD_TIME__: number;

interface ImportMetaEnv {
  /** Supabase project URL (online mode). See .env.example. */
  readonly VITE_SUPABASE_URL?: string;
  /** Public Supabase anon key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
