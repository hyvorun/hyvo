import { Link } from "react-router";
import { Tween } from "../../components/motion-data/CountUp";
import { formatAmount, formatShare, parseAmount } from "../../lib/calc";
import { ArithmeticNote, NumberField, ToolPage, useDescription, useQueryState } from "./shared";
import styles from "./Tools.module.css";

const DEFAULTS = { price: "0.00002", supply: "1b", circulating: "", held: "", cap: "" };

/** Market cap, fully diluted value, a holding's share, and the price a given market cap means. */
export function MarketCapTool() {
  useDescription("Free market cap calculator: market cap, fully diluted value, a holding's share of the supply, and the price behind any market cap.");
  const [input, set] = useQueryState(DEFAULTS);
  const price = parseAmount(input.price);
  const supply = parseAmount(input.supply);
  const circulatingTyped = input.circulating.trim() !== "";
  const circulating = circulatingTyped ? parseAmount(input.circulating) : supply;
  const held = input.held.trim() === "" ? null : parseAmount(input.held);
  const cap = input.cap.trim() === "" ? null : parseAmount(input.cap);
  const errors = {
    price: price > 0 ? null : "Enter a price above 0.",
    supply: supply > 0 ? null : "Enter the total supply, such as 1b.",
    circulating: !circulatingTyped || (circulating > 0 && circulating <= supply) ? null : "Use a number above 0 and no larger than the total supply.",
    held: held === null || held >= 0 ? null : "Enter a number of tokens, or leave it empty.",
    cap: cap === null || cap > 0 ? null : "Enter a market cap above 0, or leave it empty.",
  };
  const ready = !errors.price && !errors.supply && !errors.circulating;
  const marketCap = price * circulating;
  const fdv = price * supply;

  return (
    <ToolPage
      to="/tools/market-cap"
      title="Market cap and supply"
      lede="What a price means for the whole token, what a holding is worth at it, and what price a given market cap works out to."
    >
      <section className={`${styles.card} ${styles.split}`} aria-label="Calculator">
        <form className={styles.panel} onSubmit={(event) => event.preventDefault()}>
          <h2>The token</h2>
          <NumberField
            label="Price of one token"
            value={input.price}
            onChange={(value) => set({ price: value })}
            error={errors.price}
            hint="In any currency, such as dollars or ETH. Every result is in the same one."
          />
          <div className={`${styles.fields} ${styles.two}`}>
            <NumberField label="Total supply" value={input.supply} onChange={(value) => set({ supply: value })} error={errors.supply} hint="1b, 2.5m and 1e9 work too." />
            <NumberField
              label="Circulating (optional)"
              value={input.circulating}
              onChange={(value) => set({ circulating: value })}
              error={errors.circulating}
              placeholder="Same as total"
              hint="Tokens that can trade now."
            />
          </div>
          <NumberField label="Tokens you hold (optional)" value={input.held} onChange={(value) => set({ held: value })} error={errors.held} />
          <h2>The other way round</h2>
          <NumberField
            label="A market cap (optional)"
            value={input.cap}
            onChange={(value) => set({ cap: value })}
            error={errors.cap}
            hint="Shows the price of one token at that market cap."
          />
        </form>

        <section className={styles.panel} aria-label="Result" aria-live="polite">
          {ready ? (
            <>
              <div className={styles.lead}>
                <span>Market cap</span>
                <b className="num">
                  <Tween value={marketCap} format={formatAmount} />
                </b>
                <small>
                  {formatAmount(circulating)} circulating tokens at {formatAmount(price)} each
                </small>
              </div>
              <dl className={styles.stats}>
                <div className={styles.stat}>
                  <dt>Fully diluted value</dt>
                  <dd className="num">
                    <Tween value={fdv} format={formatAmount} />
                    <small>the whole supply at this price</small>
                  </dd>
                </div>
                <div className={styles.stat}>
                  <dt>Circulating</dt>
                  <dd className="num">
                    <Tween value={circulating / supply} format={formatShare} />
                    <small>of the total supply</small>
                  </dd>
                </div>
                {held !== null && held >= 0 && (
                  <>
                    <div className={styles.stat}>
                      <dt>Your tokens are worth</dt>
                      <dd className="num">
                        <Tween value={held * price} format={formatAmount} />
                      </dd>
                    </div>
                    <div className={styles.stat}>
                      <dt>Your share</dt>
                      <dd className="num">
                        <Tween value={held / supply} format={formatShare} />
                        <small>of the total supply</small>
                      </dd>
                    </div>
                  </>
                )}
                {cap !== null && cap > 0 && (
                  <div className={styles.stat}>
                    <dt>Price at a market cap of {formatAmount(cap)}</dt>
                    <dd className="num">
                      <Tween value={cap / circulating} format={formatAmount} />
                      <small>{formatShare(cap / marketCap - 1, true)} from the price above</small>
                    </dd>
                  </div>
                )}
              </dl>
            </>
          ) : (
            <p className={styles.empty}>Enter a price and a supply to see the result.</p>
          )}
        </section>
      </section>

      <section className={styles.notes} aria-labelledby="cap-how">
        <h2 id="cap-how">What these numbers are</h2>
        <p>
          Market cap is the last price times the circulating supply, and fully diluted value the same price times every token there will ever be. Both are
          arithmetic on one price. Nobody could take that much out: selling even a part of the supply would move the price a long way, as the{" "}
          <Link to="/tools/swap">swap calculator</Link> shows.
        </p>
        <ArithmeticNote />
      </section>
    </ToolPage>
  );
}
