/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL проекта Supabase (онлайн-режим). См. .env.example. */
  readonly VITE_SUPABASE_URL?: string;
  /** Публичный anon-ключ Supabase. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
