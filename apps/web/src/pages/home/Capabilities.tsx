import { Link } from "react-router";
import { Reveal } from "../../components/Reveal";
import { PRODUCTS, productStatus, type Features } from "../../lib/products";
import styles from "./Capabilities.module.css";
import shared from "./Section.module.css";

/** Kept for the tests and older imports: the same as productStatus. */
export const capabilityStatus = productStatus;

/** Every part of Hyvo in one list: what it does, who it is for, and whether it is open today. */
export function Capabilities({ features, loading }: { features: Features | null; loading: boolean }) {
  const statuses = PRODUCTS.map((item) => productStatus(item.gate, features));
  // When the API cannot say what is open, the list says nothing about it rather than half of it.
  const showStatus = features !== null || loading;
  const lead =
    features === null
      ? "Watching runs and checking their hashes never needs a wallet."
      : statuses.every((status) => status?.text === "Live")
        ? "All of it is open, and watching runs or checking their hashes never needs a wallet."
        : "Whatever is marked Live is open today, and watching runs or checking their hashes never needs a wallet.";

  return (
    <section className={shared.section} aria-labelledby="capabilities-title">
      <Reveal className={shared.head}>
        <h2 id="capabilities-title">What you can do with Hyvo</h2>
        <p>{lead}</p>
      </Reveal>
      <div className={styles.table}>
        <div className={styles.columns} aria-hidden="true">
          <span>Part</span>
          <span>What it does</span>
          <span>For</span>
          {showStatus && <span>Today</span>}
        </div>
        <ul className={styles.rows}>
          {PRODUCTS.map((item, index) => {
            const status = statuses[index];
            return (
              <Reveal as="li" index={index % 4} key={item.name} className={styles.row}>
                <h3 className={styles.name}>
                  <Link to={item.to} viewTransition>
                    {item.name}
                  </Link>
                </h3>
                <p className={styles.line}>{item.line}</p>
                <p className={styles.who}>
                  <span className="visually-hidden">For: </span>
                  {item.who}
                </p>
                {showStatus && (
                  <p className={styles.status} data-tone={status?.tone ?? "unknown"}>
                    {status ? (
                      <>
                        <span className={styles.dot} aria-hidden="true" />
                        {status.text}
                      </>
                    ) : (
                      <span className={`${styles.wait} skeleton`} aria-hidden="true" />
                    )}
                  </p>
                )}
                <span className={styles.chevron} aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="14" height="14">
                    <path d="M6 3.5 10.5 8 6 12.5" />
                  </svg>
                </span>
              </Reveal>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
