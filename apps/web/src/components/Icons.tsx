/*
 * Hyvo's mark, the Seal: ticks hung inward from a circle around a center dot, one per hex digit of
 * keccak256("Hyvo") = 0x1c91e60e...f5a1, clockwise from twelve o'clock, 0 the shortest and f the
 * longest. Below 40 px it draws one tick per byte instead, so the ticks stay apart. Generated from
 * the hash; the favicon, the touch icon and the share image use the same paths.
 */
const SEAL_64 = "M51.15 4L48.85 4L48.85 9.8L51.15 9.8ZM55.65 4.33L53.36 4.11L51.93 18.64L54.22 18.86ZM60.1 5.11L57.85 4.66L55.47 16.63L57.72 17.07ZM64.45 6.31L62.25 5.65L60.57 11.2L62.77 11.86ZM68.67 7.94L66.54 7.06L60.34 22.03L62.47 22.91ZM72.7 9.97L70.67 8.89L66.05 17.53L68.08 18.62ZM76.51 12.39L74.6 11.11L71.82 15.27L73.73 16.55ZM80.07 15.17L78.29 13.71L68.02 26.23L69.79 27.69ZM83.34 18.29L81.71 16.66L73.09 25.29L74.71 26.91ZM86.29 21.71L84.83 19.93L76.64 26.65L78.09 28.43ZM88.89 25.4L87.61 23.49L77.46 30.27L78.74 32.18ZM91.11 29.33L90.03 27.3L77.86 33.81L78.94 35.84ZM92.94 33.46L92.06 31.33L84.48 34.47L85.36 36.6ZM94.35 37.75L93.69 35.55L85.07 38.16L85.74 40.36ZM95.34 42.15L94.89 39.9L79.79 42.9L80.24 45.16ZM95.89 46.64L95.67 44.35L89.89 44.92L90.12 47.2ZM96 51.15L96 48.85L89.4 48.85L89.4 51.15ZM95.67 55.65L95.89 53.36L88.53 52.64L88.3 54.93ZM94.89 60.1L95.34 57.85L82.59 55.31L82.14 57.57ZM93.69 64.45L94.35 62.25L85.74 59.64L85.07 61.84ZM92.06 68.67L92.94 66.54L80.19 61.26L79.31 63.38ZM90.03 72.7L91.11 70.67L77.53 63.41L76.44 65.44ZM87.61 76.51L88.89 74.6L84.06 71.38L82.79 73.29ZM84.83 80.07L86.29 78.29L79.33 72.58L77.87 74.36ZM81.71 83.34L83.34 81.71L79.24 77.61L77.61 79.24ZM78.29 86.29L80.07 84.83L71.82 74.78L70.05 76.24ZM74.6 88.89L76.51 87.61L67.51 74.14L65.6 75.42ZM70.67 91.11L72.7 90.03L68.46 82.09L66.43 83.17ZM66.54 92.94L68.67 92.06L64.61 82.27L62.48 83.15ZM62.25 94.35L64.45 93.69L61.38 83.54L59.18 84.21ZM57.85 95.34L60.1 94.89L58.35 86.06L56.09 86.51ZM53.36 95.89L55.65 95.67L54.93 88.3L52.64 88.53ZM48.85 96L51.15 96L51.15 80.6L48.85 80.6ZM44.35 95.67L46.64 95.89L47.13 90.92L44.84 90.69ZM39.9 94.89L42.15 95.34L44.85 81.81L42.59 81.36ZM35.55 93.69L37.75 94.35L41.29 82.68L39.09 82.01ZM31.33 92.06L33.46 92.94L38.13 81.67L36 80.79ZM27.3 90.03L29.33 91.11L37.34 76.12L35.32 75.03ZM23.49 87.61L25.4 88.89L28.18 84.73L26.27 83.45ZM19.93 84.83L21.71 86.29L31.98 73.77L30.21 72.31ZM16.66 81.71L18.29 83.34L30.31 71.32L28.68 69.69ZM13.71 78.29L15.17 80.07L27.69 69.79L26.23 68.02ZM11.11 74.6L12.39 76.51L21.87 70.18L20.59 68.27ZM8.89 70.67L9.97 72.7L22.14 66.19L21.06 64.16ZM7.06 66.54L7.94 68.67L17.73 64.61L16.85 62.48ZM5.65 62.25L6.31 64.45L12.63 62.54L11.96 60.34ZM4.66 57.85L5.11 60.1L13.94 58.35L13.49 56.09ZM4.11 53.36L4.33 55.65L9.31 55.16L9.08 52.87ZM4 48.85L4 51.15L21 51.15L21 48.85ZM4.33 44.35L4.11 46.64L15.45 47.75L15.68 45.46ZM5.11 39.9L4.66 42.15L11.92 43.6L12.37 41.34ZM6.31 35.55L5.65 37.75L15.79 40.82L16.46 38.62ZM7.94 31.33L7.06 33.46L19.07 38.43L19.95 36.31ZM9.97 27.3L8.89 29.33L14.71 32.44L15.79 30.41ZM12.39 23.49L11.11 25.4L20.59 31.73L21.87 29.82ZM15.17 19.93L13.71 21.71L20.67 27.42L22.13 25.64ZM18.29 16.66L16.66 18.29L25.85 27.48L27.48 25.85ZM21.71 13.71L19.93 15.17L26.65 23.36L28.43 21.91ZM25.4 11.11L23.49 12.39L32.04 25.2L33.96 23.92ZM29.33 8.89L27.3 9.97L31.92 18.62L33.95 17.53ZM33.46 7.06L31.33 7.94L37.84 23.65L39.96 22.77ZM37.75 5.65L35.55 6.31L38.16 14.93L40.36 14.26ZM42.15 4.66L39.9 5.11L42.43 17.86L44.69 17.41ZM46.64 4.11L44.35 4.33L44.92 10.11L47.2 9.88Z";
const SEAL_32 = "M51.8 4L48.2 4L48.2 11.65L51.8 11.65ZM60.74 5.24L57.21 4.53L54.37 18.78L57.91 19.49ZM69.27 8.19L65.94 6.81L58.47 24.86L61.79 26.23ZM77.05 12.75L74.06 10.75L70.27 16.43L73.26 18.43ZM83.8 18.75L81.25 16.2L70.73 26.72L73.28 29.27ZM89.25 25.94L87.25 22.95L74.68 31.35L76.68 34.34ZM93.19 34.06L91.81 30.73L82.52 34.58L83.89 37.91ZM95.47 42.79L94.76 39.26L76.82 42.83L77.52 46.36ZM96 51.8L96 48.2L87.94 48.2L87.94 51.8ZM94.76 60.74L95.47 57.21L80.06 54.14L79.36 57.68ZM91.81 69.27L93.19 65.94L77.37 59.39L75.99 62.72ZM87.25 77.05L89.25 74.06L83.23 70.04L81.23 73.03ZM81.25 83.8L83.8 81.25L78.48 75.93L75.93 78.48ZM74.06 89.25L77.05 87.25L66.24 71.06L63.24 73.06ZM65.94 93.19L69.27 91.81L64.29 79.8L60.97 81.18ZM57.21 95.47L60.74 94.76L58.62 84.09L55.09 84.79ZM48.2 96L51.8 96L51.8 77.76L48.2 77.76ZM39.26 94.76L42.79 95.47L46.08 78.91L42.55 78.21ZM30.73 91.81L34.06 93.19L39.93 79L36.61 77.63ZM22.95 87.25L25.94 89.25L29.73 83.57L26.74 81.57ZM16.2 81.25L18.75 83.8L33.55 68.99L31.01 66.45ZM10.75 74.06L12.75 77.05L24.54 69.18L22.54 66.18ZM6.81 65.94L8.19 69.27L19.93 64.4L18.55 61.08ZM4.53 57.21L5.24 60.74L15.74 58.65L15.03 55.12ZM4 48.2L4 51.8L24.59 51.8L24.59 48.2ZM5.24 39.26L4.53 42.79L13.59 44.59L14.29 41.06ZM8.19 30.73L6.81 34.06L21.16 40L22.54 36.68ZM12.75 22.95L10.75 25.94L22.25 33.62L24.25 30.63ZM18.75 16.2L16.2 18.75L27.39 29.93L29.93 27.39ZM25.94 10.75L22.95 12.75L33.27 28.21L36.27 26.21ZM34.06 6.81L30.73 8.19L38.54 27.05L41.87 25.67ZM42.79 4.53L39.26 5.24L42.28 20.41L45.81 19.71Z";

/** The seal. Its ring of ticks and its center dot carry classes (ui.css) so a hover can turn or pulse them. */
export function Logomark({ size = 20, className }: { size?: number; className?: string | undefined }) {
  const large = size >= 40;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className ? `logomark ${className}` : "logomark"} aria-hidden="true">
      <path className="seal-ticks" d={large ? SEAL_64 : SEAL_32} fill="currentColor" />
      <circle className="seal-dot" cx="50" cy="50" r={large ? 7 : 8.5} fill="currentColor" />
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
