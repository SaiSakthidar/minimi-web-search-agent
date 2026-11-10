// Shared word tokeniser for overlap scoring (recall, search dedupe, paragraph ranking). No stemming, no embeddings.

const STOPWORDS = new Set(
  ("the and for are but not you your yours with what when where which who whom why how did does doing done was were " +
   "has have had having this that these those then than there their them they from into onto about any all can could " +
   "would should will shall just also some such only very our ours out its it's i'm i've me my mine she her his him " +
   "been being let lets tell said say says on in at to of is it be do so if or as an by we us").split(" "),
);

export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}
