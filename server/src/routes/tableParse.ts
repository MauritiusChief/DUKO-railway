/**
 * TableParse 路由 —— 表格解析 + 颜色查询 + 产品生成
 *
 * POST /api/table-parse    → TableParseAgent (SSE 流式)
 * GET  /api/colors         → 颜色代码对照表
 * POST /api/check-exposed  → 批量校验 Exposed-Items 匹配
 * POST /api/generate-products → 将 ParsedItem 转为 Product 列表
 *
 * SSE 事件（仅 /api/table-parse，reply_chunk 来自 LLM 原生流式）：
 *   round_start → { round: number }    — 新一轮 LLM 调用开始（非首轮时客户端清空前轮暂存回复）
 *   tool_call   → { tool: string }     — Agent 调用了搜索工具
 *   reply_chunk → { text: string }     — LLM 实时生成的回复片段
 *   reply_done  → {}                   — 回复推送完毕
 *   result      → { items }            — 结构化解析结果（每项自带 status / colorIgnored / shapeSizeIgnored）
 *   done        → {}                   — 流程结束
 *   error       → { message: string }  — 错误
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { createDeepSeekProvider } from '../llm/index.js';
import { config } from '../config/env.js';
import { TableParseAgent } from '../agents/table-parse-agent.js';
import { SSEConnection } from '../middleware/sse.js';
import { validate } from '../middleware/validate.js';
import {
  tableParseSchema,
  checkExposedSchema,
  generateProductsSchema,
} from '../validation/schemas.js';
import { getColorEntries } from '../services/utils.js';
import { findComboExists, findRecordByItemNameCI, getItemRow, getPartRow, getAllItemRows } from '../db/sku.js';
import { insertRecord } from '../db/users.js';
import { insertTraceSession, markSessionCompleted, markSessionError } from '../services/trace.js';
import type { TraceContext } from '../types/trace.js';
import { ACCESSORY_SHAPE_TYPE_CODES, SHAPE_TYPES_COLOR_NA, SHAPE_TYPES_SIZE_NA, NONE_EURO_COLOR_MAPPED_SHAPE_TYPE_CODES, EURO_COLOR_MAPPED_SHAPE_TYPE_CODES, ACCESSORY_COLOR_REMAP } from '../constants.js';

export const tableParseRouter = Router();

/** LLM 路由组 —— 仅含 POST /table-parse（SSE 流式），独立限流 */
export const tableParseLlmRouter = Router();

// ==================================================================
//  GET /api/colors
// ==================================================================

tableParseRouter.get('/colors', (_req: Request, res: Response) => {
  res.json(getColorEntries());
});

// ==================================================================
//  POST /api/check-exposed
// ==================================================================

tableParseRouter.post('/check-exposed', validate(checkExposedSchema), (req: Request, res: Response) => {
  const { combos } = req.body as {
    combos?: ({ colorCode: string; shapeTypeCode: string; shapeSizeCode: string } | null)[];
  };

  if (!combos || !Array.isArray(combos)) {
    res.status(400).json({ error: 'combos array is required' });
    return;
  }

  const results = combos.map((combo) => {
    if (combo === null) return null;
    if (!combo.shapeTypeCode) return null;

    // 使用 SQLite 索引查询（不区分大小写）
    return findComboExists(
      combo.colorCode || '',
      combo.shapeTypeCode,
      combo.shapeSizeCode || '',
    );
  });

  res.json({ results });
});

// ==================================================================
//  POST /api/generate-products
// ==================================================================

/** 产品生成请求中单个 ParsedItem 字段的形状 */
interface GenerateFieldInput {
  values: string[];
}

/** 产品生成请求体 */
interface GenerateProductsRequest {
  items: {
    originalName: string;
    color: GenerateFieldInput;
    shapeType: GenerateFieldInput;
    shapeSize: GenerateFieldInput;
    quantity: number;
    /** 定制要求：undefined=取全部零件, "door"=仅柜门, "box"=仅柜体(不含额外件) */
    customRequirement?: 'door' | 'box';
  }[];
}

/** 产品列表中单个条目 */
interface ProductEntry {
  productName: string;
  description: string;
  quantity: number;
}

tableParseRouter.post('/generate-products', validate(generateProductsSchema), (_req: Request, res: Response) => {
  const { items } = _req.body as GenerateProductsRequest;

  if (!items || !Array.isArray(items)) {
    res.status(400).json({ error: 'items array is required' });
    return;
  }

  // sharedPartName → quantity 聚合
  const productQtyMap = new Map<string, ProductEntry>();
  const unresolvedIndices: number[] = [];

  for (let i = 0; i < items.length; i++) {
    const row = items[i];
    const colorVals = row.color?.values;
    const typeVals = row.shapeType?.values;
    const sizeVals = row.shapeSize?.values;

    // 获取形状型号代码
    const typeCode = (Array.isArray(typeVals) && typeVals.length > 0)
      ? typeVals[0].toUpperCase()
      : '';

    // 忽略标记：动态派生自形状型号，随用户编辑自动跟随
    const colorIsNA = typeCode.length > 0 && SHAPE_TYPES_COLOR_NA.has(typeCode);
    const sizeIsNA = typeCode.length > 0 && SHAPE_TYPES_SIZE_NA.has(typeCode);

    // 任一必填字段未确认 → 跳过并标记为未解析
    if (
      (!colorIsNA && (!Array.isArray(colorVals) || colorVals.length !== 1)) ||
      !Array.isArray(typeVals) || typeVals.length !== 1 ||
      (!sizeIsNA && (!Array.isArray(sizeVals) || sizeVals.length !== 1))
    ) {
      unresolvedIndices.push(i);
      continue;
    }

    // 构建 itemName（统一大写）
    const colorStr = colorIsNA ? '' : colorVals[0].toUpperCase();
    const typeStr = typeVals[0].toUpperCase();
    const sizeStr = sizeIsNA ? '' : sizeVals[0].toUpperCase();

    // 换色配件：29→02, 32→12
    let effectiveColorStr = colorStr;
    if (typeStr && colorStr && ACCESSORY_COLOR_REMAP[colorStr]) {
      const targetColor = ACCESSORY_COLOR_REMAP[colorStr];
      if (targetColor === '02' && NONE_EURO_COLOR_MAPPED_SHAPE_TYPE_CODES.has(typeStr)) {
        effectiveColorStr = targetColor;
      } else if (targetColor === '12' && EURO_COLOR_MAPPED_SHAPE_TYPE_CODES.has(typeStr)) {
        effectiveColorStr = targetColor;
      }
    }

    // 特殊处理GD
    let itemName = typeStr === 'GD' ? 'Glass Doors' : (effectiveColorStr + typeStr + sizeStr);

    const qty = typeof row.quantity === 'number' && row.quantity > 0 ? Math.round(row.quantity) : 1;

    // 先查 SQLite Exposed-Items 是否为复合物品（subItemsName 非空则需拆解为子项）
    const exposedRecord = findRecordByItemNameCI(itemName);
    const itemNamesToResolve: string[] = [];

    if (exposedRecord?.subItemsName) {
      // 复合物品：按逗号拆分 subItemsName，每个子项独立参与聚合
      const subNames = exposedRecord.subItemsName.split(',').map((s) => s.trim()).filter(Boolean);
      itemNamesToResolve.push(...subNames);
    } else {
      itemNamesToResolve.push(itemName);
    }

    let resolvedCount = 0;

    for (const resolveName of itemNamesToResolve) {
      const itemRow = getItemRow(resolveName);
      if (!itemRow) continue;

      // 根据定制要求过滤零件：
      //   undefined/"-" → 全部零件 (doorPart + cabinetPart + extraPart)
      //   "door" → 仅 doorPart
      //   "box" → 仅 cabinetPart（不含 extraPart）
      const cr = row.customRequirement;
      const partNames = new Set<string>();
      if (itemRow.doorPart && (!cr || cr === 'door')) {
        partNames.add(itemRow.doorPart);
      }
      if (itemRow.cabinetPart && (!cr || cr === 'box')) {
        partNames.add(itemRow.cabinetPart);
      }
      if (itemRow.extraPart && !cr) {
        partNames.add(itemRow.extraPart);
      }

      for (const partName of partNames) {
        const partRow = getPartRow(partName);
        const sharedPartName = partRow?.sharedPartName || partName;

        const existing = productQtyMap.get(sharedPartName);
        if (existing) {
          existing.quantity += qty;
        } else {
          productQtyMap.set(sharedPartName, {
            productName: sharedPartName,
            description: partRow?.description || '',
            quantity: qty,
          });
        }
      }

      resolvedCount++;
    }

    // 若复合物品所有子项均无法解析，或普通物品在 items 表中找不到 → 未解析
    if (resolvedCount === 0) {
      unresolvedIndices.push(i);
    }
  }

  // 从 items 表中找出所有配件 shapeType 对应的 sharedPartName，
  // 用于将配件产品排在最终结果末尾
  const accSharedParts = new Set<string>();
  for (const itemRow of getAllItemRows()) {
    if (ACCESSORY_SHAPE_TYPE_CODES.includes(itemRow.shapeTypeCode)) {
      const partNames = new Set(
        [itemRow.doorPart, itemRow.cabinetPart, itemRow.extraPart].filter(Boolean),
      );
      for (const partName of partNames) {
        const partRow = getPartRow(partName);
        accSharedParts.add(partRow?.sharedPartName || partName);
      }
    }
  }

  // 排序：非配件在前、配件在后；同组内按 productName 字母排序
  const products = [...productQtyMap.values()].sort((a, b) => {
    const aIsAcc = accSharedParts.has(a.productName) ? 1 : 0;
    const bIsAcc = accSharedParts.has(b.productName) ? 1 : 0;
    if (aIsAcc !== bIsAcc) return aIsAcc - bIsAcc;
    return a.productName.localeCompare(b.productName);
  });

  res.json({
    products,
    unresolvedCount: unresolvedIndices.length,
    unresolvedIndices,
  });
});

// ==================================================================
//  POST /api/table-parse (SSE 流式)
// ==================================================================

tableParseLlmRouter.post('/', validate(tableParseSchema), async (req: Request, res: Response) => {
  const { input, colorHints, lang, notes, fromImage } = req.body as {
    input?: string;
    colorHints?: string[];
    lang?: string;
    notes?: Array<{ originalName: string; content: string }>;
    fromImage?: boolean;
  };

  if (!input || typeof input !== 'string' || !input.trim()) {
    res.status(400).json({ error: 'input is required' });
    return;
  }

  if (!config.deepseekApiKey) {
    res.status(500).json({
      error: 'LLM 未配置',
      detail: '请设置环境变量 DEEPSEEK_API_KEY',
    });
    return;
  }

  const sse = new SSEConnection(res);

  const llm = createDeepSeekProvider({
    apiKey: config.deepseekApiKey,
  });

  // ---- Trace：创建 session ----
  const traceEnabled = config.traceLog;
  let traceContext: TraceContext | undefined;
  if (traceEnabled) {
    const conversationId = randomUUID();
    traceContext = {
      conversationId,
      userId: req.user!.userId,
      username: req.user!.username,
      mainAgent: 'TableParseAgent',
      agentName: 'TableParseAgent',
      route: '/api/table-parse',
      provider: llm.providerName,
      model: llm.model,
      enabled: true,
    };
    insertTraceSession(
      conversationId,
      traceContext.userId,
      traceContext.username,
      traceContext.mainAgent,
      traceContext.agentName,
      null,
      traceContext.route,
      traceContext.provider,
      traceContext.model,
    );
  }

  const agent = new TableParseAgent(llm, {
    budgetLimit: 32,
    maxRounds: 40,
    langHint: '中文',
    onStep: (event) => {
      if (event.type === 'tool_call') {
        sse.send('tool_call', { tool: event.tool });
      } else if (event.type === 'reply_chunk') {
        sse.send('reply_chunk', { text: event.text });
      } else if (event.type === 'round_start') {
        sse.send('round_start', { round: event.round });
      }
    },
  });

  if (traceContext) {
    agent.trace = traceContext;
  }

  try {
    const result = await agent.parse({
      input,
      colorHints,
      lang,
      notes,
      fromImage,
    });

    if (traceContext) {
      markSessionCompleted(traceContext.conversationId);
    }

    sse.send('reply_done', {});

    sse.send('result', {
      items: result.items,
    });

    // 解析完成后自动保存历史记录
    const lineCount = input.split('\n').filter((l) => l.trim()).length;
    const conversation = [
      {
        role: 'parse_start' as const,
        content: '',
        meta: {
          lineCount,
          ...(colorHints && colorHints.length > 0 ? { colorCodes: colorHints } : {}),
        },
      },
      ...(result.reply
        ? [{ role: 'assistant' as const, content: result.reply }]
        : []),
    ];
    insertRecord(
      req.user!.userId,
      input,
      colorHints ?? [],
      JSON.stringify(result.items),
      JSON.stringify(conversation),
      lang ?? 'zh',
    );

    sse.send('done', {});
  } catch (err) {
    console.error('[table-parse] error:', err);
    if (traceContext) {
      markSessionError(traceContext.conversationId, err instanceof Error ? err.message : '解析失败');
    }
    sse.send('error', {
      message: err instanceof Error ? err.message : '解析失败',
    });
  } finally {
    sse.close();
  }
});
