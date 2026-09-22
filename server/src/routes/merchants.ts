import express, { Router, type ErrorRequestHandler } from 'express';
import { config } from '../config/env.js';
import { requireAnyRole } from '../middleware/auth.js';
import {
  merchantSearchLimiter,
  merchantWebsiteConcurrencyLimiter,
  merchantWebsiteLimiter,
} from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import {
  GooglePlacesError,
  searchGooglePlaces,
  type MerchantSearchResponse,
} from '../services/google-places.js';
import {
  WebsiteExtractionError,
  extractWebsiteContacts,
  type WebsiteExtractionResult,
} from '../services/website-contact-extractor.js';
import {
  merchantSearchSchema,
  merchantWebsiteExtractionSchema,
  type MerchantSearchInput,
  type MerchantWebsiteExtractionInput,
} from '../validation/merchants.js';

type MerchantSearchService = (
  input: MerchantSearchInput,
  apiKey: string,
) => Promise<MerchantSearchResponse>;

type WebsiteExtractionService = (
  input: MerchantWebsiteExtractionInput,
  options?: { signal?: AbortSignal },
) => Promise<WebsiteExtractionResult>;

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
  router.use(merchantSearchLimiter);

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

function statusForWebsiteExtractionError(error: WebsiteExtractionError): number {
  switch (error.code) {
    case 'invalid_url':
    case 'blocked_address':
      return 400;
    case 'response_too_large':
      return 413;
    case 'unsupported_content_type':
    case 'unsupported_content_encoding':
      return 415;
    case 'timeout':
      return 504;
    case 'dns_failed':
    case 'too_many_redirects':
    case 'upstream_http_error':
    case 'network_error':
      return 502;
  }
}

function messageForWebsiteExtractionError(error: WebsiteExtractionError): string {
  switch (error.code) {
    case 'invalid_url':
      return '官网 URL 格式无效';
    case 'blocked_address':
      return '该官网地址不允许访问';
    case 'response_too_large':
      return '官网首页内容超过大小限制';
    case 'unsupported_content_type':
    case 'unsupported_content_encoding':
      return '官网首页不是支持的 HTML 内容';
    case 'timeout':
      return '官网首页请求超时';
    default:
      return '官网首页暂时无法提取';
  }
}

export function createMerchantWebsiteRouter(
  extract: WebsiteExtractionService = extractWebsiteContacts,
): Router {
  const router = Router();
  router.use(requireAnyRole('admin', 'manager'));
  router.use(merchantWebsiteLimiter);
  router.use(express.json({ limit: '8kb' }));
  router.use(merchantWebsiteConcurrencyLimiter);

  router.post('/extract', validate(merchantWebsiteExtractionSchema), async (req, res) => {
    const controller = new AbortController();
    const abortIfDisconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', abortIfDisconnected);

    try {
      const result = await extract(req.body as MerchantWebsiteExtractionInput, {
        signal: controller.signal,
      });
      res.json(result);
    } catch (error) {
      if (error instanceof WebsiteExtractionError) {
        res.status(statusForWebsiteExtractionError(error)).json({
          error: messageForWebsiteExtractionError(error),
          code: error.code,
        });
        return;
      }
      res.status(500).json({ error: '官网首页提取失败', code: 'internal_error' });
    } finally {
      res.removeListener('close', abortIfDisconnected);
    }
  });

  const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    const type = (error as { type?: string }).type;
    if (type === 'entity.too.large') {
      res.status(413).json({ error: '官网提取请求体过大', code: 'request_too_large' });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: '请求 JSON 格式无效', code: 'invalid_json' });
      return;
    }
    next(error);
  };
  router.use(jsonErrorHandler);

  return router;
}

export const merchantWebsiteRouter = createMerchantWebsiteRouter();
