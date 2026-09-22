import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import type { MerchantSearchResponse, MerchantSearchResult } from '../types/merchant';
import './MerchantCollectionPage.css';

const CONTIGUOUS_US_BOUNDS = {
  minLatitude: 24.396308,
  maxLatitude: 49.384358,
  minLongitude: -124.848974,
  maxLongitude: -66.885444,
} as const;

const MAX_RANGE_KM = 50;

interface SearchForm {
  textQuery: string;
  centerCoordinates: string;
  rangeKm: string;
}

function validateForm(form: SearchForm): string | null {
  const textQuery = form.textQuery.trim();
  if (!textQuery) return '请输入商家类别或服务查询词。';
  if (textQuery.length > 200) return '查询词不能超过 200 个字符。';

  const parts = form.centerCoordinates.split(',');
  if (parts.length !== 2) return '中心坐标必须是“纬度, 经度”格式。';
  const latitude = Number(parts[0].trim());
  const longitude = Number(parts[1].trim());
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return '中心坐标必须包含两个有效数字。';
  }
  const bounds = CONTIGUOUS_US_BOUNDS;
  if (
    latitude < bounds.minLatitude
    || latitude > bounds.maxLatitude
    || longitude < bounds.minLongitude
    || longitude > bounds.maxLongitude
  ) {
    return '中心坐标必须位于美国本土连续 48 州范围内。';
  }

  const rangeKm = Number(form.rangeKm);
  if (!Number.isFinite(rangeKm) || rangeKm <= 0 || rangeKm > MAX_RANGE_KM) {
    return `查询范围必须大于 0 且不超过 ${MAX_RANGE_KM} km。`;
  }
  return null;
}

function safeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function websiteLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '访问官网';
  }
}

function businessStatusLabel(status: string | null): string {
  switch (status) {
    case 'OPERATIONAL':
      return '营业中';
    case 'CLOSED_TEMPORARILY':
      return '暂时停业';
    case 'CLOSED_PERMANENTLY':
      return '永久停业';
    default:
      return status ?? '未知';
  }
}

function ResultRow({ merchant }: { merchant: MerchantSearchResult }) {
  const websiteUrl = safeExternalUrl(merchant.websiteUrl);
  const googleMapsUrl = safeExternalUrl(merchant.googleMapsUrl);
  const phone = merchant.internationalPhoneNumber ?? merchant.nationalPhoneNumber;

  return (
    <tr>
      <td data-label="商家">
        <div className="mc-business-name">{merchant.businessName ?? '未提供名称'}</div>
        <div className="mc-place-id">{merchant.placeId}</div>
      </td>
      <td data-label="地址">
        <div>{merchant.formattedAddress ?? '未提供地址'}</div>
        {merchant.location && (
          <div className="mc-coordinate">
            {merchant.location.latitude.toFixed(5)}, {merchant.location.longitude.toFixed(5)}
          </div>
        )}
      </td>
      <td data-label="电话">{phone ?? '未提供'}</td>
      <td data-label="官网">
        {websiteUrl ? (
          <a href={websiteUrl} target="_blank" rel="noreferrer">
            {websiteLabel(websiteUrl)}
          </a>
        ) : '未提供'}
      </td>
      <td data-label="状态">
        <span className={`mc-status mc-status-${merchant.businessStatus?.toLowerCase() ?? 'unknown'}`}>
          {businessStatusLabel(merchant.businessStatus)}
        </span>
      </td>
      <td data-label="地图">
        {googleMapsUrl ? (
          <a href={googleMapsUrl} target="_blank" rel="noreferrer">在 Google Maps 查看</a>
        ) : '未提供'}
      </td>
    </tr>
  );
}

export default function MerchantCollectionPage() {
  const navigate = useNavigate();
  const requestRef = useRef<AbortController | null>(null);
  const [form, setForm] = useState<SearchForm>({
    textQuery: '',
    centerCoordinates: '',
    rangeKm: '10',
  });
  const [searchResult, setSearchResult] = useState<MerchantSearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => requestRef.current?.abort(), []);

  function updateForm(field: keyof SearchForm, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validationError = validateForm(form);
    if (validationError) {
      setError(validationError);
      setSearchResult(null);
      return;
    }

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError('');
    setSearchResult(null);

    try {
      const response = await fetchWithAuth('/api/merchants/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textQuery: form.textQuery.trim(),
          centerCoordinates: form.centerCoordinates.trim(),
          rangeKm: Number(form.rangeKm),
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null) as (MerchantSearchResponse & {
        error?: string;
        detail?: string;
      }) | null;

      if (!response.ok) {
        setError(data?.error ?? '商家搜索失败，请稍后重试。');
        return;
      }
      if (!data || !Array.isArray(data.results)) {
        setError('服务端返回了无法识别的搜索结果。');
        return;
      }
      setSearchResult(data);
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return;
      setError('网络连接失败，请稍后重试。');
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <main className="mc-page">
      <header className="mc-header">
        <div>
          <div className="mc-eyebrow">MERCHANT DISCOVERY</div>
          <h1>商家信息采集</h1>
          <p>按类别和矩形范围查找 Google Places 商家候选，核实前不会保存任何结果。</p>
        </div>
        <button className="mc-button mc-button-secondary" type="button" onClick={() => navigate('/')}>
          返回清单页面
        </button>
      </header>

      <section className="mc-search-panel" aria-labelledby="merchant-search-heading">
        <div className="mc-panel-heading">
          <div>
            <span className="mc-step">01</span>
            <h2 id="merchant-search-heading">定义搜索区域</h2>
          </div>
          <span className="mc-scope-badge">美国本土 · 最大 50 km</span>
        </div>

        <form className="mc-form" onSubmit={handleSearch}>
          <label className="mc-field mc-field-query">
            <span>商家类别或服务</span>
            <input
              type="text"
              value={form.textQuery}
              onChange={(event) => updateForm('textQuery', event.target.value)}
              placeholder="例如：kitchen cabinet stores"
              maxLength={200}
              disabled={loading}
              autoComplete="off"
            />
            <small>请输入类别或服务，不要把经纬度写入查询词。</small>
          </label>

          <label className="mc-field">
            <span>中心坐标</span>
            <input
              type="text"
              value={form.centerCoordinates}
              onChange={(event) => updateForm('centerCoordinates', event.target.value)}
              placeholder="41.0251868, -73.6527774"
              disabled={loading}
              autoComplete="off"
            />
            <small>从 Google Maps 复制纬度、经度，仅支持连续 48 州。</small>
          </label>

          <label className="mc-field mc-field-range">
            <span>矩形半宽</span>
            <div className="mc-range-input">
              <input
                type="number"
                value={form.rangeKm}
                onChange={(event) => updateForm('rangeKm', event.target.value)}
                min="0.1"
                max={MAX_RANGE_KM}
                step="0.1"
                disabled={loading}
              />
              <strong>km</strong>
            </div>
            <small>输入 10 表示向东、西、南、北各约延伸 10 km。</small>
          </label>

          <div className="mc-submit-cell">
            <button className="mc-button mc-button-primary" type="submit" disabled={loading}>
              {loading ? '正在搜索...' : '搜索商家'}
            </button>
          </div>
        </form>
      </section>

      {error && <div className="mc-alert mc-alert-error" role="alert">{error}</div>}

      <section className="mc-results" aria-labelledby="merchant-results-heading">
        <div className="mc-results-header">
          <div>
            <span className="mc-step">02</span>
            <div>
              <h2 id="merchant-results-heading">临时搜索结果</h2>
              <p>这些候选仅保存在当前页面内存中，刷新或离开页面后会消失。</p>
            </div>
          </div>
          {searchResult && (
            <div className="mc-result-stats" aria-label="搜索统计">
              <span><strong>{searchResult.resultCount}</strong> 条结果</span>
              <span><strong>{searchResult.pageCount}</strong> 页</span>
            </div>
          )}
        </div>

        {searchResult?.possiblyTruncated && (
          <div className="mc-alert mc-alert-warning" role="status">
            已达到 Google 单次查询上限或结果未完整返回，范围内可能还有其他商家。
          </div>
        )}
        {searchResult?.partial && searchResult.warning && (
          <div className="mc-alert mc-alert-partial" role="status">{searchResult.warning}</div>
        )}

        {!searchResult && !loading && (
          <div className="mc-empty-state">
            <div className="mc-empty-index">00</div>
            <div>
              <strong>尚未执行搜索</strong>
              <p>填写上方三个字段后，候选商家会显示在这里。</p>
            </div>
          </div>
        )}
        {loading && (
          <div className="mc-empty-state mc-loading-state" aria-live="polite">
            <div className="mc-loader" />
            <div>
              <strong>正在读取 Google Places</strong>
              <p>服务端会自动读取最多三页结果。</p>
            </div>
          </div>
        )}
        {searchResult && searchResult.results.length === 0 && (
          <div className="mc-empty-state">
            <div className="mc-empty-index">0</div>
            <div>
              <strong>没有找到匹配商家</strong>
              <p>尝试更换类别词、中心点或查询范围。</p>
            </div>
          </div>
        )}

        {searchResult && searchResult.results.length > 0 && (
          <div className="mc-table-shell">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>商家</th>
                  <th>地址</th>
                  <th>电话</th>
                  <th>官网</th>
                  <th>状态</th>
                  <th>地图</th>
                </tr>
              </thead>
              <tbody>
                {searchResult.results.map((merchant) => (
                  <ResultRow key={merchant.placeId} merchant={merchant} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <footer className="mc-attribution">
          <span>
            搜索结果由 <span className="mc-google-attribution" translate="no">Google Maps</span> 提供
          </span>
          <a
            href="https://developers.google.com/maps/documentation/places/web-service/text-search#rankpreference"
            target="_blank"
            rel="noreferrer"
          >
            了解搜索结果排序因素
          </a>
        </footer>
      </section>
    </main>
  );
}
