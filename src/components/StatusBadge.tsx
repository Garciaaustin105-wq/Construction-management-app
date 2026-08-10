/**
 * Small colored pill for a status string. Centralizes the color logic so all
 * pages (jobs, quotes, invoices) stay in sync.
 */
export default function StatusBadge({
  status,
  size = "sm",
}: {
  status: string;
  size?: "sm" | "md";
}) {
  const palette: Record<string, string> = {
    // Jobs
    scheduled: "bg-gray-100 text-gray-800",
    in_progress: "bg-amber-100 text-amber-800",
    on_hold: "bg-red-100 text-red-800",
    completed: "bg-green-100 text-green-800",
    // Quotes
    draft: "bg-gray-100 text-gray-800",
    sent: "bg-blue-100 text-blue-800",
    approved: "bg-green-100 text-green-800",
    rejected: "bg-red-100 text-red-800",
    // Invoices
    paid: "bg-green-100 text-green-800",
    void: "bg-gray-100 text-gray-800",
  };

  const sizeClass = size === "md" ? "text-sm px-2.5 py-1" : "text-xs px-2 py-1";

  return (
    <span
      className={`inline-block rounded font-medium ${sizeClass} ${palette[status] ?? "bg-gray-100 text-gray-800"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}