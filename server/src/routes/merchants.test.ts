import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '../db/users.js';
import type { MerchantSearchResponse } from '../services/google-places.js';
import { GooglePlacesError } from '../services/google-places.js';
import { WebsiteExtractionError, type WebsiteExtractionResult } from '../services/website-contact-extractor.js';
import { createMerchantsRouter, createMerchantWebsiteRouter } from './merchants.js';

const validBody = {
  textQuery: 'kitchen cabinet stores',
  centerCoordinates: '41.02518681565052, -73.65277742711385',
  rangeKm: 10,
};

const emptyResult: MerchantSearchResponse = {
  results: [],
  resultCount: 0,
  pageCount: 1,
  possiblyTruncated: false,
  partial: false,
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

async function requestAs(
  role: UserRole | undefined,
  search: Parameters<typeof createMerchantsRouter>[0],
  body: unknown = validBody,
): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (!role) {
      _res.status(401).json({ error: '未提供认证令牌' });
      return;
    }
    req.user = { userId: 1, username: 'synthetic-user', role };
    next();
  });
  app.use('/api/merchants', createMerchantsRouter(search));

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return fetch(`http://127.0.0.1:${port}/api/merchants/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function requestWebsiteAs(
  role: UserRole | undefined,
  extract: Parameters<typeof createMerchantWebsiteRouter>[0],
  body: unknown = { placeId: 'place-1', websiteUrl: 'https://example.com/' },
): Promise<Response> {
  const app = express();
  app.use((req, res, next) => {
    if (!role) {
      res.status(401).json({ error: '未提供认证令牌' });
      return;
    }
    req.user = { userId: 1, username: 'synthetic-user', role };
    next();
  });
  app.use('/api/merchant-websites', createMerchantWebsiteRouter(extract));

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return fetch(`http://127.0.0.1:${port}/api/merchant-websites/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('merchantsRouter authorization', () => {
  it.each<UserRole>(['admin', 'manager'])('allows %s', async (role) => {
    const search = vi.fn(async () => emptyResult);
    const response = await requestAs(role, search);

    expect(response.status).toBe(200);
    expect(response.headers.get('ratelimit-limit')).toBe('30');
    expect(search).toHaveBeenCalledOnce();
  });

  it.each<UserRole>(['user', 'warehouse'])('rejects %s before calling the service', async (role) => {
    const search = vi.fn(async () => emptyResult);
    const response = await requestAs(role, search);

    expect(response.status).toBe(403);
    expect(response.headers.get('ratelimit-limit')).toBeNull();
    expect(search).not.toHaveBeenCalled();
  });

  it('rejects a request without an authenticated user before the router', async () => {
    const search = vi.fn(async () => emptyResult);
    const response = await requestAs(undefined, search);

    expect(response.status).toBe(401);
    expect(search).not.toHaveBeenCalled();
  });

  it('checks authorization before validating the body', async () => {
    const search = vi.fn(async () => emptyResult);
    const response = await requestAs('user', search, {});

    expect(response.status).toBe(403);
    expect(search).not.toHaveBeenCalled();
  });
});

describe('merchantsRouter errors', () => {
  it('rejects invalid input before calling the service', async () => {
    const search = vi.fn(async () => emptyResult);
    const response = await requestAs('admin', search, { ...validBody, rangeKm: 51 });

    expect(response.status).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ['not_configured', 503],
    ['rate_limited', 503],
    ['network_error', 503],
    ['upstream_server_error', 503],
    ['timeout', 504],
    ['upstream_client_error', 502],
    ['invalid_json', 502],
    ['invalid_response', 502],
  ] as const)('maps %s to HTTP %s without exposing upstream details', async (code, status) => {
    const search = vi.fn(async () => {
      throw new GooglePlacesError(code, 418);
    });
    const response = await requestAs('manager', search);
    const body = await response.json() as { code: string; error: string };

    expect(response.status).toBe(status);
    expect(body.code).toBe(code);
    expect(body.error).not.toContain('418');
  });
});

describe('merchantWebsiteRouter', () => {
  const extracted: WebsiteExtractionResult = {
    placeId: 'place-1',
    sourceUrl: 'https://example.com/',
    emails: ['hello@example.com'],
    phones: [],
    pageTitle: 'Example',
    pageDescription: null,
    canonicalUrl: null,
    cleanedWebsiteText: 'Example',
    textTruncated: false,
  };

  it.each<UserRole>(['admin', 'manager'])('allows %s', async (role) => {
    const extract = vi.fn(async () => extracted);
    const response = await requestWebsiteAs(role, extract);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(extracted);
    expect(extract).toHaveBeenCalledOnce();
  });

  it.each<UserRole>(['user', 'warehouse'])('rejects %s before extraction', async (role) => {
    const extract = vi.fn(async () => extracted);
    const response = await requestWebsiteAs(role, extract);
    expect(response.status).toBe(403);
    expect(response.headers.get('ratelimit-limit')).toBeNull();
    expect(extract).not.toHaveBeenCalled();
  });

  it('rejects invalid URL input before extraction', async () => {
    const extract = vi.fn(async () => extracted);
    const response = await requestWebsiteAs('admin', extract, {
      placeId: 'place-1',
      websiteUrl: 'http://user:password@example.com/',
    });
    expect(response.status).toBe(400);
    expect(extract).not.toHaveBeenCalled();
  });

  it('applies the small body limit after authorization', async () => {
    const extract = vi.fn(async () => extracted);
    const oversizedBody = {
      placeId: 'place-1',
      websiteUrl: `https://example.com/${'a'.repeat(9_000)}`,
    };
    const authorized = await requestWebsiteAs('admin', extract, oversizedBody);
    expect(authorized.status).toBe(413);
    expect(await authorized.json()).toMatchObject({ code: 'request_too_large' });

    const unauthorized = await requestWebsiteAs('user', extract, oversizedBody);
    expect(unauthorized.status).toBe(403);
    expect(extract).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_url', 400],
    ['blocked_address', 400],
    ['response_too_large', 413],
    ['unsupported_content_type', 415],
    ['unsupported_content_encoding', 415],
    ['timeout', 504],
    ['dns_failed', 502],
    ['too_many_redirects', 502],
    ['upstream_http_error', 502],
    ['network_error', 502],
  ] as const)('maps %s to HTTP %s without exposing upstream details', async (code, status) => {
    const extract = vi.fn(async () => {
      throw new WebsiteExtractionError(code, 418);
    });
    const response = await requestWebsiteAs('manager', extract);
    const body = await response.json() as { code: string; error: string };
    expect(response.status).toBe(status);
    expect(body.code).toBe(code);
    expect(body.error).not.toContain('418');
    expect(body.error).not.toContain('example.com');
  });

  it('limits server-side extraction concurrency to four requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const extract = vi.fn(async () => {
      await gate;
      return extracted;
    });
    const app = express();
    app.use((req, _res, next) => {
      req.user = { userId: 1, username: 'synthetic-user', role: 'admin' };
      next();
    });
    app.use('/api/merchant-websites', createMerchantWebsiteRouter(extract));
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const requests = Array.from({ length: 5 }, () => fetch(
      `http://127.0.0.1:${port}/api/merchant-websites/extract`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId: 'place-1', websiteUrl: 'https://example.com/' }),
      },
    ));

    const busyResponse = await Promise.race(requests);
    expect(busyResponse.status).toBe(503);
    expect(await busyResponse.json()).toMatchObject({ code: 'website_extraction_busy' });
    expect(extract).toHaveBeenCalledTimes(4);
    release();
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 503]);
  });
});
