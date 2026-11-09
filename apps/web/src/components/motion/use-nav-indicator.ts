import { useEffect, useRef, type RefObject } from "react";
import { indicatorBox } from "./spring";

/**
 * A hairline under the header's links that slides to the link under the pointer (or keyboard
 * focus) and back to the page's link when the pointer leaves. It moves with transform only: a 1px
 * line translated and scaled to the link's width. The nav gets data-ready="true" once the line is
 * measured; until then, and under reduced motion, CSS underlines the active link instead.
 *
 * `route` is the current path: the line follows the active link when the page changes.
 */
export function useNavIndicator(nav: RefObject<HTMLElement | null>, line: RefObject<HTMLElement | null>, route: string) {
  const place = useRef<(instant?: boolean) => void>(() => {});

  useEffect(() => {
    const root = nav.current;
    const bar = line.current;
    if (!root || !bar) return;
    let target: HTMLElement | null = null;
    let shown = false;
    let frame = 0;

    const move = (instant = false) => {
      const link = target ?? root.querySelector<HTMLElement>("a.active");
      if (!link || link.offsetParent === null) {
        bar.style.opacity = "0";
        shown = false;
        return;
      }
      const inset = parseFloat(getComputedStyle(link).paddingLeft) || 0;
      const box = indicatorBox(link.offsetLeft, link.offsetWidth, inset);
      const jump = instant || !shown;
      if (jump) bar.dataset.jump = "true";
      bar.style.transform = `translateX(${box.x}px) scaleX(${box.width})`;
      bar.style.opacity = "1";
      shown = true;
      if (jump) {
        cancelAnimationFrame(frame);
        // Let the jump land before the line can slide again.
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => delete bar.dataset.jump);
        });
      }
    };
    place.current = move;

    const linkOf = (event: Event) => (event.target as Element | null)?.closest?.<HTMLElement>("a") ?? null;
    const enter = (event: Event) => {
      const link = linkOf(event);
      if (link && root.contains(link) && link !== target) {
        target = link;
        move();
      }
    };
    const leave = () => {
      if (!target) return;
      target = null;
      move();
    };
    const blur = (event: FocusEvent) => {
      if (!root.contains(event.relatedTarget as Node | null)) leave();
    };

    root.addEventListener("pointerover", enter);
    root.addEventListener("pointerleave", leave);
    root.addEventListener("focusin", enter);
    root.addEventListener("focusout", blur);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => move(true));
    resize?.observe(root);
    document.fonts?.ready.then(() => move(true), () => {});
    move(true);
    root.dataset.ready = "true";

    return () => {
      root.removeEventListener("pointerover", enter);
      root.removeEventListener("pointerleave", leave);
      root.removeEventListener("focusin", enter);
      root.removeEventListener("focusout", blur);
      resize?.disconnect();
      cancelAnimationFrame(frame);
      delete root.dataset.ready;
      place.current = () => {};
    };
  }, [nav, line]);

  // A new page: the line slides from the old page's link to the new one.
  useEffect(() => {
    place.current();
  }, [route]);
}
