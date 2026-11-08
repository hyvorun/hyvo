import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { Arrow } from "../../components/Icons";
import { TOOLS } from "../../lib/tools";
import { useTitle } from "../../lib/use-title";
import styles from "./Tools.module.css";

export { useDescription } from "../../lib/use-title";

/** The page around a tool: where it sits, its name, what it does, and the other tools below it. */
export function ToolPage({ to, title, lede, children }: { to: string; title: string; lede: ReactNode; children: ReactNode }) {
  useTitle(title);
  const others = TOOLS.filter((tool) => tool.to !== to);
  return (
    <article className={styles.page}>
      <nav className={styles.crumbs} aria-label="Breadcrumb">
        <Link to="/tools" viewTransition>
          Tools
        </Link>
        <span aria-hidden="true">/</span>
        <span>{title}</span>
      </nav>
      <header className={styles.head}>
        <h1>{title}</h1>
        <p>{lede}</p>
      </header>
      {children}
      <nav className={styles.others} aria-label="More tools">
        <h2>More tools</h2>
        <ul>
          {others.map((tool) => (
            <li key={tool.to}>
              <Link to={tool.to} viewTransition>
                <span>{tool.name}</span>
                <Arrow />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </article>
  );
}

/** A labelled text input for a number, with a hint and an error under it. */
export function NumberField({
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  suffix,
  inputMode = "decimal",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  suffix?: string;
  inputMode?: "decimal" | "numeric" | "text";
}) {
  const id = useId();
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <div className={styles.control}>
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          inputMode={inputMode}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          aria-invalid={Boolean(error)}
          {...(described ? { "aria-describedby": described } : {})}
        />
        {suffix && (
          <span className={styles.suffix} aria-hidden="true">
            {suffix}
          </span>
        )}
      </div>
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

/**
 * Inputs that start from the address and are written back to it once typing pauses, so a
 * calculation can be shared as a link. The inputs themselves live in React state: binding them to
 * the address directly would send every keystroke through the router. A value equal to its default
 * stays out of the address, and writing replaces the history entry instead of adding one.
 */
export function useQueryState<K extends string>(defaults: Record<K, string>): [Record<K, string>, (patch: Partial<Record<K, string>>) => void] {
  const [params, setParams] = useSearchParams();
  const [state, setState] = useState(
    () => Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback])) as Record<K, string>,
  );
  const latest = useRef({ params, setParams, defaults });
  latest.current = { params, setParams, defaults };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const { params, setParams, defaults } = latest.current;
      const next = new URLSearchParams(params);
      for (const [key, value] of Object.entries(state) as [K, string][]) {
        if (value === defaults[key]) next.delete(key);
        else next.set(key, value);
      }
      if (next.toString() !== params.toString()) setParams(next, { replace: true, preventScrollReset: true });
    }, 450);
    return () => window.clearTimeout(timer);
  }, [state]);

  return [state, (patch) => setState((current) => ({ ...current, ...patch }))];
}

/** The line every calculator ends with. */
export function ArithmeticNote({ children }: { children?: ReactNode }) {
  return (
    <p className={styles.fine}>
      {children} Arithmetic only: it is not advice, and it says nothing about where a price goes next. It runs in your browser.
    </p>
  );
}
