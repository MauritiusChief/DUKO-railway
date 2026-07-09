/**
 * 布局物料清单路由
 *
 * POST /api/layout/generate-list —— 根据当前布局生成完整物料清单文本。
 * 非 LLM 端点，纯算法计算，由 layout-material-list 服务处理。
 */
import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import { layoutGenerateListSchema } from '../validation/schemas.js';
import { generateMaterialList } from '../services/layout-material-list.js';
import type { LayoutDocument } from '../types/layout.js';

export const layoutGenerateListRouter = Router();

// POST /api/layout/generate-list —— 生成完整物料清单
layoutGenerateListRouter.post(
  '/layout/generate-list',
  validate(layoutGenerateListSchema),
  (req, res) => {
    const { layout } = req.body as { layout: LayoutDocument };
    const result = generateMaterialList(layout);
    res.json(result);
  },
);
