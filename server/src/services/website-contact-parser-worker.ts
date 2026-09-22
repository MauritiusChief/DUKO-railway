import { parentPort, workerData } from 'node:worker_threads';
import { extractContactsFromHtml } from './website-contact-extractor.js';

interface ParserWorkerInput {
  html: string;
  sourceUrl: string;
}

try {
  const { html, sourceUrl } = workerData as ParserWorkerInput;
  const result = extractContactsFromHtml(html, sourceUrl);
  parentPort?.postMessage({ ok: true, result });
} catch {
  parentPort?.postMessage({ ok: false });
}
