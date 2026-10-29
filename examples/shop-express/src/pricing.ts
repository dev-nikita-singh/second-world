/** Bulk pricing tiers. Valid quantities per the contract (openapi.yaml): 1..100. */
const TIERS = [
  { min: 1, max: 9, discount: 0 },
  { min: 10, max: 49, discount: 0.05 },
  { min: 50, max: 100, discount: 0.1 },
] as const;

export function unitPrice(price: number, qty: number): number {
  // SEEDED-DEFECT:boundary-500 — no tier for qty<=0 or qty>100 → TypeError → HTTP 500 (contract says 400).
  const tier = TIERS.find((t) => qty >= t.min && qty <= t.max)!;
  return Math.round(price * (1 - tier.discount) * 100) / 100;
}
