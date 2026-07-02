/**
 * LayoutCanvas —— 布局画布容器
 *
 * 渲染当前布局中所有的墙 WallPanel 列表。
 * 若布局为空则显示提示。
 */
import { useLayoutStore } from '../stores/layoutStore';
import { WallPanel } from './WallPanel';
import './LayoutCanvas.css';

export function LayoutCanvas() {
  const store = useLayoutStore();
  const layout = store.getActiveLayout();

  if (!layout) {
    return <div className="lc-empty">No active layout</div>;
  }

  if (layout.walls.length === 0) {
    return (
      <div className="lc-empty">
        <p>No walls yet. Click "+ 墙面/岛台" to add one.</p>
      </div>
    );
  }

  return (
    <div className="lc-canvas">
      {layout.walls.map((wall) => (
        <WallPanel key={wall.id} wall={wall} />
      ))}
    </div>
  );
}
