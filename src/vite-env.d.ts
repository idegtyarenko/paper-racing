/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Short commit SHA of the build. */
declare const __COMMIT__: string;
/** Last commit time on the build's branch, epoch milliseconds. */
declare const __BUILD_TIME__: number;
/** Whether a waiting SW update is applied immediately (staging preview) rather
 *  than only at a safe, not-mid-race moment (production). */
declare const __PWA_EAGER_UPDATE__: boolean;

interface ImportMetaEnv {
  /** Supabase project URL (online mode). See .env.example. */
  readonly VITE_SUPABASE_URL?: string;
  /** Public Supabase anon key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
