import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";

/**
 * True once the element has come into view: `threshold` of it is on screen, or, for a block taller
 * than the screen, enough of it to fill a quarter of the screen. Keyboard focus inside it counts too,
 * so focus never lands on something still invisible. It stays true.
 */
export function useInView<T extends Element>(threshold = 0.16): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry!.isIntersecting) return;
        const screen = entry!.rootBounds?.height ?? window.innerHeight;
        if (entry!.intersectionRatio >= threshold || entry!.intersectionRect.height >= screen * 0.25) show();
      },
      { threshold: [...new Set([0, 0.02, 0.05, 0.1, threshold])].sort((a, b) => a - b), rootMargin: "0px 0px -6% 0px" },
    );
    function show() {
      setSeen(true);
      observer.disconnect();
      element!.removeEventListener("focusin", show);
    }
    observer.observe(element);
    element.addEventListener("focusin", show);
    return () => {
      observer.disconnect();
      element.removeEventListener("focusin", show);
    };
  }, [threshold]);
  return [ref, seen];
}

/** A block that rises into place when it scrolls into view; `index` staggers siblings. */
export function Reveal({
  as: Tag = "div",
  index = 0,
  className = "",
  children,
  ...rest
}: {
  as?: ElementType;
  index?: number;
  className?: string;
  children: ReactNode;
  [key: string]: unknown;
}) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <Tag ref={ref} className={`reveal ${className}`} data-in={seen} style={{ "--i": index } as CSSProperties} {...rest}>
      {children}
    </Tag>
  );
}
