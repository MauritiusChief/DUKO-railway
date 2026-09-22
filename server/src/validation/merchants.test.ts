import { describe, expect, it } from 'vitest';
import {
  CONTIGUOUS_US_BOUNDS,
  MAX_MERCHANT_RANGE_KM,
  merchantSearchSchema,
} from './merchants.js';

const validRequest = {
  textQuery: 'kitchen cabinet stores',
  centerCoordinates: '41.02518681565052, -73.65277742711385',
  rangeKm: 10,
};

describe('merchantSearchSchema', () => {
  it('trims the query and parses coordinates with surrounding whitespace', () => {
    expect(merchantSearchSchema.parse({
      ...validRequest,
      textQuery: '  cabinet stores  ',
      centerCoordinates: ' 41.02518681565052 ,  -73.65277742711385 ',
    })).toEqual({
      textQuery: 'cabinet stores',
      centerCoordinates: {
        latitude: 41.02518681565052,
        longitude: -73.65277742711385,
      },
      rangeKm: 10,
    });
  });

  it.each([
    '',
    '41',
    '41,-73,10',
    'north,-73',
    'NaN,-73',
    'Infinity,-73',
  ])('rejects malformed coordinates: %s', (centerCoordinates) => {
    expect(merchantSearchSchema.safeParse({ ...validRequest, centerCoordinates }).success).toBe(false);
  });

  it('accepts the contiguous-US bounding-box edges', () => {
    const { minLatitude, maxLatitude, minLongitude, maxLongitude } = CONTIGUOUS_US_BOUNDS;
    expect(merchantSearchSchema.safeParse({
      ...validRequest,
      centerCoordinates: `${minLatitude},${minLongitude}`,
    }).success).toBe(true);
    expect(merchantSearchSchema.safeParse({
      ...validRequest,
      centerCoordinates: `${maxLatitude},${maxLongitude}`,
    }).success).toBe(true);
  });

  it.each([
    '64.2008,-149.4937',
    '21.3099,-157.8581',
    '51,-100',
    '40,-130',
    '40,-60',
  ])('rejects coordinates outside the contiguous-US bounding box: %s', (centerCoordinates) => {
    expect(merchantSearchSchema.safeParse({ ...validRequest, centerCoordinates }).success).toBe(false);
  });

  it('enforces a positive range no greater than 50 km', () => {
    expect(merchantSearchSchema.safeParse({ ...validRequest, rangeKm: 0 }).success).toBe(false);
    expect(merchantSearchSchema.safeParse({ ...validRequest, rangeKm: -1 }).success).toBe(false);
    expect(merchantSearchSchema.safeParse({
      ...validRequest,
      rangeKm: MAX_MERCHANT_RANGE_KM,
    }).success).toBe(true);
    expect(merchantSearchSchema.safeParse({
      ...validRequest,
      rangeKm: MAX_MERCHANT_RANGE_KM + 0.01,
    }).success).toBe(false);
  });
});
