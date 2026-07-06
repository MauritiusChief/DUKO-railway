/**
 * LayoutCanvas —— 布局画布容器
 *
 * 渲染当前布局中所有的墙 WallPanel 列表。
 * 若布局为空则显示提示。
 */
import { useLayoutStore } from '../stores/layoutStore';
import { useI18n } from '../i18n/context';
import { WallPanel } from './WallPanel';
import './LayoutCanvas.css';

export function LayoutCanvas() {
  const store = useLayoutStore();
  const { t } = useI18n();
  const layout = store.getActiveLayout();

  if (!layout) {
    return <div className="lc-empty">{t('无激活布局')}</div>;
  }

  if (layout.walls.length === 0) {
    return (
      <div className="lc-empty">
        <p>{t('无墙面提示')}</p>
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
