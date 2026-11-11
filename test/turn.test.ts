import { expect, it } from "vitest";
import { citedSources, withoutUnrecalledBefore } from "../src/turn.ts";

const src = (id: number) => ({ id, title: `s${id}`, url: `https://s${id}.test`, publishedDate: null });

it("counts grouped, comma-separated and single citations", () => {
  const sources = [1, 2, 3, 4, 11, 15, 20].map(src);
  const text = "Vercel is $20 [11, 15]. Netlify is $20 [1][4]. Other [2,3].";
  expect(citedSources({ text, diff: null, sources }).map((s) => s.id)).toEqual([1, 2, 3, 4, 11, 15]);
});

it("blanks 'before' values when nothing was recalled, so they cannot be invented", () => {
  const items = [{ item: "Neon", before: "usage-based", beforeDate: "2026-11-10", after: "usage-based", afterDate: "2026-11-11", verdict: "same" as const, source: 3 }];
  expect(withoutUnrecalledBefore(items, false)).toEqual([{ ...items[0], before: null, beforeDate: null, verdict: "unverified" }]);
  expect(withoutUnrecalledBefore(items, true)).toEqual(items);
  expect(withoutUnrecalledBefore(null, false)).toBeNull();
});
