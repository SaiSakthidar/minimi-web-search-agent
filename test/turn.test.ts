import { expect, it } from "vitest";
import { citedSources } from "../src/turn.ts";

const src = (id: number) => ({ id, title: `s${id}`, url: `https://s${id}.test`, publishedDate: null });

it("counts grouped, comma-separated and single citations", () => {
  const sources = [1, 2, 3, 4, 11, 15, 20].map(src);
  const text = "Vercel is $20 [11, 15]. Netlify is $20 [1][4]. Other [2,3].";
  expect(citedSources({ text, diff: null, sources }).map((s) => s.id)).toEqual([1, 2, 3, 4, 11, 15]);
});
