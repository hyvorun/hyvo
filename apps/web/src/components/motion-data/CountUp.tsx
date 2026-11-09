import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { countAt, countDuration, easeOutCubic, easeOutQuart } from "../../lib/motion/count";
import { useInView } from "../Reveal";
import { prefersReducedMotion } from "../use-playback";
import styles from "./motion.module.css";

type Align = "start" | "end";

interface Props {
  value: number;
  format: (value: number) => string;
  className?: string;
  /** Which edge the passing values line up with while they are shorter than the final one. */
  align?: Align;
  title?: string;
}

/** The final value, with the passing values drawn over it (see motion.module.css). */
function Overlay({ dataRef, value, text, className, align, title }: { dataRef: React.Ref<HTMLDataElement>; value: number; text: ReactNode; className: string; align: Align; title?: string }) {
  return (
    <data ref={dataRef} value={String(value)} className={`${styles.overlay} ${className}`} data-align={align} title={title}>
      {text}
    </data>
  );
}

/**
 * A number that counts from `from` (0) to its value the first time it comes into view, in about
 * 900 ms with an ease-out, through the same formatter as the final value. With reduced motion it is
 * simply the final value.
 */
export function CountUp({ value, format, from = 0, duration, className = "", align = "start", title }: Props & { from?: number; duration?: number }) {
  const [ref, seen] = useInView<HTMLDataElement>(0.2);
  const phase = useRef<"idle" | "pending" | "running" | "done">("idle");
  const latest = useRef({ value, format });
  latest.current = { value, format };

  // Before the first paint, so the final value never flashes before the count starts.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || phase.current !== "idle") return;
    if (prefersReducedMotion() || from === value || !Number.isFinite(value)) {
      phase.current = "done";
      return;
    }
    phase.current = "pending";
    element.dataset.shown = format(from);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at mount
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element || !seen || phase.current !== "pending") return;
    phase.current = "running";
    const target = latest.current.value;
    const total = duration ?? countDuration(from, target);
    const begin = performance.now();
    let frame = 0;
    const finish = () => {
      delete element.dataset.shown;
      phase.current = "done";
    };
    const tick = (now: number) => {
      const { value: end, format: show } = latest.current;
      const shown = show(countAt(from, end, now - begin, total, easeOutQuart));
      if (now - begin >= total || shown === show(end)) return finish();
      element.dataset.shown = shown;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (phase.current === "running") finish();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when the number is first seen
  }, [seen]);

  return <Overlay dataRef={ref} value={value} text={format(value)} className={className} align={align} title={title} />;
}

/**
 * A number that tweens from what it showed to its new value whenever the value changes (a
 * calculator's answer as the inputs change). The first value shows as it is.
 */
export function Tween({ value, format, duration = 380, className = "", align = "start", title }: Props & { duration?: number }) {
  const ref = useRef<HTMLDataElement>(null);
  const shown = useRef(value);
  const latest = useRef(format);
  latest.current = format;

  useEffect(() => {
    const element = ref.current;
    const from = shown.current;
    if (!element || from === value || !Number.isFinite(from) || !Number.isFinite(value) || prefersReducedMotion()) {
      shown.current = value;
      if (element) delete element.dataset.shown;
      return;
    }
    const begin = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const show = latest.current;
      const current = countAt(from, value, now - begin, duration, easeOutCubic);
      shown.current = current;
      const text = show(current);
      if (now - begin >= duration || text === show(value)) {
        shown.current = value;
        delete element.dataset.shown;
        return;
      }
      element.dataset.shown = text;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // A change during the tween starts the next one from wherever this one had got to.
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return <Overlay dataRef={ref} value={value} text={format(value)} className={className} align={align} title={title} />;
}
