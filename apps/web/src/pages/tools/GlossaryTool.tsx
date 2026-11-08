import { useEffect, useId, useState } from "react";
import { Link, useLocation } from "react-router";
import { TERMS, type Term } from "../../lib/glossary";
import { ToolPage, useDescription } from "./shared";
import glossary from "./Glossary.module.css";

const SORTED = [...TERMS].sort((a, b) => a.term.localeCompare(b.term, "en", { sensitivity: "base" }));

function letterOf(term: Term): string {
  const first = term.term[0]?.toUpperCase() ?? "#";
  return /[A-Z]/.test(first) ? first : "#";
}

export function GlossaryTool() {
  useDescription("A plain-language glossary of token launch and trading words: price impact, slippage, impermanent loss, rug pull, market cap and more.");
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const location = useLocation();
  const inputId = useId();

  // A link to one term (/tools/glossary#slippage) lands on it, after the layout's scroll to the top.
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id || !TERMS.some((term) => term.id === id)) return;
    setFilter("");
    setTarget(id);
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "center" }));
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash]);

  const query = filter.trim().toLowerCase();
  const shown = query ? SORTED.filter((term) => `${term.term} ${term.definition}`.toLowerCase().includes(query)) : SORTED;
  const letters = [...new Set(shown.map(letterOf))];

  return (
    <ToolPage
      to="/tools/glossary"
      title="Glossary"
      lede="The words that come up around token launches and trading, in plain language. Terms marked Hyvo are this site's own."
    >
      <div className={glossary.tools}>
        <div className={glossary.search}>
          <label htmlFor={inputId}>Find a term</label>
          <input
            id={inputId}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="slippage, rug pull, gwei…"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p className={glossary.count} role="status">
          {shown.length === SORTED.length ? `${SORTED.length} terms` : `${shown.length} of ${SORTED.length} terms`}
        </p>
      </div>

      {!query && (
        <nav className={glossary.letters} aria-label="Letters">
          {letters.map((letter) => (
            <a key={letter} href={`#letter-${letter}`}>
              {letter}
            </a>
          ))}
        </nav>
      )}

      {shown.length === 0 ? (
        <p className={glossary.none}>No term matches “{filter.trim()}”.</p>
      ) : (
        <div className={glossary.list}>
          {letters.map((letter) => (
            <section key={letter} id={`letter-${letter}`} className={glossary.section} aria-label={letter}>
              <h2 aria-hidden="true">{letter}</h2>
              <dl>
                {shown
                  .filter((term) => letterOf(term) === letter)
                  .map((term) => (
                    <div key={term.id} id={term.id} className={glossary.term} data-target={term.id === target}>
                      <dt>
                        {term.term}
                        {term.hyvo && <span className={glossary.tag}>Hyvo</span>}
                        <a className={glossary.anchor} href={`#${term.id}`} aria-label={`Link to ${term.term}`}>
                          #
                        </a>
                      </dt>
                      <dd>
                        {term.definition}
                        {term.link && (
                          <>
                            {" "}
                            <Link to={term.link.to} viewTransition>
                              {term.link.label}
                            </Link>
                          </>
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </ToolPage>
  );
}
