import { Link, useRouteError } from "react-router";
import { Failure } from "../components/States";
import { Arrow } from "../components/Icons";
import { useTitle } from "../lib/use-title";
import styles from "./pages.module.css";

/** A page that failed to load or crashed. The usual cause: the site was updated while this tab was open. */
export function PageError() {
  const error = useRouteError();
  useTitle("Something went wrong");
  console.error(error);
  return (
    <section className={styles.lost}>
      <header className={styles.pageHead}>
        <h1>This page could not be shown</h1>
        <p>The site may have been updated while this tab was open. Reloading usually fixes it.</p>
      </header>
      <Failure message="The page did not load." onRetry={() => window.location.reload()} />
      <Link to="/runs" className="arrow-link" viewTransition>
        Browse runs <Arrow />
      </Link>
    </section>
  );
}

export function NotFoundPage() {
  useTitle("Page not found");
  return (
    <section className={styles.lost}>
      <header className={styles.pageHead}>
        <h1>This page does not exist</h1>
        <p>The link may be mistyped, or the page has moved.</p>
      </header>
      <Link to="/runs" className="arrow-link" viewTransition>
        Browse runs <Arrow />
      </Link>
    </section>
  );
}
