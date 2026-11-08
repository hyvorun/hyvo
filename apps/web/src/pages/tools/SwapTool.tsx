import { Link } from "react-router";
import { useWidth } from "../../components/use-playback";
import { formatAmount, formatShare, parseAmount, quote, roundTrip, TRADE_SHARES, type PoolState, type Quote, type Side } from "../../lib/calc";
import { formatScaled, priceUnit, type PriceUnit } from "../../lib/format";
import { ArithmeticNote, NumberField, ToolPage, useDescription, useQueryState } from "./shared";
import styles from "./Tools.module.css";

const DEFAULTS = { eth: "5", tokens: "1b", fee: "1", side: "eth", amount: "0.5" };

/** A swap against a constant-product pool: what comes out, the price move, and the round trip. */
export function SwapTool() {
  useDescription(
    "Free swap and price impact calculator for constant-product pools: what a trade returns, how far it moves the price, and what a quick round trip costs.",
  );
  const [input, set] = useQueryState(DEFAULTS);
  const side: Side = input.side === "tokens" ? "tokens-in" : "eth-in";
  const pool: PoolState = { eth: parseAmount(input.eth), tokens: parseAmount(input.tokens) };
  const fee = parseAmount(input.fee);
  const amount = parseAmount(input.amount);
  const errors = {
    eth: pool.eth > 0 ? null : "Enter the ETH in the pool, such as 5.",
    tokens: pool.tokens > 0 ? null : "Enter the tokens in the pool, such as 1b or 1,000,000,000.",
    fee: fee >= 0 && fee < 100 ? null : "Use a fee from 0 to 99.99%.",
    amount: amount > 0 ? null : "Enter an amount above 0.",
  };
  const result = quote(pool, fee, side, amount);
  const unit = result ? priceUnit([result.priceBefore, result.priceAfter, result.averagePrice], "tokens") : null;
  const ethIn = side === "eth-in";
  const trip = result && ethIn ? roundTrip(pool, fee, amount) : null;

  return (
    <ToolPage
      to="/tools/swap"
      title="Swap and price impact"
      lede="What a trade gets from a pool, how far it moves the price, and what it costs to go in and straight back out."
    >
      <section className={`${styles.card} ${styles.split}`} aria-label="Calculator">
        <form className={styles.panel} onSubmit={(event) => event.preventDefault()}>
          <h2>The pool</h2>
          <div className={`${styles.fields} ${styles.two}`}>
            <NumberField label="ETH in the pool" value={input.eth} onChange={(eth) => set({ eth })} error={errors.eth} suffix="ETH" />
            <NumberField label="Tokens in the pool" value={input.tokens} onChange={(tokens) => set({ tokens })} error={errors.tokens} hint="1b, 2.5m and 1e9 work too." />
          </div>
          <NumberField
            label="Fee or tax per trade"
            value={input.fee}
            onChange={(fee) => set({ fee })}
            error={errors.fee}
            suffix="%"
            hint="Taken from what goes in. Pool fee and token tax together."
          />
          <h2>The trade</h2>
          <div className={styles.seg} role="radiogroup" aria-label="What goes in">
            <button type="button" role="radio" aria-checked={ethIn} onClick={() => set({ side: "eth" })}>
              ETH in, tokens out
            </button>
            <button type="button" role="radio" aria-checked={!ethIn} onClick={() => set({ side: "tokens" })}>
              Tokens in, ETH out
            </button>
          </div>
          <NumberField
            label={ethIn ? "ETH you put in" : "Tokens you put in"}
            value={input.amount}
            onChange={(amount) => set({ amount })}
            error={errors.amount}
            suffix={ethIn ? "ETH" : "tokens"}
          />
        </form>

        <section className={styles.panel} aria-label="Result" aria-live="polite">
          {result && unit ? <Readout result={result} unit={unit} trip={trip} /> : <p className={styles.empty}>Fill in the pool and the trade to see the result.</p>}
        </section>

        {result && (
          <div className={`${styles.panel} ${styles.wide}`}>
            <CurveFigure pool={pool} result={result} />
          </div>
        )}
      </section>

      {pool.eth > 0 && pool.tokens > 0 && fee >= 0 && fee < 100 && <SizeTable pool={pool} fee={fee} current={ethIn ? amount : null} />}

      <section className={styles.notes} aria-labelledby="swap-how">
        <h2 id="swap-how">How it is worked out</h2>
        <p>
          The pool keeps the product of its two reserves constant: x × y = k. The fee is taken from what goes in and stays in the pool, as in Uniswap V2-style
          pools. It is the same rule the test pools on Hyvo's forks follow, so it matches what a <Link to="/runs">run</Link> does.
        </p>
        <p>
          A round trip puts the ETH in and every token straight back, with nobody trading in between. It costs about two fees; part of the first fee stays in the pool
          and comes back on the way out, which is why a larger round trip can cost a little less.
        </p>
        <p>
          Pools with concentrated liquidity, bonding curves, and taxes that leave the pool give somewhat different numbers. Other people's trades in the same block
          change them too: that is slippage on top of your own price impact.
        </p>
        <ArithmeticNote />
      </section>
    </ToolPage>
  );
}

function Readout({ result, unit, trip }: { result: Quote; unit: PriceUnit; trip: { ethBack: number; loss: number } | null }) {
  const ethIn = result.side === "eth-in";
  return (
    <>
      <div className={styles.lead}>
        <span>You get</span>
        <b className="num">
          {formatAmount(result.amountOut)} {ethIn ? "tokens" : "ETH"}
        </b>
        <small>
          for {formatAmount(result.amountIn)} {ethIn ? "ETH" : "tokens"}, of which {formatAmount(result.fee)} {ethIn ? "ETH" : "tokens"} is the fee
        </small>
      </div>
      <dl className={styles.stats}>
        <div className={styles.stat}>
          <dt>Pool price moves</dt>
          <dd className={`num ${result.priceMove >= 0 ? styles.up : styles.down}`}>{formatShare(result.priceMove, true)}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Worse than the pool price</dt>
          <dd className="num">
            {formatShare(result.costVsSpot)}
            <small>fee included</small>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Average price</dt>
          <dd className="num">
            {formatScaled(result.averagePrice, unit)}
            <small>{unit.label}</small>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Pool price before → after</dt>
          <dd className="num">
            {formatScaled(result.priceBefore, unit)} → {formatScaled(result.priceAfter, unit)}
            <small>{unit.label}</small>
          </dd>
        </div>
        {trip && (
          <div className={styles.stat}>
            <dt>In and straight back out</dt>
            <dd className="num">
              {formatAmount(trip.ethBack)} ETH
              <small>{formatShare(trip.loss)} less than went in</small>
            </dd>
          </div>
        )}
        <div className={styles.stat}>
          <dt>Pool after</dt>
          <dd className="num">
            {formatAmount(result.after.eth)} ETH
            <small>{formatAmount(result.after.tokens)} tokens</small>
          </dd>
        </div>
      </dl>
    </>
  );
}

/** The curve x × y = k, and the stretch of it this trade travels. */
function CurveFigure({ pool, result }: { pool: PoolState; result: Quote }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const height = 220;
  const pad = { left: 14, right: 14, top: 18, bottom: 30 };
  const k = pool.eth * pool.tokens;
  const from = pool.eth;
  const to = result.after.eth;
  const lo = Math.min(from, to) * 0.4;
  const hi = Math.max(from, to) * 1.8;
  const yTop = k / lo;
  const yBottom = k / hi;
  const sx = (x: number) => pad.left + ((x - lo) / (hi - lo)) * (width - pad.left - pad.right);
  const sy = (y: number) => pad.top + (1 - (y - yBottom) / (yTop - yBottom)) * (height - pad.top - pad.bottom);
  const path = (a: number, b: number, steps: number) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const x = a + ((b - a) * i) / steps;
      return `${i === 0 ? "M" : "L"}${sx(x).toFixed(1)},${sy(k / x).toFixed(1)}`;
    }).join("");
  const before = { x: sx(from), y: sy(pool.tokens) };
  const after = { x: sx(to), y: sy(result.after.tokens) };
  const leftLabel = before.x <= after.x;

  return (
    <figure className={styles.figure}>
      <div ref={ref}>
        {width > 0 && (
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`The pool moves along the curve from ${formatAmount(from)} to ${formatAmount(to)} ETH.`}>
            <line className={styles.axis} x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} />
            <path className={styles.curve} d={path(lo, hi, 96)} />
            <path className={styles.trace} d={path(from, to, 24)} />
            <circle className={styles.dot} cx={before.x} cy={before.y} r={4.5} />
            <circle className={`${styles.dot} ${styles.dotNow}`} cx={after.x} cy={after.y} r={4.5} />
            <text className={styles.tick} x={before.x + (leftLabel ? -10 : 10)} y={before.y - 10} textAnchor={leftLabel ? "end" : "start"}>
              before
            </text>
            <text className={styles.tick} x={after.x + (leftLabel ? 10 : -10)} y={after.y - 10} textAnchor={leftLabel ? "start" : "end"}>
              after
            </text>
            <text className={styles.tick} x={pad.left} y={height - 8}>
              less ETH in the pool
            </text>
            <text className={styles.tick} x={width - pad.right} y={height - 8} textAnchor="end">
              more ETH
            </text>
          </svg>
        )}
      </div>
      <figcaption>
        Every point on the curve has the same product of ETH and tokens. A trade slides the pool along it; the farther it slides, the more the price moves.
      </figcaption>
    </figure>
  );
}

/** The same pool and fee, for trades of different sizes. */
function SizeTable({ pool, fee, current }: { pool: PoolState; fee: number; current: number | null }) {
  const rows = TRADE_SHARES.map((share) => {
    const ethIn = pool.eth * share;
    return { share, ethIn, result: quote(pool, fee, "eth-in", ethIn), trip: roundTrip(pool, fee, ethIn) };
  });
  return (
    // Wide on a phone: it scrolls on its own, so it takes focus for the keyboard.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
    <div className={styles.tableWrap} tabIndex={0}>
      <table className={styles.table}>
        <caption>The same pool, with ETH going in, at other sizes</caption>
        <thead>
          <tr>
            <th scope="col">ETH in</th>
            <th scope="col">Share of the pool</th>
            <th scope="col">Tokens out</th>
            <th scope="col">Price moves</th>
            <th scope="col">Worse than pool price</th>
            <th scope="col">Round trip costs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ share, ethIn, result, trip }) => (
            <tr key={share} aria-current={current !== null && Math.abs(ethIn - current) / current < 1e-9 ? "true" : undefined}>
              <td>{formatAmount(ethIn)}</td>
              <td className={styles.muted}>{formatShare(share)}</td>
              <td>{result ? formatAmount(result.amountOut) : "–"}</td>
              <td className={styles.up}>{result ? formatShare(result.priceMove, true) : "–"}</td>
              <td>{result ? formatShare(result.costVsSpot) : "–"}</td>
              <td>{trip ? formatShare(trip.loss) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
