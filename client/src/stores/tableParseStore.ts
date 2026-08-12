/**
 * TableParse 状态管理 —— Zustand store
 *
 * 管理清单文本输入、颜色提示勾选、后端解析、表格编辑状态。
 */
import { create } from 'zustand';
import type { ColorEntry, ParsedItem, TableParseResponse, ProductEntry, GenerateProductsResponse, ConversationEntry } from '../types';
import { tOutside, getLang } from '../i18n/context';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import type { SSEEvent } from '../lib/sse';

// Shape types whose color field can be N/A (not tied to any specific color/finish)
export const SHAPE_TYPES_COLOR_NA = new Set(['GD', 'TCR']);

// Shape types whose size field can be N/A (no meaningful size distinction)
export const SHAPE_TYPES_SIZE_NA = new Set(['GD', 'CBL', 'TUK', 'SD']);

/** localStorage 键名 —— 存储解析结果表格与匹配状态 */
const STORAGE_KEY = 'duko_parsed_data';

/** 将解析结果同步写入 localStorage（仅存 items，status 等已内嵌在 item 中） */
function syncToStorage(items: ParsedItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items }));
  } catch {
    /* localStorage 不可用（无痕模式等），静默忽略 */
  }
}

/** 从 localStorage 读取缓存的解析结果，失败或不存在返回空 */
function loadFromStorage(): ParsedItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.items) ? parsed.items : [];
    }
  } catch {
    /* 数据损坏或格式不兼容，静默回退 */
  }
  return [];
}

// ---- check-exposed 缓存 ----
// 键：colorCode\x00shapeTypeCode\x00shapeSizeCode（全大写）
// 值：true=数据库中匹配，false=不匹配
// 同会话内数据库不变，缓存永久有效；页面刷新后自然清除。

/** 单条 combo 的形态（用于构建缓存键和 API 请求） */
type ComboInput = { colorCode: string; shapeTypeCode: string; shapeSizeCode: string };

const SEP = '\x00'; // null 字节，不会出现在合法 SKU 编码中

function makeExposedCacheKey(colorCode: string, shapeTypeCode: string, shapeSizeCode: string): string {
  return `${colorCode.toUpperCase()}${SEP}${shapeTypeCode.toUpperCase()}${SEP}${shapeSizeCode.toUpperCase()}`;
}

const exposedCache = new Map<string, boolean>();

/** 将 results[] 数组中的 status 和忽略标记写回到 items */
function applyStatusToItems(items: ParsedItem[], results: (boolean | null)[]): ParsedItem[] {
  return items.map((item, i) => {
    const result = results[i];
    const shapeTypeCode = item.shapeType.values.length > 0
      ? item.shapeType.values[0].toUpperCase()
      : '';
    const colorIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_COLOR_NA.has(shapeTypeCode);
    const sizeIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_SIZE_NA.has(shapeTypeCode);
    return {
      ...item,
      status: (result === null || !result ? 'missing' : 'found') as 'found' | 'missing',
      colorIgnored: colorIgnored || undefined,
      shapeSizeIgnored: sizeIgnored || undefined,
    };
  });
}

interface TableParseState {
  /** 用户粘贴的清单文本 */
  input: string;
  /** 已勾选的颜色提示 code 集合 */
  colorHints: Set<string>;
  /** 从服务端加载的可用颜色列表 */
  availableColors: ColorEntry[];
  /** 后端解析返回的表格行（每项自带 status / colorIgnored / shapeSizeIgnored） */
  items: ParsedItem[];
  /** 是否正在等待后端响应 */
  loading: boolean;
  /** 请求错误信息 */
  error: string;
  /** 是否通过历史记录自动恢复了本次解析结果（显示恢复提示用） */
  fromHistoryRestored: boolean;
  /** 生成的产品列表 */
  products: ProductEntry[];
  /** 是否正在生成产品 */
  productsLoading: boolean;
  /** 未解析的行数 */
  unresolvedCount: number;
  /** 未解析的行索引 */
  unresolvedIndices: number[];
  /** 五列表是否折叠（产品生成后自动折叠，可手动展开） */
  resultCollapsed: boolean;
  /** 三列表（产品清单）是否折叠 */
  productsCollapsed: boolean;

  // ---- 图片输入模式 ----

  /** 当前输入模式：text（文本）或 image（图片） */
  inputMode: 'text' | 'image';
  /** 用户上传的图片 base64 data URL 列表（支持多张图片表示同一清单） */
  imageDataList: string[];
  /** 图片预览 URL 列表（与 imageDataList 一一对应，用于 <img> 显示） */
  imagePreviewUrls: string[];
  /** 图片解析是否正在加载 */
  imageLoading: boolean;

  /** 当前输入文本是否来自图片解析（用于向 text agent 注入提醒） */
  fromImage: boolean;

  /** 设置输入文本 */
  setInput: (text: string) => void;
  /** 切换颜色提示复选框 */
  toggleColorHint: (code: string) => void;
  /** 覆盖所有颜色提示（供历史记录填充等场景） */
  setColorHints: (codes: string[]) => void;
  /** 加载可用颜色列表 */
  fetchColors: () => Promise<void>;
  /** 提交解析请求 */
  parseTable: () => Promise<void>;
  /** 更新某个 item 的某个字段的值 */
  updateItemField: (
    index: number,
    field: 'color' | 'shapeType' | 'shapeSize' | 'customRequirement' | 'quantity',
    value: string | number,
  ) => void;
  /** 删除某一行 */
  removeItem: (index: number) => void;
  /** 手动添加一个空行（所有字段为空，数量为 1，status 为 missing） */
  addEmptyItem: () => void;
  /** 重新检查所有行的 Exposed-Items 匹配状态（blur 后调用） */
  checkExposedItems: () => Promise<void>;
  /** 生成产品清单 */
  generateProducts: () => Promise<void>;
  /** 切换五列表折叠状态（展开时自动折叠三列表） */
  toggleResultCollapsed: () => void;
  /** 切换三列表折叠状态（展开时自动折叠五列表） */
  toggleProductsCollapsed: () => void;
  /** 将 productName 转为 CSV 字符串 */
  getProductsCsv: () => string;
  /** 复制 CSV 到剪贴板 */
  copyProductsCsv: () => Promise<void>;
  /** 复制 CSV 是否已完成（用于按钮反馈） */
  copySuccess: boolean;

  /** 将当前 items 下载为 JSON 存档文件 */
  saveArchive: () => void;
  /** 从存档 JSON 加载解析结果 */
  loadArchiveData: (items: ParsedItem[]) => void;
  /** 从 chat API 响应中替换整个 items（对话编辑后的结果） */
  replaceItems: (items: ParsedItem[]) => void;
  /** 从 chat API 响应中替换产品清单（对话编辑后的结果） */
  replaceProducts: (products: ProductEntry[]) => void;

  // ---- 解析清单事件（供 ChatPanel 订阅） ----

  /** 最近一次解析的输入行数（ChatPanel 显示缩写消息用） */
  parseInputLineCount: number;
  /** 解析过程中产生的事件回调（ChatPanel 在 useEffect 中设置） */
  parseEventCallback: ((event: SSEEvent) => void) | null;
  /** 供 ChatPanel 注册事件回调 */
  setParseEventCallback: (cb: ((event: SSEEvent) => void) | null) => void;

  // ---- 图片模式操作 ----

  /** 切换输入模式（text ↔ image） */
  setInputMode: (mode: 'text' | 'image') => void;

  // ---- 历史记录填充 ----

  /** 供 HistoryPage 设置待填充的对话记录，ChatPanel 消费后自动置 null */
  fillConversation: ConversationEntry[] | null;
  setFillConversation: (conv: ConversationEntry[] | null) => void;
  /** 添加一张图片（base64 data URL），自动生成预览 URL */
  addImage: (data: string) => void;
  /** 移除指定索引的图片 */
  removeImage: (index: number) => void;
  /** 清空所有图片 */
  clearImages: () => void;
  /** 提交图片到后端解析，成功后自动切换回文本模式并预填文本 */
  parseImage: () => Promise<void>;
}

export const useTableParseStore = create<TableParseState>((set, get) => {
  const cached = loadFromStorage();
  return {
  input: '',
  colorHints: new Set(),
  availableColors: [],
  items: cached,
  loading: false,
  error: '',
  fromHistoryRestored: false,
  products: [],
  productsLoading: false,
  unresolvedCount: 0,
  unresolvedIndices: [],
  resultCollapsed: false,
  productsCollapsed: false,

  // 图片输入模式初始状态
  inputMode: 'text',
  imageDataList: [],
  imagePreviewUrls: [],
  imageLoading: false,
  fromImage: false,

  fillConversation: null,
  setFillConversation: (conv) => set({ fillConversation: conv }),

  copySuccess: false,

  parseInputLineCount: 0,
  parseEventCallback: null,
  setParseEventCallback: (cb) => set({ parseEventCallback: cb }),

  setInput: (text: string) => set({ input: text, fromImage: false }),

  toggleColorHint: (code: string) => {
    const next = new Set(get().colorHints);
    if (next.has(code)) {
      next.delete(code);
    } else {
      next.add(code);
    }
    set({ colorHints: next });
  },

  setColorHints: (codes: string[]) => {
    set({ colorHints: new Set(codes) });
  },

  fetchColors: async () => {
    // 已缓存则跳过请求
    const { availableColors } = get();
    if (availableColors.length > 0) return;
    try {
      const res = await fetchWithAuth('/api/colors');
      if (!res.ok) throw new Error('获取颜色列表失败');
      const colors: ColorEntry[] = await res.json();
      set({ availableColors: colors });
    } catch (err) {
      console.error('fetchColors error:', err);
    }
  },

  parseTable: async () => {
    const { input, colorHints, fromImage, parseEventCallback } = get();
    if (!input.trim() || get().loading) return;

    const lineCount = input.split('\n').filter((l) => l.trim()).length;
    set({ items: [], loading: true, error: '', fromHistoryRestored: false, parseInputLineCount: lineCount });

    // 通知 ChatPanel：解析开始（附带行数和已勾选颜色代码，供 rich parse_start 消息使用）
    parseEventCallback?.({ type: 'parse_start', data: {
      lineCount,
      colorHintCodes: Array.from(colorHints),
    } });

    try {
      const res = await fetchWithAuth('/api/table-parse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input,
          colorHints: Array.from(colorHints),
          lang: getLang(),
          fromImage,
          notes: (() => {
            try {
              const raw = localStorage.getItem('duko_notes');
              return raw ? JSON.parse(raw) : [];
            } catch {
              return [];
            }
          })(),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        const errMsg = errText || `请求失败${tOutside('联系支持')}`;
        parseEventCallback?.({ type: 'error', data: { message: errMsg } });
        set({ error: errMsg, loading: false });
        return;
      }

      // 读取 SSE 流
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const readLoop = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || ''; // 保留未完成的最后一块

          for (const raw of lines) {
            const match = raw.match(/^event: (.+)\ndata: (.+)$/s);
            if (!match) continue;

            const eventType = match[1].trim();
            let eventData: Record<string, unknown> = {};
            try {
              eventData = JSON.parse(match[2].trim());
            } catch { /* 忽略 JSON 解析错误 */ }

            parseEventCallback?.({ type: eventType, data: eventData });

            if (eventType === 'tool_call') {
              // tool_call 事件由 ChatPanel 处理 UI
            } else if (eventType === 'reply_chunk') {
              // reply_chunk 由 ChatPanel 处理打字机效果
            } else if (eventType === 'result') {
              const payload = eventData as { items?: unknown };
              const newItems = Array.isArray(payload.items) ? payload.items as ParsedItem[] : [];
              set({ items: newItems, resultCollapsed: false });
              syncToStorage(newItems);
            } else if (eventType === 'error') {
              set({ error: String((eventData as { message?: string }).message || '解析失败'), loading: false });
              parseEventCallback?.({ type: 'done', data: {} });
              return;
            }
          }
        }
      };

      await readLoop();
      set({ loading: false });
      parseEventCallback?.({ type: 'done', data: {} });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : `请求失败，请检查网络连接。${tOutside('联系支持')}`;

      // 自动从最新历史记录恢复（仅当 input 完全匹配时）
      let recovered = false;
      try {
        const historyRes = await fetchWithAuth('/api/htory');
        if (historyRes.ok) {
          const records: { id: number }[] = await historyRes.json();
          if (records.length > 0) {
            const detailRes = await fetchWithAuth(`/api/htory/${records[0].id}`);
            if (detailRes.ok) {
              const detail: { input: string; items: ParsedItem[]; colorHints: string[]; conversation: ConversationEntry[] } = await detailRes.json();
              if (detail.input && detail.input.trim() === input.trim()) {
                get().replaceItems(detail.items);
                get().setColorHints(detail.colorHints);
                get().setFillConversation(detail.conversation);
                set({ error: '', loading: false, fromHistoryRestored: true });
                parseEventCallback?.({ type: 'done', data: {} });
                recovered = true;
              }
            }
          }
        }
      } catch {
        // 恢复失败，静默
      }

      if (!recovered) {
        parseEventCallback?.({ type: 'error', data: { message: errMsg } });
        set({ error: errMsg, loading: false });
        parseEventCallback?.({ type: 'done', data: {} });
      }
    }
  },

  /** 更新表格中某行某字段的编辑值。
   *  对于 ParsedField 类型字段，写入其 values[0]（编辑后认为已确）。
   *  对于 customRequirement，直接写入字符串值或 undefined（空字符串 = 清除 = "-"）。 */
  updateItemField: (index, field, value) => {
    const { items } = get();
    const newItems = [...items];
    if (index < 0 || index >= newItems.length) return;

    if (field === 'quantity') {
      newItems[index] = { ...newItems[index], quantity: value as number };
    } else if (field === 'customRequirement') {
      const strVal = String(value ?? '');
      newItems[index] = {
        ...newItems[index],
        customRequirement: (strVal === 'door' || strVal === 'box') ? strVal as 'door' | 'box' : undefined,
      };
    } else {
      // 编辑 ParsedField：将用户填写的值写入 values[0]
      // 若 values 原为空，则创建单元素数组
      const updated = { ...newItems[index] };
      updated[field] = { values: [String(value)] };
      newItems[index] = updated;
    }

    set({ items: newItems });
    syncToStorage(newItems);
  },

  /** 重新检查所有行的 Exposed-Items 匹配状态。
   *  忽略判断仅由 shapeType 决定（不依赖 color/size 是否为空）：
   *  GD/TCR 忽略颜色，GD/CBL/TUK/SD 忽略尺寸。
   *  被忽略的字段传空字符串给服务端，比对时跳过。
   *  注意：values.length === 1 但 values[0] 为空字符串时同样视为字段缺失。
   *
   *  缓存策略：全部 combo 命中缓存则跳过网络，任一未命中则照常 POST 全部。 */
  checkExposedItems: async () => {
    const { items } = get();
    if (items.length === 0) return;

    // 1. 构建全部 combo（逻辑不变）
    const combos: (ComboInput | null)[] = items.map((item) => {
      const shapeTypeCode = item.shapeType.values.length > 0
        ? item.shapeType.values[0].toUpperCase()
        : '';

        // 形状型号本身为空 → 无法判断
      if (shapeTypeCode.length === 0) return null;

        // 忽略标记：仅由形状型号决定
      const colorIgnored = SHAPE_TYPES_COLOR_NA.has(shapeTypeCode);
      const sizeIgnored = SHAPE_TYPES_SIZE_NA.has(shapeTypeCode);

        // 提取有效值（trim 后为空字符串等同于缺失）
      const colorVal = item.color.values.length > 0 ? item.color.values[0].trim() : '';
      const sizeVal = item.shapeSize.values.length > 0 ? item.shapeSize.values[0].trim() : '';

        // 非忽略字段为空 → 不完整
        if (
          (!colorIgnored && !colorVal) ||
          (!sizeIgnored && !sizeVal)
        ) {
          return null;
        }

      return {
        colorCode: colorIgnored ? '' : colorVal,
        shapeTypeCode: item.shapeType.values[0],
        shapeSizeCode: sizeIgnored ? '' : sizeVal,
      };
    });

    // 2. 检查是否全部非 null combo 都在缓存中
    let allCached = true;
    const cachedResults: (boolean | null)[] = new Array(items.length);

    for (let i = 0; i < combos.length; i++) {
      const combo = combos[i];
      if (!combo) {
        cachedResults[i] = null;
        continue;
      }
      const key = makeExposedCacheKey(combo.colorCode, combo.shapeTypeCode, combo.shapeSizeCode);
      const cached = exposedCache.get(key);
      if (cached !== undefined) {
        cachedResults[i] = cached;
      } else {
        allCached = false;
        break; // 不再继续检查，直接走 POST
      }
    }

    // 3. 全部命中缓存 → 跳过网络，直接更新 items
    if (allCached) {
      set({ items: applyStatusToItems(items, cachedResults) });
      syncToStorage(get().items);
      return;
    }

    // 4. 有未命中 → 照常一次 POST 发送全部 combo
    try {
      const res = await fetchWithAuth('/api/check-exposed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ combos }),
      });

      if (!res.ok) {
        console.error('checkExposedItems failed:', res.status);
        return;
      }

      const data: { results: (boolean | null)[] } = await res.json();

      // 5. 所有非 null 结果写回缓存
      for (let i = 0; i < combos.length; i++) {
        const combo = combos[i];
        if (combo) {
          exposedCache.set(
            makeExposedCacheKey(combo.colorCode, combo.shapeTypeCode, combo.shapeSizeCode),
            data.results[i] ?? false,
          );
        }
      }

      // 6. 更新 items
      set({ items: applyStatusToItems(items, data.results) });
      syncToStorage(get().items);
    } catch (err) {
      console.error('checkExposedItems error:', err);
    }
  },

  /** 删除表格中某一行。
   *  更新 items，清除产品列表，删除后重新检查匹配状态。 */
  removeItem: (index) => {
    const { items } = get();
    if (index < 0 || index >= items.length) return;

    const newItems = [...items];
    newItems.splice(index, 1);

    // 清除已生成的产品列表（表格已变化，旧产品列表失效）
    set({ items: newItems, products: [], unresolvedCount: 0, unresolvedIndices: [] });
    syncToStorage(newItems);

    // 删除后重新检查 Exposed-Items 匹配状态
    get().checkExposedItems();
  },

  /** 手动添加一个空行：所有字段为空，数量为 1，status 为 missing。
   *  不触发 Exposed-Items 检查（空行无有效字段），等待用户自行填写。
   *  与删除行一致：清空已生成的产品和未解析统计。 */
  addEmptyItem: () => {
    const { items } = get();
    const emptyItem: ParsedItem = {
      originalName: '',
      color: { values: [] },
      shapeType: { values: [] },
      shapeSize: { values: [] },
      quantity: 1,
      status: 'missing',
    };
    const newItems = [...items, emptyItem];
    set({ items: newItems, products: [], unresolvedCount: 0, unresolvedIndices: [], resultCollapsed: false });
    syncToStorage(newItems);
  },

  /** 根据当前编辑后的表格生成 DUKO 产品清单。
   *  仅提交三字段均已确认（values.length === 1）的行，
   *  未确认的行在结果中标注为未解析。 */
  generateProducts: async () => {
    const { items, productsLoading } = get();
    if (items.length === 0 || productsLoading) return;

    set({ productsLoading: true, products: [], unresolvedCount: 0, unresolvedIndices: [] });

    try {
      const res = await fetchWithAuth('/api/generate-products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ items }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `生成产品失败${tOutside('联系支持')}` }));
        set({ error: err.error || `生成产品失败${tOutside('联系支持')}`, productsLoading: false });
        return;
      }

      const data: GenerateProductsResponse = await res.json();
      set({
        products: data.products,
        unresolvedCount: data.unresolvedCount,
        unresolvedIndices: data.unresolvedIndices,
        productsLoading: false,
        resultCollapsed: true,
        productsCollapsed: false,
      });
    } catch {
      set({ error: `生成产品失败，请检查网络连接。${tOutside('联系支持')}`, productsLoading: false });
    }
  },

  /** 展开五列表时自动折叠三列表（仅展开侧触发互斥） */
  toggleResultCollapsed: () => {
    const { resultCollapsed } = get();
    if (resultCollapsed) {
      set({ resultCollapsed: false, productsCollapsed: true });
    } else {
      set({ resultCollapsed: true });
    }
  },

  /** 展开三列表时自动折叠五列表（仅展开侧触发互斥） */
  toggleProductsCollapsed: () => {
    const { productsCollapsed } = get();
    if (productsCollapsed) {
      set({ productsCollapsed: false, resultCollapsed: true });
    } else {
      set({ productsCollapsed: true });
    }
  },

  /** 将当前产品清单转为 CSV 字符串（productName,quantity,discount；无折扣时第三列留空） */
  getProductsCsv: () => {
    const { products } = get();
    return 'productName,quantity,discount\n' + products
      .map((p) => `${p.productName},${p.quantity},${p.discount ?? ''}`)
      .join('\n');
  },

  /** 复制产品 CSV 到剪贴板，并设置 copySuccess 标志（2 秒后自动重置） */
  copyProductsCsv: async () => {
    const csv = get().getProductsCsv();
    try {
      await navigator.clipboard.writeText(csv);
      set({ copySuccess: true });
      setTimeout(() => set({ copySuccess: false }), 2000);
    } catch {
      // 降级方案：创建临时 textarea
      const ta = document.createElement('textarea');
      ta.value = csv;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      set({ copySuccess: true });
      setTimeout(() => set({ copySuccess: false }), 2000);
    }
  },

  /** 将当前 items 导出为 JSON 文件下载（不含 exposedStatus） */
  saveArchive: () => {
    const { items } = get();
    if (items.length === 0) return;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

    const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duko-archive-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /** 从外部加载解析结果（文件导入或其它来源），同步写入 localStorage */
  loadArchiveData: (items) => {
    set({ items, products: [], unresolvedCount: 0, unresolvedIndices: [],
          resultCollapsed: false, productsCollapsed: false, fromImage: false });
    syncToStorage(items);
  },

  /** 从 chat API 响应中替换整个 items。
   *  用于对话中 LLM 通过工具编辑清单后返回的更新结果。
   *  不再清空产品清单（products），以支持 AI 对产品清单的独立编辑。 */
  replaceItems: (items) => {
    set({ items, resultCollapsed: false });
    syncToStorage(items);
  },

  /** 从 chat API 响应中替换产品清单（products）。
   *  只更新 products，不改变其他状态，避免普通对话导致 UI 折叠状态跳动。 */
  replaceProducts: (products) => {
    set({ products });
  },

  // ---- 图片模式操作 ----

  /** 切换输入模式（text ↔ image）。
   *  切换时不清除数据，以便用户在两种模式间来回查看。 */
  setInputMode: (mode) => set({ inputMode: mode }),

  /** 添加一张图片（base64 data URL）到列表末尾 */
  addImage: (data) => {
    let blobUrl: string;
    try {
      const parts = data.split(',');
      if (parts.length < 2) { blobUrl = data; }
      else {
        const mime = parts[0].match(/data:(image\/[^;]*)/)?.[1] || 'image/png';
        const binary = atob(parts[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mime });
        blobUrl = URL.createObjectURL(blob);
      }
    } catch {
      blobUrl = data;
    }
    set((state) => ({
      imageDataList: [...state.imageDataList, data],
      imagePreviewUrls: [...state.imagePreviewUrls, blobUrl],
      error: '',
    }));
  },

  /** 移除指定索引的图片，并释放对应的 blob URL */
  removeImage: (index) => {
    const { imagePreviewUrls, imageDataList } = get();
    if (index < 0 || index >= imageDataList.length) return;
    const oldUrl = imagePreviewUrls[index];
    if (oldUrl && oldUrl.startsWith('blob:')) {
      URL.revokeObjectURL(oldUrl);
    }
    set({
      imageDataList: imageDataList.filter((_, i) => i !== index),
      imagePreviewUrls: imagePreviewUrls.filter((_, i) => i !== index),
      error: '',
    });
  },

  /** 清空所有图片并释放 blob URL */
  clearImages: () => {
    for (const url of get().imagePreviewUrls) {
      if (url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    }
    set({ imageDataList: [], imagePreviewUrls: [], error: '' });
  },

  /** 提交图片到后端 OPENROUTER 视觉模型进行解析。
   *  成功后自动切换回文本模式并将解析文本预填入输入框。
   *  失败时在 error 中显示错误信息。 */
  parseImage: async () => {
    const { imageDataList, colorHints, imageLoading } = get();
    if (imageDataList.length === 0 || imageLoading) return;

    set({ imageLoading: true, error: '' });

    try {
      const res = await fetchWithAuth('/api/image-parse', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          images: imageDataList,
          colorHints: Array.from(colorHints),
          lang: getLang(),
          notes: (() => {
            try {
              const raw = localStorage.getItem('duko_notes');
              return raw ? JSON.parse(raw) : [];
            } catch {
              return [];
            }
          })(),
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: '图片解析失败' }));
        set({ error: err.error || `图片解析失败${tOutside('联系支持')}`, imageLoading: false });
        return;
      }

      // 读取 SSE 流，监听 result（解析文本）和 error（解析失败）事件
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;

      const readLoop = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || ''; // 保留未完成的最后一块

          for (const raw of lines) {
            const match = raw.match(/^event: (.+)\ndata: (.+)$/s);
            if (!match) continue;

            const eventType = match[1].trim();
            let eventData: Record<string, unknown> = {};
            try {
              eventData = JSON.parse(match[2].trim());
            } catch { /* 忽略 JSON 解析错误 */ }

            if (eventType === 'result') {
              const text = String(eventData.text ?? '');
              completed = true;
              // 释放所有旧的预览 URL
              for (const url of get().imagePreviewUrls) {
                if (url.startsWith('blob:')) {
                  URL.revokeObjectURL(url);
                }
              }
              // 成功后：预填文本 → 切换到文本模式 → 清除所有图片状态 → 标记来源
              set({
                input: text,
                inputMode: 'text',
                imageDataList: [],
                imagePreviewUrls: [],
                imageLoading: false,
                fromImage: true,
                error: '',
              });
            } else if (eventType === 'error') {
              set({
                error: String((eventData as { message?: string }).message || `图片解析失败${tOutside('联系支持')}`),
                imageLoading: false,
              });
              return;
            }
          }
        }
      };

      await readLoop();
      if (!completed) {
        set({
          error: `图片解析未返回有效结果。${tOutside('联系支持')}`,
          imageLoading: false,
        });
      }
    } catch {
      set({
        error: `网络请求失败，请检查网络连接。${tOutside('联系支持')}`,
        imageLoading: false,
      });
    }
  },
  };
});
