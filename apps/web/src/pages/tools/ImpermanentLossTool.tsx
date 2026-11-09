import { Tween } from "../../components/motion-data/CountUp";
import { useWidth } from "../../components/use-playback";
import { formatAmount, formatShare, impermanentLoss, parseAmount, positionValues, PRICE_MOVES } from "../../lib/calc";
import { ArithmeticNote, NumberField, ToolPage, useDescription, useQueryState } from "./shared";
import styles from "./Tools.module.css";

const DEFAULTS = { move: "100", deposit: "10" };
const signedShare = (value: number) => formatShare(value, true);
/** The chart's price range, as multiples of the starting price, on a log scale. */
const LOW = 0.1;
const HIGH = 10;

export function ImpermanentLossTool() {
  useDescription("Free impermanent loss calculator: what a 50/50 liquidity position is worth against simply holding, after a price move.");
  const [input, set] = useQueryState(DEFAULTS);
  const move = parseAmount(input.move, true);
  const deposit = parseAmount(input.deposit);
  const ratio = 1 + move / 100;
  const errors = {
    move: Number.isFinite(move) && ratio > 0 ? null : "Use a change above −100%, such as 100 for a doubling or −50 for a halving.",
    deposit: input.deposit.trim() === "" || deposit > 0 ? null : "Enter an amount above 0, or leave it empty.",
  };
  const loss = errors.move ? null : impermanentLoss(ratio);
  const values = loss !== null && deposit > 0 ? positionValues(deposit, ratio) : null;

  return (
    <ToolPage
      to="/tools/impermanent-loss"
      title="Impermanent loss"
      lede="What a 50/50 liquidity position is worth after the token's price moves, next to simply holding the same two assets."
    >
      <section className={`${styles.card} ${styles.split}`} aria-label="Calculator">
        <form className={styles.panel} onSubmit={(event) => event.preventDefault()}>
          <h2>The move</h2>
          <NumberField
            label="Change in the token's price"
            value={input.move}
            onChange={(value) => set({ move: value })}
            error={errors.move}
            suffix="%"
            hint="Against the other asset in the pool. 100 is a doubling, −50 a halving."
          />
          <NumberField
            label="What you put in (optional)"
            value={input.deposit}
            onChange={(value) => set({ deposit: value })}
            error={errors.deposit}
            hint="Half in each asset at the start, valued in the other asset. Any unit."
          />
        </form>

        <section className={styles.panel} aria-label="Result" aria-live="polite">
          {loss === null ? (
            <p className={styles.empty}>Enter a price change to see the result.</p>
          ) : (
            <>
              <div className={styles.lead}>
                <span>Against holding</span>
                <b className={`num ${loss < -0.00005 ? styles.down : ""}`}>
                  <Tween value={loss} format={signedShare} />
                </b>
                <small>The position is worth this much less than the same two assets held, before fees.</small>
              </div>
              {values && (
                <dl className={styles.stats}>
                  <div className={styles.stat}>
                    <dt>Held</dt>
                    <dd className="num">
                      <Tween value={values.held} format={formatAmount} />
                    </dd>
                  </div>
                  <div className={styles.stat}>
                    <dt>In the pool</dt>
                    <dd className="num">
                      <Tween value={values.pooled} format={formatAmount} />
                    </dd>
                  </div>
                  <div className={styles.stat}>
                    <dt>Difference</dt>
                    <dd className="num">
                      <Tween value={values.pooled - values.held} format={formatAmount} />
                    </dd>
                  </div>
                </dl>
              )}
            </>
          )}
        </section>

        <div className={`${styles.panel} ${styles.wide}`}>
          <LossFigure ratio={loss === null ? null : ratio} />
        </div>
      </section>

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className={styles.tableWrap} tabIndex={0}>
        <table className={styles.table}>
          <caption>Common moves</caption>
          <thead>
            <tr>
              <th scope="col">Token price</th>
              <th scope="col">Price multiple</th>
              <th scope="col">Against holding</th>
            </tr>
          </thead>
          <tbody>
            {PRICE_MOVES.map((pct) => (
              <tr key={pct} aria-current={!errors.move && Math.abs(pct - move) < 1e-9 ? "true" : undefined}>
                <td>{formatShare(pct / 100, true)}</td>
                <td className={styles.muted}>{formatAmount(1 + pct / 100)}×</td>
                <td className={styles.down}>{formatShare(impermanentLoss(1 + pct / 100) ?? Number.NaN, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className={styles.notes} aria-labelledby="il-how">
        <h2 id="il-how">How it is worked out</h2>
        <p>
          A constant-product pool rebalances as the price moves: it ends up with more of whatever fell and less of whatever rose. Against simply holding, the position
          is worth 2√r ÷ (1 + r), where r is the price multiple. The loss is the same for a move up or down by the same multiple, and it is called impermanent because it
          shrinks again if the price comes back.
        </p>
        <p>
          Fees earned by the position are not included, and they can make up for some or all of it. Pools that concentrate liquidity in a price range lose more for
          the same move.
        </p>
        <ArithmeticNote />
      </section>
    </ToolPage>
  );
}

/** Loss against holding, for price multiples from 0.1× to 10× on a log scale. */
function LossFigure({ ratio }: { ratio: number | null }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = 200;
  const pad = { left: 46, right: 14, top: 14, bottom: 28 };
  const floor = -0.45;
  const sx = (r: number) => pad.left + ((Math.log(r) - Math.log(LOW)) / (Math.log(HIGH) - Math.log(LOW))) * (width - pad.left - pad.right);
  const sy = (loss: number) => pad.top + (loss / floor) * (height - pad.top - pad.bottom);
  const steps = 120;
  const path = Array.from({ length: steps + 1 }, (_, i) => {
    const r = Math.exp(Math.log(LOW) + ((Math.log(HIGH) - Math.log(LOW)) * i) / steps);
    return `${i === 0 ? "M" : "L"}${sx(r).toFixed(1)},${sy(impermanentLoss(r)!).toFixed(1)}`;
  }).join("");
  const shown = ratio !== null && ratio >= LOW && ratio <= HIGH ? ratio : null;

  return (
    <figure className={styles.figure}>
      <div ref={ref}>
        {width > 0 && (
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Impermanent loss grows as the price moves away from where it started, in either direction.">
            {[0, -0.1, -0.2, -0.3, -0.4].map((level) => (
              <g key={level}>
                <line className={styles.axis} x1={pad.left} x2={width - pad.right} y1={sy(level)} y2={sy(level)} strokeOpacity={level === 0 ? 1 : 0.45} />
                <text className={styles.tick} x={pad.left - 8} y={sy(level) + 4} textAnchor="end">
                  {level === 0 ? "0%" : `${Math.round(level * 100)}%`.replace("-", "−")}
                </text>
              </g>
            ))}
            {[0.1, 0.25, 0.5, 1, 2, 4, 10].map((r) => (
              <text key={r} className={styles.tick} x={sx(r)} y={height - 8} textAnchor="middle">
                {r}×
              </text>
            ))}
            <path className={styles.curve} d={path} />
            {shown !== null && (
              <>
                <line className={styles.axis} x1={sx(shown)} x2={sx(shown)} y1={sy(0)} y2={sy(impermanentLoss(shown)!)} />
                <circle className={`${styles.dot} ${styles.dotNow}`} cx={sx(shown)} cy={sy(impermanentLoss(shown)!)} r={4.5} />
              </>
            )}
          </svg>
        )}
      </div>
      <figcaption>Loss against holding, by how many times the starting price the token ends at.</figcaption>
    </figure>
  );
}
