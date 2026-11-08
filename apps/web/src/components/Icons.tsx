/** Hyvo's mark: one dot of the crowd, part full. */
export function Logomark({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <circle cx="10" cy="10" r="8.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.2 11.5a8 8 0 0 0 15.6 0Z" fill="currentColor" />
    </svg>
  );
}

/** One small mark per kind of trader, so a feed reads at a glance without more color. */
export function PersonaIcon({ persona, size = 14 }: { persona: string; size?: number }) {
  const common = {
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.25,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
  switch (persona) {
    case "sniper":
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4.4" />
          <path d="M8 1.2v3.2M8 11.6v3.2M1.2 8h3.2M11.6 8h3.2" />
        </svg>
      );
    case "holder":
      return (
        <svg {...common}>
          <path d="M4.6 2.6h6.8L14.4 6.4 8 13.8 1.6 6.4Z" />
          <path d="M1.6 6.4h12.8" />
        </svg>
      );
    case "panic_seller":
      return (
        <svg {...common}>
          <path d="M9.2 1.4 3.4 9h4.1l-.9 5.6L12.6 7H8.4Z" />
        </svg>
      );
    case "skeptic":
      return (
        <svg {...common}>
          <path d="M1.4 8s2.5-4.6 6.6-4.6S14.6 8 14.6 8s-2.5 4.6-6.6 4.6S1.4 8 1.4 8Z" />
          <circle cx="8" cy="8" r="1.9" />
        </svg>
      );
    case "swing_trader":
      return (
        <svg {...common}>
          <path d="M1.4 11.2 5 6.2l3.2 3.6 3.2-5.4 3.2 3.2" />
        </svg>
      );
    case "whale":
      return (
        <svg {...common}>
          <path d="M1.6 8.6c0 2.9 2.5 4.6 5.8 4.6 3.9 0 6.2-2.5 6.2-5.4V4.2" />
          <path d="M1.6 8.6h7.2c1.7 0 3-1.3 3-3" />
          <path d="M13.6 4.2 11.8 2.6M13.6 4.2l1.6-1.6" />
        </svg>
      );
    case "kol_follower":
      return (
        <svg {...common}>
          <path d="M2 6.4v3.2h2.2l4.6 3V3.4L4.2 6.4Z" />
          <path d="M11.2 6a3 3 0 0 1 0 4M13.2 4.4a5.4 5.4 0 0 1 0 7.2" />
        </svg>
      );
    case "market_maker_bot":
      return (
        <svg {...common}>
          <path d="M2 5.4h10.6M10.2 3l2.4 2.4-2.4 2.4" />
          <path d="M14 10.6H3.4M5.8 8.2l-2.4 2.4L5.8 13" />
        </svg>
      );
    case "stock_token_holder":
      return (
        <svg {...common}>
          <path d="M2 14h12" />
          <path d="M4 11.4V8M8 11.4V4.4M12 11.4V6.4" />
        </svg>
      );
    case "clone":
      return (
        <svg {...common}>
          <circle cx="6" cy="8" r="4" />
          <circle cx="10" cy="8" r="4" />
        </svg>
      );
    case "newcomer":
      return (
        <svg {...common}>
          <path d="M8 14V7.4" />
          <path d="M8 8.6C8 5.8 5.8 4.6 3 4.6c0 2.8 2 4 5 4Z" />
          <path d="M8 7.2c0-2.8 2-4.6 5-4.6 0 3-2 4.6-5 4.6Z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" />
        </svg>
      );
  }
}

export function Arrow() {
  return (
    <svg className="arrow" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.500 8h11M9 3.500 13.500 8 9 12.500" />
    </svg>
  );
}

export function CheckMark({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.600 6.400 12 13 4.600" pathLength={1} className="draw" />
    </svg>
  );
}
