import { z } from 'zod';
import type { MerchantSearchInput } from '../validation/merchants.js';

export const GOOGLE_PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const GOOGLE_PLACES_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.internationalPhoneNumber',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.businessStatus',
  'places.googleMapsUri',
  'nextPageToken',
].join(',');

const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const MAX_RESULTS = 60;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;
const PARTIAL_RESULTS_WARNING = '后续页面获取失败，当前仅显示已取得的部分结果';

const googlePlaceSchema = z.object({
  id: z.string().min(1),
  displayName: z.object({
    text: z.string(),
    languageCode: z.string().optional(),
  }).optional(),
  formattedAddress: z.string().optional(),
  location: z.object({
    latitude: z.number().finite(),
    longitude: z.number().finite(),
  }).optional(),
  internationalPhoneNumber: z.string().optional(),
  nationalPhoneNumber: z.string().optional(),
  websiteUri: z.string().optional(),
  businessStatus: z.string().optional(),
  googleMapsUri: z.string().optional(),
});

const googleSearchResponseSchema = z.object({
  places: z.array(googlePlaceSchema).optional().default([]),
  nextPageToken: z.string().min(1).optional(),
});

type GooglePlace = z.infer<typeof googlePlaceSchema>;

export interface MerchantSearchResult {
  placeId: string;
  businessName: string | null;
  formattedAddress: string | null;
  location: { latitude: number; longitude: number } | null;
  internationalPhoneNumber: string | null;
  nationalPhoneNumber: string | null;
  websiteUrl: string | null;
  businessStatus: string | null;
  googleMapsUrl: string | null;
}

export interface MerchantSearchResponse {
  results: MerchantSearchResult[];
  resultCount: number;
  pageCount: number;
  possiblyTruncated: boolean;
  partial: boolean;
  warning?: string;
}

export type GooglePlacesErrorCode =
  | 'not_configured'
  | 'timeout'
  | 'network_error'
  | 'rate_limited'
  | 'upstream_server_error'
  | 'upstream_client_error'
  | 'invalid_json'
  | 'invalid_response';

export class GooglePlacesError extends Error {
  constructor(
    public readonly code: GooglePlacesErrorCode,
    public readonly upstreamStatus?: number,
  ) {
    super(code);
    this.name = 'GooglePlacesError';
  }
}

interface GooglePlacesDependencies {
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

interface SearchRequestBody {
  textQuery: string;
  pageSize: number;
  locationRestriction: {
    rectangle: {
      low: { latitude: number; longitude: number };
      high: { latitude: number; longitude: number };
    };
  };
  pageToken?: string;
}

export function calculateSearchRectangle(
  center: MerchantSearchInput['centerCoordinates'],
  rangeKm: number,
): SearchRequestBody['locationRestriction']['rectangle'] {
  const latitudeDelta = rangeKm / 111;
  const longitudeDelta = rangeKm / (111 * Math.cos(center.latitude * Math.PI / 180));

  return {
    low: {
      latitude: center.latitude - latitudeDelta,
      longitude: center.longitude - longitudeDelta,
    },
    high: {
      latitude: center.latitude + latitudeDelta,
      longitude: center.longitude + longitudeDelta,
    },
  };
}

export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
  }

  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.min(Math.max(0, retryAt - nowMs), MAX_RETRY_DELAY_MS);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function mapHttpError(status: number): GooglePlacesError {
  if (status === 429) return new GooglePlacesError('rate_limited', status);
  if (status >= 500) return new GooglePlacesError('upstream_server_error', status);
  return new GooglePlacesError('upstream_client_error', status);
}

function toMerchantResult(place: GooglePlace): MerchantSearchResult {
  return {
    placeId: place.id,
    businessName: place.displayName?.text ?? null,
    formattedAddress: place.formattedAddress ?? null,
    location: place.location ?? null,
    internationalPhoneNumber: place.internationalPhoneNumber ?? null,
    nationalPhoneNumber: place.nationalPhoneNumber ?? null,
    websiteUrl: place.websiteUri ?? null,
    businessStatus: place.businessStatus ?? null,
    googleMapsUrl: place.googleMapsUri ?? null,
  };
}

async function fetchSearchPage(
  body: SearchRequestBody,
  apiKey: string,
  dependencies: Required<GooglePlacesDependencies>,
): Promise<z.infer<typeof googleSearchResponseSchema>> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs);

    try {
      const response = await dependencies.fetchImpl(GOOGLE_PLACES_TEXT_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GOOGLE_PLACES_FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        if (attempt < MAX_RETRIES && isRetryableStatus(response.status)) {
          const retryAfter = parseRetryAfterMs(response.headers.get('Retry-After'), dependencies.now());
          await dependencies.sleep(retryAfter ?? DEFAULT_RETRY_DELAY_MS);
          continue;
        }
        throw mapHttpError(response.status);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new GooglePlacesError('invalid_json');
      }

      const parsed = googleSearchResponseSchema.safeParse(raw);
      if (!parsed.success) throw new GooglePlacesError('invalid_response');
      return parsed.data;
    } catch (error) {
      if (error instanceof GooglePlacesError) throw error;

      const code: GooglePlacesErrorCode = controller.signal.aborted ? 'timeout' : 'network_error';
      if (attempt < MAX_RETRIES) {
        await dependencies.sleep(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw new GooglePlacesError(code);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new GooglePlacesError('network_error');
}

export async function searchGooglePlaces(
  input: MerchantSearchInput,
  apiKey: string,
  overrides: GooglePlacesDependencies = {},
): Promise<MerchantSearchResponse> {
  if (!apiKey.trim()) throw new GooglePlacesError('not_configured');

  const dependencies: Required<GooglePlacesDependencies> = {
    fetchImpl: overrides.fetchImpl ?? globalThis.fetch,
    sleep: overrides.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    now: overrides.now ?? Date.now,
    timeoutMs: overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const baseBody: SearchRequestBody = {
    textQuery: input.textQuery,
    pageSize: PAGE_SIZE,
    locationRestriction: {
      rectangle: calculateSearchRectangle(input.centerCoordinates, input.rangeKm),
    },
  };
  const resultsById = new Map<string, MerchantSearchResult>();
  let rawResultCount = 0;
  let pageCount = 0;
  let nextPageToken: string | undefined;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let response: z.infer<typeof googleSearchResponseSchema>;
    try {
      response = await fetchSearchPage(
        nextPageToken ? { ...baseBody, pageToken: nextPageToken } : baseBody,
        apiKey,
        dependencies,
      );
    } catch (error) {
      if (page === 1) throw error;
      const results = [...resultsById.values()];
      return {
        results,
        resultCount: results.length,
        pageCount,
        possiblyTruncated: true,
        partial: true,
        warning: PARTIAL_RESULTS_WARNING,
      };
    }

    pageCount += 1;
    rawResultCount += response.places.length;
    for (const place of response.places) {
      if (!resultsById.has(place.id)) resultsById.set(place.id, toMerchantResult(place));
    }

    nextPageToken = response.nextPageToken;
    if (!nextPageToken) break;
  }

  const results = [...resultsById.values()];
  return {
    results,
    resultCount: results.length,
    pageCount,
    possiblyTruncated: rawResultCount >= MAX_RESULTS || (pageCount === MAX_PAGES && Boolean(nextPageToken)),
    partial: false,
  };
}
