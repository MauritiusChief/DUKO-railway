import { Router } from 'express';
import { config } from '../config/env.js';
import { requireAnyRole } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  GooglePlacesError,
  searchGooglePlaces,
  type MerchantSearchResponse,
} from '../services/google-places.js';
import { merchantSearchSchema, type MerchantSearchInput } from '../validation/merchants.js';

type MerchantSearchService = (
  input: MerchantSearchInput,
  apiKey: string,
) => Promise<MerchantSearchResponse>;

function statusForGooglePlacesError(error: GooglePlacesError): number {
  switch (error.code) {
    case 'not_configured':
    case 'rate_limited':
    case 'network_error':
    case 'upstream_server_error':
      return 503;
    case 'timeout':
      return 504;
    case 'upstream_client_error':
    case 'invalid_json':
    case 'invalid_response':
      return 502;
  }
}

function messageForGooglePlacesError(error: GooglePlacesError): string {
  if (error.code === 'not_configured') return 'Google Places 搜索尚未配置';
  if (error.code === 'timeout') return 'Google Places 搜索超时，请稍后重试';
  if (error.code === 'rate_limited') return 'Google Places 请求受限，请稍后重试';
  return 'Google Places 搜索暂时不可用，请稍后重试';
}

export function createMerchantsRouter(search: MerchantSearchService = searchGooglePlaces): Router {
  const router = Router();
  router.use(requireAnyRole('admin', 'manager'));

  router.post('/search', validate(merchantSearchSchema), async (req, res) => {
    try {
      const result = await search(req.body as MerchantSearchInput, config.googlePlacesApiKey);
      res.json(result);
    } catch (error) {
      if (error instanceof GooglePlacesError) {
        res.status(statusForGooglePlacesError(error)).json({
          error: messageForGooglePlacesError(error),
          code: error.code,
        });
        return;
      }

      res.status(500).json({ error: '商家搜索失败', code: 'internal_error' });
    }
  });

  return router;
}

export const merchantsRouter = createMerchantsRouter();
