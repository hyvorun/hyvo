import { useMemo } from "react";
import { previewLayout } from "../lib/crowd";
import { Crowd } from "./Crowd";
import styles from "./DecisionGrid.module.css";
import { Tween } from "./motion-data/CountUp";

const whole = (value: number) => Math.round(value).toLocaleString("en-US");

/**
 * What a run is made of, drawn before it exists: the crowd, one dot per agent, growing as you change
 * its size, under the number of decisions. The price follows that number. The crowd's rows come in
 * one after another once it is in view, and the numbers tween to each new size.
 */
export function DecisionGrid({ agents, rounds }: { agents: number; rounds: number }) {
  const valid = Number.isInteger(agents) && Number.isInteger(rounds) && agents > 0 && rounds > 0;
  const size = valid ? Math.min(agents, 500) : 40;
  const layout = useMemo(() => previewLayout(size), [size]);
  const decisions = valid ? agents * rounds : 0;

  return (
    <figure className={`${styles.figure} card`}>
      <figcaption className={styles.caption}>
        <span className={styles.total}>
          {valid ? <Tween value={decisions} format={whole} className={`${styles.number} num`} /> : <span className={`${styles.number} num`}>–</span>} decisions
        </span>
        <span className={`${styles.detail} num`}>
          {valid ? (
            <>
              <Tween value={agents} format={whole} /> agents × <Tween value={rounds} format={whole} /> rounds
            </>
          ) : (
            "choose a crowd size"
          )}
        </span>
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
