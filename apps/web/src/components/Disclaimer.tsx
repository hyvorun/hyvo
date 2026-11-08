import { DISCLAIMER } from "@hyvo/schema";
import styles from "./Disclaimer.module.css";

/** Shown on every surface that carries run results (spec §9.2). */
export function Disclaimer() {
  return <p className={styles.disclaimer}>{DISCLAIMER}</p>;
}
