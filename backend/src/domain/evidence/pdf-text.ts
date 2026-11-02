// Text layer of an untrusted PDF (S03 T5.3): pdfjs legacy build, no worker, ≤ 10 pages, deadline-capped. pdfjs 6 has no code
// evaluation at all (its `isEvalSupported` option was removed; the build contains no eval/new Function), so nothing to switch off.
// Text items are joined per line (by y position). Image-only PDFs come back empty: the caller holds them, never guesses.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// pdfjs runs its parser in-process ("fake worker") in Node. By default it loads ./pdf.worker.mjs by relative path, which doesn't
// exist inside an esbuild Lambda bundle; handing it the statically imported module works bundled and unbundled.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

export const MAX_PAGES = 10;
export const PDF_TEXT_MS = 5_000;

export class PdfUnreadable extends Error {}

export async function pdfText(bytes: Uint8Array, timeoutMs = PDF_TEXT_MS): Promise<string> {
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new PdfUnreadable(`PDF text took longer than ${timeoutMs} ms`)), Math.max(1, timeoutMs)); });
  try {
    return await Promise.race([read(task.promise), deadline]);
  } catch (e) {
    throw e instanceof PdfUnreadable ? e : new PdfUnreadable(`Not a readable PDF: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    task.destroy().catch(() => {});
  }
}

async function read(p: Promise<{ numPages: number; getPage(n: number): Promise<any> }>): Promise<string> {
  const doc = await p;
  const out: string[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const lines = new Map<number, string[]>();
    for (const it of tc.items as { str?: string; transform?: number[] }[]) {
      if (!it.str || !it.transform) continue;
      const y = Math.round(it.transform[5]);
      lines.set(y, [...(lines.get(y) ?? []), it.str]);
    }
    out.push(...[...lines.entries()].sort((a, b) => b[0] - a[0]).map(([, s]) => s.join(' ').trim()));
  }
  return out.join('\n');
}

/** G7: fewer than this many non-space characters means no usable text layer. */
export const MIN_TEXT_CHARS = 20;
export const nonSpace = (s: string) => s.replace(/\s/g, '').length;
