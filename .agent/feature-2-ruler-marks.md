# Feature 2：wp-track-blocks 动态标尺线

## Goal

在 `wp-track-blocks` 容器内绘制动态标尺线（如 30in, 60in, 90in 标记），给用户对墙体宽度的直观参照。标尺不提供详细信息，只需保证有充足数量的标记。

## 间隔挡位与"充足数量"定义

- 间隔挡位（从大到小）：`30, 15, 9, 6, 3`（英寸）
- **充足数量 = 至少 3 道标记（即 4 个区间）**
- 从最大间隔开始尝试，选第一个满足条件的间隔；若都不满足（极小墙），兜底使用 3in

### 选间隔算法

```
const RULER_INTERVALS = [30, 15, 9, 6, 3];

function pickRulerInterval(wallWidth: number): number {
  for (const iv of RULER_INTERVALS) {
    // 统计 k*iv < wallWidth 的 k 个数（即标记数）
    let marks = 0;
    for (let k = 1; k * iv < wallWidth; k++) marks++;
    if (marks >= 3) return iv;
  }
  return 3; // 极小墙兜底
}
```

### 验证用例

| 墙宽 | 尝试 30in | 标记数 | 结果间隔 | 标记位置 |
|------|-----------|--------|----------|----------|
| 120in | 30,60,90 (k=4→120 不 < 120) | 3 ✓ | 30in | 30, 60, 90 |
| 91in  | 30,60,90 (90 < 91) | 3 ✓ | 30in | 30, 60, 90 |
| 90in  | 30,60 (90 不 < 90) | 2 ✗ → 试 15in | 15in | 15, 30, 45, 60, 75 |
| 45in  | 30 (60 不 < 45) | 1 ✗ → 试 15in → 15,30 (45 不 < 45) | 2 ✗ → 试 9in → 9,18,27,36 | 4 ✓ | 9in | 9, 18, 27, 36 |
| 8in   | 全不满足 | 兜底 3in | 3, 6 |

## 涉及文件

| 文件 | 改动 |
|------|------|
| `client/src/components/WallPanel.tsx` | 添加 `pickRulerInterval` 函数；在 `renderTrack` 的 `wp-track-blocks` 内渲染标尺线 |
| `client/src/components/WallPanel.css` | 添加 `.wp-ruler-mark`、`.wp-ruler-label` 样式 |

## 实施细节

### 1. 纯函数 `pickRulerInterval`

放在 `WallPanel.tsx` 顶部常量区（`PX_PER_INCH` 附近），不依赖组件状态。

### 2. 渲染标尺线

在 `renderTrack` 函数内，`wp-track-blocks` div 中（与 blocks 和拖拽指示线同级）渲染标尺：

```tsx
// 在 renderTrack 内，positioned 和 trackRef 之后
const totalWidth = wall.width || 1;
const rulerInterval = pickRulerInterval(totalWidth);
const rulerMarks: number[] = [];
for (let k = 1; k * rulerInterval < totalWidth; k++) {
  rulerMarks.push(k * rulerInterval);
}
```

在 JSX 中（`wp-track-blocks` 内，blocks map 之后、拖拽指示线之前或之后）：

```tsx
{/* 标尺线 */}
{rulerMarks.map((pos) => (
  <div
    key={`ruler-${pos}`}
    className="wp-ruler-mark"
    style={{ left: `${(pos / totalWidth) * 100}%` }}
  >
    <span className="wp-ruler-label">{pos}{t('英寸')}</span>
  </div>
))}
```

### 3. CSS 样式

```css
/* 标尺线 */
.wp-ruler-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px dashed #ddd;
  z-index: 1;
  pointer-events: none;
}

.wp-ruler-label {
  position: absolute;
  top: 0;
  left: 2px;
  font-size: 9px;
  color: #bbb;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.8);
  padding: 0 2px;
  border-radius: 2px;
}
```

设计要点：
- `pointer-events: none` — 不遮挡块的点击/拖拽
- `z-index: 1` — 在 blocks（默认 z-index）之上但可透视
- 虚线 + 浅灰，视觉上不抢眼
- 标签带半透明白底，防止与块内文字重叠时不可读

### 4. 两轨共用同一间隔

`pickRulerInterval(wall.width)` 在两轨中结果相同，视觉上标尺线在 air/ground 两轨对齐。

## 注意事项

- `wp-track-blocks` 当前 `overflow: hidden`，标尺线在容器内不会溢出，符合预期。
- 标尺线是 `position: absolute`，`wp-track-blocks` 已有 `style={{ position: 'relative' }}`，无需额外修改。
- 极小墙（如 8in）标尺线可能很少（仅 3, 6），这是可接受的——"尽量保证充足"而非强制。

## 验证

- `cd client && npm run build`（tsc + vite）
- 手动 dev 验证：
  - 创建 120in 墙 → 应见 30/60/90 三道标记
  - 创建 90in 墙 → 应见 15/30/45/60/75 五道标记
  - 创建 45in 墙 → 应见 9/18/27/36 四道标记
  - 标尺线不遮挡块的点击和拖拽
  - 标尺标签可读，不与 SKU 文字冲突
