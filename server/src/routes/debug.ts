/**
 * Debug 工具测试路由
 *
 * 提供无鉴权的泛用工具调用端点，供前端 debug 页面直接测试搜索工具效果。
 * 非生产用途。
 */

import { Router } from 'express';
import { executeSearchSkuShape } from '../tools/search-shape.js';
import { executeSearchSkuDescription } from '../tools/search-description.js';
import { executeSearchSkuOverlap } from '../tools/search-overlap.js';
import { executeSearchSkuStructured } from '../tools/search-structured.js';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { debugToolSchema } from '../validation/schemas.js';

export const debugRouter = Router();

const EXECUTORS: Record<string, (args: Record<string, unknown>) => string | Promise<string>> = {
  searchSkuShape: executeSearchSkuShape,
  searchSkuDescription: executeSearchSkuDescription,
  searchSkuOverlap: executeSearchSkuOverlap,
  searchSkuStructured: executeSearchSkuStructured,
};

debugRouter.post('/debug/tool', requireAdmin, validate(debugToolSchema), async (req, res) => {
  try {
    const { tool, args } = req.body as { tool?: string; args?: Record<string, unknown> };

    if (!tool) {
      res.status(400).json({ error: '缺少 tool 字段' });
      return;
    }

    const executor = EXECUTORS[tool];
    if (!executor) {
      res.status(400).json({ error: `未知工具: ${tool}，可用: ${Object.keys(EXECUTORS).join(', ')}` });
      return;
    }

    const output = await executor(args ?? {});
    res.json({ output });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[debug/tool] 执行失败:', message);
    res.status(500).json({ error: message });
  }
});
