import { load } from "https://deno.land/std@0.184.0/dotenv/mod.ts";
import {
  join,
  fromFileUrl,
  dirname,
} from "https://deno.land/std@0.184.0/path/mod.ts";

/**
 * Make `.env` work regardless of where the script is being called from. Call
 * like this:
 * ```ts
 * const env = await loadEnv(import.meta.url)
 * ```
 */
export const loadEnv = (importMetaUrl: string) =>
  load({
    envPath: join(dirname(fromFileUrl(importMetaUrl)), ".env"),
  });
