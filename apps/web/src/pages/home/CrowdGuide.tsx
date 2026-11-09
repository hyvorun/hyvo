import { PERSONAS } from "@hyvo/schema";
import { useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router";
import { Arrow, PersonaIcon } from "../../components/Icons";
import { Reveal } from "../../components/Reveal";
import { PROFILES, type Archetype } from "../../lib/archetypes";
import styles from "./CrowdGuide.module.css";
import shared from "./Section.module.css";

/**
 * The ten archetypes a crowd is made of, one at a time: what each wants, how much risk it takes,
 * what it reacts to and how it posts. With a featured run, the list says how many of each sat in it.
 */
export function CrowdGuide({ seated }: { seated: Map<string, number> | null }) {
  const [active, setActive] = useState<Archetype>(PERSONAS[0]);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const profile = PROFILES[active];
  const anySeated = seated !== null && PERSONAS.some((id) => (seated.get(id) ?? 0) > 0);

  const pick = (index: number) => {
    const next = (index + PERSONAS.length) % PERSONAS.length;
    setActive(PERSONAS[next]!);
    tabs.current[next]?.focus();
  };

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // Leave the browser's own shortcuts alone, such as Alt+Left for back.
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const moves: Record<string, number> = { ArrowDown: index + 1, ArrowRight: index + 1, ArrowUp: index - 1, ArrowLeft: index - 1, Home: 0, End: PERSONAS.length - 1 };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    pick(next);
  };

  return (
    <section className={shared.section} aria-labelledby="crowd-title">
      <Reveal className={shared.head}>
        <h2 id="crowd-title">Ten kinds of trader. None of them real.</h2>
        <p>
          Each agent plays an archetype with its own goal, horizon and triggers, under a generated handle. A run can seat any mix of them, all reading
          one feed.
        </p>
      </Reveal>

      <Reveal className={styles.guide}>
        <div className={styles.side}>
          <div role="tablist" aria-label="Trader archetypes" aria-orientation="vertical" className={styles.list}>
            {PERSONAS.map((id, index) => {
              const count = seated?.get(id) ?? 0;
              return (
                <button
                  key={id}
                  ref={(element) => {
                    tabs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`archetype-${id}`}
                  aria-selected={active === id}
                  aria-controls="archetype-panel"
                  tabIndex={active === id ? 0 : -1}
                  className={styles.tab}
                  data-persona={id}
                  onClick={() => setActive(id)}
                  onKeyDown={(event) => onKey(event, index)}
                >
                  <span className={styles.tabIcon} aria-hidden="true">
                    <PersonaIcon persona={id} size={15} />
                  </span>
                  <span className={styles.name}>{PROFILES[id].label}</span>
                  {count > 0 && (
                    <span className={`${styles.count} num pop`}>
                      {count.toLocaleString("en-US")}
                      <span className="visually-hidden"> in the run above</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {anySeated && <p className={styles.legend}>A number marks how many sat in the run above.</p>}
        </div>

        <div role="tabpanel" id="archetype-panel" aria-labelledby={`archetype-${active}`} className={styles.panel} tabIndex={0}>
          <div key={active} className={styles.panelBody}>
            <div className={styles.panelHead}>
              <span className={styles.panelIcon} data-persona={active} aria-hidden="true">
                <PersonaIcon persona={active} size={20} />
              </span>
              <div>
                <h3>{profile.label}</h3>
                <p>{profile.line}</p>
              </div>
            </div>
            <dl className={styles.traits}>
              <div>
                <dt>Wants</dt>
                <dd>{profile.goal}</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd>{profile.risk}</dd>
              </div>
              <div>
                <dt>Horizon</dt>
                <dd>{profile.horizon}</dd>
              </div>
              <div>
                <dt>Reacts to</dt>
                <dd>
                  <ul>
                    {profile.reactsTo.map((trigger) => (
                      <li key={trigger}>{trigger}</li>
                    ))}
                  </ul>
                </dd>
              </div>
              <div>
                <dt>Posts</dt>
                <dd>{profile.posts}</dd>
              </div>
            </dl>
          </div>
        </div>
      </Reveal>

      <div className={shared.links}>
        <Link to="/tools/quiz" className="arrow-link" viewTransition>
          Which trader are you? Ten questions <Arrow />
        </Link>
        <Link to="/new" className="arrow-link" viewTransition>
          Choose the mix for a run <Arrow />
        </Link>
      </div>
    </section>
  );
}
