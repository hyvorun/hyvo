import { MAX_EVENT_CHARS, MAX_SEED_CHARS, PERSONAS } from "@hyvo/schema";
import { useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Checkout } from "../components/Checkout";
import { DecisionGrid } from "../components/DecisionGrid";
import { Arrow } from "../components/Icons";
import { Web3 } from "../components/Web3";
import { fetchHealth } from "../lib/api";
import { assignedAgents, BOUNDS, codePoints, EMPTY_DRAFT, SIZES, toRequest, type Draft, type FieldErrors } from "../lib/draft";
import { personaLabel } from "../lib/format";
import { lastEventRound, TEMPLATES, type Template } from "../lib/templates";
import { useAsync } from "../lib/use-async";
import { useTitle } from "../lib/use-title";
import styles from "./NewRunPage.module.css";

const MAX_EVENTS = 50;

export function NewRunPage() {
  return (
    <Web3>
      <NewRun />
    </Web3>
  );
}

function NewRun() {
  useTitle("Run a simulation");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [picked, setPicked] = useState<Template | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const health = useAsync(fetchHealth, "health");
  const limits = health.status === "ready" ? health.data.limits : null;
  const paymentsOff = health.status === "ready" && !health.data.features.payments;

  const request = () => {
    const result = toRequest(draft);
    const errors = { ...result.errors };
    if (limits && Number(draft.agents) * Number(draft.rounds) > limits.maxDecisions) {
      errors.agents ??= `Runs are limited to ${limits.maxDecisions.toLocaleString("en-US")} decisions (agents × rounds) for now.`;
    }
    setErrors(errors);
    return Object.keys(errors).length > 0 ? null : result.request;
  };
  const showErrors = () => {
    window.setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(), 0);
  };

  const agents = Number(draft.agents);
  const rounds = Number(draft.rounds);
  const preset = SIZES.find((size) => size.agents === agents && size.rounds === rounds)?.id ?? "custom";

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Run a simulation</h1>
        <p>
          Describe a launch or a market moment. A crowd of synthetic traders reads it, posts about it and trades on its own
          fork of Robinhood Chain, round by round. You get a price before anything runs; the result is published with its
          hash committed on-chain.
        </p>
      </header>

      <div className={styles.layout}>
      <aside className={styles.side}>
        <DecisionGrid agents={agents} rounds={rounds} />
      </aside>
      <form ref={formRef} className={styles.form} onSubmit={(event) => event.preventDefault()} noValidate>
        <section className={styles.step} aria-labelledby="step-scenario">
          <h2 id="step-scenario">
            <span className={styles.n}>1</span> The scenario
          </h2>
          <Examples
            onPick={(template) => {
              // Switching between examples asks nothing; replacing the person's own words asks first.
              const written = draft.title.trim() || draft.seedText.trim() || draft.events.some((event) => event.text.trim());
              const asPicked =
                picked !== null &&
                draft.title === picked.draft.title &&
                draft.seedText === picked.draft.seedText &&
                JSON.stringify(draft.events) === JSON.stringify(picked.draft.events);
              if (written && !asPicked && !window.confirm("Replace what you wrote with this example?")) return;
              const rounds = Number(draft.rounds);
              set({
                ...template.draft,
                events: template.draft.events.map((event) => ({ ...event })),
                ...(Number.isFinite(rounds) && rounds >= lastEventRound(template) ? {} : { rounds: String(Math.max(10, lastEventRound(template))) }),
              });
              setErrors({});
              setPicked(template);
            }}
            picked={picked}
          />
          <Field label="Title" error={errors.title} hint="Name the token or the moment. Use made-up names, not real people.">
            {(props) => (
              <input
                {...props}
                value={draft.title}
                onChange={(e) => set({ title: e.target.value })}
                maxLength={220}
                placeholder="Fictional token FIZZ launches with a 3% creator tax"
              />
            )}
          </Field>
          <Field
            label="What the crowd reads before round 1"
            error={errors.seedText}
            hint={`${codePoints(draft.seedText).toLocaleString("en-US")} / ${MAX_SEED_CHARS.toLocaleString("en-US")} characters. Links are shown as plain text.`}
          >
            {(props) => (
              <textarea
                {...props}
                rows={7}
                value={draft.seedText}
                onChange={(e) => set({ seedText: e.target.value })}
                placeholder="The launch post, the liquidity, who holds what, what people are saying…"
              />
            )}
          </Field>

          <fieldset className={styles.events}>
            <legend>Events during the run (optional)</legend>
            <p className={styles.hint}>Something that happens at a given round: a rumor, a large wallet, a reply from the team.</p>
            {draft.events.map((event, index) => (
              <div className={styles.event} key={index}>
                <Field label="Round" error={errors[`events.${index}.round`]} compact>
                  {(props) => (
                    <input
                      {...props}
                      inputMode="numeric"
                      value={event.round}
                      onChange={(e) => set({ events: draft.events.map((x, i) => (i === index ? { ...x, round: e.target.value } : x)) })}
                    />
                  )}
                </Field>
                <Field label="What happens" error={errors[`events.${index}.text`]} compact>
                  {(props) => (
                    <input
                      {...props}
                      value={event.text}
                      maxLength={MAX_EVENT_CHARS + 20}
                      onChange={(e) => set({ events: draft.events.map((x, i) => (i === index ? { ...x, text: e.target.value } : x)) })}
                    />
                  )}
                </Field>
                <button
                  type="button"
                  className={`btn btn-ghost btn-sm ${styles.remove}`}
                  onClick={() => set({ events: draft.events.filter((_, i) => i !== index) })}
                  aria-label={`Remove event ${index + 1}`}
                >
                  Remove
                </button>
              </div>
            ))}
            {draft.events.length < MAX_EVENTS && (
              <button
                type="button"
                className={`btn btn-ghost btn-sm ${styles.add}`}
                onClick={() =>
                  set({ events: [...draft.events, { round: String(Math.min(3, Number(draft.rounds) || 3)), text: "" }] })
                }
              >
                Add an event
              </button>
            )}
          </fieldset>

          <Field
            label="A yes or no question for the crowd (optional)"
            error={errors["question.text"]}
            hint="Each agent answers at the end of the run, and the crowd's lean is hashed with the run. After the date, the outcome goes on-chain and on the calibration page."
          >
            {(props) => (
              <input
                {...props}
                value={draft.question}
                onChange={(e) => set({ question: e.target.value })}
                maxLength={320}
                placeholder="Will FIZZ stay above its launch price for a week?"
              />
            )}
          </Field>
          <Field label="When the outcome is known" error={errors["question.resolvesAt"]}>
            {(props) => <input {...props} type="date" value={draft.questionDate} onChange={(e) => set({ questionDate: e.target.value })} />}
          </Field>

          <details className={styles.market}>
            <summary>Market settings (optional)</summary>
            <p className={styles.hint}>The simulated pool on the fork. Leave empty for the defaults.</p>
            <div className={styles.marketGrid}>
              <Field label="Token symbol" error={errors["market.tokenSymbol"]} compact>
                {(props) => (
                  <input {...props} value={draft.tokenSymbol} onChange={(e) => set({ tokenSymbol: e.target.value })} placeholder="FIZZ" />
                )}
              </Field>
              <Field label="Token name" error={errors["market.tokenName"]} compact>
                {(props) => (
                  <input {...props} value={draft.tokenName} onChange={(e) => set({ tokenName: e.target.value })} placeholder="Fizz (fictional)" />
                )}
              </Field>
              <Field label="Starting liquidity (ETH)" error={errors["market.liquidityEth"]} compact>
                {(props) => (
                  <input {...props} inputMode="decimal" value={draft.liquidityEth} onChange={(e) => set({ liquidityEth: e.target.value })} placeholder="5" />
                )}
              </Field>
              <Field label="Swap fee or tax (%)" error={errors["market.feeBps"]} compact>
                {(props) => (
                  <input {...props} inputMode="decimal" value={draft.feePct} onChange={(e) => set({ feePct: e.target.value })} placeholder="1" />
                )}
              </Field>
            </div>
          </details>
        </section>

        <section className={styles.step} aria-labelledby="step-crowd">
          <h2 id="step-crowd">
            <span className={styles.n}>2</span> The crowd
          </h2>
          <div className={styles.sizes}>
              <div className={styles.presets} role="radiogroup" aria-label="Crowd size">
                {SIZES.map((size) => (
                  <button
                    key={size.id}
                    type="button"
                    role="radio"
                    aria-checked={preset === size.id}
                    className={styles.preset}
                    disabled={limits !== null && size.agents * size.rounds > limits.maxDecisions}
                    onClick={() => set({ agents: String(size.agents), rounds: String(size.rounds) })}
                  >
                    <span className={styles.presetName}>{size.label}</span>
                    <span className={`${styles.presetSize} num`}>
                      {size.agents} × {size.rounds}
                    </span>
                  </button>
                ))}
              </div>
              <div className={styles.custom}>
                <Field label="Agents" error={errors.agents} hint={`${BOUNDS.minAgents} to ${BOUNDS.maxAgents.toLocaleString("en-US")}`} compact>
                  {(props) => <input {...props} inputMode="numeric" value={draft.agents} onChange={(e) => set({ agents: e.target.value })} />}
                </Field>
                <Field label="Rounds" error={errors.rounds} hint={`${BOUNDS.minRounds} to ${BOUNDS.maxRounds}`} compact>
                  {(props) => <input {...props} inputMode="numeric" value={draft.rounds} onChange={(e) => set({ rounds: e.target.value })} />}
                </Field>
              </div>
              <details className={styles.market}>
                <summary>Who is in the crowd (optional)</summary>
                <p className={styles.hint}>
                  By default the crowd is snipers, holders, panic sellers and skeptics. To choose your own, give each kind of trader a number. They have to add up to the
                  crowd.
                </p>
                <div className={styles.mixGrid}>
                  {PERSONAS.map((persona) => (
                    <Field key={persona} label={personaLabel(persona, 2)} error={errors[`mix.${persona}`]} compact>
                      {(props) => (
                        <input
                          {...props}
                          aria-invalid={props["aria-invalid"] || Boolean(errors.mix)}
                          inputMode="numeric"
                          placeholder="0"
                          value={draft.mix[persona] ?? ""}
                          onChange={(e) => set({ mix: { ...draft.mix, [persona]: e.target.value } })}
                        />
                      )}
                    </Field>
                  ))}
                </div>
                <p className={`${styles.hint} ${styles.mixTotal}`} role="status">
                  <span className="num">{assignedAgents(draft)}</span> of <span className="num">{Number.isFinite(agents) ? agents : 0}</span> agents assigned
                </p>
                {errors.mix && <p className={styles.error}>{errors.mix}</p>}
              </details>
              <label className={styles.check}>
                <input type="checkbox" checked={draft.listed} onChange={(e) => set({ listed: e.target.checked })} />
                <span>
                  List the result in the public gallery
                  <small>
                    Unlisted runs stay out of the gallery, but they are not private: anyone with the run id can open them, and
                    the id is public on-chain with the run's hash.
                  </small>
                </span>
              </label>
          </div>
        </section>

        <section className={styles.step} aria-labelledby="step-pay">
          <h2 id="step-pay">
            <span className={styles.n}>3</span> Price and payment
          </h2>
          {paymentsOff ? (
            <div className={styles.notice}>
              <p>
                Paid runs are not open yet. Until they open, every published run can be replayed, and its hash checked, in the
                gallery.
              </p>
              <Link to="/runs" className="arrow-link" viewTransition>
                Browse runs <Arrow />
              </Link>
            </div>
          ) : (
            <Checkout request={request} onInvalid={showErrors} draftKey={JSON.stringify(draft)} />
          )}
        </section>
      </form>
      </div>
    </article>
  );
}

/** Example scenarios with fictional tokens: one click fills the scenario and the market. */
function Examples({ onPick, picked }: { onPick: (template: Template) => void; picked: Template | null }) {
  return (
    <div className={styles.examples}>
      <span className={styles.examplesLabel} id="examples-label">
        Start from an example
      </span>
      <div className={styles.exampleList} role="group" aria-labelledby="examples-label">
        {TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            className={styles.example}
            aria-pressed={picked?.id === template.id}
            onClick={() => onPick(template)}
            title={template.tests}
          >
            {template.label}
          </button>
        ))}
      </div>
      <p className={styles.hint} role="status">
        {picked
          ? `Filled in: ${picked.draft.tokenSymbol}, ${picked.draft.liquidityEth} ETH of liquidity, a ${picked.draft.feePct}% fee and ${picked.draft.events.length} ${picked.draft.events.length === 1 ? "event" : "events"}. Change anything.`
          : "Every example uses a fictional token. Pick one, then make it yours."}
      </p>
    </div>
  );
}

interface FieldProps {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby"?: string;
}

function Field({
  label,
  hint,
  error,
  compact = false,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  compact?: boolean;
  children: (props: FieldProps) => ReactNode;
}) {
  const id = useId();
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className={compact ? `${styles.field} ${styles.compact}` : styles.field}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error), ...(described ? { "aria-describedby": described } : {}) })}
      {hint && (
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className={styles.error}>
          {error}
        </span>
      )}
    </div>
  );
}
