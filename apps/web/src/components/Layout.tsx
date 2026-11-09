import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { Logomark } from "./Icons";
import styles from "./Layout.module.css";

type Theme = "light" | "dark";
const THEME_KEY = "hyvo.theme";
/** The public repository, once there is one (apps/web/.env.production). */
const SOURCE_URL = ((import.meta.env.VITE_SOURCE_URL as string | undefined) ?? "").trim();

/** Dark is the default; index.html applies a saved choice before the first paint. */
function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function Layout() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const location = useLocation();

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "dark") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Storage can be blocked; the choice then lasts for this page view.
    }
  }, [theme]);

  // A new page starts at the top, or at the section its #link names once that section has rendered
  // (a lazy page needs a moment to load).
  useEffect(() => {
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    let frame = 0;
    let tries = 0;
    const seek = () => {
      const target = document.getElementById(id);
      if (target) target.scrollIntoView({ block: "start" });
      else if (++tries < 180) frame = requestAnimationFrame(seek);
      else window.scrollTo({ top: 0, behavior: "instant" });
    };
    seek();
    return () => cancelAnimationFrame(frame);
  }, [location.pathname, location.hash]);

  return (
    <div className={styles.shell}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.header}>
        <div className={styles.bar}>
          <Link to="/" className={styles.mark} aria-label="Hyvo home" viewTransition>
            <Logomark />
            Hyvo
          </Link>
          <nav className={styles.nav} aria-label="Main">
            <NavLink to="/runs" className={styles.link} viewTransition>
              Runs
            </NavLink>
            <NavLink to="/tools" className={styles.link} viewTransition>
              Tools
            </NavLink>
            <NavLink to="/oracle" className={`${styles.link} ${styles.wideOnly}`} viewTransition>
              Oracle
            </NavLink>
            <NavLink to="/docs" className={styles.link} viewTransition>
              Docs
            </NavLink>
          </nav>
          <div className={styles.end}>
            <button
              type="button"
              className={styles.theme}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              aria-label={`Switch to the ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span key={theme} className={styles.themeIcon}>
                {theme === "dark" ? (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M13.500 9.800A5.600 5.600 0 0 1 6.200 2.500a5.600 5.600 0 1 0 7.300 7.300Z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="3.200" />
                    <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.400 1.400M11.600 11.600 13 13M3 13l1.400-1.400M11.600 4.400 13 3" />
                  </svg>
                )}
              </span>
            </button>
            <NavLink to="/new" className="btn btn-ghost btn-sm" viewTransition>
              <span className={styles.long}>Run a simulation</span>
              <span className={styles.short}>New run</span>
            </NavLink>
          </div>
        </div>
      </header>

      <main id="main" className={styles.main}>
        <Outlet />
      </main>

      <footer className={styles.footer}>
        <div className={styles.footMain}>
          <Link to="/" className={styles.mark} aria-label="Hyvo home" viewTransition>
            <Logomark size={18} />
            Hyvo
          </Link>
          <p>
            Hyvo runs synthetic crowds on a private fork of Robinhood Chain. Results are synthetic crowd reactions, not trading
            signals, and nothing here is financial advice.
          </p>
          <p>The engine builds on MiroFish and is licensed AGPL-3.0.</p>
        </div>
        <nav className={styles.footNav} aria-label="Footer">
          <Link to="/runs" viewTransition>
            Runs
          </Link>
          <Link to="/oracle" viewTransition>
            Oracle
          </Link>
          <Link to="/calibration" viewTransition>
            Calibration
          </Link>
          <Link to="/trust" viewTransition>
            Trust
          </Link>
          <Link to="/token" viewTransition>
            Token
          </Link>
          <Link to="/tools" viewTransition>
            Free tools
          </Link>
          <Link to="/new" viewTransition>
            Run a simulation
          </Link>
          <Link to="/dryrun" viewTransition>
            Dry Run
          </Link>
          <Link to="/clone" viewTransition>
            Wallet Clone
          </Link>
          <Link to="/rewind" viewTransition>
            Rewind
          </Link>
          <Link to="/docs" viewTransition>
            Docs
          </Link>
          <Link to="/account" viewTransition>
            API keys
          </Link>
          {SOURCE_URL && (
            <a href={SOURCE_URL} target="_blank" rel="noreferrer">
              Source
            </a>
          )}
        </nav>
      </footer>
    </div>
  );
}
