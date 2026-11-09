import type { Action, Post, RunV1 } from "@hyvo/schema";
import { useMemo, useState, type ReactNode } from "react";
import { formatEth, formatTokens, personaLabel, REMOVED_POST } from "../lib/format";
import { type Frame, isSwap } from "../lib/replay";
import { PersonaIcon } from "./Icons";
import styles from "./RoundPanel.module.css";

interface Props {
  run: RunV1;
  frame: Frame;
  /** The handle about to post at the next step, while the replay plays (the home console). */
  typing?: string | null;
  /** True while the replay plays: the newest post is marked as it lands. */
  live?: boolean;
}

type Tab = "feed" | "trades";

/** How many posts or trades of the earlier rounds stay on screen: a big run has thousands. */
const MAX_EARLIER = 60;

const isTrade = (action: Action) => isSwap(action) && action.status !== "invalid";

/** Items of the rounds before `round`, newest first, each with the round it belongs to. */
function earlierItems<T>(rounds: RunV1["rounds"], round: number, items: (round: RunV1["rounds"][number]) => T[]) {
  const earlier: { round: number; item: T }[] = [];
  for (let n = round - 1; n >= 1 && earlier.length < MAX_EARLIER; n--) {
    const shown = items(rounds[n - 1]!).slice(-(MAX_EARLIER - earlier.length)).reverse();
    earlier.push(...shown.map((item) => ({ round: n, item })));
  }
  return earlier;
}

/**
 * The run so far, the way a feed keeps its history: this round's posts and trades on top, newest
 * first, then the earlier rounds'. One flat list with stable keys, so a post stays in place when a
 * new round starts and only what is new slides in.
 */
function history<T>(
  current: T[],
  earlier: { round: number; item: T }[],
  render: (item: T, round: number) => ReactNode,
  round: number,
): ReactNode[] {
  const rows = [...current].reverse().map((item) => render(item, round));
  let mark = round;
  for (const entry of earlier) {
    if (entry.round !== mark) {
      mark = entry.round;
      rows.push(
        <p key={`round-${mark}`} className={styles.roundMark}>
          Round {mark}
        </p>,
      );
    }
    rows.push(render(entry.item, entry.round));
  }
  return rows;
}

/** The round as the crowd saw it, with its events, above everything said and traded so far. */
export function RoundPanel({ run, frame, typing = null, live = false }: Props) {
  const [tab, setTab] = useState<Tab>("feed");
  const agents = useMemo(() => new Map(run.crowd.agents.map((a) => [a.agentId, a])), [run]);
  const posts = useMemo(() => new Map(run.rounds.flatMap((r) => r.posts.map((p) => [p.id, p] as const))), [run]);
  const events = run.scenario.injectedEvents.filter((e) => e.round === frame.round);
  const trades = frame.actions.filter(isTrade);
  const earlierPosts = useMemo(() => earlierItems(run.rounds, frame.round, (r) => r.posts), [run, frame.round]);
  const earlierTrades = useMemo(() => earlierItems(run.rounds, frame.round, (r) => r.actions.filter(isTrade)), [run, frame.round]);
  const postsSoFar = useMemo(
    () => run.rounds.slice(0, frame.round - 1).reduce((sum, r) => sum + r.posts.length, 0) + frame.posts.length,
    [run, frame.round, frame.posts.length],
  );
  const tradesSoFar = useMemo(
    () => run.rounds.slice(0, frame.round - 1).reduce((sum, r) => sum + r.actions.filter(isTrade).length, 0) + trades.length,
    [run, frame.round, trades.length],
  );

  return (
    <section className={styles.panel} aria-label={`Round ${frame.round}`}>
      <header className={styles.head}>
        <h3 key={frame.round} className={styles.roundTitle}>
          Round {frame.round}
        </h3>
        {tab === "feed" && (
          <span className={styles.typing} data-on={typing !== null} aria-hidden="true">
            <span className={styles.dots}>
              <i />
              <i />
              <i />
            </span>
            <span className={styles.typer}>{typing ?? ""}</span>
          </span>
        )}
        <div className={styles.tabs} role="tablist" aria-label="Round view">
          <button type="button" role="tab" aria-selected={tab === "feed"} onClick={() => setTab("feed")}>
            Feed <span className={`${styles.count} num`}>{postsSoFar}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === "trades"} onClick={() => setTab("trades")}>
            Trades <span className={`${styles.count} num`}>{tradesSoFar}</span>
          </button>
        </div>
      </header>

      {events.map((event) => (
        <p key={event.text} className={styles.event}>
          <span>Scenario event</span>
          {event.text}
        </p>
      ))}

      <div className={styles.list} role="tabpanel" aria-live="off">
        {tab === "feed" ? (
          postsSoFar === 0 ? (
            <p className={styles.empty}>No posts yet.</p>
          ) : (
            history(
              frame.posts,
              earlierPosts,
              (post) => <PostItem key={post.id} post={post} agents={agents} posts={posts} fresh={live && post.id === frame.posts.at(-1)?.id} />,
              frame.round,
            )
          )
        ) : tradesSoFar === 0 ? (
          <p className={styles.empty}>No trades yet.</p>
        ) : (
          history(
            trades,
            earlierTrades,
            (action, round) => (
              <TradeItem key={`${round}-${action.agentId}`} action={action} handle={agents.get(action.agentId)?.handle ?? action.agentId} symbol={run.world.token.symbol} />
            ),
            frame.round,
          )
        )}
      </div>
    </section>
  );
}

function PostItem({
  post,
  agents,
  posts,
  fresh = false,
}: {
  post: Post;
  agents: Map<string, RunV1["crowd"]["agents"][number]>;
  posts: Map<string, Post>;
  fresh?: boolean;
}) {
  const author = agents.get(post.agentId);
  const parent = post.replyTo ? posts.get(post.replyTo) : undefined;
  const parentHandle = parent ? agents.get(parent.agentId)?.handle : undefined;
  return (
    <article className={styles.post} data-fresh={fresh}>
      <span className={styles.avatar} aria-hidden="true">
        {author && <PersonaIcon persona={author.persona} size={14} />}
      </span>
      <div className={styles.body}>
        <div className={styles.byline}>
          <span className={styles.handle}>{author?.handle ?? post.agentId}</span>
          {author && <span className={styles.persona}>{personaLabel(author.persona)}</span>}
        </div>
        {parentHandle && <p className={styles.reply}>replying to {parentHandle}</p>}
        <p className={post.text === REMOVED_POST ? styles.removed : styles.text}>{post.text}</p>
        <div className={styles.foot}>
          <span className={styles.synthetic}>synthetic agent</span>
          {post.likes > 0 && (
            <span className={styles.likes}>
              <span className="num">{post.likes}</span> {post.likes === 1 ? "like" : "likes"} by the end
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function TradeItem({ action, handle, symbol }: { action: Action; handle: string; symbol: string }) {
  const buy = action.kind === "swap_buy";
  if (action.status === "reverted") {
    return (
      <p className={`${styles.trade} ${styles.reverted}`}>
        <Direction buy={buy} />
        <span>
          <b>{handle}</b>’s {buy ? "purchase" : "sale"} reverted: the price moved past its slippage limit.
        </span>
      </p>
    );
  }
  return (
    <p className={styles.trade}>
      <Direction buy={buy} />
      <span>
        <b>{handle}</b> {buy ? "bought" : "sold"}{" "}
        <span className={`num ${buy ? styles.buyText : styles.sellText}`}>{formatTokens(buy ? action.amountOut! : action.amountIn!)}</span> {symbol}{" "}
        for <span className="num">{formatEth(buy ? action.amountIn! : action.amountOut!)}</span> ETH
      </span>
    </p>
  );
}

function Direction({ buy }: { buy: boolean }) {
  return (
    <span className={`${buy ? styles.buyMark : styles.sellMark} pop`} aria-hidden="true">
      <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {buy ? <path d="M6 10V2M2.500 5.500 6 2l3.500 3.500" /> : <path d="M6 2v8M2.500 6.500 6 10l3.500-3.500" />}
      </svg>
    </span>
  );
}
