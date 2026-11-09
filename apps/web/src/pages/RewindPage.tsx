import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Disclaimer } from "../components/Disclaimer";
import { PaymentsNote } from "../components/PaymentsNote";
import { Reveal } from "../components/Reveal";
import { useWalletSession, Web3 } from "../components/Web3";
import { ApiError, startRunFromBalance } from "../lib/api";
import { useTitle } from "../lib/use-title";
import styles from "./DryRunPage.module.css";

const ROUNDS = 10;
const AGENTS = 50;

export function RewindPage() {
  useTitle("Rewind");
  return (
    <Web3>
      <Rewind />
    </Web3>
  );
}

interface Fields {
  pool: string;
  block: string;
  hours: string;
  change: string;
  round: string;
  context: string;
}

type Errors = Partial<Record<keyof Fields, string>>;

export function checkFields(fields: Fields): Errors {
  const errors: Errors = {};
  if (!/^0x[0-9a-fA-F]{40}$/.test(fields.pool.trim())) errors.pool = "Use the pool's contract address, 0x and 40 hex digits.";
  if (!/^[1-9][0-9]*$/.test(fields.block.trim())) errors.block = "Use a block number.";
  const hours = Number(fields.hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 72) errors.hours = "Choose 1 to 72 hours.";
  const change = fields.change.trim();
  if (!change) errors.change = "Say the one thing that is different this time.";
  else if ([...change].length > 500) errors.change = "Keep it to 500 characters.";
  const round = Number(fields.round);
  if (!Number.isInteger(round) || round < 1 || round > ROUNDS) errors.round = `Choose a round from 1 to ${ROUNDS}.`;
  return errors;
}

function Rewind() {
  const wallet = useWalletSession();
  const navigate = useNavigate();
  const [fields, setFields] = useState<Fields>({ pool: "", block: "", hours: "6", change: "", round: "3", context: "" });
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<{ message: string; short: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Fields>) => setFields((current) => ({ ...current, ...patch }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const found = checkFields(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const session = await wallet.ensureSession();
    if (!session) return;
    setBusy(true);
    try {
      const block = Number(fields.block);
      const { runId } = await startRunFromBalance(session.token, {
        balance: true,
        rewind: { pool: fields.pool.trim(), block, hours: Number(fields.hours) },
        scenario: { title: `Rewind of block ${block.toLocaleString("en-US")}`, seedText: fields.context.trim(), events: [{ round: Number(fields.round), text: fields.change.trim() }] },
        agents: AGENTS,
        rounds: ROUNDS,
      });
      navigate(`/run/${runId}`);
    } catch (caught) {
      const api = caught instanceof ApiError ? caught : null;
      setFailure({ message: api?.message ?? "The rewind could not be started.", short: api?.code === "insufficient_balance" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={styles.page}>
      <header className={styles.head}>
        <h1>Rewind</h1>
        <p>
          Go back to a past block of a real pool, change one thing, and watch a crowd react. The pool's reserves at that block seed a private test market, and its result sits next to what actually
          happened afterwards, read from the chain.
        </p>
        <p className={styles.small}>It compares one run with one past. It does not forecast anything, and the run stays out of the gallery.</p>
      </header>

      <Reveal as="form" index={1} className={`${styles.form} stagger`} onSubmit={(event: FormEvent) => void submit(event)} noValidate>
        <Field label="Pool address" error={errors.pool} id="pool">
          <input id="pool" className="mono" value={fields.pool} onChange={(event) => set({ pool: event.target.value })} aria-invalid={Boolean(errors.pool)} placeholder="0x…" spellCheck={false} />
        </Field>
        <div className={styles.row}>
          <Field label="Block" error={errors.block} id="block">
            <input id="block" inputMode="numeric" value={fields.block} onChange={(event) => set({ block: event.target.value })} aria-invalid={Boolean(errors.block)} />
          </Field>
          <Field label="Hours to compare" error={errors.hours} id="hours">
            <input id="hours" inputMode="decimal" value={fields.hours} onChange={(event) => set({ hours: event.target.value })} aria-invalid={Boolean(errors.hours)} />
          </Field>
        </div>
        <Field label="What is different this time" error={errors.change} id="change">
          <textarea id="change" rows={3} value={fields.change} onChange={(event) => set({ change: event.target.value })} aria-invalid={Boolean(errors.change)} placeholder="The rumor about the team's wallet came two hours earlier." />
        </Field>
        <div className={styles.row}>
          <Field label={`In which round (1 to ${ROUNDS})`} error={errors.round} id="round">
            <input id="round" inputMode="numeric" value={fields.round} onChange={(event) => set({ round: event.target.value })} aria-invalid={Boolean(errors.round)} />
          </Field>
        </div>
        <Field label="What else the crowd should know (optional)" id="context">
          <textarea id="context" rows={3} value={fields.context} onChange={(event) => set({ context: event.target.value })} />
        </Field>
        <p className={styles.small}>
          Fifty agents and ten rounds, paid from your <Link to="/account">balance</Link>. Old blocks depend on what the public node still serves: if it cannot read yours, the run fails and the price goes back.
        </p>
        <PaymentsNote className={styles.small} />
        <div className={styles.actions}>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || wallet.busy !== null}>
            {busy ? "Starting…" : wallet.busy === "signing" ? "Sign the message in your wallet…" : "Start the rewind"}
          </button>
        </div>
      </Reveal>
      {/* After the form rather than in it, so it shows at once instead of waiting its turn in the entrance. */}
      {(failure || wallet.error) && (
        <p className={styles.error} role="alert">
          {failure?.message ?? wallet.error} {failure?.short && <Link to="/account">Top up</Link>}
        </p>
      )}
      <Disclaimer />
    </article>
  );
}

function Field({ label, error, id, children }: { label: string; error?: string | undefined; id: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
