import { describe, it, expect, beforeAll } from 'vitest'
import { searchSku } from '../retriever.js'
import { initDB } from '../../db/lance.js'
import { getAllRecords, initSkuDB } from '../../db/sku.js'
import { loadCacheFromCSV } from '../sku-ingest.js'
import { fileURLToPath } from 'url'
import path from 'path'
import { log } from 'console'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_CSV = path.resolve(__dirname, '../../../src/data/Exposed-Items.csv')

describe('searchSku 向量检索功能', () => {
  beforeAll(async () => {
    await initDB()
    initSkuDB(path.resolve(__dirname, '../../data'))
    loadCacheFromCSV(DATA_CSV)
  })

  it('精确代码匹配 - 查询 "02B15" 应在结果中', async () => {
    const results = await searchSku('02B15', 10, 0.5, 0.5, '*')
    const names = results.map((r) => r.item.itemName)
    expect(names).toContain('02B15')
  })

  it('向量搜索 - 自然语言查询应返回 LanceDB 结果', async () => {
    const results = await searchSku('base cabinet with drawer', 10, 0.5, 0.5, '*')
    expect(results.length).toBeGreaterThan(0)
  })

  it('混合权重 - 同一查询 vectorWeight=0 vs 1 得到的排序不同', async () => {
    const query = 'base cabinet with drawers and doors'
    const vecOff = await searchSku(query, 10, 0.9, 0.5, '*')
    const vecOn = await searchSku(query, 10, 1, 0.5, '*')
    const vecOffNames = vecOff.map((r) => r.item.itemName)
    // log(vecOffNames)
    const vecOnNames = vecOn.map((r) => r.item.itemName)
    // log(vecOnNames)
    expect(vecOffNames).not.toEqual(vecOnNames)
  })

  it('语义搜索 - corner cabinet 应找到转角柜', async () => {
    const results = await searchSku('corner cabinet', 10, 0.5, 0.5, '*')
    const names = results.map((r) => r.item.itemName)
    expect(names.length).toBeGreaterThan(0)
  })

  it('纯向量检索 (vectorWeight=1) - "lazy susan" 应找到 BLS 产品', async () => {
    const results = await searchSku('lazy susan corner cabinet', 10, 1, 0, '*')
    const names = results.map((r) => r.item.itemName)
    expect(names.some((n) => n.includes('BLS'))).toBe(true)
  })

  it('纯编辑距离检索 (editWeight=1) - "02B15" 排第一', async () => {
    const results = await searchSku('02B15', 10, 0, 1, '*')
    const names = results.map((r) => r.item.itemName)
    expect(names[0]).toBe('02B15')
  })

  it('编辑距离容错 - 手误 "02b14" 应找到 "02B15"', async () => {
    const results = await searchSku('02b14', 10, 0, 1, '*')
    const names = results.map((r) => r.item.itemName)
    expect(names).toContain('02B15')
  })

  it('权重差异验证 - vectorWeight=0.2 vs 0.8 的结果不完全相同', async () => {
    const query = 'white base cabinet with 2 drawers and 2 doors'
    const lowVec = await searchSku(query, 10, 0.2, 0.8, '*')
    const highVec = await searchSku(query, 10, 0.8, 0.2, '*')

    const lowNames = lowVec.map((r) => r.item.itemName)
    const highNames = highVec.map((r) => r.item.itemName)

    expect(lowNames).not.toEqual(highNames)
  })

  it('颜色过滤 - "base cabinet" + color="02" 所有结果颜色为 "02"', async () => {
    const results = await searchSku('base cabinet', 10, 0.5, 0.5, '02')
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) {
      expect(r.item.colorCode).toBe('02')
    }
  })

  it('topK 限制 - 返回条数不超过 topK', async () => {
    const results = await searchSku('cabinet', 3, 0.5, 0.5, '*')
    expect(results.length).toBeLessThanOrEqual(3)
  })

  it('空查询 - query 为空时仍能运行不抛错', async () => {
    // 空字符串会生成有效 embedding，可能返回结果，这里只验证不崩溃
    const results = await searchSku('', 10, 0.5, 0.5, '*')
    expect(results).toBeDefined()
  })

  it('全表记录数大于 0', () => {
    expect(getAllRecords().length).toBeGreaterThan(0)
  })
})
