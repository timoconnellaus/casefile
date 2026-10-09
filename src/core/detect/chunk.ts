/** A slice of a larger text, with its offset in that text (UTF-16 indices). */
export interface Chunk {
  offset: number;
  text: string;
}

/**
 * Split text into chunks of at most `max` characters, breaking after a newline where possible,
 * otherwise after a space, otherwise mid-text. Chunks are contiguous and cover the whole text, so
 * `offset + index` in a chunk is the index in the original.
 */
export function chunkText(text: string, max: number): Chunk[] {
  if (max < 1) throw new RangeError("chunk size must be at least 1");
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1);
      if (nl >= start) end = nl + 1;
      else {
        const sp = text.lastIndexOf(" ", end - 1);
        if (sp >= start) end = sp + 1;
      }
      // Never cut a surrogate pair in half.
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && end - 1 > start) end--;
    }
    chunks.push({ offset: start, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

function isHighSurrogate(c: number) {
  return c >= 0xd800 && c <= 0xdbff;
}
