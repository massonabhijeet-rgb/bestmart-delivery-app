import { useEffect, useRef, useState, type ReactNode } from 'react';

interface LazyMountProps {
  /** Children render only after the placeholder scrolls into view. */
  children: ReactNode;
  /** Distance off-screen at which to start mounting (e.g. "200px"). */
  rootMargin?: string;
  /** Min height for the placeholder so layout doesn't jump. */
  placeholderHeight?: number | string;
  /** Optional class for the wrapper. */
  className?: string;
}

/**
 * Defers rendering of `children` until the wrapper enters the viewport
 * (with a configurable rootMargin head-start). Once mounted it stays
 * mounted — this is "render on first visibility", not virtualised.
 */
export function LazyMount({
  children,
  rootMargin = '200px',
  placeholderHeight = 200,
  className,
}: LazyMountProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, rootMargin]);

  return (
    <div
      ref={ref}
      className={className}
      style={visible ? undefined : { minHeight: placeholderHeight }}
    >
      {visible ? children : null}
    </div>
  );
}

export default LazyMount;
