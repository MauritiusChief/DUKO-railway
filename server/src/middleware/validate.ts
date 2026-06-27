/**
 * Zod 校验中间件
 *
 * 泛型工厂函数，返回 Express 中间件。
 * 对 req.body 执行 Zod schema 校验，失败则返回 400 + 格式化错误信息。
 */

import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema, ZodError } from 'zod';

/** 将 ZodError 转为人类可读的字符串 */
function formatZodError(error: ZodError): string {
  return error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
}

/** 创建校验中间件，对 req.body 执行 schema.parse */
export function validate<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        error: '请求参数校验失败',
        detail: formatZodError(result.error),
      });
      return;
    }
    // 用校验后的值替换 req.body（确保默认值/类型转换生效）
    req.body = result.data;
    next();
  };
}
