import { useEffect, useLayoutEffect, useRef } from "react";
import { canScramble, scrambleAt } from "../../lib/motion/scramble";
import { useInView } from "../Reveal";
import { prefersReducedMotion } from "../use-playback";
import styles from "./motion.module.css";

/** How often the unresolved characters change: often enough to read as decoding, not as flicker. */
const SHUFFLE_MS = 45;

/**
 * A hash or an address that decodes left to right, in about 700 ms, the first time it comes into
 * view. The element holds the final text throughout (see motion.module.css), so screen readers,
 * copying and tests only ever meet the real value.
 */
export function Decode({ text, duration = 700, className = "", title }: { text: string; duration?: number; className?: string; title?: string }) {
  const [ref, seen] = useInView<HTMLDataElement>(0.2);
  const phase = useRef<"idle" | "pending" | "running" | "done">("idle");

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || phase.current !== "idle") return;
    if (prefersReducedMotion() || !canScramble(text)) {
      phase.current = "done";
      return;
    }
    phase.current = "pending";
    element.dataset.shown = scrambleAt(text, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at mount
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element || !seen || phase.current !== "pending") return;
    phase.current = "running";
    const begin = performance.now();
    let frame = 0;
    let shuffled = 0;
    let last = element.dataset.shown ?? "";
    const finish = () => {
      delete element.dataset.shown;
      phase.current = "done";
    };
    const tick = (now: number) => {
      const progress = (now - begin) / duration;
      if (progress >= 1) return finish();
      // The front moves every frame; the characters ahead of it change a little less often.
      if (now - shuffled >= SHUFFLE_MS) {
        shuffled = now;
        last = scrambleAt(text, progress);
      } else {
        const front = Math.floor(progress * text.length);
        last = text.slice(0, front) + last.slice(front);
      }
      element.dataset.shown = last;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (phase.current === "running") finish();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the value is first seen
  }, [seen]);

  return (
    <data ref={ref} value={text} className={`${styles.overlay} ${className}`} data-wrap="" title={title}>
      {text}
    </data>
  );
}
