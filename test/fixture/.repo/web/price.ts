export function applyTax(amount: number): number {
  return Math.round(amount * 1.2 * 100) / 100;
}
