/** Chunking — mesmo algoritmo e mesmos números da v1.x. */

export function chunkText(text: string, maxWords: number, overlap: number): string[] {
  // colapsa espaços (equivale a \s+ -> ' ') e apara
  const limpo = text.replace(/\s+/g, " ").trim();
  if (!limpo) return [];
  const words = limpo.split(" ");
  if (words.length <= maxWords) return [limpo];

  // índice (em palavras) do fim de cada frase
  const ends: number[] = [];
  const re = /\b\w+[.!?]+\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(limpo)) !== null) {
    const trecho = limpo.slice(0, m.index + m[0].length);
    let espacos = 0;
    for (const ch of trecho) if (ch === " ") espacos++;
    ends.push(espacos);
  }

  const chunks: string[] = [];
  let pos = 0;
  while (pos < words.length) {
    let cut = Math.min(pos + maxWords, words.length);
    for (let i = ends.length - 1; i >= 0; i--) {
      const se = ends[i];
      if (pos < se && se < cut && se - pos >= 20 && words.length - se >= 10) {
        cut = se + 1;
        break;
      }
    }
    chunks.push(words.slice(pos, cut).join(" "));
    pos = Math.max(cut - overlap, cut + 1);
  }
  if (chunks.length > 1) {
    const ultimo = chunks[chunks.length - 1].split(" ").length;
    if (ultimo < 15) {
      chunks[chunks.length - 2] = chunks[chunks.length - 2] + " " + chunks[chunks.length - 1];
      chunks.pop();
    }
  }
  return chunks.map((c) => c.trim()).filter(Boolean);
}