import { DRYRUN_LIMITS, DryRunRequest, runPriceUsd, type DryRunView, type HealthResponse, type RunSize } from "@hyvo/schema";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { PaymentsNote } from "../components/PaymentsNote";
import { Reveal } from "../components/Reveal";
import { useWalletSession, Web3 } from "../components/Web3";
import { ApiError, createDryRun, fetchDryRuns, fetchHealth, fetchMe } from "../lib/api";
import { formatUsd } from "../lib/draft";
import { formatDate, shortHash } from "../lib/format";
import { useAsync } from "../lib/use-async";
import { useTitle } from "../lib/use-title";
import styles from "./DryRunPage.module.css";

/** This wallet's holder discount once it is signed in, as the API will apply it: 0 until then, and for everyone else. */
function useHolderDiscount(token: string | null): number {
  const [discountBps, setDiscountBps] = useState(0);
  useEffect(() => {
    setDiscountBps(0);
    if (!token) return;
    let current = true;
    fetchMe(token).then(
      (me) => current && setDiscountBps(me.holder.eligible ? me.holder.discountBps : 0),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [token]);
  return discountBps;
}

/** /v1/health, or null while it loads or when it cannot be read. */
export function useHealth(): HealthResponse | null {
  const health = useAsync(fetchHealth, "health");
  return health.status === "ready" ? health.data : null;
}

/**
 * The price of a run paid from the balance, said before the button that spends it: the API's own terms (`/v1/health`)
 * through the function the API charges with, and this wallet's holder discount once it is signed in. The line holds
 * its place while the terms load or the size is not valid yet, so nothing below it moves.
 */
export function BalancePrice({ health, size, token }: { health: HealthResponse | null; size: RunSize | null; token: string | null }) {
  const discountBps = useHolderDiscount(token);
  const price = health?.pricing && size ? runPriceUsd(health.pricing, size, discountBps) : null;
  return (
    <p className={styles.price} role="status">
      <span>Price</span>
      <b className="num">{price === null ? "–" : formatUsd(price)}</b>
      <span className={styles.small}>{price !== null && discountBps > 0 ? `with your ${discountBps / 100}% holder discount, from your prepaid balance` : "from your prepaid balance"}</span>
    </p>
  );
}

export function DryRunPage() {
  useTitle("Dry Run");
  return (
    <Web3>
      <Submit />
    </Web3>
  );
}

type Target = "address" | "bytecode";

interface Fields {
  target: Target;
  address: string;
  bytecode: string;
  abi: string;
  description: string;
  invariants: string;
  agents: string;
  rounds: string;
}

const EMPTY: Fields = { target: "address", address: "", bytecode: "", abi: "", description: "", invariants: "", agents: "12", rounds: "8" };

/** The size the form holds, when it is one the API would take: within the Dry Run's bounds and `/v1/health`'s `maxDecisions`. */
export function dryRunSize(fields: Pick<Fields, "agents" | "rounds">, maxDecisions: number | null): RunSize | null {
  const agents = Number(fields.agents);
  const rounds = Number(fields.rounds);
  if (!Number.isInteger(agents) || agents < DRYRUN_LIMITS.minAgents || agents > DRYRUN_LIMITS.maxAgents) return null;
  if (!Number.isInteger(rounds) || rounds < DRYRUN_LIMITS.minRounds || rounds > DRYRUN_LIMITS.maxRounds) return null;
  return maxDecisions !== null && agents * rounds > maxDecisions ? null : { agents, rounds };
}

/** The form as a submission, or what is wrong with it, by field. `maxDecisions` is `/v1/health`'s, once it is known. */
export function toSubmission(fields: Fields, maxDecisions: number | null = null): { body: DryRunRequest | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  let abi: unknown;
  if (fields.abi.trim()) {
    try {
      abi = JSON.parse(fields.abi);
      if (!Array.isArray(abi)) errors.abi = "The ABI is a JSON list.";
    } catch {
      errors.abi = "This is not valid JSON.";
    }
  } else if (fields.target === "bytecode") {
    errors.abi = "Bytecode needs its ABI.";
  }
  if (fields.target === "address" && !/^0x[0-9a-fA-F]{40}$/.test(fields.address.trim())) errors.address = "Use 0x and 40 hex digits.";
  if (fields.target === "bytecode" && !/^0x(?:[0-9a-fA-F]{2})+$/.test(fields.bytecode.trim())) errors.bytecode = "Use 0x and an even number of hex digits: the contract's creation code.";
  if (!fields.description.trim()) errors.description = "Describe it in plain language: the crowd reads this.";
  const invariants = fields.invariants.split(",").map((name) => name.trim()).filter(Boolean);
  if (invariants.some((name) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))) errors.invariants = "Give names of view functions, separated by commas.";
  const agents = Number(fields.agents);
  const rounds = Number(fields.rounds);
  if (!Number.isInteger(agents) || agents < DRYRUN_LIMITS.minAgents || agents > DRYRUN_LIMITS.maxAgents) errors.agents = `Use ${DRYRUN_LIMITS.minAgents} to ${DRYRUN_LIMITS.maxAgents}.`;
  if (!Number.isInteger(rounds) || rounds < DRYRUN_LIMITS.minRounds || rounds > DRYRUN_LIMITS.maxRounds) errors.rounds = `Use ${DRYRUN_LIMITS.minRounds} to ${DRYRUN_LIMITS.maxRounds}.`;
  // What the API's daily limit lets through, as /new keeps its runs to it.
  if (!errors.agents && !errors.rounds && maxDecisions !== null && agents * rounds > maxDecisions) {
    errors.agents = `For now, users × rounds can be at most ${maxDecisions.toLocaleString("en-US")}.`;
  }
  if (Object.keys(errors).length > 0) return { body: null, errors };
  const candidate = {
    balance: true as const,
    description: fields.description.trim(),
    ...(fields.target === "address" ? { address: fields.address.trim() } : { bytecode: fields.bytecode.trim() }),
    ...(abi ? { abi } : {}),
    ...(invariants.length ? { invariants } : {}),
    agents,
    rounds,
  };
  const parsed = DryRunRequest.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors[String(issue.path[0] ?? "description")] ??= issue.message;
    return { body: null, errors };
  }
  return { body: candidate as DryRunRequest, errors };
}

function Submit() {
  const wallet = useWalletSession();
  const navigate = useNavigate();
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ message: string; short: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [earlier, setEarlier] = useState<DryRunView[]>([]);
  const token = wallet.session?.token ?? null;
  const health = useHealth();
  const maxDecisions = health?.limits.maxDecisions ?? null;
  const set = (patch: Partial<Fields>) => setFields((current) => ({ ...current, ...patch }));

  const refresh = useCallback(() => {
    if (token) fetchDryRuns(token).then((answer) => setEarlier(answer.dryRuns), () => setEarlier([]));
  }, [token]);
  useEffect(refresh, [refresh]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const { body, errors: found } = toSubmission(fields, maxDecisions);
    setErrors(found);
    if (!body) return;
    const session = await wallet.ensureSession();
    if (!session) return;
    setBusy(true);
    try {
      const { dryRun } = await createDryRun(session.token, body);
      navigate(`/dryrun/${dryRun.runId}`);
    } catch (error) {
      const api = error instanceof ApiError ? error : null;
      setFailure({ message: api?.message ?? "The Dry Run could not be started.", short: api?.code === "insufficient_balance" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Dry Run</h1>
        <p>
          A crowd of synthetic users tries your contract before mainnet: newcomers, power users, an adversarial tester and whales. It runs in a private sandbox of its own, and the report is
          yours alone. You get what they ran into, and how to reproduce each thing. It is not an audit.
        </p>
      </header>

      <Reveal as="form" index={1} className={`${styles.form} stagger`} onSubmit={(event: FormEvent) => void submit(event)} noValidate>
        <fieldset className={styles.choice}>
          <legend>The contract</legend>
          <label>
            <input type="radio" name="target" checked={fields.target === "address"} onChange={() => set({ target: "address" })} /> Deployed on Robinhood Chain
          </label>
          <label>
            <input type="radio" name="target" checked={fields.target === "bytecode"} onChange={() => set({ target: "bytecode" })} /> Not deployed yet
          </label>
        </fieldset>
        {fields.target === "address" ? (
          <Field label="Contract address" error={errors.address} hint="Played on a private fork, so nothing touches the real contract.">
            {(props) => <input {...props} className="mono" value={fields.address} onChange={(e) => set({ address: e.target.value })} placeholder="0x…" />}
          </Field>
        ) : (
          <Field label="Creation bytecode" error={errors.bytecode} hint="At most 49,152 bytes. It only ever runs in this job's sandbox.">
            {(props) => <textarea {...props} className="mono" rows={4} value={fields.bytecode} onChange={(e) => set({ bytecode: e.target.value })} placeholder="0x6080…" />}
          </Field>
        )}
        <Field
          label={fields.target === "address" ? "ABI (optional if the contract is verified on Sourcify)" : "ABI"}
          error={errors.abi}
          hint="Users call its state-changing functions. Functions named like admin ones are kept out, and a stranger's wallet then tries each of them."
        >
          {(props) => <textarea {...props} className="mono" rows={4} value={fields.abi} onChange={(e) => set({ abi: e.target.value })} placeholder='[{"type":"function","name":"deposit",…}]' />}
        </Field>
        <Field label="What it does, in plain language" error={errors.description} hint="The crowd reads this, and nothing else, before it starts.">
          {(props) => <textarea {...props} rows={3} maxLength={2000} value={fields.description} onChange={(e) => set({ description: e.target.value })} placeholder="A savings vault. People deposit ETH and can withdraw it whenever they want." />}
        </Field>
        <Field label="Invariants (optional)" error={errors.invariants} hint="Names of view functions without arguments that must stay true, separated by commas. They are checked after every call.">
          {(props) => <input {...props} className="mono" value={fields.invariants} onChange={(e) => set({ invariants: e.target.value })} placeholder="isSolvent, totalsMatch" />}
        </Field>
        <div className={styles.row}>
          <Field label="Users" error={errors.agents}>
            {(props) => <input {...props} inputMode="numeric" value={fields.agents} onChange={(e) => set({ agents: e.target.value })} />}
          </Field>
          <Field label="Rounds" error={errors.rounds}>
            {(props) => <input {...props} inputMode="numeric" value={fields.rounds} onChange={(e) => set({ rounds: e.target.value })} />}
          </Field>
        </div>
        <BalancePrice health={health} size={dryRunSize(fields, maxDecisions)} token={token} />
        <PaymentsNote className={styles.small} />
        <div className={styles.actions}>
          <button type="submit" className="btn btn-primary" disabled={busy || wallet.busy !== null}>
            {wallet.busy === "connecting" ? "Connecting your wallet…" : wallet.busy === "signing" ? "Sign the message in your wallet…" : busy ? "Starting…" : "Start the Dry Run"}
          </button>
          <p className={styles.small}>
            If it fails, the price goes back to your <Link to="/account">prepaid balance</Link>.
          </p>
        </div>
      </Reveal>
      {/* After the form rather than in it, so it shows at once instead of waiting its turn in the entrance. */}
      {(failure || wallet.error) && (
        <p className={styles.error} role="alert">
          {failure?.message ?? wallet.error} {failure?.short && <Link to="/account">Top up</Link>}
        </p>
      )}

      {earlier.length > 0 && (
        <section className={styles.section} aria-labelledby="earlier">
          <h2 id="earlier">Your Dry Runs</h2>
          <Reveal as="ul" className={`${styles.list} stagger`}>
            {earlier.map((item) => (
              <li key={item.runId}>
                <Link to={`/dryrun/${item.runId}`} viewTransition>
                  {item.title}
                </Link>
                <span className={styles.small}>
                  {item.status} · {formatDate(item.queuedAt)} · {formatUsd(item.chargedUsd)}
                  {item.summary && ` · ${item.summary.findings.high} high, ${item.summary.findings.medium} medium`} · <span className="mono">{shortHash(item.runId, 8, 4)}</span>
                </span>
              </li>
            ))}
          </Reveal>
        </section>
      )}
    </article>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (props: { id: string; "aria-invalid": boolean }) => React.ReactNode;
}) {
  const id = `f-${label.replace(/[^a-z]/gi, "").toLowerCase()}`;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error) })}
      {hint && <span className={styles.small}>{hint}</span>}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
