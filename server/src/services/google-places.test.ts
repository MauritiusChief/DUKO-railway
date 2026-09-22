import { describe, expect, it } from 'vitest';
import type { MerchantSearchInput } from '../validation/merchants.js';
import {
  GOOGLE_PLACES_FIELD_MASK,
  GOOGLE_PLACES_TEXT_SEARCH_URL,
  GooglePlacesError,
  calculateSearchRectangle,
  parseRetryAfterMs,
  searchGooglePlaces,
} from './google-places.js';

const input: MerchantSearchInput = {
  textQuery: 'kitchen cabinet stores',
  centerCoordinates: { latitude: 41.02518681565052, longitude: -73.65277742711385 },
  rangeKm: 10,
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function queuedFetch(responses: Response[]) {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = async (request, init) => {
    calls.push({ input: request, init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected fetch call');
    return response;
  };
  return { fetchImpl, calls };
}

describe('Google Places range calculation', () => {
  it('calculates a 10 km rectangular half-width', () => {
    const rectangle = calculateSearchRectangle(input.centerCoordinates, 10);
    expect(rectangle.low.latitude).toBeCloseTo(input.centerCoordinates.latitude - 10 / 111, 10);
    expect(rectangle.high.latitude).toBeCloseTo(input.centerCoordinates.latitude + 10 / 111, 10);
    const longitudeDelta = 10 / (111 * Math.cos(input.centerCoordinates.latitude * Math.PI / 180));
    expect(rectangle.low.longitude).toBeCloseTo(input.centerCoordinates.longitude - longitudeDelta, 10);
    expect(rectangle.high.longitude).toBeCloseTo(input.centerCoordinates.longitude + longitudeDelta, 10);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds and caps long waits', () => {
    expect(parseRetryAfterMs('1.5', 0)).toBe(1_500);
    expect(parseRetryAfterMs('60', 0)).toBe(5_000);
  });

  it('parses an HTTP date relative to the supplied clock', () => {
    const now = Date.parse('2026-09-22T12:00:00Z');
    expect(parseRetryAfterMs('Tue, 22 Sep 2026 12:00:03 GMT', now)).toBe(3_000);
    expect(parseRetryAfterMs('invalid', now)).toBeNull();
  });
});

describe('searchGooglePlaces', () => {
  it('uses the fixed endpoint, headers and minimal field mask without putting the key in the body', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse({
      places: [{
        id: 'place-1',
        displayName: { text: 'Example Merchant', languageCode: 'en' },
        formattedAddress: '1 Main St',
        location: { latitude: 41, longitude: -73 },
        internationalPhoneNumber: '+1 555-0100',
        nationalPhoneNumber: '(555) 0100',
        websiteUri: 'https://example.com',
        businessStatus: 'OPERATIONAL',
        googleMapsUri: 'https://maps.google.com/example',
      }],
    })]);

    const result = await searchGooglePlaces(input, 'synthetic-test-key', { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(GOOGLE_PLACES_TEXT_SEARCH_URL);
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toMatchObject({
      'X-Goog-Api-Key': 'synthetic-test-key',
      'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
    });
    expect(calls[0].init?.body).not.toContain('synthetic-test-key');
    expect(result).toMatchObject({ resultCount: 1, pageCount: 1, partial: false });
    expect(result.results[0]).toEqual({
      placeId: 'place-1',
      businessName: 'Example Merchant',
      formattedAddress: '1 Main St',
      location: { latitude: 41, longitude: -73 },
      internationalPhoneNumber: '+1 555-0100',
      nationalPhoneNumber: '(555) 0100',
      websiteUrl: 'https://example.com',
      businessStatus: 'OPERATIONAL',
      googleMapsUrl: 'https://maps.google.com/example',
    });
  });

  it('reads at most three pages, preserves request parameters and deduplicates Place IDs', async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse({ places: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'token-2' }),
      jsonResponse({ places: [{ id: 'b' }, { id: 'c' }], nextPageToken: 'token-3' }),
      jsonResponse({ places: [{ id: 'd' }], nextPageToken: 'token-4' }),
    ]);

    const result = await searchGooglePlaces(input, 'key', { fetchImpl });
    const bodies = calls.map((call) => JSON.parse(String(call.init?.body)));

    expect(calls).toHaveLength(3);
    expect(bodies.map((body) => body.pageToken)).toEqual([undefined, 'token-2', 'token-3']);
    for (const body of bodies) {
      expect(body.textQuery).toBe(input.textQuery);
      expect(body.pageSize).toBe(20);
      expect(body.locationRestriction).toEqual(bodies[0].locationRestriction);
    }
    expect(result.results.map((place) => place.placeId)).toEqual(['a', 'b', 'c', 'd']);
    expect(result).toMatchObject({
      resultCount: 4,
      pageCount: 3,
      possiblyTruncated: true,
      partial: false,
    });
  });

  it('marks 60 raw results as possibly truncated even after deduplication', async () => {
    const places = Array.from({ length: 20 }, (_, index) => ({ id: `place-${index}` }));
    const { fetchImpl } = queuedFetch([
      jsonResponse({ places, nextPageToken: 'two' }),
      jsonResponse({ places, nextPageToken: 'three' }),
      jsonResponse({ places }),
    ]);

    const result = await searchGooglePlaces(input, 'key', { fetchImpl });
    expect(result.resultCount).toBe(20);
    expect(result.possiblyTruncated).toBe(true);
  });

  it('returns explicit partial results when a later page fails', async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse({ places: [{ id: 'a' }], nextPageToken: 'two' }),
      jsonResponse({ error: 'upstream details must not be exposed' }, 400),
    ]);

    await expect(searchGooglePlaces(input, 'key', { fetchImpl })).resolves.toEqual({
      results: [{
        placeId: 'a',
        businessName: null,
        formattedAddress: null,
        location: null,
        internationalPhoneNumber: null,
        nationalPhoneNumber: null,
        websiteUrl: null,
        businessStatus: null,
        googleMapsUrl: null,
      }],
      resultCount: 1,
      pageCount: 1,
      possiblyTruncated: true,
      partial: true,
      warning: '后续页面获取失败，当前仅显示已取得的部分结果',
    });
  });

  it('retries 429 once and respects Retry-After', async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse({}, 429, { 'Retry-After': '1' }),
      jsonResponse({ places: [] }),
    ]);
    const delays: number[] = [];

    await searchGooglePlaces(input, 'key', {
      fetchImpl,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    });

    expect(calls).toHaveLength(2);
    expect(delays).toEqual([1_000]);
  });

  it('never exceeds six outbound attempts across three retried pages', async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse({}, 503),
      jsonResponse({ places: [{ id: 'a' }], nextPageToken: 'two' }),
      jsonResponse({}, 503),
      jsonResponse({ places: [{ id: 'b' }], nextPageToken: 'three' }),
      jsonResponse({}, 503),
      jsonResponse({ places: [{ id: 'c' }], nextPageToken: 'four' }),
    ]);

    const result = await searchGooglePlaces(input, 'key', {
      fetchImpl,
      sleep: async () => undefined,
    });

    expect(calls).toHaveLength(6);
    expect(result.results.map((place) => place.placeId)).toEqual(['a', 'b', 'c']);
    expect(result.possiblyTruncated).toBe(true);
  });

  it.each([
    [400, 'upstream_client_error'],
    [429, 'rate_limited'],
    [503, 'upstream_server_error'],
  ] as const)('classifies exhausted HTTP %s responses as %s', async (status, code) => {
    const responses = status === 400
      ? [jsonResponse({}, status)]
      : [jsonResponse({}, status), jsonResponse({}, status)];
    const { fetchImpl } = queuedFetch(responses);

    await expect(searchGooglePlaces(input, 'key', {
      fetchImpl,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code, upstreamStatus: status });
  });

  it('rejects malformed JSON and invalid response schemas', async () => {
    const malformed = queuedFetch([new Response('{', { status: 200 })]);
    await expect(searchGooglePlaces(input, 'key', { fetchImpl: malformed.fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_json' });

    const invalid = queuedFetch([jsonResponse({ places: [{ displayName: { text: 'No ID' } }] })]);
    await expect(searchGooglePlaces(input, 'key', { fetchImpl: invalid.fetchImpl }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('retries network failures once and classifies request timeout', async () => {
    let networkCalls = 0;
    const networkFetch: typeof fetch = async () => {
      networkCalls += 1;
      throw new Error('synthetic network failure');
    };
    await expect(searchGooglePlaces(input, 'key', {
      fetchImpl: networkFetch,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: 'network_error' });
    expect(networkCalls).toBe(2);

    let timeoutCalls = 0;
    const timeoutFetch: typeof fetch = async (_request, init) => new Promise((_resolve, reject) => {
      timeoutCalls += 1;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
    await expect(searchGooglePlaces(input, 'key', {
      fetchImpl: timeoutFetch,
      sleep: async () => undefined,
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: 'timeout' });
    expect(timeoutCalls).toBe(2);
  });

  it('fails clearly when the API key is not configured', async () => {
    await expect(searchGooglePlaces(input, '   ')).rejects.toBeInstanceOf(GooglePlacesError);
    await expect(searchGooglePlaces(input, '')).rejects.toMatchObject({ code: 'not_configured' });
  });
});
