/**
 * DebugPage —— 搜索工具测试页面
 *
 * 零样式纯功能页面，用于直接调用 /api/debug/tool 测试四个新增搜索工具的效果。
 * 路由：/debug
 */

import { useState, useCallback, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fetchWithAuth } from '../lib/fetchWithAuth';

type ToolName = 'searchSkuShape' | 'searchSkuDescription' | 'searchSkuOverlap' | 'searchSkuStructured';

const TOOLS: { value: ToolName; label: string }[] = [
  { value: 'searchSkuShape', label: 'searchSkuShape — 形状编辑距离模糊搜索' },
  { value: 'searchSkuDescription', label: 'searchSkuDescription — BM25 描述文本搜索' },
  { value: 'searchSkuOverlap', label: 'searchSkuOverlap — 形状 × 描述交集搜索' },
  { value: 'searchSkuStructured', label: 'searchSkuStructured — 结构化多维度精确搜索' },
];

interface FormValues {
  shapeTypeCode: string;
  shapeSizeCode: string;
  colorCode: string;
  topK: string;
  descriptionQuery: string;
  shapeFilter: string;
  descriptionFilter: string;
  vectorQuery: string;
}

const DEFAULTS: FormValues = {
  shapeTypeCode: 'B',
  shapeSizeCode: '',
  colorCode: '*',
  topK: '10',
  descriptionQuery: 'wall cabinet',
  shapeFilter: JSON.stringify(
    {
      operator: 'or',
      conditions: [
        { shapeTypeCode: 'GD', shapeSizeCode: '*' },
        { shapeTypeCode: 'B', shapeSizeCode: '15' },
      ],
    },
    null,
    2,
  ),
  descriptionFilter: JSON.stringify(
    {
      operator: 'and',
      conditions: [
        { text: 'filler' },
        { operator: 'not', condition: { text: 'wall' } },
      ],
    },
    null,
    2,
  ),
  vectorQuery: 'white base cabinet',
};

export default function DebugPage() {
  const [tool, setTool] = useState<ToolName>('searchSkuShape');
  const [form, setForm] = useState<FormValues>(DEFAULTS);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const setField = useCallback(
    (field: keyof FormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
    },
    [],
  );

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setLoading(true);
      setError(null);
      setResult(null);

      let args: Record<string, unknown> = {};

      switch (tool) {
        case 'searchSkuShape':
          args = {
            shapeTypeCode: form.shapeTypeCode,
            colorCode: form.colorCode,
            topK: Number(form.topK) || 10,
          };
          if (form.shapeSizeCode.trim()) {
            args.shapeSizeCode = form.shapeSizeCode.trim();
          }
          break;
        case 'searchSkuDescription':
          args = {
            query: form.descriptionQuery,
            colorCode: form.colorCode,
            topK: Number(form.topK) || 10,
          };
          break;
        case 'searchSkuOverlap':
          args = {
            shapeTypeCode: form.shapeTypeCode,
            descriptionQuery: form.descriptionQuery,
            colorCode: form.colorCode,
            topK: Number(form.topK) || 10,
          };
          if (form.shapeSizeCode.trim()) {
            args.shapeSizeCode = form.shapeSizeCode.trim();
          }
          break;
        case 'searchSkuStructured':
          args = {
            colorCode: form.colorCode,
            topK: Number(form.topK) || 10,
          };
          if (form.shapeFilter.trim()) args.shapeFilter = form.shapeFilter.trim();
          if (form.descriptionFilter.trim()) args.descriptionFilter = form.descriptionFilter.trim();
          if (form.vectorQuery.trim()) args.vectorQuery = form.vectorQuery.trim();
          break;
      }

      try {
        const res = await fetchWithAuth('/api/debug/tool', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool, args }),
        });
        const data = await res.json();
        if (res.ok) {
          setResult(data.output);
        } else {
          setError(data.error ?? '请求失败');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tool, form],
  );

  const showShapeFields =
    tool === 'searchSkuShape' || tool === 'searchSkuOverlap';
  const showDescQuery =
    tool === 'searchSkuDescription' || tool === 'searchSkuOverlap';
  const showStructuredFields = tool === 'searchSkuStructured';

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: 16, fontFamily: 'monospace' }}>
      <h1>🔧 搜索工具 Debug 页面</h1>
      <p>
        <a href="/">返回主页</a>
      </p>
      <hr />

      <form onSubmit={handleSubmit}>
        {/* 工具选择 */}
        <p>
          <label>
            <strong>工具：</strong>
            <select
              value={tool}
              onChange={(e) => setTool(e.target.value as ToolName)}
              style={{ fontFamily: 'monospace' }}
            >
              {TOOLS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </p>

        {/* 通用参数 */}
        <p>
          <label>
            colorCode：
            <input
              type="text"
              value={form.colorCode}
              onChange={setField('colorCode')}
              size={6}
              style={{ fontFamily: 'monospace' }}
            />
          </label>
          {'    '}
          <label>
            topK：
            <input
              type="number"
              value={form.topK}
              onChange={setField('topK')}
              size={4}
              min={1}
              max={50}
              style={{ fontFamily: 'monospace', width: 60 }}
            />
          </label>
        </p>

        {/* shapeTypeCode / shapeSizeCode */}
        {showShapeFields && (
          <p>
            <label>
              shapeTypeCode：
              <input
                type="text"
                value={form.shapeTypeCode}
                onChange={setField('shapeTypeCode')}
                size={8}
                style={{ fontFamily: 'monospace' }}
              />
            </label>
            {'    '}
            <label>
              shapeSizeCode：
              <input
                type="text"
                value={form.shapeSizeCode}
                onChange={setField('shapeSizeCode')}
                size={8}
                placeholder="可选"
                style={{ fontFamily: 'monospace' }}
              />
            </label>
          </p>
        )}

        {/* descriptionQuery */}
        {showDescQuery && (
          <p>
            <label>
              descriptionQuery：
              <input
                type="text"
                value={form.descriptionQuery}
                onChange={setField('descriptionQuery')}
                size={30}
                style={{ fontFamily: 'monospace' }}
              />
            </label>
          </p>
        )}

        {/* searchSkuStructured 专用 */}
        {showStructuredFields && (
          <>
            <p>
              <label>
                shapeFilter (JSON)：
                <br />
                <textarea
                  value={form.shapeFilter}
                  onChange={setField('shapeFilter')}
                  rows={8}
                  cols={60}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                />
              </label>
            </p>
            <p>
              <label>
                descriptionFilter (JSON)：
                <br />
                <textarea
                  value={form.descriptionFilter}
                  onChange={setField('descriptionFilter')}
                  rows={8}
                  cols={60}
                  style={{ fontFamily: 'monospace', fontSize: 12 }}
                />
              </label>
            </p>
            <p>
              <label>
                vectorQuery：
                <input
                  type="text"
                  value={form.vectorQuery}
                  onChange={setField('vectorQuery')}
                  size={30}
                  placeholder="可选，留空跳过向量检索"
                  style={{ fontFamily: 'monospace' }}
                />
              </label>
            </p>
          </>
        )}

        <p>
          <button type="submit" disabled={loading}>
            {loading ? '执行中...' : '执行工具'}
          </button>
        </p>
      </form>

      <hr />

      {/* 错误 */}
      {error && (
        <pre style={{ color: 'red', whiteSpace: 'pre-wrap' }}>错误：{error}</pre>
      )}

      {/* 结果 */}
      {result && (
        <div style={{ border: '1px solid #ccc', padding: 8, background: '#fafafa' }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{result}</ReactMarkdown>
        </div>
      )}

      {!result && !error && !loading && (
        <p style={{ color: '#888' }}>选择工具、填写参数后点击"执行"。</p>
      )}
    </div>
  );
}
