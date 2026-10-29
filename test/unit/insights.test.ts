import * as assert from "node:assert/strict";
import { capNote, type FileInsights, type FileSymbol, lensSymbols, lensText, locate, MAX_LENSES } from "../../src/insights";

const py = (over: Partial<FileSymbol> = {}): FileSymbol => ({
  id: "py:shop.cart.cart_total",
  name: "cart_total",
  kind: "Function",
  line: 1,
  caller_count: 2,
  interface_caller_count: 0,
  target_covered: true,
  untested_in_reach: 1,
  untested_truncated: false,
  unresolved_calls: { count: 1, shown: 1, declared: 1, sites: [] },
  ...over,
});

describe("lensText (D15)", () => {
  it("says callers are a floor, and names untested reach and possible untraced calls", () => {
    assert.equal(lensText(py()), "2 callers (at least) · 1 untested in reach · 1 possible untraced call");
  });

  it("uses the singular for one", () => {
    assert.equal(
      lensText(py({ caller_count: 1, unresolved_calls: { count: 2, shown: 2, declared: 1, sites: [] } })),
      "1 caller (at least) · 1 untested in reach · 2 possible untraced calls",
    );
  });

  it("never shows a function with untraced calls as having no callers", () => {
    const text = lensText(py({ caller_count: 0, untested_in_reach: 0 }));
    assert.equal(text, "0 typed callers · 1 possible untraced call");
    assert.doesNotMatch(text, /(^|[^a-z])0 callers/);
  });

  it("says untraced calls are not tracked, in Spine's words, for a language that does not track them", () => {
    const ts = py({
      id: "ts:web/price.applyTax",
      caller_count: 1,
      untested_in_reach: 0,
      unresolved_calls: null,
      unresolved_calls_note: "not tracked for typescript",
    });
    assert.equal(lensText(ts), "1 caller (at least) · untraced calls not tracked for typescript");
  });

  it("marks a clipped untested count as a floor", () => {
    assert.equal(
      lensText(py({ untested_in_reach: 20, untested_truncated: true, unresolved_calls: undefined })),
      "2 callers (at least) · 20+ untested in reach",
    );
  });

  it("says nothing about untraced calls for a class, where the question does not apply", () => {
    assert.equal(
      lensText(py({ kind: "Type", caller_count: 3, untested_in_reach: 0, unresolved_calls: undefined })),
      "3 callers (at least)",
    );
  });

  it("counts calls through an interface and Java/C# creations as their own reach", () => {
    assert.equal(
      lensText(py({ caller_count: 0, interface_caller_count: 2, untested_in_reach: 0, unresolved_calls: undefined })),
      "0 typed callers · 2 through an interface",
    );
    assert.equal(
      lensText(
        py({ caller_count: 0, instantiated_via_type_count: 4, untested_in_reach: 0, unresolved_calls: undefined }),
      ),
      "0 typed callers · 4 creations of its type",
    );
  });
});

describe("capNote (D16)", () => {
  const file = (count: number, shown = count): FileInsights => ({
    file: "a.py",
    found: true,
    symbol_count: count,
    shown,
    truncated: shown < count,
    symbols: [],
  });

  it("says nothing when every symbol has a lens", () => {
    assert.equal(capNote(file(MAX_LENSES)), undefined);
  });

  it("says how many of how many have a lens", () => {
    assert.equal(capNote(file(80, 80)), `Spine: showing ${MAX_LENSES} of 80 functions and classes`);
    assert.equal(capNote(file(500, 200)), `Spine: showing ${MAX_LENSES} of 500 functions and classes`);
  });
});

describe("locate", () => {
  const lines = ["", "# note", "def other():", "    pass", "def cart_total(prices):", "    return sum(prices)"];

  it("keeps Spine's line when the name is on it", () => {
    assert.equal(locate(lines, "cart_total", 5), 4);
  });

  it("finds the nearest line naming the symbol when unsaved edits moved it", () => {
    assert.equal(locate(lines, "cart_total", 3), 4);
    assert.equal(locate(lines, "other", 5), 2);
  });

  it("matches the name as a word, not inside a longer name", () => {
    assert.equal(locate(["def cart_total_v2():", "def cart_total():"], "cart_total", 1), 1);
  });

  it("falls back to Spine's line, clamped to the text, when the name is not near", () => {
    assert.equal(locate(lines, "missing", 2), 1);
    assert.equal(locate(lines, "missing", 99), lines.length - 1);
  });
});

describe("lensSymbols (D16)", () => {
  it("gives a lens to the first MAX_LENSES symbols by line, no more", () => {
    const symbols = Array.from({ length: MAX_LENSES + 5 }, (_, i) => py({ id: `py:m.f${i}`, name: `f${i}`, line: i + 1 }));
    const picked = lensSymbols({ file: "m.py", found: true, symbol_count: 200, shown: symbols.length, truncated: true, symbols });
    assert.equal(picked.length, MAX_LENSES);
    assert.deepEqual(picked.map((s) => s.line), Array.from({ length: MAX_LENSES }, (_, i) => i + 1));
  });
});
