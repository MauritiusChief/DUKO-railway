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

#### 步骤

1. **记录方向**：`direction = X < oldX ? 'left' : (X > oldX ? 'right' : 'none')`。若 `none` 直接返回。

2. **移除 A**：`blocks.splice(idx, 1)` → `remaining`，重算 remaining 的累积位置。

3. **定位插入点**：遍历 `remaining`，累积 `cursor`（每块的 start/end）：
   - **X 落在 gap 块内**（`gapStart <= X < gapEnd`）：在该 gap 处插入 A。拆分 gap：
     - `leftGapWidth = X - gapStart`
     - `rightGapWidth = gapEnd - X - A.width`
     - 若 `rightGapWidth >= 0`：替换 gap 为 `[左gap?, A, 右gap?]`
     - 若 `rightGapWidth < 0`（A 比 gap 宽）：A 溢出部分把右侧块整体右移
   - **X 落在非 gap 块 B 内**（`bStart <= X < bEnd`）：A 越过 B。
     - 左移 → A 插在 B 之前
     - 右移 → A 保持在 B 之前，B以及其他右侧块整体右移动
   - **X 落在边界/首/尾**：直接插入，必要时补 gap。

4. **调整 A 左侧 gap**：插入 A 后，确保 A 起点恰好 = X：
   - A 前面有 gap → 改其宽度 = `X - 该 gap 之前的累积宽度`（缩或扩）
   - A 前面无 gap → 在 A 前插入 gap

5. **`alignAirGround(updatedWall)`** — 保证双轨物品对齐。

#### 行为对应

**左移侵蚀 gap**（A 左侧有 gap）：
- gap 缩小，A 及右侧块左移，总占用宽度缩小。

**左移越过 B**（A 左侧无 gap，紧邻 B）：
- A 与 B 互换顺序，B 原位变 gap 供 A 侵蚀。
- 若 A 右侧原有 C，则 B 插入 A 与 C 之间。
- **C 及更右侧块整体右移，总宽增长。**

**右移**：
- A 左侧创建/扩大 gap，右侧块右移，总宽增长。

#### 示例验证

**Case 1：侵蚀 gap**
```
初始: [gap(5), A(10), B(10)]  A 在位置 5
设 X=2（左移 3）
→ gap 缩为 2，A 在 2-12，B 在 12-22
结果: [gap(2), A(10), B(10)]  总宽 22（原 25，缩 3）
```

**Case 2：越过 B（有 C）**
```
初始: [B(10), A(10), C(10)]  A 在位置 10
设 X=5（左移 5，越过 B）
→ 移除 A → [B(10), C(10)]
→ X=5 落在 B(0-10) 内，非 gap，左移 → A 插在 B 前
→ 插入 A → [A(10), B(10), C(10)]
→ 调整 A 左侧 gap：Start=0, X=5 → 插入 gap(5)
结果: [gap(5), A(10), B(10), C(10)]  总宽 35（原 30，增 5）
```

**Case 3：右移创建 gap**
```
初始: [gap(5), A(10), B(10)]  A 在位置 5
设 X=8（右移 3）
→ X=8 落在 A(5-15) 内
→ A 没有越过任何块（仍在自己原位附近）
→ 实际上：移除 A → [gap(5), B(10)]，X=8 落在 B(5-15) 内
→ 右移 → A 插在 B 后 → [gap(5), B(10), A(10)]
→ 调整 A 左侧 gap：Start=15, X=8 < 15...
```
> 此 case 需注意：右移时若 X 仍落在 A 原有范围内或紧邻，不应触发越过。算法需判断 X 是否真的越过了相邻块。若 X 在 A 原有范围内（`oldX <= X < oldX + A.width`），则为 no-op 或仅扩大左侧 gap。

**修正 Case 3**：
```
初始: [gap(5), A(10), B(10)]  A 在位置 5
设 X=8（右移 3，但仍 A 范围内 5-15）
→ 移除 A → [gap(5), B(10)]，重算位置：gap(0-5), B(5-15)
→ X=8 落在 B(5-15) 内，非 gap，右移 → A 插在 B 后
→ [gap(5), B(10), A(10)]
→ A 的 naturalStart = 15, X=8 < 15
→ 这不对！A 应该在 8，但 B 在 5-15 挡住了
```
> **问题**：右移 3 应该只是把 A 的起点从 5 改到 8，即扩大左侧 gap 从 5 到 8，而不是越过 B。
>
> **修正**：在移除 A 之前，先判断 X 是否在 A 的"势力范围"内（即 X 落在 A 的左侧 gap 区域或 A 自身区域内，且没有越过其他非 gap 块）。如果是，只需调整左侧 gap，不需要 reorder。
>
> 更简洁的处理：移除 A 后，若 X 落在 remaining 中 A 原位置附近的 gap 内，直接调整 gap。若 X 越过了非 gap 块，才 reorder。

**算法修正版**：

移除 A 后，遍历 remaining 找 X 落点时，需考虑 A 原位置的 gap：

```
初始: [gap(5), A(10), B(10)]
移除 A → [gap(5), B(10)]  位置: gap(0-5), B(5-15)
X=8 落在 B(5-15) 内 → 但 A 原本就在 5-15

问题核心：移除 A 后 B 左移了，X=8 变成落在 B 内
```

> 这说明不能简单移除后查找。需要保留 A 的原始位置信息。
>
> **更好的方法**：不移除 A，而是直接在原数组上操作：
> 1. 找到 A 的当前 index 和 oldX。
> 2. 若 `direction === 'left'`：
>    a. 检查 A 左侧的 gap（A 前一个块是否是 gap）。
>    b. 若有 gap 且 `X >= oldX - gapWidth`（即左移量 ≤ gap 宽度）：直接缩小 gap，A 位置自然左移。Done。
>    c. 若无 gap 或左移量 > gapWidth：需要越过左侧块 B。将 B 移到 A 右侧（swap），在 A 左侧创建新 gap。
> 3. 若 `direction === 'right'`：
>    a. 在 A 左侧创建/扩大 gap，使 A 起点变为 X。A 右侧的块自然右移。
>    b. 若 A 右侧有块 C 且 A 扩大后与 C 重叠：C 及更右块整体右移（总宽增长）。

**最终算法（直接操作数组，不移除 A）**：

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
      // 5. 若 A 右侧有 C，B 插入 A 和 C 之间（自然结果 of array reorder）

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

> **此算法更直观且正确**。左移时先尝试侵蚀 gap，不够才越过；右移时直接扩大/创建 gap。越过操作是 array reorder（B 从 A 左侧移到 A 右侧）。

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
