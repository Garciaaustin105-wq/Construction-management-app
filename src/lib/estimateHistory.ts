import { createClient } from "@/lib/supabase/client";

export type PriorItem = {
  description: string;
  unit: string | null;
  unit_price: number;
};

// Previously-used line items across all estimates, deduped by description. Fed
// into a <datalist> on the estimate editor so the office can pull a past item
// (description + unit + unit price) instead of retyping. Quotes were merged
// into estimates (their line items migrated into estimate_line_items), so this
// single table covers everything. Office RLS sees all estimates; crew never
// reaches this page.
export async function fetchPriorLineItems(): Promise<PriorItem[]> {
  const supabase = createClient();
  const { data } = await supabase
    .from("estimate_line_items")
    .select("description, unit, unit_price")
    .not("description", "is", null);

  const map = new Map<string, PriorItem>();
  const rows =
    (data ?? []) as { description: string | null; unit: string | null; unit_price: number }[];
  for (const r of rows) {
    if (!r.description) continue;
    const desc = r.description.trim();
    const key = desc.toLowerCase();
    if (!key) continue;
    // Prefer the first row that carries a non-zero price so the autocomplete
    // fills a useful unit price rather than a 0 placeholder.
    const existing = map.get(key);
    const candidate: PriorItem = {
      description: desc,
      unit: r.unit,
      unit_price: Number(r.unit_price) || 0,
    };
    if (!existing || (existing.unit_price === 0 && candidate.unit_price > 0)) {
      map.set(key, candidate);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.description.localeCompare(b.description));
}