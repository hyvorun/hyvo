import {
  CHECK_ORDER,
  CHECKS,
  DEFAULT_ETH_IN,
  formatAmount,
  isAddress,
  shortenAddress,
  toChecksumAddress,
  type Address,
  type CheckReport,
  type ExitSimulation,
  type Finding,
} from "@hyvo/check";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Arrow } from "../components/Icons";
import { Failure, Loading } from "../components/States";
import {
  STATUS_LABEL,
  checkFailure,
  ethAmount,
  exitState,
  exitSteps,
  findingSummary,
  formatBlock,
  looksFor,
  parseAddressInput,
  roundTripView,
  sentence,
  tokenLabel,
  venueView,
  type ExitState,
  type StepView,
} from "../lib/check-view";
import { addressUrl, blockUrl } from "../lib/explorer";
import { useCheck, type CheckState } from "../lib/use-check";
import { useDescription, useTitle } from "../lib/use-title";
import styles from "./CheckPage.module.css";

/**
 * Hyvo Check: a token on Robinhood Chain read at one block, in the visitor's browser. Its owner, the
 * functions that could change it, where it trades, and what happens when someone buys it, sends it on
 * and sells it back, each with its evidence. /check/:address is the link to share.
 */
export function CheckPage() {
  const raw = useParams().address ?? "";
  const navigate = useNavigate();
  const address = isAddress(raw) ? toChecksumAddress(raw) : null;
  const [state, reload] = useCheck(address);
  const report = state.status === "ready" ? state.report : state.status === "loading" ? state.previous : null;

  // One link per token: the checksummed form.
  useEffect(() => {
    if (address && raw !== address) navigate(`/check/${address}`, { replace: true });
  }, [address, raw, navigate]);

  const label = report ? (tokenLabel(report.token) ?? shortenAddress(report.token.address)) : null;
  useTitle(label ? `Check ${label}` : "Hyvo Check");
  useDescription(
    "Hyvo Check reads a Robinhood Chain token at one block, in your browser: its owner, the functions that could change it, where it trades, and what happens when someone buys it, sends it on and sells it back. Every finding with its evidence.",
  );

  const check = (next: Address) => {
    if (next === address) reload();
    else navigate(`/check/${next}`, { viewTransition: true });
  };

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Hyvo Check</h1>
        <p>
          Read a token on Robinhood Chain at one block: its owner, the functions that could change it, where it trades, and what happens when someone
          buys it, sends it on and sells it back. Your browser reads the chain itself. Nothing is signed or sent.
        </p>
      </header>

      <CheckForm key={raw} initial={raw} onCheck={check} />
      <Announcer state={state} />

      {raw && !address ? (
        <Failure message={`${raw.length > 60 ? `${raw.slice(0, 60)}…` : raw} is not a token address. A token address is 0x followed by 40 hexadecimal characters.`} />
      ) : state.status === "idle" ? (
        <Intro />
      ) : state.status === "error" ? (
        <CheckFailed error={state.error} onRetry={reload} />
      ) : state.status === "loading" && !state.previous ? (
        <Checking address={state.address} />
      ) : report ? (
        <Report report={report} reading={state.status === "loading"} onReload={reload} />
      ) : null}
    </article>
  );
}

// --- the form ------------------------------------------------------------------------------------

function CheckForm({ initial, onCheck }: { initial: string; onCheck: (address: Address) => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = parseAddressInput(value);
    if (!address) {
      setError(
        value.trim()
          ? "That is not a token address. Enter 0x followed by 40 hexadecimal characters, or paste a link that holds one."
          : "Enter a token address: 0x followed by 40 hexadecimal characters.",
      );
      return;
    }
    setError(null);
    setValue(address);
    onCheck(address);
  };

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Check a token" noValidate>
      <label htmlFor={id}>Token address</label>
      <div className={styles.row}>
        <input
          id={id}
          className="mono"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError(null);
          }}
          placeholder="0x…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : `${id}-hint`}
        />
        <button type="submit" className="btn btn-primary">
          Check
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        <p id={`${id}-hint`} className={styles.hint}>
          A token on Robinhood Chain (chain 4663). A link to a token on the block explorer works too.
        </p>
      )}
    </form>
  );
}

/** Says what happened, for screen readers, without moving focus. */
function Announcer({ state }: { state: CheckState }) {
  let message = "";
  if (state.status === "loading") message = `Checking ${shortenAddress(state.address)}.`;
  else if (state.status === "error") message = checkFailure(state.error).title;
  else if (state.status === "ready") {
    const { report } = state;
    message = `Check finished: ${tokenLabel(report.token) ?? shortenAddress(report.token.address)} at block ${formatBlock(report.block)}. ${findingSummary(report.findings)}.`;
  }
  return (
    <p className="visually-hidden" aria-live="polite" aria-atomic="true">
      {message}
    </p>
  );
}

// --- before a check, while it runs, when it fails ------------------------------------------------

function Intro() {
  return (
    <div className={styles.intro}>
      <section className={styles.section} aria-labelledby="check-how">
        <div className={styles.sectionHead}>
          <h2 id="check-how">How the exit simulation works</h2>
          <p>
            One read-only call to Robinhood Chain lends a small test contract an address and some made-up ETH for the length of that call. It walks the path a
            holder takes on the way out. Nothing is deployed, signed or sent.
          </p>
        </div>
        <ol className={styles.howSteps}>
          <li>
            <span className={styles.stepNo} aria-hidden="true">
              1
            </span>
            <div>
              <h3>Buy</h3>
              <p>0.001 ETH in, where the token trades: a Pons curve, a Pons V4 pool, or a Uniswap V2 pair or V3 pool with WETH.</p>
            </div>
          </li>
          <li>
            <span className={styles.stepNo} aria-hidden="true">
              2
            </span>
            <div>
              <h3>Send to another wallet</h3>
              <p>A tenth of what arrived goes to a fresh address, to see whether a plain transfer arrives in full.</p>
            </div>
          </li>
          <li>
            <span className={styles.stepNo} aria-hidden="true">
              3
            </span>
            <div>
              <h3>Sell back</h3>
              <p>The rest goes back through the same venue. Each trade is set against what the venue&apos;s own math promised.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="check-reads">
        <div className={styles.sectionHead}>
          <h2 id="check-reads">What each check looks for</h2>
          <p>Each one reports what it found with its evidence. A check that cannot run says skipped, and why. None of them gives a verdict about a token.</p>
        </div>
        <ul className={styles.catalog}>
          {CHECK_ORDER.map((id) => (
            <li key={id}>
              <h3>{CHECKS[id].title}</h3>
              <p>{CHECKS[id].looksFor}</p>
            </li>
          ))}
        </ul>
      </section>

      <MoreLinks />
    </div>
  );
}

function Checking({ address }: { address: string }) {
  return (
    <section className={styles.checking} aria-label="Checking the token">
      <Loading label={`Reading ${shortenAddress(address)} from Robinhood Chain and trying its exit…`} />
      <div className={styles.skeleton} aria-hidden="true">
        <span className="skeleton" style={{ height: 28, width: "38%" }} />
        <span className="skeleton" style={{ height: 14, width: "62%" }} />
        <div className={styles.skeletonSteps}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="skeleton" style={{ height: 150 }} />
          ))}
        </div>
      </div>
    </section>
  );
}

function CheckFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const failure = checkFailure(error);
  return (
    <section className={styles.failed} aria-labelledby="check-failed">
      <h2 id="check-failed">{failure.title}</h2>
      <Failure message={failure.detail} onRetry={failure.retry ? onRetry : undefined} />
    </section>
  );
}

// --- the report ----------------------------------------------------------------------------------

function Report({ report, reading, onReload }: { report: CheckReport; reading: boolean; onReload: () => void }) {
  return (
    <div className={styles.report} aria-busy={reading}>
      <TokenHead report={report} reading={reading} onReload={onReload} />
      <ExitSection report={report} state={exitState(report)} />
      <Findings findings={report.findings} />
      <Limits block={report.block} ethIn={report.exit?.ethIn ?? DEFAULT_ETH_IN} />
      <MoreLinks />
    </div>
  );
}

function TokenHead({ report, reading, onReload }: { report: CheckReport; reading: boolean; onReload: () => void }) {
  const { token, block, timings } = report;
  const label = tokenLabel(token);
  const seconds = (timings.totalMs / 1000).toFixed(1);
  const requests = timings.requests.rpc + timings.requests.sourcify + timings.requests.blockscout;
  return (
    <section className={styles.token} aria-labelledby="check-token">
      <div className={styles.tokenMain}>
        <h2 id="check-token">
          {label ?? "A token without a name"}
          {token.name && token.symbol && token.name !== token.symbol && <span className={styles.tokenName}>{token.name}</span>}
        </h2>
        <a className={`mono ${styles.fullAddress}`} href={addressUrl(token.address)} target="_blank" rel="noreferrer">
          {token.address}
        </a>
        <p className={styles.fine}>The name and the symbol are what the token says about itself. {report.notice}</p>
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>Read at block</dt>
          <dd className="num">
            <a href={blockUrl(Number(block))} target="_blank" rel="noreferrer">
              {formatBlock(block)}
            </a>
          </dd>
        </div>
        <div>
          <dt>Total supply</dt>
          <dd className="num">{token.totalSupply !== null ? formatAmount(token.totalSupply, token.decimals ?? 18) : "Not reported"}</dd>
        </div>
        <div>
          <dt>Decimals</dt>
          <dd className="num">{token.decimals ?? "Not reported"}</dd>
        </div>
        <div>
          <dt>Read in</dt>
          <dd className="num">
            {seconds} s<small>{requests} requests from this browser</small>
          </dd>
        </div>
      </dl>
      <div className={styles.actions}>
        {/* aria-disabled rather than disabled, so a keyboard keeps its focus here while the chain is read again. */}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => !reading && onReload()} aria-disabled={reading}>
          {reading ? "Reading the latest block…" : "Check again at the latest block"}
        </button>
        <CopyLink address={token.address} />
      </div>
    </section>
  );
}

function CopyLink({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/check/${address}`);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // A blocked clipboard: the address bar holds the same link.
    }
  };
  return (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>
      <span aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
    </button>
  );
}

// --- the exit simulation -------------------------------------------------------------------------

function ExitSection({ report, state }: { report: CheckReport; state: ExitState }) {
  return (
    <section className={styles.section} aria-labelledby="check-exit">
      <div className={styles.sectionHead}>
        <h2 id="check-exit">Buy, send, sell back</h2>
        {state.kind === "simulated" ? (
          <p>
            In one read-only call at block {formatBlock(report.block)}, a test contract with made-up ETH bought the token for {ethAmount(state.exit.ethIn)}, sent a
            tenth to a fresh address and sold the rest back. Promised is what the venue&apos;s own math quoted, after its published fees and taxes. Nothing was
            signed or sent, and no real ETH moved.
          </p>
        ) : (
          <p>The exit simulation buys a token through its venue, sends a tenth to a fresh address and sells the rest back, inside one read-only call.</p>
        )}
      </div>
      {state.kind === "simulated" ? <Simulation exit={state.exit} report={report} /> : <NoSimulation state={state} />}
    </section>
  );
}

function Simulation({ exit, report }: { exit: ExitSimulation; report: CheckReport }) {
  const steps = exitSteps(exit, report.token);
  const trip = roundTripView(exit);
  const venue = venueView(exit.venue);
  return (
    <div className={styles.sim}>
      <ol className={styles.steps}>
        {steps.map((step) => (
          <StepCard key={step.key} step={step} />
        ))}
      </ol>

      <div className={styles.trip}>
        <h3>Round trip</h3>
        {trip.kind === "none" || !trip.percent ? (
          <p className={styles.tripLine}>{trip.line}</p>
        ) : (
          <>
            <p className={styles.tripFigure}>
              <b className="num" data-tone={trip.kind === "cost" ? "lost" : "more"}>
                {trip.percent}
              </b>
              <span>{trip.kind === "cost" ? "less came back than the sold part cost" : "more came back than the sold part cost"}</span>
            </p>
            {trip.bar && <Bar bar={trip.bar} label="came back" />}
            <p className={styles.tripLine}>{trip.line} Fees, taxes and the trade&apos;s own price move, together.</p>
          </>
        )}
      </div>

      <div className={styles.venue}>
        <h3>Venue</h3>
        <p className={styles.venueName}>{venue.name}</p>
        <dl className={styles.venueFacts}>
          <div>
            <dt>{venue.addressLabel}</dt>
            <dd>
              <a className="mono" href={addressUrl(venue.address)} target="_blank" rel="noreferrer" title={venue.address}>
                {shortenAddress(venue.address)}
              </a>
            </dd>
          </div>
          {venue.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd className="num">{fact.value}</dd>
            </div>
          ))}
          <div>
            <dt>Paid out in</dt>
            <dd>{exit.payout === "weth" ? "WETH" : "ETH"}</dd>
          </div>
        </dl>
        <p className={styles.fine}>The promises come from {venue.promises}.</p>
      </div>
    </div>
  );
}

function StepCard({ step }: { step: StepView }) {
  return (
    <li className={styles.step} data-state={step.state}>
      <div className={styles.stepHead}>
        <span className={styles.stepNo} aria-hidden="true">
          {step.number}
        </span>
        <h3>{step.title}</h3>
      </div>
      <p className={styles.stepLine}>{step.line}</p>
      {step.state === "not_tried" ? (
        <p className={styles.notTried}>{step.reason}</p>
      ) : (
        <>
          <dl className={styles.figures}>
            <div>
              <dt>{step.promisedLabel}</dt>
              <dd className="num">{step.promised ?? "No quote"}</dd>
            </div>
            <div>
              <dt>Arrived</dt>
              <dd className={`num ${step.state === "done" ? styles.arrived : ""}`}>{step.arrived}</dd>
            </div>
            {step.difference && (
              <div>
                <dt>Difference</dt>
                <dd className="num">
                  <span data-tone={step.difference.tone}>{step.difference.text}</span>
                  <small>{step.difference.note}</small>
                </dd>
              </div>
            )}
          </dl>
          {step.bar && <Bar bar={step.bar} label="arrived" />}
          {step.state === "reverted" && (
            <p className={styles.reverted}>
              <b>Reverted</b>
              <code className="mono">{step.reason}</code>
            </p>
          )}
          {step.gas && <p className={styles.gas}>Gas used {step.gas}</p>}
        </>
      )}
    </li>
  );
}

/** What arrived (jade) and what did not (rose), as parts of one line. The figures say the same in text. */
function Bar({ bar, label }: { bar: { arrived: number; lost: number }; label: string }) {
  return (
    <span className={styles.bar} aria-hidden="true" title={`${(bar.arrived * 100).toFixed(2)}% ${label}`}>
      <span className={styles.barIn} style={{ width: `${bar.arrived * 100}%` }} />
      {bar.lost > 0 && <span className={styles.barOut} style={{ width: `${bar.lost * 100}%` }} />}
    </span>
  );
}

function NoSimulation({ state }: { state: Exclude<ExitState, { kind: "simulated" }> }) {
  const copy = {
    no_venue: {
      title: "No venue with liquidity",
      body: "Hyvo found nothing to trade this token through at this block, so nothing was bought or sold. No liquidity reads as no liquidity: it says nothing else about the token.",
    },
    not_covered: {
      title: "No venue Hyvo can test yet",
      body: "The token trades somewhere the exit simulation does not reach yet, so nothing was bought or sold. The other checks below still ran.",
    },
    failed: {
      title: "The simulation could not run",
      body: "A venue was found, but the simulation's call did not complete. The other checks below still ran; checking again may get through.",
    },
  }[state.kind];
  return (
    <div className={styles.none}>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      <dl className={styles.noneFacts}>
        <div>
          <dt>Why</dt>
          <dd>{sentence(state.reason)}</dd>
        </div>
        {state.venueEvidence && (
          <div>
            <dt>Venue</dt>
            <dd>{sentence(state.venueEvidence)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// --- findings and limits -------------------------------------------------------------------------

function Findings({ findings }: { findings: Finding[] }) {
  return (
    <section className={styles.section} aria-labelledby="check-findings">
      <div className={styles.sectionHead}>
        <h2 id="check-findings">Every check, with its evidence</h2>
        <p>
          {findingSummary(findings)}. Found means the check found what it looks for: a fact, not a verdict. Skipped means it could not look, and says why.
        </p>
      </div>
      <ul className={styles.findings}>
        {findings.map((item) => (
          <li key={item.id} className={styles.finding}>
            <div className={styles.findingHead}>
              <h3>{item.title}</h3>
              <span className={styles.status} data-status={item.status}>
                {STATUS_LABEL[item.status]}
              </span>
            </div>
            <div className={styles.findingBody}>
              <p className={styles.evidence}>{sentence(item.evidence)}</p>
              <p className={styles.looks}>
                <span>Looks for:</span> {looksFor(item)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Limits({ block, ethIn }: { block: bigint; ethIn: bigint }) {
  return (
    <section className={styles.section} aria-labelledby="check-limits">
      <div className={styles.sectionHead}>
        <h2 id="check-limits">What this check cannot tell</h2>
      </div>
      <ul className={styles.limits}>
        <li>
          <b>One block only.</b> Every read and the simulation ran at block {formatBlock(block)}. A later block can differ.
        </li>
        <li>
          <b>Other wallets, other times.</b> The simulation trades {ethAmount(ethIn)} from a fresh address with no history. A token can behave differently for
          other wallets, other amounts or later blocks.
        </li>
        <li>
          <b>Settings can change.</b> An owner, or whoever controls the code, can change fees, lists or switches after this block, wherever the code allows it.
        </li>
        <li>
          <b>No liquidity reads as no liquidity.</b> Without a pool or a launch to trade through there is no exit simulation, and that says nothing else about
          the token.
        </li>
        <li>
          <b>Not an audit.</b> Functions are found by their names, and who may call them is not worked out. Code can do the same things under other names.
        </li>
      </ul>
      <p className={styles.measured}>
        Measured on-chain at block{" "}
        <a href={blockUrl(Number(block))} target="_blank" rel="noreferrer" className="num">
          {formatBlock(block)}
        </a>
        . Not a trading signal.
      </p>
    </section>
  );
}

function MoreLinks() {
  return (
    <div className={styles.links}>
      <Link to="/docs#cli" className="arrow-link" viewTransition>
        Hyvo Check in your terminal <Arrow />
      </Link>
      <Link to="/trust#probe" className="arrow-link" viewTransition>
        How the simulation stays read-only <Arrow />
      </Link>
    </div>
  );
}
