// Hand-rolled SVG bar chart for /lawn/insights. No chart library (the app's
// stance is minimal deps; GanttChart.tsx is the inline-SVG precedent). Renders
// vertical bars, optionally stacked (pass multiple segments per bar). Pure
// markup — no "use client" — so it can be used directly in the server insights
// page. Responsive via viewBox + preserveAspectRatio="xMidYMid meet".

export type BarSegment = { value: number; color?: string; name?: string };
export type BarDatum = { label: string; segments: BarSegment[] };

type Props = {
  data: BarDatum[];
  height?: number; // plot height in svg units (excl. axis padding)
  formatValue?: (n: number) => string;
  showTotals?: boolean; // print the bar total above each bar
  emptyText?: string;
};

// Default palette cycled per segment index (stacked layers).
const PALETTE = ["#16a34a", "#9ca3af", "#f59e0b", "#3b82f6", "#ef4444", "#a855f7"];

export default function BarChart({
  data,
  height = 160,
  formatValue = (n) => String(Math.round(n)),
  showTotals = false,
  emptyText = "No data",
}: Props) {
  const PAD_L = 40;
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 30; // x labels
  const slot = 44;
  const barW = 28;
  const plotH = height;
  const viewW = PAD_L + PAD_R + Math.max(1, data.length) * slot;
  const viewH = PAD_T + plotH + PAD_B;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-gray-400 py-8">
        {emptyText}
      </div>
    );
  }

  const totals = data.map((d) => d.segments.reduce((s, x) => s + Math.max(0, x.value), 0));
  const max = Math.max(1, ...totals);

  // 4 horizontal gridlines at 0/25/50/75/100% of max.
  const gridlines = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full"
        style={{ minWidth: viewW }}
        role="img"
      >
        {gridlines.map((g) => {
          const y = PAD_T + plotH - g * plotH;
          return (
            <g key={g}>
              <line
                x1={PAD_L}
                y1={y}
                x2={viewW - PAD_R}
                y2={y}
                stroke="#e5e7eb"
                strokeWidth={1}
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                className="fill-gray-400"
                fontSize={9}
              >
                {formatValue(max * g)}
              </text>
            </g>
          );
        })}

        {data.map((d, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2;
          let stackTop = PAD_T + plotH; // grow upward from baseline
          return (
            <g key={i}>
              {d.segments.map((seg, si) => {
                const h = (Math.max(0, seg.value) / max) * plotH;
                const y = stackTop - h;
                stackTop = y;
                return (
                  <rect
                    key={si}
                    x={x}
                    y={y}
                    width={barW}
                    height={h}
                    rx={2}
                    fill={seg.color ?? PALETTE[si % PALETTE.length]}
                  />
                );
              })}
              {showTotals && totals[i] > 0 && (
                <text
                  x={x + barW / 2}
                  y={stackTop - 4}
                  textAnchor="middle"
                  className="fill-gray-600"
                  fontSize={9}
                  fontWeight={600}
                >
                  {formatValue(totals[i])}
                </text>
              )}
              <text
                x={x + barW / 2}
                y={PAD_T + plotH + 14}
                textAnchor="middle"
                className="fill-gray-500"
                fontSize={9}
              >
                {d.label.length > 6 ? `${d.label.slice(0, 5)}…` : d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}