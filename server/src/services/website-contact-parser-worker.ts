/**
 * 一次性 Cheerio 解析 worker。
 * 主线程负责网络和 deadline；worker 只接收当前请求内存中的 HTML，并返回结构化结果。
 */
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
  // 不把可能包含页面内容的解析异常跨线程返回或写入日志。
  parentPort?.postMessage({ ok: false });
}
