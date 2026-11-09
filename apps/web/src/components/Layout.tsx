import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { HYVO_TOKEN, OFFICIAL } from "../lib/official";
import { CheckMark, Logomark } from "./Icons";
import styles from "./Layout.module.css";
import { useNavIndicator } from "./motion/use-nav-indicator";
import { useScrolled } from "./motion/use-scrolled";
import { prefersReducedMotion } from "./use-playback";

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

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    if (theme === "dark") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked; the choice then lasts for this page view.
  }
}

type TransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * The header's links, in order. Runs, Check, Launches and Stocks show at every width. Where the bar
 * runs short of room the others give way (the footer has them all): `wide` links show from 900px,
 * `roomy` ones wherever the bar has room for them, which on a phone is its sideways scroll.
 */
const NAV: { to: string; label: string; show?: "wide" | "roomy" }[] = [
  { to: "/runs", label: "Runs" },
  { to: "/check", label: "Check" },
  { to: "/launches", label: "Launches" },
  { to: "/stocks", label: "Stocks" },
  { to: "/tools", label: "Tools", show: "roomy" },
  { to: "/oracle", label: "Oracle", show: "wide" },
  { to: "/docs", label: "Docs", show: "roomy" },
];
const SHOW = { wide: styles.wideOnly, roomy: styles.roomy };

export function Layout() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  // The icon animates only when the theme is switched, not on the first paint.
  const [switched, setSwitched] = useState(false);
  const location = useLocation();
  const scrolled = useScrolled();
  const nav = useRef<HTMLElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  useNavIndicator(nav, line, location.pathname);

  // On a phone too narrow for every link, the nav scrolls sideways: bring the current page's link into
  // it, with a little of its neighbor showing so the row still reads as one that scrolls. The first
  // page lands there at once; after that the row glides, unless the viewer prefers reduced motion.
  const navPath = useRef<string | null>(null);
  useEffect(() => {
    const bar = nav.current;
    const active = bar?.querySelector<HTMLElement>("a.active");
    const glide = navPath.current !== null && navPath.current !== location.pathname && !prefersReducedMotion();
    navPath.current = location.pathname;
    if (!bar || !active || bar.scrollWidth <= bar.clientWidth) return;
    const room = bar.getBoundingClientRect();
    const link = active.getBoundingClientRect();
    const margin = Math.min(28, Math.max(0, (room.width - link.width) / 2));
    let left = bar.scrollLeft;
    if (link.left < room.left + margin) left -= room.left + margin - link.left;
    else if (link.right > room.right - margin) left += link.right - (room.right - margin);
    if (left !== bar.scrollLeft) bar.scrollTo({ left, behavior: glide ? "smooth" : "instant" });
  }, [location.pathname]);

  useEffect(() => applyTheme(theme), [theme]);

  /** Where the browser can, the whole page cross-fades into the other theme. */
  const switchTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const doc = document as TransitionDocument;
    const update = () => {
      setSwitched(true);
      setTheme(next);
    };
    if (typeof doc.startViewTransition !== "function" || prefersReducedMotion()) return update();
    const root = document.documentElement;
    root.dataset.switching = "theme";
    const done = () => delete root.dataset.switching;
    doc
      .startViewTransition(() => {
        flushSync(update);
        applyTheme(next);
      })
      .finished.then(done, done);
  };

  // A new page starts at the top, or at the section its #link names once that section has rendered
  // (a lazy page needs a moment to load). A #link within the same page glides there (base.css makes
  // scrolling smooth unless the viewer prefers reduced motion); a new page lands on it at once.
  const lastPath = useRef<string | null>(null);
  useEffect(() => {
    const samePage = lastPath.current === location.pathname;
    lastPath.current = location.pathname;
    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) {
      window.scrollTo({ top: 0, behavior: "instant" });
      return;
    }
    let frame = 0;
    let tries = 0;
    const seek = () => {
      const target = document.getElementById(id);
      if (target) target.scrollIntoView(samePage ? { block: "start" } : { block: "start", behavior: "instant" });
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
      <header className={styles.header} data-scrolled={scrolled}>
        <div className={styles.bar}>
          <Link to="/" className={styles.mark} aria-label="Hyvo home" viewTransition>
            <Logomark />
            <span className={styles.word}>Hyvo</span>
          </Link>
          <nav ref={nav} className={styles.nav} aria-label="Main">
            <span ref={line} className={styles.indicator} aria-hidden="true" />
            {NAV.map((item) => (
              <NavLink key={item.to} to={item.to} className={item.show ? `${styles.link} ${SHOW[item.show]}` : styles.link} viewTransition>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className={styles.end}>
            {HYVO_TOKEN && <TokenAddress address={HYVO_TOKEN.address} />}
            <a className={styles.social} href={OFFICIAL.x.url} target="_blank" rel="noreferrer" aria-label={`Hyvo on X, ${OFFICIAL.x.handle}`}>
              <XMark />
              <span className={styles.handle}>{OFFICIAL.x.handle}</span>
            </a>
            <button
              type="button"
              className={styles.theme}
              onClick={switchTheme}
              aria-label={`Switch to the ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span key={theme} className={`${styles.themeIcon} ${switched ? styles.swap : ""}`}>
                {theme === "dark" ? (
                  <svg viewBox="0 0 16 16" className={styles.moon} aria-hidden="true">
                    <path d="M13.500 9.800A5.600 5.600 0 0 1 6.200 2.500a5.600 5.600 0 1 0 7.300 7.300Z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" className={styles.sun} aria-hidden="true">
                    <circle className={styles.core} cx="8" cy="8" r="3.200" />
                    <path className={styles.rays} d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.400 1.400M11.600 11.600 13 13M3 13l1.400-1.400M11.600 4.400 13 3" />
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
        <span className={styles.read} aria-hidden="true" />
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
          <Link to="/check" viewTransition>
            Hyvo Check
          </Link>
          <Link to="/launches" viewTransition>
            Launches
          </Link>
          <Link to="/watchlist" viewTransition>
            Watchlist
          </Link>
          <Link to="/track" viewTransition>
            Track
          </Link>
          <Link to="/stocks" viewTransition>
            Stocks
          </Link>
          <Link to="/tools" viewTransition>
            Free tools
          </Link>
          <Link to="/oracle" viewTransition>
            Oracle
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
          <Link to="/calibration" viewTransition>
            Calibration
          </Link>
          <Link to="/docs" viewTransition>
            Docs
          </Link>
          <Link to="/account" viewTransition>
            API keys
          </Link>
          <Link to="/trust" viewTransition>
            Trust
          </Link>
          <Link to="/token" viewTransition>
            Token
          </Link>
          <a href={OFFICIAL.x.url} target="_blank" rel="noreferrer">
            X ({OFFICIAL.x.handle})
          </a>
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

/**
 * HYVO's address in the header, beside the X link: one press copies it, the full address is in its title, and
 * without a clipboard it opens /token. Shown only once the token has launched.
 */
function TokenAddress({ address }: { address: string }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      navigate("/token");
    }
  };
  return (
    <button type="button" className={styles.ca} onClick={copy} title={address} aria-label={`Copy HYVO's address, ${address}`}>
      <span className={styles.caLabel}>CA</span>
      <span className={`mono ${styles.caAddr}`}>
        {address.slice(0, 6)}…{address.slice(-4)}
      </span>
      {copied ? (
        <span className="pop" aria-hidden="true">
          <CheckMark size={13} />
        </span>
      ) : (
        <CopyIcon />
      )}
      <span className="visually-hidden" role="status">
        {copied ? "Copied HYVO's address" : ""}
      </span>
    </button>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
      <path d="M10.5 3.6V3.2a1.6 1.6 0 0 0-1.6-1.6H3.6A1.6 1.6 0 0 0 2 3.2v5.3a1.6 1.6 0 0 0 1.6 1.6H4" />
    </svg>
  );
}

/** The X logo, for the link to Hyvo's official account. */
function XMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}
