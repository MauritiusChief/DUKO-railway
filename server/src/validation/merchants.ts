import { z } from 'zod';

/** Approximate bounding box for the contiguous United States. */
export const CONTIGUOUS_US_BOUNDS = {
  minLatitude: 24.396308,
  maxLatitude: 49.384358,
  minLongitude: -124.848974,
  maxLongitude: -66.885444,
} as const;

export const MAX_MERCHANT_RANGE_KM = 50;

const centerCoordinatesSchema = z.string().trim().transform((value, ctx) => {
  const parts = value.split(',');
  if (parts.length !== 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '中心坐标必须是“纬度, 经度”格式',
    });
    return z.NEVER;
  }

  const latitude = Number(parts[0].trim());
  const longitude = Number(parts[1].trim());
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '中心坐标必须包含两个有效数字',
    });
    return z.NEVER;
  }

  const bounds = CONTIGUOUS_US_BOUNDS;
  if (
    latitude < bounds.minLatitude
    || latitude > bounds.maxLatitude
    || longitude < bounds.minLongitude
    || longitude > bounds.maxLongitude
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: '中心坐标必须位于美国本土连续 48 州范围内',
    });
    return z.NEVER;
  }

  return { latitude, longitude };
});

export const merchantSearchSchema = z.object({
  textQuery: z.string().trim().min(1, '查询词不能为空').max(200, '查询词不能超过 200 个字符'),
  centerCoordinates: centerCoordinatesSchema,
  rangeKm: z.number()
    .finite('查询范围必须是有效数字')
    .positive('查询范围必须大于 0')
    .max(MAX_MERCHANT_RANGE_KM, `查询范围不能超过 ${MAX_MERCHANT_RANGE_KM} km`),
});

export type MerchantSearchInput = z.infer<typeof merchantSearchSchema>;

export const merchantWebsiteExtractionSchema = z.object({
  placeId: z.string().trim().min(1, 'Place ID 不能为空').max(256, 'Place ID 过长'),
  websiteUrl: z.string().trim().min(1, '官网 URL 不能为空').max(2_048, '官网 URL 过长').superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '官网 URL 只允许 http 或 https' });
      }
      if (url.username || url.password) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '官网 URL 不允许包含用户名或密码' });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '官网 URL 格式无效' });
    }
  }),
});

export type MerchantWebsiteExtractionInput = z.infer<typeof merchantWebsiteExtractionSchema>;
