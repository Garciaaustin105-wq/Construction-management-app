// Pure money/line-item helpers shared by server and client components.
// IMPORTANT: this module must NOT have a "use client" directive and must not
// import any client-only code. Functions exported from a "use client" module
// become client-only references that throw when called from a server component
// (the cause of the /invoices/[id] 500s). Keeping these helpers in a plain
// server-safe module lets server components call them directly.

export type LineItem = {
  description: string;
  quantity: number;
  unit_price: number;
};

export function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount || 0);
}

export function computeTotal(items: { quantity: number; unit_price: number }[]) {
  return items.reduce(
    (sum, item) => sum + (item.quantity || 0) * (item.unit_price || 0),
    0
  );
}