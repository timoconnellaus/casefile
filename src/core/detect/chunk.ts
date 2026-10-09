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

/**
 * Like `chunkText`, but each chunk after the first starts about `overlap` characters before the
 * previous one ended, at the start of a word, so a name cut by one chunk's end is whole in the
 * next. Every chunk still ends past the previous one, so the chunks cover the whole text and the
 * loop always moves on. A finding in the overlap can come from two chunks; callers de-duplicate
 * by absolute offset (`offset + index`).
 */
export function chunkTextOverlapping(text: string, max: number, overlap: number): Chunk[] {
  if (overlap <= 0) return chunkText(text, max);
  if (max < 1) throw new RangeError("chunk size must be at least 1");
  if (overlap >= max) throw new RangeError("overlap must be smaller than the chunk size");
  const chunks: Chunk[] = [];
  let start = 0;
  let covered = 0; // where the previous chunk ended
  while (covered < text.length) {
    let end = Math.min(text.length, start + max);
    if (end < text.length) {
      // Break where `chunkText` would, but never at or before the previous chunk's end.
      const nl = text.lastIndexOf("\n", end - 1);
      if (nl >= covered) end = nl + 1;
      else {
        const sp = text.lastIndexOf(" ", end - 1);
        if (sp >= covered) end = sp + 1;
      }
      if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && end - 1 > covered) {
        end--;
      }
    }
    chunks.push({ offset: start, text: text.slice(start, end) });
    covered = end;
    if (end >= text.length) break;
    // The next chunk starts at the first word that begins at least `overlap` before `end`. With no
    // whitespace there (one very long word), it starts at `end`, without overlap.
    let next = end;
    for (let i = Math.max(start + 1, end - overlap); i < end; i++) {
      if (/\s/.test(text[i])) {
        let j = i;
        while (j < end && /\s/.test(text[j])) j++;
        next = j;
        break;
      }
    }
    start = next;
  }
  return chunks;
}
