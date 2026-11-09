import { Link } from "react-router";
import { Arrow } from "../../components/Icons";
import { Reveal } from "../../components/Reveal";
import { TOOLS, type ToolInfo } from "../../lib/tools";
import { useDescription, useTitle } from "../../lib/use-title";
import hub from "./ToolsPage.module.css";

const GROUPS: { title: ToolInfo["group"]; line: string }[] = [
  { title: "Calculators", line: "Pool math, worked out in your browser." },
  { title: "Guides", line: "What to ask, and what the words mean." },
  { title: "Just for fun", line: "" },
];

/** The free tools, for anyone launching or trading tokens. No wallet and no sign-in. */
export function ToolsPage() {
  useTitle("Free tools");
  useDescription("Free tools for token launches and trading: a swap and price impact calculator, impermanent loss, market cap, unit conversion, checklists, a glossary and a trader quiz.");
  return (
    <article className={hub.page}>
      <header className={hub.head}>
        <h1>Free tools</h1>
        <p>Calculators and guides for anyone launching or trading tokens. No wallet, no sign-in, and nothing to pay.</p>
      </header>
      {GROUPS.map((group) => (
        <section key={group.title} className={hub.group} aria-labelledby={`group-${group.title}`}>
          <div className={hub.groupHead}>
            <h2 id={`group-${group.title}`}>{group.title}</h2>
            {group.line && <p>{group.line}</p>}
          </div>
          <Reveal as="ul" className={`${hub.list} stagger`}>
            {TOOLS.filter((tool) => tool.group === group.title).map((tool) => (
              <li key={tool.to}>
                <Link to={tool.to} className="press" viewTransition>
                  <span className={hub.name}>{tool.name}</span>
                  <span className={hub.line}>{tool.line}</span>
                  <Arrow />
                </Link>
              </li>
            ))}
          </Reveal>
        </section>
      ))}
      <section className={hub.crowd} aria-labelledby="tools-crowd">
        <div>
          <h2 id="tools-crowd">The tools work on numbers. Hyvo works on a crowd.</h2>
          <p>
            Put a launch in front of synthetic traders on a private fork of Robinhood Chain, and watch them post and trade round by round before anything is live.
          </p>
        </div>
        <div className={hub.crowdLinks}>
          <Link to="/new" className="btn btn-primary" viewTransition>
            Run a simulation
          </Link>
          <Link to="/" className="arrow-link" viewTransition>
            Watch a published run <Arrow />
          </Link>
        </div>
      </section>
    </article>
  );
}
