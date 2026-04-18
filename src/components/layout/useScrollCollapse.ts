"use client";

import { useCallback, useRef, useState, type UIEvent } from "react";

type UseScrollCollapseOptions = {
  threshold?: number;
  hysteresis?: number;
};

export function useScrollCollapse(options: UseScrollCollapseOptions = {}) {
  const { threshold = 64, hysteresis = 6 } = options;
  const [collapsed, setCollapsed] = useState(false);
  const previousTopRef = useRef(0);

  const handleScrollTop = useCallback(
    (scrollTop: number) => {
      const top = Math.max(0, scrollTop);
      const delta = top - previousTopRef.current;

      if (top <= threshold) {
        if (collapsed) setCollapsed(false);
        previousTopRef.current = top;
        return;
      }

      if (delta > hysteresis && !collapsed) {
        setCollapsed(true);
      } else if (delta < -hysteresis && collapsed) {
        setCollapsed(false);
      }

      previousTopRef.current = top;
    },
    [collapsed, hysteresis, threshold],
  );

  const onScroll = useCallback(
    (event: UIEvent<HTMLElement>) => {
      handleScrollTop(event.currentTarget.scrollTop);
    },
    [handleScrollTop],
  );

  return {
    collapsed,
    handleScrollTop,
    onScroll,
    setCollapsed,
  };
}
