import { useEffect } from "react";

const SITE_TITLE = "Hyvo: launch it in a parallel world first";

/**
 * The page's description while it is open, for search engines that run scripts. Leaving the page
 * puts the site's description back.
 */
export function useDescription(text: string): void {
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!meta) return;
    const before = meta.content;
    meta.content = text;
    return () => {
      meta.content = before;
    };
  }, [text]);
}

/** The browser tab says which page this is; leaving the page puts the site's title back. */
export function useTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · Hyvo`;
    return () => {
      document.title = SITE_TITLE;
    };
  }, [title]);
}
