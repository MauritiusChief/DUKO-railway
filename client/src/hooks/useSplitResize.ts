import { useState, useEffect, useRef, useCallback } from 'react';

export interface SplitResizeConfig {
  cursor?: string;
  getContainer(): HTMLElement | null;
  onResize(percent: number, event: MouseEvent, rect: DOMRect): void;
  getPercent(event: MouseEvent, rect: DOMRect): number;
}

export function useSplitResize(targets: Record<string, SplitResizeConfig>) {
  const [resizing, setResizing] = useState<string | null>(null);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  const startResize = useCallback(
    (type: string) => (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(type);
    },
    [],
  );

  useEffect(() => {
    if (!resizing) return;
    const config = targetsRef.current[resizing];
    if (!config) return;

    const handleMouseMove = (e: MouseEvent) => {
      const container = config.getContainer();
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const pct = config.getPercent(e, rect);
      config.onResize(pct, e, rect);
    };

    const handleMouseUp = () => setResizing(null);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = config.cursor || 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing]);

  return { resizing, startResize };
}
