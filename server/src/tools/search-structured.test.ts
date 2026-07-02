import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SkuRecord } from '../types/sku.js';

const { resolveSubItemsMock } = vi.hoisted(() => ({
  resolveSubItemsMock: vi.fn((arr: Array<{ item: SkuRecord }>) =>
    arr.map((r) => ({ ...r, subItems: [] as SkuRecord[] })),
  ),
}));

vi.mock('../db/sku.js', () => ({
  getAllRecords: vi.fn(),
}));

vi.mock('../services/retriever.js', () => ({
  resolveSubItems: resolveSubItemsMock,
}));

vi.mock('../services/bm25.js', () => ({
  searchBm25All: vi.fn(),
}));

vi.mock('../services/embeddings.js', () => ({
  getEmbedding: vi.fn(),
}));

vi.mock('../db/lance.js', () => ({
  searchSimilar: vi.fn(),
}));

import { executeSearchSkuStructured } from './search-structured.js';
import { getAllRecords } from '../db/sku.js';
import { searchBm25All } from '../services/bm25.js';
import { getEmbedding } from '../services/embeddings.js';
import { searchSimilar } from '../db/lance.js';

function makeRecord(overrides: Partial<SkuRecord> = {}): SkuRecord {
  return {
    id: 'default-id',
    itemName: 'default-itemName',
    colorCode: '02',
    shapeTypeCode: 'GD',
    shapeTypeAlias: '',
    shapeSizeCode: '',
    shapeSizeAlias: '',
    subItemsName: '',
    mainDescription: '',
    mainAlias: '',
    sizeDescription: '',
    otherDescription: '',
    text: '',
    vector: [],
    ...overrides,
  };
}

function makeRecords(count: number, base: Partial<SkuRecord> & { id: string }): SkuRecord[] {
  return Array.from({ length: count }, (_, i) =>
    makeRecord({ ...base, id: `${base.id}-${i}`, itemName: `${base.id}-${i}` }),
  );
}

const mockGetAll = vi.mocked(getAllRecords);
const mockBm25All = vi.mocked(searchBm25All);
const mockEmbedding = vi.mocked(getEmbedding);
const mockSearchSimilar = vi.mocked(searchSimilar);

function results() {
  return resolveSubItemsMock.mock.calls.at(-1)?.[0] ?? [];
}

function resultCount() {
  return results().length;
}

// ==================================================================
describe('searchSkuStructured', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  describe('基本路径', () => {
    it('仅传入 colorCode 时返回所有颜色匹配的记录', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', itemName: '02GD' }),
        makeRecord({ id: 'r2', colorCode: '02', itemName: '02B' }),
      ]);

      const output = await executeSearchSkuStructured({ colorCode: '02' });

      expect(output).toContain('02GD');
      expect(output).toContain('02B');
      expect(resultCount()).toBe(2);
    });

    it('colorCode 无匹配时应及早提示', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '14' }),
      ]);

      const output = await executeSearchSkuStructured({ colorCode: '02' });

      expect(output).toContain('无匹配记录');
      expect(resultCount()).toBe(0);
    });

    it('topK 限制返回数量', async () => {
      mockGetAll.mockReturnValue(makeRecords(5, { id: 'r', colorCode: '02' }));

      await executeSearchSkuStructured({ colorCode: '02', topK: 2 });

      expect(resultCount()).toBe(2);
    });

    it('topK 为 0 时回退默认值 10', async () => {
      mockGetAll.mockReturnValue(makeRecords(5, { id: 'r', colorCode: '02' }));

      await executeSearchSkuStructured({ colorCode: '02', topK: 0 });

      expect(resultCount()).toBe(5);
    });

    it('topK 为负数时回退默认值 10', async () => {
      mockGetAll.mockReturnValue(makeRecords(3, { id: 'r', colorCode: '02' }));

      await executeSearchSkuStructured({ colorCode: '02', topK: -1 });

      expect(resultCount()).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  describe('shapeFilter - 正常场景', () => {
    beforeEach(() => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r-bf', colorCode: '02', shapeTypeCode: 'BF' }),
        makeRecord({ id: 'r-bls', colorCode: '02', shapeTypeCode: 'BLS' }),
        makeRecord({ id: 'r-wdd', colorCode: '02', shapeTypeCode: 'WDD' }),
      ]);
    });

    it('简单叶子按 shapeTypeCode 编辑距离过滤', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeTypeCode: 'BF' }),
      });

      expect(resultCount()).toBe(1);
      expect(results()).toContainEqual(
        expect.objectContaining({ item: expect.objectContaining({ id: 'r-bf' }) }),
      );
    });

    it('shapeTypeCode 为 "*" 时宽度不限', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeTypeCode: '*' }),
      });

      expect(resultCount()).toBe(3);
    });

    it('叶子缺 shapeSizeCode 时不限制尺寸', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r-gd', colorCode: '02', shapeTypeCode: 'GD', shapeSizeCode: '15' }),
        makeRecord({ id: 'r-gd2', colorCode: '02', shapeTypeCode: 'GD', shapeSizeCode: '18' }),
      ]);

      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeTypeCode: 'GD' }),
      });

      expect(resultCount()).toBe(2);
    });

    it('shapeSizeCode 为空字符串时不限制尺寸', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD', shapeSizeCode: '15' }),
      ]);

      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeTypeCode: 'GD', shapeSizeCode: '' }),
      });

      expect(resultCount()).toBe(1);
    });

    it('shapeSizeCode 为 "*" 时不限制尺寸', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD', shapeSizeCode: '15' }),
      ]);

      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeTypeCode: 'GD', shapeSizeCode: '*' }),
      });

      expect(resultCount()).toBe(1);
    });

    it('and 求交集', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r-bf', colorCode: '02', shapeTypeCode: 'BF' }),
        makeRecord({ id: 'r-bls', colorCode: '02', shapeTypeCode: 'BLS' }),
      ]);

      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({
          operator: 'and',
          conditions: [{ shapeTypeCode: 'BF' }, { shapeTypeCode: '*' }],
        }),
      });

      expect(resultCount()).toBe(1);
      expect(results()).toContainEqual(
        expect.objectContaining({ item: expect.objectContaining({ id: 'r-bf' }) }),
      );
    });

    it('or 求并集', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({
          operator: 'or',
          conditions: [{ shapeTypeCode: 'BF' }, { shapeTypeCode: 'WDD' }],
        }),
      });

      expect(resultCount()).toBe(2);
    });

    it('not 求补集', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({
          operator: 'not',
          condition: { shapeTypeCode: 'BF' },
        }),
      });

      expect(resultCount()).toBe(2);
      const ids = results().map((r: { item: SkuRecord }) => r.item.id);
      expect(ids).not.toContain('r-bf');
    });

    it('and 空 conditions 返回全集', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ operator: 'and', conditions: [] }),
      });

      expect(resultCount()).toBe(3);
    });

    it('shapeFilter 为空字符串时跳过过滤', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: '',
      });

      expect(resultCount()).toBe(3);
    });

    it('shapeFilter 不是合法 JSON 时跳过过滤', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: '不是json{{{',
      });

      expect(resultCount()).toBe(3);
    });

    it('未传入 shapeFilter 时跳过过滤', async () => {
      await executeSearchSkuStructured({ colorCode: '02' });

      expect(resultCount()).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  describe('descriptionFilter - 正常场景', () => {
    beforeEach(() => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD' }),
        makeRecord({ id: 'r2', colorCode: '02', shapeTypeCode: 'B' }),
        makeRecord({ id: 'r3', colorCode: '02', shapeTypeCode: 'W' }),
      ]);
    });

    it('text 叶子通过 BM25 过滤', async () => {
      mockBm25All.mockReturnValue(new Map([['r1', 0.9]]));

      await executeSearchSkuStructured({
        colorCode: '02',
        descriptionFilter: JSON.stringify({ text: 'filler' }),
      });

      expect(resultCount()).toBe(1);
      expect(results()).toContainEqual(
        expect.objectContaining({ item: expect.objectContaining({ id: 'r1' }) }),
      );
    });

    it('and 描述过滤求交集', async () => {
      mockBm25All
        .mockReturnValueOnce(new Map([['r1', 0.9]]))
        .mockReturnValueOnce(new Map([['r1', 0.8], ['r2', 0.7]]));

      await executeSearchSkuStructured({
        colorCode: '02',
        descriptionFilter: JSON.stringify({
          operator: 'and',
          conditions: [{ text: 'filler' }, { text: 'cabinet' }],
        }),
      });

      expect(resultCount()).toBe(1);
      expect(results()).toContainEqual(
        expect.objectContaining({ item: expect.objectContaining({ id: 'r1' }) }),
      );
    });

    it('or 描述过滤求并集', async () => {
      mockBm25All
        .mockReturnValueOnce(new Map([['r1', 0.9]]))
        .mockReturnValueOnce(new Map([['r2', 0.7]]));

      await executeSearchSkuStructured({
        colorCode: '02',
        descriptionFilter: JSON.stringify({
          operator: 'or',
          conditions: [{ text: 'filler' }, { text: 'cabinet' }],
        }),
      });

      expect(resultCount()).toBe(2);
    });

    it('descriptionFilter 为空时跳过过滤', async () => {
      await executeSearchSkuStructured({
        colorCode: '02',
        descriptionFilter: '',
      });

      expect(resultCount()).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  describe('组合过滤', () => {
    it('shapeFilter 与 descriptionFilter 取交集', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD' }),
        makeRecord({ id: 'r2', colorCode: '02', shapeTypeCode: 'B' }),
      ]);
      mockBm25All.mockReturnValue(new Map([['r1', 0.9]]));

      await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeTypeCode: '*' }),
        descriptionFilter: JSON.stringify({ text: 'glass' }),
      });

      expect(resultCount()).toBe(1);
      expect(results()).toContainEqual(
        expect.objectContaining({ item: expect.objectContaining({ id: 'r1' }) }),
      );
    });

    it('无 vectorQuery 时不会调用向量排序', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD' }),
      ]);

      await executeSearchSkuStructured({ colorCode: '02' });

      expect(mockEmbedding).not.toHaveBeenCalled();
      expect(resultCount()).toBe(1);
    });

    it('有 vectorQuery 时按向量距离排序', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD', itemName: 'A' }),
        makeRecord({ id: 'r2', colorCode: '02', shapeTypeCode: 'B', itemName: 'B' }),
      ]);
      mockEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
      mockSearchSimilar.mockResolvedValue([
        { ...makeRecord({ id: 'r2', itemName: 'B' }), _distance: 0.1 },
        { ...makeRecord({ id: 'r1', itemName: 'A' }), _distance: 0.5 },
      ]);

      await executeSearchSkuStructured({
        colorCode: '02',
        vectorQuery: 'glass door',
      });

      expect(resultCount()).toBe(2);
      const ids = results().map((r: { item: SkuRecord }) => r.item.id);
      expect(ids[0]).toBe('r2');
    });
  });

  // =================================================================
  describe('shapeFilter 畸形输入不应崩溃', () => {
    beforeEach(() => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD' }),
      ]);
    });

    it('叶子缺 shapeTypeCode → 该叶子返回空集', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeSizeCode: '15' }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });

    it('shapeTypeCode 为 null → 该叶子返回空集', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ shapeTypeCode: null }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });

    it('and 的 conditions 数组含 null → 空集', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ operator: 'and', conditions: [{ shapeTypeCode: 'GD' }, null] }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });

    it('or 的 conditions 含缺 shapeTypeCode 的空对象 → 并集不受影响', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r-gd', colorCode: '02', shapeTypeCode: 'GD' }),
        makeRecord({ id: 'r-w', colorCode: '02', shapeTypeCode: 'W' }),
      ]);

      // {} 叶子返回空集，{shapeTypeCode:'W'} 只匹配 W
      // 但 W 编辑距离 1 ≤ ceil(1/2)=1 也可能误匹配... 
      // 这里用更长码值: BLS (len 3, thresh 2), UT (len 2, thresh 1)
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r-bls', colorCode: '02', shapeTypeCode: 'BLS' }),
        makeRecord({ id: 'r-ut', colorCode: '02', shapeTypeCode: 'UT' }),
      ]);

      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ operator: 'or', conditions: [{}, { shapeTypeCode: 'UT' }] }),
      });

      expect(output).toMatch(/匹配结果.*1/);
    });

    it('嵌套 and 内层 or 叶子缺 shapeTypeCode → 交集结果为空', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({
          operator: 'and',
          conditions: [
            { operator: 'or', conditions: [{ shapeSizeCode: '18' }] },
            { shapeTypeCode: 'GD' },
          ],
        }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });

    it('not 的 condition 缺 shapeTypeCode → 叶子返回空集，not 后为全集', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ operator: 'not', condition: {} }),
      });

      expect(resultCount()).toBe(1);
    });

    it('not 缺 condition 字段 → 排除条件不存在，返回全集', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ operator: 'not' }),
      });

      expect(resultCount()).toBe(1);
    });

    it('or 的 conditions 不是数组 → 返回空集', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ operator: 'or', conditions: 'bad' }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });

    it('shapeFilter 是纯数字 JSON 时 safeParseJson 拒绝 → 跳过过滤', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: '42',
      });

      expect(resultCount()).toBe(1);
    });
  });

  // =================================================================
  describe('descriptionFilter 畸形输入不应崩溃', () => {
    beforeEach(() => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD' }),
      ]);
    });

    it('叶子缺 text 字段 → 返回空集', async () => {
      mockBm25All.mockReturnValue(new Map());
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        descriptionFilter: JSON.stringify({}),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });

    it('or 的 conditions 含 null 或字符串 → 非法叶子返回空集', async () => {
      mockBm25All.mockReturnValue(new Map());
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        descriptionFilter: JSON.stringify({ operator: 'or', conditions: [null, 'hello'] }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });

    it('and 的 conditions 不是数组 → 返回空集', async () => {
      const output = await executeSearchSkuStructured({
        colorCode: '02',
        descriptionFilter: JSON.stringify({ operator: 'and', conditions: 123 }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });
  });

  // =================================================================
  describe('未知 operator', () => {
    it('未知 operator 返回空集', async () => {
      mockGetAll.mockReturnValue([
        makeRecord({ id: 'r1', colorCode: '02', shapeTypeCode: 'GD' }),
      ]);

      const output = await executeSearchSkuStructured({
        colorCode: '02',
        shapeFilter: JSON.stringify({ operator: 'xor', conditions: [{ shapeTypeCode: 'GD' }] }),
      });

      expect(output).toMatch(/匹配结果.*0/);
    });
  });
});
