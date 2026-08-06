/**
 * TableParsePage —— 清单解析 agent 的前端界面
 *
 * 布局（左栏 + 右栏）：
 *   1. 顶部标题栏（全宽）
 *   2. 左栏：上区（清单输入 + 颜色勾选）| 横向分隔条 | 下区（解析结果 + 产品清单）
 *   3. 右栏：对话面板（完整高度）
 *
 * 解析结果表格（7 列）：
 *   - 原始名称/型号（只读）
 *   - 颜色（信心感知编辑）
 *   - 形状型号（信心感知编辑）
 *   - 形状尺寸（信心感知编辑）
 *   - 数量（数字输入）
 *
 * 信心感知单元格逻辑：
 *   values.length === 1 → 确认（白色背景，预填文本输入）
 *   values.length  >  1 → 候选（橙色背景，radio 组 + 自定义）
 *   values.length === 0 → 未知（红色背景，空白文本输入）
 *
 * 输入模式切换：
 *   支持文本模式和图片模式。图片模式下，用户可粘贴截图或选择图片文件，
 *   由 OpenRouter 视觉模型解析图片内容后返回文本，自动预填入文本输入框。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTableParseStore, SHAPE_TYPES_COLOR_NA, SHAPE_TYPES_SIZE_NA } from '../stores/tableParseStore';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../i18n/context';
import { useSplitResize } from '../hooks/useSplitResize';
import type { ParsedItem } from '../types';
import ChatPanel from '../components/ChatPanel';
import { SegSwitch } from '../components/SegSwitch';
import './TableParsePage.css';

// =================================================================
// ConfidenceCell —— 根据 values 数组长度渲染不同 UI
// =================================================================

interface ConfidenceCellProps {
  /** 后端返回的候选值数组（长度决定信心状态） */
  values: string[];
  /** 字段 + 行索引的组合名，用作 radio group 的 name */
  radioGroupName: string;
  /** 用户选择/编辑后的回调 */
  onChange: (value: string) => void;
  /** 是否禁用 */
  disabled?: boolean;
  /** 单元格内输入/radio 失焦或选择后触发（用于重新检查 Exposed-Items 匹配状态） */
  onFieldBlur?: () => void;
}

function ConfidenceCell({
  values,
  radioGroupName,
  onChange,
  disabled = false,
  onFieldBlur,
}: ConfidenceCellProps) {
  const { t } = useI18n();

  // ---- 候选模式下的本地状态 ----
  // selectedRadio = -1 表示无预选，用户必须显式点击 radio 才能确认
  const [selectedRadio, setSelectedRadio] = useState<number>(-1);
  const [customValue, setCustomValue] = useState('');
  // 未知模式的本地编辑值（延迟到 blur 才提交）
  const [localUnknown, setLocalUnknown] = useState('');

  // values 数组变化时（后端重新解析）重置全部本地状态
  useEffect(() => {
    setSelectedRadio(-1);
    setCustomValue('');
    setLocalUnknown('');
  }, [values]);

  // ========== 确认模式：values.length === 1 ==========

  if (values.length === 1) {
    return (
      <input
        type="text"
        className="cell-input"
        value={values[0]}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onFieldBlur}
        disabled={disabled}
      />
    );
  }

  // ========== 候选模式：values.length > 1 ==========
  // n 个候选值 → n 个 label radio + 1 个自定义 radio
  // 共 n+1 个 radio button

  if (values.length > 1) {
    const handleRadioChange = (index: number) => {
      setSelectedRadio(index);
      if (index < values.length) {
        // 选中某个候选 label
        onChange(values[index]);
      }
      // 选择变更后触发外层 Exposed-Items 重查
      onFieldBlur?.();
    };

    const handleCustomChange = (val: string) => {
      setCustomValue(val);
      // 不立即提交，保持橙色；blur 时若非空再提交
    };

    // 点击自定义输入框时自动切换到自定义 radio
    const handleCustomInputFocus = () => {
      if (selectedRadio !== values.length) {
        setSelectedRadio(values.length);
      }
    };

    return (
      <div className="cell-candidates">
        {/* 候选 label radio */}
        {values.map((v, i) => (
          <label key={i} className="cell-radio-label">
            <input
              type="radio"
              name={radioGroupName}
              checked={selectedRadio === i}
              onChange={() => handleRadioChange(i)}
              disabled={disabled}
            />
            <span>{v}</span>
          </label>
        ))}

        {/* 自定义 radio + 文本输入 */}
        <label className="cell-radio-label cell-radio-custom">
          <input
            type="radio"
            name={radioGroupName}
            checked={selectedRadio === values.length}
            onChange={() => handleRadioChange(values.length)}
            disabled={disabled}
          />
          <input
            type="text"
            className="cell-input cell-input-inline"
            value={customValue}
            onChange={(e) => handleCustomChange(e.target.value)}
            onFocus={handleCustomInputFocus}
            onBlur={() => {
              if (customValue.trim() && selectedRadio === values.length) {
                onChange(customValue);
              }
              onFieldBlur?.();
            }}
            disabled={disabled || selectedRadio !== values.length}
            placeholder="自填..."
          />
        </label>
      </div>
    );
  }

  // ========== 未知模式：values.length === 0 ==========

  return (
    <input
      type="text"
      className="cell-input cell-input-unknown"
      value={localUnknown}
      onChange={(e) => setLocalUnknown(e.target.value)}
      onBlur={() => {
        if (localUnknown.trim()) {
          onChange(localUnknown);
        }
        onFieldBlur?.();
      }}
      disabled={disabled}
      placeholder={t('未知')}
    />
  );
}

// =================================================================
// TableParsePage —— 主页面组件
// =================================================================

export default function TableParsePage() {
  const {
    input,
    colorHints,
    availableColors,
    items,
    loading,
    error,
    products,
    productsLoading,
    unresolvedCount,
    unresolvedIndices,
    resultCollapsed,
    productsCollapsed,
    // 图片模式相关
    inputMode,
    imageDataList,
    imagePreviewUrls,
    imageLoading,
    setInput,
    toggleColorHint,
    fetchColors,
    parseTable,
    updateItemField,
    removeItem,
    checkExposedItems,
    generateProducts,
    toggleResultCollapsed,
    toggleProductsCollapsed,
    copyProductsCsv,
    copySuccess,
    fromHistoryRestored,
    saveArchive,
    loadArchiveData,
    addEmptyItem,
    // 图片模式操作
    setInputMode,
    addImage,
    removeImage,
    clearImages,
    parseImage,
  } = useTableParseStore();

  const { logout, user } = useAuthStore();
  const { lang, setLang, t } = useI18n();
  const navigate = useNavigate();

  // 页面加载时获取颜色列表
  useEffect(() => {
    fetchColors();
  }, []);

  /** 用于触分 <input type="file"> 加载存档 JSON */
  const fileInputRef = useRef<HTMLInputElement>(null);

  /** 加载存档：读取用户选择的 JSON 文件并载入 store */
  const handleLoadArchive = () => {
    const input = fileInputRef.current;
    if (!input) return;

    const handleFile = (e: Event) => {
      const target = e.target as HTMLInputElement;
      const file = target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result as string);
          const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.items) ? parsed.items : null);
          if (!items || items.length === 0) {
            alert('存档文件格式无效：缺少 items 数组。');
            return;
          }
          // 校验每项是否为 ParsedItem 结构
          if (!items.every((it: any) => it && typeof it.originalName === 'string' && typeof it.quantity === 'number')) {
            alert('存档文件格式无效：数组元素缺少 originalName 或 quantity 字段。');
            return;
          }
          loadArchiveData(items as ParsedItem[]);
        } catch {
          alert('文件读取失败：无法解析 JSON。');
        }
      };
      reader.readAsText(file);

      // 清除选择以支持重复加载同一文件
      target.value = '';
      input.removeEventListener('change', handleFile);
    };

    input.addEventListener('change', handleFile);
    input.click();
  };

  /** 三个可拖拽分隔条的尺寸状态（百分比） */
  const [topAreaHeight, setTopAreaHeight] = useState(40);
  const [topLeftWidth, setTopLeftWidth] = useState(60);
  const [chatColumnWidth, setChatColumnWidth] = useState(35);

  const containerRef = useRef<HTMLDivElement>(null);
  const topAreaRef = useRef<HTMLDivElement>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const leftColumnRef = useRef<HTMLDivElement>(null);

  const { startResize } = useSplitResize({
    horizontal: {
      cursor: 'row-resize',
      getContainer: () => leftColumnRef.current,
      onResize: (pct) => setTopAreaHeight(Math.max(15, Math.min(70, pct))),
      getPercent: (e, rect) => {
        const topAreaEl = topAreaRef.current;
        if (!topAreaEl) return 0;
        const topAreaRect = topAreaEl.getBoundingClientRect();
        const headerOffset = topAreaRect.top - rect.top;
        return ((e.clientY - rect.top - headerOffset) / rect.height) * 100;
      },
    },
    'top-vertical': {
      cursor: 'col-resize',
      getContainer: () => topAreaRef.current,
      onResize: (pct) => setTopLeftWidth(Math.max(30, Math.min(80, pct))),
      getPercent: (e, rect) => ((e.clientX - rect.left) / rect.width) * 100,
    },
    'main-vertical': {
      cursor: 'col-resize',
      getContainer: () => mainAreaRef.current,
      onResize: (pct) => setChatColumnWidth(100 - Math.max(40, Math.min(85, pct))),
      getPercent: (e, rect) => ((e.clientX - rect.left) / rect.width) * 100,
    },
  });

  // Ctrl+Enter 触分解析
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      parseTable();
    }
  };

  const handleDownloadScript = () => {
    const a = document.createElement('a');
    a.href = '/api/script/download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // =================================================================
  // 图片输入模式 —— 压缩、粘贴、文件选择
  // =================================================================

  /** 用于触发 <input type="file"> 的文件输入引用 */
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  /** 拖拽悬停状态（用于高亮 drop zone） */
  const [isDragOver, setIsDragOver] = useState(false);

  /**
   * 将图片文件/Blob 压缩并转为 base64 data URL。
   *
   * 压缩策略：
   *  - 最大尺寸 2048px（宽或高），维持原始宽高比
   *  - JPEG 格式，quality 0.8
   *  - 若图片小于限制 → 不缩放，但统一转换为 JPEG base64
   *
   * @param file - 图片文件或 Blob
   * @returns base64 data URL（data:image/jpeg;base64,...）
   */
  function compressImage(file: File | Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          const maxDim = 1536;

          // 缩放到 maxDim 以内
          if (width > maxDim || height > maxDim) {
            const ratio = Math.min(maxDim / width, maxDim / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('Canvas context 创建失败'));
            return;
          }
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.6));
        };
        img.onerror = () => reject(new Error('图片加载失败'));
        img.src = reader.result as string;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }

  /** 处理文件（从文件选择或粘贴中获取） */
  async function handleImageFile(file: File) {
    if (!file.type.startsWith('image/')) {
      alert(t('图片格式错误'));
      return;
    }
    try {
      const dataUrl = await compressImage(file);
      addImage(dataUrl);
    } catch (err) {
      console.error('图片处理失败:', err);
      clearImages();
    }
  }

  /** 文件选择按钮点击 → 触发隐藏的 <input type="file"> */
  const handleBrowseClick = () => {
    imageFileInputRef.current?.click();
  };

  /** 隐藏文件输入的选择事件 */
  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImageFile(file);
    }
    // 清除选择以支持重复选择同一文件
    e.target.value = '';
  };

  /** 处理粘贴事件：拦截图片粘贴 */
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    // 优先查找图片
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) {
          handleImageFile(file);
        }
        return;
      }
    }
  };

  /** 拖拽事件 —— 阻止默认行为以允许 drop */
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  /** 拖拽放下图片文件 */
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      handleImageFile(file);
    }
  };

  return (
    <div className="table-parse-container" ref={containerRef}>
      {/* ---- 标题 ---- */}
      <div className="tp-header">
        <div className="tp-header-left">
          <div className="tp-header-title">{t('页面标题')}</div>
          <div className="tp-header-sub">{t('页面说明')}</div>
        </div>
        <div className="tp-header-right">
          <SegSwitch
            options={[
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            value={lang}
            onChange={setLang}
          />
          <button className="tp-submit-btn tp-download-btn" onClick={() => navigate('/quotation-tasks')}>
            {t('前往报价任务')}
          </button>
          {(user?.role === 'admin' || user?.role === 'manager') && (
            <button className="tp-submit-btn tp-download-btn" onClick={() => navigate('/inventory')}>
              库存看板
            </button>
          )}
          <button className="tp-submit-btn tp-download-btn" onClick={handleDownloadScript}>
            {t('下载脚本')}
          </button>
          <button className="tp-submit-btn tp-download-btn" onClick={() => navigate('/history')}>
            {t('前往历史记录')}
          </button>
          <button className="tp-submit-btn tp-logout-btn" onClick={logout} title={user ? `${user.username} (${user.role})` : ''}>
            {t('登出')}
          </button>
        </div>
      </div>

      {/* ---- 主区域：左栏（输入 + 颜色 + 表格）| 分割线 | 右栏（对话） ---- */}
      <div className="tp-main-area" ref={mainAreaRef}>
        <div className="tp-left-column" ref={leftColumnRef}>
          {/* ---- 上二列区：清单输入（左）| 分割线 | 颜色勾选（右） ---- */}
          <div className="tp-top-area" ref={topAreaRef} style={{ height: `${topAreaHeight}%` }}>
            <div className="tp-top-left" style={{ width: `${topLeftWidth}%` }}>

              {/* ---- 输入模式切换 ---- */}
          <SegSwitch
            options={[
              { value: 'text', label: t('文本模式') },
              { value: 'image', label: t('图片模式') },
            ]}
            value={inputMode}
            onChange={setInputMode}
            disabled={loading || imageLoading}
          />

          {/* ======== 文本模式：textarea ======== */}
          {inputMode === 'text' && (
            <>
              <textarea
                className="tp-textarea"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t('输入框提示')}
                rows={10}
                disabled={loading}
              />

              {/* 解析按钮行 */}
              <div className="tp-action-row">
                <div className="tp-action-row-left">
                  <button
                    className="tp-submit-btn"
                    onClick={parseTable}
                    disabled={loading || !input.trim()}
                  >
                    {loading ? t('解析中') : t('解析清单')}
                  </button>
                  <span className="tp-hint">{t('快捷键提示')}</span>
                </div>
                <button
                  className="tp-submit-btn tp-archive-btn"
                  onClick={handleLoadArchive}
                >
                  {t('加载存档')}
                </button>
              </div>
              <input
                type="file"
                ref={fileInputRef}
                accept=".json"
                style={{ display: 'none' }}
              />
            </>
          )}

          {/* ======== 图片模式：粘贴/上传图片 ======== */}
          {inputMode === 'image' && (
            <>
              {imageDataList.length > 0 && (
                /* 已有图片 → 显示缩略图列表 + 删除按钮 */
                <div className="tp-image-thumbnails">
                  {imagePreviewUrls.map((url, i) => (
                    <div key={i} className="tp-image-thumbnail-wrapper">
                      <img
                        className="tp-image-thumbnail"
                        src={url}
                        alt={`上传的图片 ${i + 1}`}
                      />
                      <button
                        className="tp-thumbnail-delete-btn"
                        onClick={() => removeImage(i)}
                        disabled={imageLoading}
                        title={t('删除此行')}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* drop zone 始终可见，允许追加更多图片 */}
              <div
                className={`tp-image-dropzone${isDragOver ? ' tp-dropzone-active' : ''}`}
                onPaste={handlePaste}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                tabIndex={0}
              >
                <div className="tp-dropzone-text">
                  {imageDataList.length > 0
                    ? t('图片追加提示')
                    : t('图片上传提示')}
                </div>
                <button
                  className="tp-submit-btn tp-browse-btn"
                  onClick={handleBrowseClick}
                  disabled={imageLoading}
                  type="button"
                >
                  {t('浏览')}
                </button>
              </div>

              {imageDataList.length > 0 && (
                <div className="tp-image-actions">
                  <button
                    className="tp-submit-btn"
                    onClick={parseImage}
                    disabled={imageLoading}
                  >
                    {imageLoading ? t('图片处理中') : t('处理图片')}
                  </button>
                  <button
                    className="tp-submit-btn tp-clear-btn"
                    onClick={clearImages}
                    disabled={imageLoading}
                  >
                    {t('清除图片')}
                  </button>
                </div>
              )}

              {/* 隐藏的图片文件输入 */}
              <input
                type="file"
                ref={imageFileInputRef}
                accept="image/*"
                onChange={handleFileInputChange}
                style={{ display: 'none' }}
              />
            </>
          )}

          {/* 错误信息 */}
          {error && <div className="tp-error">{error}</div>}
          {/* 历史自动恢复提示 */}
          {fromHistoryRestored && !error && (
            <div className="tp-recovery-hint">{t('从历史恢复提示')}</div>
          )}
        </div>
        <div
          className="tp-resize-handle"
          onMouseDown={startResize('top-vertical')}
        />
        <div className="tp-top-right">
          <span className="tp-color-hints-label">{t('颜色提示')}</span>
          <div className="tp-color-list">
            {availableColors.map((c) => (
              <label key={c.code} className="tp-color-row">
                <input
                  type="checkbox"
                  checked={colorHints.has(c.code)}
                  onChange={() => toggleColorHint(c.code)}
                  disabled={loading}
                />
                <span>[{c.code}] {c.name}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ---- 横向分隔条（上下拖拽调节） ---- */}
      <div
        className="tp-horizontal-handle"
        onMouseDown={startResize('horizontal')}
      />

      {/* ---- 下区：左（解析 + 产品）全宽 ---- */}
      <div className="tp-bottom-area">
        <div className="tp-left-panel">
          {/* ---- 结果表格（五列可折叠区） ---- */}
            <div className={`tp-result-section${resultCollapsed ? ' tp-collapsed' : ''}`}>
              <div
                className="tp-result-header"
                onClick={toggleResultCollapsed}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleResultCollapsed();
                  }
                }}
              >
                <span className="tp-result-header-icon">{resultCollapsed ? '\u25B8' : '\u25BE'}</span>
                <span className="tp-result-header-text">{t('解析结果')}（{t('行数', { n: items.length })}）</span>
              </div>
              {!resultCollapsed && (
                <>
                  {items.length === 0 ? (
                    <div className="tp-empty-state">
                      <span className="tp-empty-state-text">{t('暂无结果')}</span>
                      <button
                        className="tp-submit-btn"
                        onClick={addEmptyItem}
                        disabled={loading}
                      >
                        {t('添加空行')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="tp-table-wrapper">
                        <table className="tp-table">
                        <thead>
                          <tr>
                            <th className="tp-th-name">{t('原始名称')}</th>
                            <th className="tp-th-field">{t('颜色')}</th>
                            <th className="tp-th-field">{t('形状型号')}</th>
                            <th className="tp-th-field">{t('形状尺寸')}</th>
                            <th className="tp-th-req">{t('定制要求')}</th>
                            <th className="tp-th-qty">{t('数量')}</th>
                            <th className="tp-th-action">{t('操作')}</th>
                          </tr>
                        </thead>
                         <tbody>
                          {items.map((item, rowIndex) => {
                            /** 直接读取 item 内置的 status */
                            const rowStatus = item.status || 'missing';

                            /** 忽略标记：动态派生自当前 shapeType.values[0]，
                             *  随用户编辑 shapeType 自动跟随变化。 */
                            const shapeTypeCode = item.shapeType.values.length > 0
                              ? item.shapeType.values[0].toUpperCase()
                              : '';
                            const dynColorIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_COLOR_NA.has(shapeTypeCode);
                            const dynSizeIgnored = shapeTypeCode.length > 0 && SHAPE_TYPES_SIZE_NA.has(shapeTypeCode);

                            /** 计算单格 CSS 类名：
                             *   - 字段被忽略 → 无特殊样式（该型号天然不需要此字段）
                             *   - 空字段 + 非忽略 → cell-unknown（红色，需要关注）
                             *   - 多候选 → cell-candidates（橙色）
                             *   - 确认 ∧ 行状态 missing → cell-exposed-missing（黄色） */
                            const getCellClass = (field: 'color' | 'shapeType' | 'shapeSize', item: ParsedItem): string => {
                              const valuesLen = item[field].values.length;

                              if (valuesLen === 0) {
                                // 被忽略的字段：不渲染任何警告样式（无需用户关注）
                                if (field === 'color' && dynColorIgnored) {
                                  return '';
                                }
                                if (field === 'shapeSize' && dynSizeIgnored) {
                                  return '';
                                }
                                return 'cell-unknown';
                              }
                              if (valuesLen > 1) return 'cell-candidates';
                              // valuesLen === 1（确认）
                              if (rowStatus === 'missing') {
                                return 'cell-exposed-missing';
                              }
                              return '';
                            };

                            return (
                            <tr key={rowIndex}>
                              {/* 原始名称 —— 只读 */}
                              <td className="tp-td-name">{item.originalName}</td>

                              {/* 颜色 */}
                              <td className={`tp-td-field ${getCellClass('color', item)}`}>
                                <ConfidenceCell
                                  values={item.color.values}
                                  radioGroupName={`color-${rowIndex}`}
                                  onChange={(val) => updateItemField(rowIndex, 'color', val)}
                                  disabled={loading}
                                  onFieldBlur={checkExposedItems}
                                />
                              </td>

                              {/* 形状型号 */}
                              <td className={`tp-td-field ${getCellClass('shapeType', item)}`}>
                                <ConfidenceCell
                                  values={item.shapeType.values}
                                  radioGroupName={`shapeType-${rowIndex}`}
                                  onChange={(val) => updateItemField(rowIndex, 'shapeType', val)}
                                  disabled={loading}
                                  onFieldBlur={checkExposedItems}
                                />
                              </td>

                              {/* 形状尺寸 */}
                              <td className={`tp-td-field ${getCellClass('shapeSize', item)}`}>
                                <ConfidenceCell
                                  values={item.shapeSize.values}
                                  radioGroupName={`shapeSize-${rowIndex}`}
                                  onChange={(val) => updateItemField(rowIndex, 'shapeSize', val)}
                                  disabled={loading}
                                  onFieldBlur={checkExposedItems}
                                />
                              </td>

                              {/* 定制要求 —— 下拉选择 */}
                              <td className="tp-td-req">
                                <select
                                  className="tp-select-req"
                                  value={item.customRequirement ?? ''}
                                  onChange={(e) => updateItemField(rowIndex, 'customRequirement', e.target.value)}
                                  disabled={loading}
                                >
                                  <option value="">-</option>
                                  <option value="door">{t('door')}</option>
                                  <option value="box">{t('box')}</option>
                                </select>
                              </td>

                              {/* 数量 —— 数字编辑框 */}
                              <td className="tp-td-qty">
                                <input
                                  type="number"
                                  className="cell-input cell-input-qty"
                                  min={1}
                                  value={item.quantity}
                                  onChange={(e) =>
                                    updateItemField(rowIndex, 'quantity', parseInt(e.target.value, 10) || 1)
                                  }
                                  disabled={loading}
                                />
                              </td>

                              {/* 删除按钮 */}
                              <td className="tp-td-action">
                                <button
                                  className="tp-delete-btn"
                                  onClick={() => removeItem(rowIndex)}
                                  disabled={loading}
                                  title={t('删除此行')}
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                      {/* 生成产品清单 + 保存存档 + 添加空行按钮行 */}
                      <div className="tp-button-row">
                        <button
                          className="tp-submit-btn tp-generate-btn"
                          onClick={generateProducts}
                          disabled={productsLoading || items.length === 0}
                        >
                          {productsLoading ? t('生成中') : t('生成产品清单')}
                        </button>
                        <button
                          className="tp-submit-btn tp-generate-btn"
                          onClick={saveArchive}
                          disabled={items.length === 0}
                        >
                          {t('保存存档')}
                        </button>
                        <button
                          className="tp-submit-btn"
                          onClick={addEmptyItem}
                          disabled={loading}
                        >
                          {t('添加空行')}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

          {/* ---- 产品清单（三列可折叠区） ---- */}
          {products.length > 0 && (
            <div className={`tp-result-section${productsCollapsed ? ' tp-collapsed' : ''}`}>
              <div
                className="tp-result-header"
                onClick={toggleProductsCollapsed}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleProductsCollapsed();
                  }
                }}
              >
                <span className="tp-result-header-icon">{productsCollapsed ? '\u25B8' : '\u25BE'}</span>
                <span className="tp-result-header-text">{t('产品清单')}（{t('项数', { n: products.length })}）</span>
              </div>
              {!productsCollapsed && (
                <>
                  {/* 未解析提示 */}
                  {unresolvedCount > 0 && (
                    <div className="tp-unresolved-hint">
                      {t('未解析提示', { n: unresolvedCount, rows: unresolvedIndices.map((i) => i + 1).join(', ') })}
                    </div>
                  )}
                  <div className="tp-product-table-wrapper">
                    <table className="tp-table tp-product-table">
                      <thead>
                        <tr>
                          <th className="tp-th-sku">{t('SKU')}</th>
                          <th className="tp-th-desc">{t('描述')}</th>
                          <th className="tp-th-qty">{t('数量')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {products.map((p, i) => (
                          <tr key={i}>
                            <td className="tp-td-sku">{p.productName}</td>
                            <td className="tp-td-desc">{p.description}</td>
                            <td className="tp-td-qty">{p.quantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* 复制 CSV 按钮 */}
                  <div className="tp-scriptcat-actions">
                    <button
                      className="tp-submit-btn tp-generate-btn"
                      onClick={copyProductsCsv}
                    >
                      {copySuccess ? t('已复制') : t('复制CSV')}
                    </button>
                    <button
                      className="tp-submit-btn tp-generate-btn"
                      onClick={() => {
                        const products = useTableParseStore.getState().products
                        const csv = products.map((p) => `${p.productName},${p.quantity}`).join('\n')
                        const draft = {
                          quotationNumber: '',
                          writeMode: 'append' as const,
                          csvText: csv,
                          savedAt: Date.now(),
                        }
                        localStorage.setItem('duko_quotation_draft', JSON.stringify(draft))
                        navigate('/quotation-tasks')
                      }}
                    >
                      {t('创建报价任务')}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
        </div>
        <div
          className="tp-resize-handle"
          onMouseDown={startResize('main-vertical')}
        />
        <div className="tp-chat-column" style={{ width: `${chatColumnWidth}%` }}>
          <ChatPanel />
        </div>
      </div>
    </div>
  );
}
