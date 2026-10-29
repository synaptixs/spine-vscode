import { applyTax } from "./price";

export function orderTotal(amounts: number[]): number {
  return applyTax(amounts.reduce((a, b) => a + b, 0));
}
