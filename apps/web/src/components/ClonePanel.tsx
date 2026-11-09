import type { RunV1 } from "@hyvo/schema";
import { Link } from "react-router";
import { formatPct } from "../lib/format";
import { isSwap } from "../lib/replay";
import { CountUp } from "./motion-data/CountUp";
import styles from "./RewindPanel.module.css";

const whole = (value: number) => String(Math.round(value));

/** What the clone in a crowd did, from the run's own record. The run holds its actions, not the numbers it was made from. */
export function ClonePanel({ run }: { run: RunV1 }) {
  const agent = run.crowd.agents.find((item) => item.persona === "clone");
  if (!agent) return null;
  let buys = 0;
  let sells = 0;
  let reverted = 0;
  let eth = Number(agent.startEth);
  let tokens = Number(agent.startTokens);
  for (const round of run.rounds) {
    for (const action of round.actions) {
      if (action.agentId !== agent.agentId || !isSwap(action)) continue;
      if (action.status === "reverted") reverted++;
      if (action.status !== "ok") continue;
      const paid = Number(action.amountIn);
      const got = Number(action.amountOut);
      if (action.kind === "swap_buy") {
        buys++;
        eth -= paid;
        tokens += got;
      } else {
        sells++;
        tokens -= paid;
        eth += got;
      }
    }
  }
  const last = run.rounds.at(-1);
  const price = Number(last ? last.market.price : run.world.initialMarket.price);
  const start = Number(agent.startEth) + Number(agent.startTokens) * Number(run.world.initialMarket.price);
  const end = eth + Math.max(0, tokens) * price;
  const change = start > 0 ? (end / start - 1) * 100 : 0;
  const posts = run.rounds.reduce((sum, round) => sum + round.posts.filter((post) => post.agentId === agent.agentId).length, 0);

  return (
    <section className={styles.panel} aria-labelledby="clone-title">
      <h2 id="clone-title">The clone in this crowd</h2>
      <p>
        <span className="mono">{agent.handle}</span> traded by one wallet's recorded numbers. It bought{" "}
        <b className="num">
          <CountUp value={buys} format={whole} />
        </b>{" "}
        {buys === 1 ? "time" : "times"} and sold{" "}
        <b className="num">
          <CountUp value={sells} format={whole} />
        </b>
        {reverted > 0 && (
          <>
            , with <b className="num">{reverted}</b> {reverted === 1 ? "swap" : "swaps"} refused by its slippage limit
          </>
        )}
        , and wrote{" "}
        <b className="num">
          <CountUp value={posts} format={whole} />
        </b>{" "}
        {posts === 1 ? "post" : "posts"}. At the last price its wallet moved{" "}
        <b className="num">
          <CountUp value={change} format={formatPct} />
        </b>{" "}
        in this synthetic market, before gas.
      </p>
      <p className={styles.note}>
        What one agent did in one simulated crowd, not a measure of the wallet behind it. <Link to="/clone">Your clone</Link>
      </p>
    </section>
  );
}
