import { useEffect, useMemo, useRef } from "react";
import { previewLayout } from "../lib/crowd";
import { Crowd } from "./Crowd";
import styles from "./DecisionGrid.module.css";

/**
 * What a run is made of, drawn before it exists: the crowd, one dot per agent, growing as you change
 * its size, under the number of decisions. The price follows that number.
 */
export function DecisionGrid({ agents, rounds }: { agents: number; rounds: number }) {
  const valid = Number.isInteger(agents) && Number.isInteger(rounds) && agents > 0 && rounds > 0;
  const size = valid ? Math.min(agents, 500) : 40;
  const layout = useMemo(() => previewLayout(size), [size]);
  const decisions = valid ? agents * rounds : 0;

  // The number settles into place when it changes.
  const number = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    number.current?.animate?.([{ opacity: 0.35, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], {
      duration: 320,
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
    });
  }, [decisions]);

  return (
    <figure className={`${styles.figure} card`}>
      <figcaption className={styles.caption}>
        <span className={styles.total}>
          <span ref={number} className={`${styles.number} num`}>
            {valid ? decisions.toLocaleString("en-US") : "–"}
          </span>{" "}
          decisions
        </span>
        <span className={`${styles.detail} num`}>{valid ? `${agents.toLocaleString("en-US")} agents × ${rounds} rounds` : "choose a crowd size"}</span>
      </figcaption>
      <Crowd
        layout={layout}
        fill={0.6}
        maxPitch={20}
        ariaLabel={valid ? `${agents} agents by ${rounds} rounds: ${decisions.toLocaleString("en-US")} decisions` : "Choose a crowd size"}
      />
    </figure>
  );
}
