/** A run's price path for the gallery: start price, then each round. The color follows the
 * overall move. */
export function Sparkline({ values, width = 112, height = 28 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const line = values
    .map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 3 - ((v - min) / span) * (height - 6)).toFixed(1)}`)
    .join("");
  const up = values.at(-1)! >= values[0]!;
  const endY = height - 3 - ((values.at(-1)! - min) / span) * (height - 6);
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path className="spark-line" d={line} fill="none" stroke={up ? "var(--buy)" : "var(--sell)"} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" pathLength={1} />
      {/* Where the run ended: pops in once the line has drawn to it. */}
      <circle className="spark-end" cx={width - 1} cy={endY} r={1.75} fill={up ? "var(--buy)" : "var(--sell)"} />
    </svg>
  );
}
