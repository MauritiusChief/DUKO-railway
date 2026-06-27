/**
 * HistoryPage —— 用户解析记录历史页面
 *
 * 左侧：按时间倒序排列的记录摘要列表（时间戳 + 行数）
 * 右侧：选中记录的详情（只读的输入文本、颜色提示、解析结果表格、对话记录）
 * 支持删除记录和"填充回主页"操作。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTableParseStore, SHAPE_TYPES_COLOR_NA, SHAPE_TYPES_SIZE_NA } from '../stores/tableParseStore';
import { fetchWithAuth } from '../lib/fetchWithAuth';
import { useI18n } from '../i18n/context';
import type { TranslationKey } from '../i18n/translations';
import type { HistoryRecordSummary, HistoryRecordFull, ParsedItem, ConversationEntry } from '../types';
import './HistoryPage.css';

/** 格式化 SQLite datetime('now') 输出为友好的本地时间字符串 */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return iso;
  }
}

/** 获取 item 的匹配状态文本 */
function getStatusText(item: ParsedItem, t: (key: TranslationKey) => string): string {
  const shapeTypeCode = item.shapeType.values.length > 0 ? item.shapeType.values[0].toUpperCase() : '';
  const colorIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_COLOR_NA.has(shapeTypeCode);
  const sizeIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_SIZE_NA.has(shapeTypeCode);

  if (!item.shapeType.values.length) return t('未知');
  if (item.colorIgnored ?? colorIgnored) return 'N/A';
  if (item.shapeSizeIgnored ?? sizeIgnored) return 'N/A';
  return item.status === 'found' ? t('已匹配') : t('未匹配');
}

export default function HistoryPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  const [records, setRecords] = useState<HistoryRecordSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<HistoryRecordFull | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  const replaceItems = useTableParseStore((s) => s.replaceItems);
  const setInput = useTableParseStore((s) => s.setInput);
  const setColorHints = useTableParseStore((s) => s.setColorHints);

  /** 加载记录摘要列表 */
  const fetchRecords = async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/api/history');
      if (res.ok) {
        const data: HistoryRecordSummary[] = await res.json();
        setRecords(data);
      }
    } catch {
      /* 静默失败 */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
  }, []);

  /** 点击记录 —— 加载详情 */
  const handleSelect = async (id: number) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await fetchWithAuth(`/api/history/${id}`);
      if (res.ok) {
        const data: HistoryRecordFull = await res.json();
        setDetail(data);
      }
    } catch {
      /* 静默失败 */
    } finally {
      setDetailLoading(false);
    }
  };

  /** 删除记录 */
  const handleDelete = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetchWithAuth(`/api/history/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setRecords((prev) => prev.filter((r) => r.id !== id));
        if (selectedId === id) {
          setSelectedId(null);
          setDetail(null);
        }
      }
    } catch {
      /* 静默失败 */
    }
  };

  /** 填充回主页：将记录的 items / input / colorHints 写入 store，跳转到 "/" */
  const handleFillBack = () => {
    if (!detail) return;

    replaceItems(detail.items);
    setInput(detail.input);
    setColorHints(detail.colorHints);

    navigate('/');
  };

  const hasItems = detail && detail.items.length > 0;
  const hasConversation = detail && detail.conversation.length > 0;

  return (
    <div className="history-container">
      {/* 标题栏 */}
      <div className="history-header">
        <div className="history-header-left">
          <div className="history-header-title">{t('历史记录')}</div>
        </div>
        <button className="tp-submit-btn" onClick={() => navigate('/')}>
          {t('回到主页')}
        </button>
      </div>

      {/* 主区域 */}
      <div className="history-main">
        {/* 左侧：记录列表 */}
        <div className="history-left">
          <div className="history-left-header">{t('历史记录')}</div>
          <div className="history-list">
            {loading && <div className="history-list-empty">{t('解析中') + '...'}</div>}
            {!loading && records.length === 0 && (
              <div className="history-list-empty">{t('无记录提示')}</div>
            )}
            {records.map((rec) => (
              <div
                key={rec.id}
                className={`history-list-item${selectedId === rec.id ? ' history-list-item-active' : ''}`}
                onClick={() => handleSelect(rec.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSelect(rec.id);
                }}
              >
                <div className="history-item-main">
                  <span className="history-item-time">{formatTime(rec.created_at)}</span>
                  <span className="history-item-count">
                    {rec.itemCount} {t('行')}
                  </span>
                </div>
                <button
                  className="history-item-delete"
                  onClick={(e) => handleDelete(rec.id, e)}
                  title={t('删除记录')}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧：记录详情 */}
        <div className="history-right">
          {!selectedId && (
            <div className="history-detail-empty">
              {records.length > 0 ? t('选择记录提示') : ''}
            </div>
          )}

          {detailLoading && (
            <div className="history-detail-loading">{t('解析中') + '...'}</div>
          )}

          {detail && !detailLoading && (
            <div className="history-detail">
              {/* TOP 区：左右分栏 —— 输入文本 + 颜色提示 */}
              <div className="history-top">
                <div className="history-top-left">
                  <div className="history-section-label">{t('原始输入')}</div>
                  <textarea
                    className="history-textarea"
                    value={detail.input}
                    readOnly
                  />
                </div>
                <div className="history-top-right">
                  <div className="history-section-label">{t('颜色')}</div>
                  {detail.colorHints.length > 0 ? (
                    <ul className="history-color-list">
                      {detail.colorHints.map((code) => (
                        <li key={code} className="history-color-item">{code}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="history-no-colors">-</div>
                  )}
                </div>
              </div>

              {/* MID 区：解析结果表格（只读） */}
              {hasItems && (
                <div className="history-result-section">
                  <div className="history-section-label">
                    {t('解析结果')} ({detail.items.length} {t('行')})
                  </div>
                  <div className="history-table-wrapper">
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th className="history-th-name">{t('原始名称')}</th>
                          <th className="history-th-field">{t('颜色')}</th>
                          <th className="history-th-field">{t('形状型号')}</th>
                          <th className="history-th-field">{t('形状尺寸')}</th>
                          <th className="history-th-qty">{t('数量')}</th>
                          <th className="history-th-req">{t('定制要求')}</th>
                          <th className="history-th-status">{t('匹配状态')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.items.map((item, i) => (
                          <tr key={i}>
                            <td className="history-td-name">{item.originalName}</td>
                            <td className="history-td-field">
                              <input
                                type="text"
                                className="cell-input"
                                value={item.color.values[0] ?? ''}
                                readOnly
                                disabled
                              />
                            </td>
                            <td className="history-td-field">
                              <input
                                type="text"
                                className="cell-input"
                                value={item.shapeType.values[0] ?? ''}
                                readOnly
                                disabled
                              />
                            </td>
                            <td className="history-td-field">
                              <input
                                type="text"
                                className="cell-input"
                                value={item.shapeSize.values[0] ?? ''}
                                readOnly
                                disabled
                              />
                            </td>
                            <td className="history-td-qty">
                              <input
                                type="text"
                                className="cell-input cell-input-qty"
                                value={item.quantity}
                                readOnly
                                disabled
                              />
                            </td>
                            <td className="history-td-req">
                              <span className="history-req-text">
                                {item.customRequirement === 'door'
                                  ? t('door')
                                  : item.customRequirement === 'box'
                                    ? t('box')
                                    : '-'}
                              </span>
                            </td>
                            <td className="history-td-status">
                              <span className={`history-status history-status-${item.status}`}>
                                {getStatusText(item, t)}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 填充回主页按钮 */}
              {hasItems && (
                <div className="history-fill-row">
                  <button className="tp-submit-btn" onClick={handleFillBack}>
                    {t('填充回主页')}
                  </button>
                </div>
              )}

              {/* 对话记录 */}
              {hasConversation && (
                <div className="history-conversation-section">
                  <div className="history-section-label">{t('对话记录')}</div>
                  <div className="history-conversation-list">
                    {detail.conversation.map((entry, i) => (
                      <div key={i} className={`history-conv-msg history-conv-msg-${entry.role}`}>
                        <div className="history-conv-role">
                          {entry.role === 'user' || entry.role === 'parse_start'
                            ? t('你')
                            : t('助手')}
                        </div>
                        {entry.role === 'parse_start' ? (
                          <div className="history-conv-content history-conv-parse-start">
                            <ul className="history-parse-start-list">
                              {entry.meta?.colorCodes && entry.meta.colorCodes.length > 0 && (
                                <li>
                                  <strong>{t('颜色')}:</strong>{' '}
                                  {entry.meta.colorCodes.map((c) => (
                                    <code key={c} className="history-parse-start-code">{c}</code>
                                  ))}
                                </li>
                              )}
                              <li>
                                <strong>{t('行数标签')}:</strong>{' '}
                                {t('行数', { n: entry.meta?.lineCount ?? 0 })}
                              </li>
                            </ul>
                          </div>
                        ) : (
                          <div className="history-conv-content">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {entry.content}
                            </ReactMarkdown>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
