// Hand-rolled SVG line chart for /lawn/insights. No chart library — polyline
// + area fill + dots, with a minimal y gridline axis and x labels. Pure
// markup (no "use client") so it renders in the server insights page.
// Responsive via viewBox + preserveAspectRatio.

export type LineDatum = { label: string; value: number };

type Props = {
  data: LineDatum[];
  height?: number; // plot height in svg units (excl. axis padding)
  formatValue?: (n: number) => string;
  color?: string;
  emptyText?: string;
};

export default function LineChart({
  data,
  height = 160,
  formatValue = (n) => String(Math.round(n)),
  color = "#16a34a",
  emptyText = "No data",
}: Props) {
  const PAD_L = 44;
  const PAD_R = 12;
  const PAD_T = 12;
  const PAD_B = 30;
  const plotH = height;
  const viewW = PAD_L + PAD_R + Math.max(2, data.length) * 46;
  const viewH = PAD_T + plotH + PAD_B;

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-gray-400 py-8">
        {emptyText}
      </div>
    );
  }

  const max = Math.max(1, ...data.map((d) => Math.max(0, d.value)));
  const innerW = viewW - PAD_L - PAD_R;
  const stepX = data.length > 1 ? innerW / (data.length - 1) : 0;

  const xAt = (i: number) => PAD_L + i * stepX;
  const yAt = (v: number) => PAD_T + plotH - (Math.max(0, v) / max) * plotH;

  const points = data.map((d, i) => `${xAt(i)},${yAt(d.value)}`);
  const linePath = `M ${points.join(" L ")}`;
  const areaPath = `M ${xAt(0)},${PAD_T + plotH} L ${points.join(" L ")} L ${xAt(
    data.length - 1
  )},${PAD_T + plotH} Z`;

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
              <line x1={PAD_L} y1={y} x2={viewW - PAD_R} y2={y} stroke="#e5e7eb" strokeWidth={1} />
              <text x={PAD_L - 6} y={y + 3} textAnchor="end" className="fill-gray-400" fontSize={9}>
                {formatValue(max * g)}
              </text>
            </g>
          );
        })}

        {data.length > 1 && <path d={areaPath} fill={color} opacity={0.1} />}
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {data.map((d, i) => (
          <g key={i}>
            <circle cx={xAt(i)} cy={yAt(d.value)} r={3} fill="#fff" stroke={color} strokeWidth={2} />
            <text
              x={xAt(i)}
              y={PAD_T + plotH + 14}
              textAnchor="middle"
              className="fill-gray-500"
              fontSize={9}
            >
              {d.label.length > 6 ? `${d.label.slice(0, 5)}…` : d.label}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}