// Shared prop types for the estimator panels (Lane C). Kept out of the panel
// files so the workspace and every panel import one definition and the line
// shape can never drift between panels.

// The line shape addMeasuredLines takes — same as the workspace's NewLine and
// the same shape every *LineItem contract returns. internal_cost is what the
// item costs US, per unit where the contract says so; jobProfitability reads
// quantity x internal_cost, so an extended figure here would multiply twice.
export type EstimatorLine = {
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  internal_cost?: number | null;
};