# Feature 3：拖拽改序 + 精确位置编辑

## Goal

将拖拽行为从「任意位置放置」改为「仅调整顺序」（吸附到块间隙）。同时在 BlockInfoBar 信息栏中开放「距左位置」的直接编辑，支持精确调整橱柜位置，包含推挤逻辑。

## 涉及文件

| 文件 | 改动 |
|------|------|
| `client/src/stores/layoutStore.ts` | 新增 `reorderBlock`、`setBlockPosition` 方法 |
| `client/src/components/WallPanel.tsx` | 拖拽 mousemove/mouseup 改为吸附间隙 + 调 `reorderBlock` |
| `client/src/components/BlockInfoBar.tsx` | 「距左」从只读 span 改为可编辑 input（blur/Enter 提交 → `setBlockPosition`） |
| `client/src/components/panelForm.css` | 若需样式，复用 `pf-input`/`pf-width-input` |
| `client/src/i18n/translations.ts` | 若需新增翻译 key |

---

## 3a. 拖拽改为仅调序

### 当前行为（需替换）

`WallPanel.tsx` 的拖拽逻辑（约 160-215 行）：
- `handleDragStart`：记录鼠标相对轨道左侧偏移
- `mousemove`：`setDragIndicatorX(x)` — 指示线跟随鼠标任意位置
- `mouseup`：计算 `newDistanceFromLeft = dropX * inchesPerPixel`，调 `store.moveBlock(wallId, track, blockId, newDistanceFromLeft)` — 任意位置放置（split gap / push right）

### 新行为

#### mousemove：吸附到最近间隙

块间隙 = 累积宽度的边界位置，即 `[0, w0, w0+w1, w0+w1+w2, ..., total]`。

```tsx
const handleMouseMove = (e: MouseEvent) => {
  const trackEl = trackRef.current;
  if (!trackEl) return;
  const trackRect = trackEl.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - trackRect.left, trackRect.width));

  // 计算所有间隙的像素位置
  const inchesPerPixel = (wall.width || 1) / (trackRect.width || 1);
  const boundaries: number[] = [0]; // 左边界
  let cumulative = 0;
  for (const b of positioned) {
    cumulative += b.block.width;
    boundaries.push(cumulative);
  }
  // 找最近的边界
  let nearestPx = 0;
  let nearestDist = Infinity;
  for (const boundary of boundaries) {
    const boundaryPx = (boundary / (wall.width || 1)) * trackRect.width;
    const dist = Math.abs(x - boundaryPx);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestPx = boundaryPx;
    }
  }
  setDragIndicatorX(nearestPx);
};
```

#### mouseup：调 `reorderBlock`

根据吸附到的边界，确定目标索引 `toIndex`：

```tsx
const handleMouseUp = (e: MouseEvent) => {
  // ... 同样计算 nearestPx 和对应的 boundary（英寸）
  // boundary 对应的索引 = 该边界之前有几个块
  // boundaries[0]=0 → toIndex=0（插到最前）
  // boundaries[1]=w0 → toIndex=1（插到第0块之后）
  // ...
  const toIndex = nearestBoundaryIndex;
  store.reorderBlock(wall.id, dragTrack, dragBlockId, toIndex);
  // 清理 drag 状态
};
```

注意：如果拖拽的块原本就在该索引附近（没有实际移动），`reorderBlock` 应为 no-op。

#### 指示线

`wp-drop-indicator` 的 `left` 已改为吸附后的像素位置（`dragIndicatorX`），无需改 CSS。指示线落在缝隙中。

### 新 store 方法 `reorderBlock`

```ts
reorderBlock: (wallId: string, track: TrackSpan, blockId: string, toIndex: number) => void;
```

实现（单轨块）：
1. `findWallInLayout` → `updatedWall`
2. `blocks = getTrackBlocks(updatedWall, track)`
3. `idx = blocks.findIndex(b => b.id === blockId)`，`removed = blocks.splice(idx, 1)[0]`
4. 若 `toIndex > idx`，`toIndex--`（因为移除后索引偏移）
5. `blocks.splice(toIndex, 0, removed)`
6. `alignAirGround(updatedWall)`
7. set + sync

实现（双轨块 — tall_cabinet / tall_appliance）：
1. 按 `itemId` 在 air/ground 各自找到索引
2. 分别 splice 移除
3. 分别计算目标索引（两轨的块数量可能不同，但 `toIndex` 是基于拖拽所在轨道的边界计算的，另一轨用相同 `toIndex` 或按 itemId 对齐）
4. **关键决策**：双轨块在 air 和 ground 中应保持相同顺序位置。两轨分别 splice 插入 `toIndex`（需 clamp 到各自数组范围）。
5. `alignAirGround(updatedWall)`

> **注意**：`reorderBlock` 的 `toIndex` 是基于拖拽轨道的块间隙计算的。对于双轨块，另一轨也用相同 `toIndex` 插入。由于双轨块在两轨中位置通常一致（由 `alignAirGround` 保证），这种处理在大多数情况下正确。极端情况下 `alignAirGround` 会修正对齐。

---

## 3b. 精确位置编辑 `setBlockPosition`

### BlockInfoBar「距左」字段改造

当前状态（`BlockInfoBar.tsx` 约 148-150 行）：
```tsx
<span className="pf-readonly">
  {t('距左')}: {distanceFromLeft}{t('英寸')}
</span>
```

改为可编辑 input（与 SKU/宽度同样的 commit-on-blur 模式）：

```tsx
<label className="pf-field">
  {t('距左')}
  <input
    className="pf-input pf-width-input"
    type="number"
    min="0"
    step="0.5"
    value={pos}
    onChange={(e) => setPos(e.target.value)}
    onBlur={commitPos}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
  />
  {t('英寸')}
</label>
```

新增本地状态 `const [pos, setPos] = useState(String(distanceFromLeft));`

提交逻辑：
```tsx
const commitPos = useCallback(() => {
  const p = parseFloat(pos);
  if (!isNaN(p) && p >= 0 && p !== distanceFromLeft) {
    store.setBlockPosition(wall.id, track, block.id, p);
  } else if (isNaN(p) || p < 0) {
    setPos(String(distanceFromLeft)); // 回退
  }
}, [pos, distanceFromLeft, wall.id, track, block.id, store]);
```

> **注意**：`BlockInfoBar` 使用 `key={block.id}`（由 WallPanel 传入），切换块时组件 remount，`pos` 初始值正确。但同一块内若 `setBlockPosition` 改变了位置，`distanceFromLeft` prop 更新，而 `pos` 本地态已是用户输入值，无需同步。

### 新 store 方法 `setBlockPosition`

```ts
setBlockPosition: (wallId: string, track: TrackSpan, blockId: string, newDistanceFromLeft: number) => void;
```

双轨块（tall_cabinet / tall_appliance）需同步两轨。

### 推挤算法（单轨 `blocks` 数组）

设 A = 被移动块，X = 目标距左位置，oldX = A 当前距左。

**最终算法**：

```
function setBlockPosition(blocks, blockId, X):
  idx = blocks.findIndex(blockId)
  A = blocks[idx]
  oldX = sum(blocks[0..idx-1].width)

  if X === oldX: return

  if X < oldX:  // 左移
    leftGapIdx = idx - 1
    leftGap = (leftGapIdx >= 0 && blocks[leftGapIdx] is gap) ? blocks[leftGapIdx] : null
    availableGap = leftGap ? leftGap.width : 0
    delta = oldX - X

    if delta <= availableGap:
      // 侵蚀左侧 gap
      leftGap.width -= delta
      // A 位置自然左移（累积宽度减少）
    else:
      // 越过左侧块
      // 1. 找到左侧最近的非 gap 块 B（跳过 gap）
      // 2. 将 B 移到 A 右侧
      // 3. B 原位变为 gap（或与已有 gap 合并）
      // 4. A 左侧 gap = X - (B 之前的累积宽度)
      // 5. 若 A 右侧有 C，B 插入 A 和 C 之间

      // 具体操作：
      // 移除 B（splice）
      // 在 A 之后插入 B
      // 调整 A 左侧的 gap 宽度

  else:  // 右移
    delta = X - oldX
    // 在 A 左侧创建/扩大 gap
    if leftGap exists:
      leftGap.width += delta
    else:
      // 在 A 前插入新 gap
      blocks.splice(idx, 0, newGap(delta))
      // A 的索引 +1
    // A 右侧的块自然右移（总宽增长）
    // 注意：如果右侧有块且总宽超过墙宽，块会溢出——这是预期行为（用户可通过其他操作修正）
```

> **算法说明**：左移时先尝试侵蚀左侧 gap，不够才越过相邻块；右移时直接在左侧扩大/创建 gap。越过操作本质是数组元素重排序（B 从 A 左侧移到 A 右侧）。

#### 示例验证

**Case 1：左移侵蚀 gap**
```
初始: [gap(5), A(10), B(10)]
设 X=2（左移 3，oldX=5）
→ A 在 idx=1, leftGap=gap(5), delta=3, availableGap=5
→ delta ≤ availableGap → 侵蚀 gap: 5-3=2
→ A 位置自然左移（累积宽度减少）
结果: [gap(2), A(10), B(10)]  总宽 22（原 25，缩 3）
```

**Case 2：左移越过 B**
```
初始: [B(10), A(10), C(10)]
设 X=5（左移 5，oldX=10）
→ A 在 idx=1, leftGap 为 null（左侧是 B，非 gap）, availableGap=0
→ delta=5 > 0 → 越过左侧块
→ 找到左侧最近的非 gap 块 B(idx=0)，将 B 移到 A 右侧
→ [A(10), B(10), C(10)]
→ A 在 idx=0，累积前无内容 → 插入 gap(X-0)=gap(5)
结果: [gap(5), A(10), B(10), C(10)]  总宽 35（原 30，增 5）
```

**Case 3：右移扩大 gap**
```
初始: [gap(5), A(10), B(10)]
设 X=8（右移 3，oldX=5）
→ A 在 idx=1, leftGap=gap(5), delta=3
→ 右移 → 扩大 gap: gap(5+3)=gap(8)
→ B 自然右移: 原在 15-25，现在 18-28
结果: [gap(8), A(10), B(10)]  总宽 28（原 25，增 3）
```

**Case 4：右移创建 gap**
```
初始: [A(10), B(10)]
设 X=5（右移 5，oldX=0）
→ A 在 idx=0, leftGap 不存在
→ 右移 → 在 A 前插入 gap(5)
→ A 索引变为 1, B 自然右移
结果: [gap(5), A(10), B(10)]  总宽 25（原 20，增 5）
```

### 双轨块处理

`setBlockPosition` 对双轨块（tall_cabinet / tall_appliance）：
1. 按 `itemId` 在 air/ground 找到各自的 block。
2. 对 air 和 ground 分别执行上述算法（两轨的 gap/块布局可能不同）。
3. `alignAirGround` 修正对齐。

> **注意**：双轨块在两轨中通常位置一致（由 `alignAirGround` 保证）。若用户精确调整双轨块位置，两轨应同步移动。由于两轨布局可能不同（各自有不同的 gap），分别执行算法后 `alignAirGround` 会确保最终对齐。

---

## 实施顺序

1. **layoutStore.ts**：
   - 添加 `reorderBlock` 方法（interface + impl）
   - 添加 `setBlockPosition` 方法（interface + impl，含推挤算法）
2. **WallPanel.tsx**：拖拽 mousemove/mouseup 改为吸附间隙 + `reorderBlock`
3. **BlockInfoBar.tsx**：「距左」改为可编辑 input + `commitPos` → `setBlockPosition`
4. **i18n**：若需新 key
5. 测试 + 验证

## 验证

- `cd client && npm run build`（tsc + vite）
- 手动 dev 验证：
  - **拖拽改序**：拖动块到两块之间的缝隙，指示线吸附到缝隙，释放后块 reorder（不改变任意位置）
  - **双轨块拖拽**：拖动 tall_cabinet，air/ground 两轨同步 reorder
  - **距左编辑 — 侵蚀 gap**：块左侧有 gap，输入更小的距左值 → gap 缩小
  - **距左编辑 — 越过 B**：块左侧紧邻另一块 B，输入更小的距左值 → A 与 B swap，B 移到 A 右侧，C 及右侧块右移
  - **距左编辑 — 右移创建 gap**：输入更大的距左值 → A 左侧出现/扩大 gap，右侧块右移
  - **双轨块距左编辑**：调整 tall_cabinet 距左 → air/ground 同步
  - **alignAirGround**：操作后双轨物品仍对齐

## 已确认的决策

1. **右侧挤压行为**：当 A 向左移动越过 B 时，B 被挤到 A 右侧。若 A 右侧原有 C，B 插入 A 与 C 之间，C 及更右侧块**整体右移，总宽增长**。（用户已确认）
2. **距左位置编辑**：在 Feature 1 中为只读展示，Feature 3 中变为可编辑。（用户已确认）
3. **拖拽仅调序**：不改变块的任意位置，只改变顺序。精确位置通过信息栏编辑。（用户已确认）
