/**
 * Zod 请求校验 Schema
 *
 * 为每个 API 端点定义输入结构，由 validate 中间件统一消费。
 * 仅校验顶层必填字段与类型；嵌套复杂类型使用 .passthrough() 保持实用。
 */

import { z } from 'zod';

/** POST /api/auth/login */
export const loginSchema = z.object({
  username: z.string().min(1, '请输入用户名'),
  password: z.string().min(1, '请输入密码'),
});

/** POST /api/auth/register */
export const registerSchema = z.object({
  username: z
    .string()
    .min(2, '用户名至少 2 个字符')
    .max(32, '用户名最长 32 个字符')
    .regex(/^[a-zA-Z0-9_-]+$/, '用户名只能包含字母、数字、下划线和连字符'),
  password: z.string().min(6, '密码至少 6 个字符').max(128, '密码最长 128 个字符'),
});

/** POST /api/table-parse */
export const tableParseSchema = z.object({
  input: z.string().min(1, '输入不能为空'),
  colorHints: z.array(z.string()).optional(),
  lang: z.string().optional(),
  notes: z
    .array(
      z.object({
        originalName: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
  fromImage: z.boolean().optional(),
});

/** POST /api/check-exposed */
export const checkExposedSchema = z.object({
  combos: z.array(
    z
      .object({
        colorCode: z.string(),
        shapeTypeCode: z.string(),
        shapeSizeCode: z.string(),
      })
      .nullable(),
  ),
});

/** POST /api/generate-products */
export const generateProductsSchema = z.object({
  items: z.array(
    z.object({
      originalName: z.string(),
      color: z.object({ values: z.array(z.string()) }),
      shapeType: z.object({ values: z.array(z.string()) }),
      shapeSize: z.object({ values: z.array(z.string()) }),
      quantity: z.number().int().min(1).default(1),
      customRequirement: z.enum(['door', 'box']).optional(),
    }),
  ),
});

/** POST /api/chat */
export const chatSchema = z.object({
  message: z.string().min(1, '消息不能为空'),
  lang: z.string().optional(),
  items: z.array(z.unknown()).optional(),
  products: z.array(z.unknown()).optional(),
  history: z.array(z.unknown()).optional(),
  notes: z.array(z.unknown()).optional(),
  mainAgentReply: z.string().optional(),
  initialInput: z.string().optional(),
  colorHints: z.array(z.string()).optional(),
});

/** POST /api/image-parse */
export const imageParseSchema = z.object({
  image: z.string().optional(),
  images: z.array(z.string()).optional(),
  colorHints: z.array(z.string()).optional(),
  lang: z.string().optional(),
  notes: z
    .array(
      z.object({
        originalName: z.string(),
        content: z.string(),
      }),
    )
    .optional(),
});

/** POST /api/layout/parse-image */
export const layoutParseSchema = z.object({
  image: z.string().min(1, '图片不能为空'),
  viewType: z.string().optional(),
  associatedWallIds: z.array(z.string()).optional(),
  layout: z.object({}).passthrough(),
});

/** POST /api/debug/tool */
export const debugToolSchema = z.object({
  tool: z.string().min(1, '工具名称不能为空'),
  args: z.record(z.unknown()).optional(),
});
