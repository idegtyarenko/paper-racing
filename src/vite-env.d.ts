/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/** Короткий SHA коммита сборки. */
declare const __COMMIT__: string;
/** Время сборки, epoch-миллисекунды. */
declare const __BUILD_TIME__: number;

interface ImportMetaEnv {
  /** URL проекта Supabase (онлайн-режим). См. .env.example. */
  readonly VITE_SUPABASE_URL?: string;
  /** Публичный anon-ключ Supabase. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
