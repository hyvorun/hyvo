import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CHECKLISTS, type Checklist } from "../../lib/checklists";
import { ToolPage, useDescription } from "./shared";
import list from "./Checklist.module.css";
import styles from "./Tools.module.css";

const STORAGE_KEY = "hyvo.checklists";

/** Ticked items, kept in this browser only. Storage can be blocked: the list then works for this visit. */
function useTicks(): [Set<string>, (id: string, on: boolean) => void, (ids: string[]) => void] {
  const [ticks, setTicks] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
      return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...ticks]));
    } catch {
      // Blocked storage: nothing to keep.
    }
  }, [ticks]);
  const toggle = (id: string, on: boolean) =>
    setTicks((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const clear = (ids: string[]) =>
    setTicks((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  return [ticks, toggle, clear];
}

export function ChecklistTool() {
  useDescription("Free checklists: what to settle before launching a token, and questions to answer before trading a new one.");
  const [params, setParams] = useSearchParams();
  const active = CHECKLISTS.find((checklist) => checklist.id === params.get("list")) ?? CHECKLISTS[0]!;
  const [ticks, toggle, clear] = useTicks();

  return (
    <ToolPage
      to="/tools/checklist"
      title="Checklists"
      lede="What to settle before you launch a token, and what to ask before you trade a new one. Your ticks stay in this browser."
    >
      <div className={`${styles.seg} ${list.switch}`} role="radiogroup" aria-label="Checklist">
        {CHECKLISTS.map((checklist) => (
          <button
            key={checklist.id}
            type="button"
            role="radio"
            aria-checked={checklist.id === active.id}
            onClick={() => setParams(checklist.id === CHECKLISTS[0]!.id ? {} : { list: checklist.id }, { replace: true, preventScrollReset: true })}
          >
            {checklist.id === "launch" ? "Launching a token" : "Trading a new token"}
          </button>
        ))}
      </div>
      <List checklist={active} ticks={ticks} onToggle={toggle} onClear={clear} />
    </ToolPage>
  );
}

function List({
  checklist,
  ticks,
  onToggle,
  onClear,
}: {
  checklist: Checklist;
  ticks: Set<string>;
  onToggle: (id: string, on: boolean) => void;
  onClear: (ids: string[]) => void;
}) {
  const ids = checklist.groups.flatMap((group) => group.items.map((item) => item.id));
  const done = ids.filter((id) => ticks.has(id)).length;
  return (
    <section aria-labelledby={`list-${checklist.id}`} className={list.panel}>
      <header className={list.head}>
        <div>
          <h2 id={`list-${checklist.id}`}>{checklist.title}</h2>
          <p>{checklist.lede}</p>
        </div>
        <div className={list.count}>
          <span className="num" role="status">
            {done} of {ids.length} done
          </span>
          <span className={list.bar} aria-hidden="true">
            <i style={{ width: `${(done / ids.length) * 100}%` }} />
          </span>
          {done > 0 && (
            <button type="button" className={list.clear} onClick={() => onClear(ids)}>
              Clear
            </button>
          )}
        </div>
      </header>
      {checklist.groups.map((group) => (
        <fieldset key={group.title} className={list.group}>
          <legend>{group.title}</legend>
          <ul>
            {group.items.map((item) => (
              <li key={item.id} data-done={ticks.has(item.id)}>
                <label>
                  <span className={list.check}>
                    <input type="checkbox" checked={ticks.has(item.id)} onChange={(event) => onToggle(item.id, event.target.checked)} />
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M3.6 8.4 6.6 11.4 12.4 5" pathLength={1} />
                    </svg>
                  </span>
                  <span className={list.text}>
                    <b>{item.text}</b>
                    <span>{item.detail}</span>
                  </span>
                </label>
                {item.link && (
                  <Link to={item.link.to} className={list.link} viewTransition>
                    {item.link.label}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
      <p className={styles.fine}>
        {checklist.id === "trade"
          ? "These questions do not tell you what to do, and answering all of them does not make a token safe. Nothing here is advice."
          : "General practice, not legal advice. Rules on promoting tokens differ from country to country."}
      </p>
    </section>
  );
}
