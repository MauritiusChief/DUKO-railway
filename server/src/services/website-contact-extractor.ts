import dns from 'node:dns/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { load } from 'cheerio';
import type { MerchantWebsiteExtractionInput } from '../validation/merchants.js';

export const WEBSITE_USER_AGENT = 'DUKO-Merchant-Contact-Extractor/1.0';
export const MAX_REDIRECTS = 3;
export const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 5 * 1024 * 1024;
export const MAX_CLEANED_TEXT_BYTES = 50 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CONTACT_VALUES = 50;

export type WebsiteExtractionErrorCode =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'timeout'
  | 'response_too_large'
  | 'unsupported_content_type'
  | 'unsupported_content_encoding'
  | 'upstream_http_error'
  | 'network_error';

export class WebsiteExtractionError extends Error {
  constructor(
    public readonly code: WebsiteExtractionErrorCode,
    public readonly upstreamStatus?: number,
  ) {
    super(code);
    this.name = 'WebsiteExtractionError';
  }
}

export interface WebsiteExtractionResult {
  placeId: string;
  sourceUrl: string;
  emails: string[];
  phones: string[];
  pageTitle: string | null;
  pageDescription: string | null;
  canonicalUrl: string | null;
  cleanedWebsiteText: string;
  textTruncated: boolean;
}

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface RawWebsiteResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface WebsiteExtractorDependencies {
  resolveHostname?: (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;
  requestPage?: (
    url: URL,
    address: ResolvedAddress,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<RawWebsiteResponse>;
  parseHtml?: (
    html: string,
    sourceUrl: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<Omit<WebsiteExtractionResult, 'placeId'>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function parseIpv4(address: string): number | null {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function ipv4InCidr(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;
  const blocked: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  return !blocked.some(([base, prefix]) => ipv4InCidr(value, parseIpv4(base)!, prefix));
}

function parseIpv6(address: string): bigint | null {
  if (net.isIP(address) !== 6 || address.includes('%')) return null;
  let normalized = address.toLowerCase();
  const lastColon = normalized.lastIndexOf(':');
  const ipv4Tail = normalized.slice(lastColon + 1);
  if (ipv4Tail.includes('.')) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) + BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(value: bigint, base: bigint, prefix: number): boolean {
  const shift = BigInt(128 - prefix);
  return (value >> shift) === (base >> shift);
}

function ipv6Base(address: string): bigint {
  const value = parseIpv6(address);
  if (value === null) throw new Error(`Invalid IPv6 constant: ${address}`);
  return value;
}

function isPublicIpv6(address: string): boolean {
  const value = parseIpv6(address);
  if (value === null) return false;

  // Only global unicast is eligible; explicitly remove special-purpose ranges inside 2000::/3.
  if (!ipv6InCidr(value, ipv6Base('2000::'), 3)) return false;
  const blocked: Array<[string, number]> = [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
  ];
  return !blocked.some(([base, prefix]) => ipv6InCidr(value, ipv6Base(base), prefix));
}

export function isPublicIpAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function parseWebsiteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebsiteExtractionError('invalid_url');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new WebsiteExtractionError('invalid_url');
  }
  url.hash = '';
  return url;
}

async function defaultResolveHostname(hostname: string, signal?: AbortSignal): Promise<ResolvedAddress[]> {
  const literal = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const family = net.isIP(literal);
  if (family === 4 || family === 6) return [{ address: literal, family }];
  const resolver = new dns.Resolver();
  const cancel = () => resolver.cancel();
  if (signal?.aborted) throw new WebsiteExtractionError('timeout');
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const [ipv4, ipv6] = await Promise.allSettled([
      resolver.resolve4(literal),
      resolver.resolve6(literal),
    ]);
    if (signal?.aborted) throw new WebsiteExtractionError('timeout');
    const addresses: ResolvedAddress[] = [];
    if (ipv4.status === 'fulfilled') {
      addresses.push(...ipv4.value.map((address) => ({ address, family: 4 as const })));
    }
    if (ipv6.status === 'fulfilled') {
      addresses.push(...ipv6.value.map((address) => ({ address, family: 6 as const })));
    }
    if (addresses.length === 0) throw new WebsiteExtractionError('dns_failed');
    return addresses;
  } catch (error) {
    if (error instanceof WebsiteExtractionError) throw error;
    throw new WebsiteExtractionError(signal?.aborted ? 'timeout' : 'dns_failed');
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function resolvePublicTarget(
  url: URL,
  resolver: (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>,
  signal?: AbortSignal,
): Promise<ResolvedAddress> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(url.hostname, signal);
  } catch (error) {
    if (error instanceof WebsiteExtractionError) throw error;
    throw new WebsiteExtractionError('dns_failed');
  }
  if (addresses.length === 0) throw new WebsiteExtractionError('dns_failed');
  if (addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw new WebsiteExtractionError('blocked_address');
  }
  return addresses[0];
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || Date.now() >= deadlineMs) {
      reject(new WebsiteExtractionError('timeout'));
      return;
    }

    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => finish(() => reject(new WebsiteExtractionError('timeout')));
    const timer = setTimeout(abort, Math.max(1, deadlineMs - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function readResponseBody(response: http.IncomingMessage, request: http.ClientRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let compressedBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
      response.destroy();
      request.destroy();
    };
    response.on('data', (chunk: Buffer) => {
      compressedBytes += chunk.length;
      if (compressedBytes > MAX_COMPRESSED_BYTES) {
        fail(new WebsiteExtractionError('response_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    response.on('error', (error) => fail(error));
  });
}

export async function requestPinnedPage(
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RawWebsiteResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WebsiteExtractionError('timeout'));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: address.address,
      family: address.family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: true,
      headers: {
        Host: url.host,
        'User-Agent': WEBSITE_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, async (response) => {
      try {
        const contentLength = Number(headerValue(response.headers['content-length']));
        if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_BYTES) {
          response.destroy();
          reject(new WebsiteExtractionError('response_too_large'));
          return;
        }
        const body = await readResponseBody(response, request);
        resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body });
      } catch (error) {
        reject(error);
      }
    });

    const timer = setTimeout(() => request.destroy(new WebsiteExtractionError('timeout')), timeoutMs);
    const abort = () => request.destroy(new WebsiteExtractionError('timeout'));
    signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
    request.on('error', (error) => {
      if (error instanceof WebsiteExtractionError) reject(error);
      else reject(new WebsiteExtractionError('network_error'));
    });
    request.end();
  });
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

async function decodeBody(body: Buffer, encodingHeader: string, signal?: AbortSignal): Promise<Buffer> {
  const encoding = encodingHeader.trim().toLowerCase();
  if (!encoding || encoding === 'identity') {
    if (body.length > MAX_DECOMPRESSED_BYTES) throw new WebsiteExtractionError('response_too_large');
    return body;
  }

  let decoder: ReturnType<typeof createGunzip> | ReturnType<typeof createInflate> | ReturnType<typeof createBrotliDecompress>;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
  else if (encoding === 'deflate') decoder = createInflate();
  else if (encoding === 'br') decoder = createBrotliDecompress();
  else throw new WebsiteExtractionError('unsupported_content_encoding');

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let decodedBytes = 0;
    let settled = false;
    const abort = () => decoder.destroy(new WebsiteExtractionError('timeout'));
    if (signal?.aborted) {
      reject(new WebsiteExtractionError('timeout'));
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    decoder.on('data', (chunk: Buffer) => {
      decodedBytes += chunk.length;
      if (decodedBytes > MAX_DECOMPRESSED_BYTES) {
        decoder.destroy(new WebsiteExtractionError('response_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    decoder.on('end', () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(Buffer.concat(chunks));
    });
    decoder.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      reject(error instanceof WebsiteExtractionError ? error : new WebsiteExtractionError('network_error'));
    });
    decoder.end(body);
  });
}

function decodeHtml(buffer: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: value.slice(0, low), truncated: true };
}

function addEmail(target: Set<string>, candidate: string): void {
  const email = candidate.trim().replace(/^mailto:/i, '').split('?')[0].toLowerCase();
  if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) target.add(email);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function addPhone(target: Map<string, string>, candidate: string): void {
  const phone = cleanText(candidate.replace(/^tel:/i, '').split('?')[0]);
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 15 && !target.has(digits)) target.set(digits, phone);
}

function safeCanonicalUrl(value: string | undefined, sourceUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, sourceUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function extractContactsFromHtml(html: string, sourceUrl: string): Omit<WebsiteExtractionResult, 'placeId'> {
  const $ = load(html);
  const pageTitle = cleanText($('title').first().text()).slice(0, 500) || null;
  const pageDescription = cleanText($('meta[name="description" i]').first().attr('content') ?? '').slice(0, 2_000) || null;
  const canonicalUrl = safeCanonicalUrl($('link[rel="canonical" i]').first().attr('href'), sourceUrl);
  const emails = new Set<string>();
  const phones = new Map<string, string>();

  $('script, style, noscript, svg, template, iframe, canvas, [hidden], [aria-hidden="true" i], [style*="display:none" i], [style*="display: none" i], [style*="visibility:hidden" i], [style*="visibility: hidden" i]').remove();
  $('a[href]').each((_index, element) => {
    const href = $(element).attr('href') ?? '';
    if (/^mailto:/i.test(href)) {
      for (const candidate of safeDecodeURIComponent(href).split(',')) addEmail(emails, candidate);
    }
    if (/^tel:/i.test(href)) addPhone(phones, safeDecodeURIComponent(href));
  });

  const visibleText = cleanText($('body').text() || $.root().text());
  for (const match of visibleText.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) addEmail(emails, match[0]);
  for (const match of visibleText.matchAll(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?/gi)) {
    addPhone(phones, match[0]);
  }

  const truncatedText = truncateUtf8(visibleText, MAX_CLEANED_TEXT_BYTES);
  return {
    sourceUrl,
    emails: [...emails].slice(0, MAX_CONTACT_VALUES),
    phones: [...phones.values()].slice(0, MAX_CONTACT_VALUES),
    pageTitle,
    pageDescription,
    canonicalUrl,
    cleanedWebsiteText: truncatedText.value,
    textTruncated: truncatedText.truncated,
  };
}

function parserWorkerUrl(): URL {
  const isTs = import.meta.url.endsWith('.ts');
  return new URL(isTs ? './website-contact-parser-worker.ts' : './website-contact-parser-worker.js', import.meta.url);
}

export function extractContactsInWorker(
  html: string,
  sourceUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Omit<WebsiteExtractionResult, 'placeId'>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || timeoutMs <= 0) {
      reject(new WebsiteExtractionError('timeout'));
      return;
    }

    const isTs = import.meta.url.endsWith('.ts');
    const worker = new Worker(parserWorkerUrl(), {
      workerData: { html, sourceUrl },
      execArgv: isTs ? ['--import', 'tsx'] : undefined,
    });
    worker.unref();
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new WebsiteExtractionError('timeout')));
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', (message: { ok: boolean; result?: Omit<WebsiteExtractionResult, 'placeId'> }) => {
      if (message?.ok && message.result) finish(() => resolve(message.result!));
      else finish(() => reject(new WebsiteExtractionError('network_error')));
    });
    worker.once('error', () => finish(() => reject(new WebsiteExtractionError('network_error'))));
    worker.once('exit', (code) => {
      if (code !== 0) finish(() => reject(new WebsiteExtractionError('network_error')));
    });
  });
}

export async function extractWebsiteContacts(
  input: MerchantWebsiteExtractionInput,
  overrides: WebsiteExtractorDependencies = {},
): Promise<WebsiteExtractionResult> {
  const resolveHostname = overrides.resolveHostname ?? defaultResolveHostname;
  const requestPage = overrides.requestPage ?? requestPinnedPage;
  const parseHtml = overrides.parseHtml ?? extractContactsInWorker;
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let currentUrl = parseWebsiteUrl(input.websiteUrl);
  const deadlineMs = Date.now() + timeoutMs;
  const operationController = new AbortController();
  const abortOperation = () => operationController.abort();
  const deadlineTimer = setTimeout(abortOperation, timeoutMs);
  overrides.signal?.addEventListener('abort', abortOperation, { once: true });
  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const address = await withDeadline(
        resolvePublicTarget(currentUrl, resolveHostname, operationController.signal),
        deadlineMs,
        operationController.signal,
      );
      const response = await withDeadline(
        requestPage(currentUrl, address, Math.max(1, deadlineMs - Date.now()), operationController.signal),
        deadlineMs,
        operationController.signal,
      );
      const location = headerValue(response.headers.location);
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
        if (redirectCount === MAX_REDIRECTS) throw new WebsiteExtractionError('too_many_redirects');
        currentUrl = parseWebsiteUrl(new URL(location, currentUrl).href);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new WebsiteExtractionError('upstream_http_error', response.statusCode);
      }

      const contentType = headerValue(response.headers['content-type']);
      const mediaType = contentType.split(';')[0].trim().toLowerCase();
      if (mediaType !== 'text/html' && mediaType !== 'application/xhtml+xml') {
        throw new WebsiteExtractionError('unsupported_content_type');
      }
      if (response.body.length > MAX_COMPRESSED_BYTES) throw new WebsiteExtractionError('response_too_large');
      const decoded = await withDeadline(
        decodeBody(response.body, headerValue(response.headers['content-encoding']), operationController.signal),
        deadlineMs,
        operationController.signal,
      );
      const extracted = await withDeadline(
        parseHtml(
          decodeHtml(decoded, contentType),
          currentUrl.href,
          Math.max(1, deadlineMs - Date.now()),
          operationController.signal,
        ),
        deadlineMs,
        operationController.signal,
      );
      return { placeId: input.placeId, ...extracted };
    }

    throw new WebsiteExtractionError('too_many_redirects');
  } finally {
    clearTimeout(deadlineTimer);
    overrides.signal?.removeEventListener('abort', abortOperation);
  }
}
