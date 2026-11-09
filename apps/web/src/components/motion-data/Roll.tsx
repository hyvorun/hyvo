import { useEffect, useRef } from "react";
import { rollDirection, rollKeys } from "../../lib/motion/roll";
import styles from "./motion.module.css";

type Born = "up" | "down" | "none";

/**
 * A number whose changed digits roll into place: up when it grows, down when it shrinks. Only the
 * characters that changed move. Screen readers get the whole value at once; the rolling copy is
 * hidden from them.
 */
export function Roll({ text, value, className = "" }: { text: string; value?: number; className?: string }) {
  const keys = rollKeys(text);
  const previous = useRef<number | null>(null);
  const born = useRef(new Map<string, Born>());
  const mounted = useRef(false);
  const direction = value === undefined ? "up" : rollDirection(previous.current, value);
  const roll: Born = !mounted.current ? "none" : direction === "none" ? "up" : direction;

  useEffect(() => {
    // Remember how each character arrived, so a re-render does not change (and restart) its motion.
    const present = new Set(keys.map((k) => k.key));
    for (const key of born.current.keys()) if (!present.has(key)) born.current.delete(key);
    for (const { key } of keys) if (!born.current.has(key)) born.current.set(key, roll);
    mounted.current = true;
    if (value !== undefined) previous.current = value;
  });

  return (
    <span className={className}>
      <span className="visually-hidden">{text}</span>
      <span className={styles.roll} aria-hidden="true">
        {keys.map(({ key, char }) => (
          <span key={key} className={styles.char} data-roll={born.current.get(key) ?? roll}>
            {char}
          </span>
        ))}
      </span>
    </span>
  );
}
