export function applyTax(amount: number): number {
  return Math.round(amount * 1.2 * 100) / 100;
}

export function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}
