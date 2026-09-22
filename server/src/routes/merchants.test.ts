import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '../db/users.js';
import type { MerchantSearchResponse } from '../services/google-places.js';
import { GooglePlacesError } from '../services/google-places.js';
import { createMerchantsRouter } from './merchants.js';

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

describe('merchantsRouter authorization', () => {
  it.each<UserRole>(['admin', 'manager'])('allows %s', async (role) => {
    const search = vi.fn(async () => emptyResult);
    const response = await requestAs(role, search);

    expect(response.status).toBe(200);
    expect(search).toHaveBeenCalledOnce();
  });

  it.each<UserRole>(['user', 'warehouse'])('rejects %s before calling the service', async (role) => {
    const search = vi.fn(async () => emptyResult);
    const response = await requestAs(role, search);

    expect(response.status).toBe(403);
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
