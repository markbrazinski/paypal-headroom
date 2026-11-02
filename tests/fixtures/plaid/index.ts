import { readFileSync } from 'node:fs';

/** Sanitized REPLAY fixture: {status, body}. A fresh deep copy each call so tests can alter it. */
export function fixture<T = any>(name: string): { status: number; body: T } {
  return JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8'));
}
