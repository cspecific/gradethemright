/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type Runtime = import('@astrojs/cloudflare').Runtime<Env>;

declare namespace App {
  interface Locals extends Runtime {}
}

interface Env {
  FILES_BUCKET: R2Bucket;
  DB: D1Database;
  EDEN_AI_KEY: string;
  ENVIRONMENT: string;
}
