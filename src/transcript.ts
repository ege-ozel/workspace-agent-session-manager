import * as fs from 'fs';
import { ChatItem } from './api';

/**
 * Complete lines of a JSONL file from byte `from` up to its last newline; `next` is where the following read starts.
 * `offsets[i]` is the byte offset of `lines[i]` in the file (blank lines are dropped, so offsets stay aligned).
 * A half-written last line is left for the next pass. If the file is shorter than `from` it was replaced: read from 0.
 */
export function readLines(file: string, from: number): { lines: string[]; offsets: number[]; next: number } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < from) from = 0;
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offsets: [], next: from };
    const lines: string[] = [];
    const offsets: number[] = [];
    for (let pos = 0; pos <= end;) {
      const nl = buf.indexOf(0x0a, pos);
      const line = buf.toString('utf8', pos, nl).replace(/\r$/, '');
      if (line) { lines.push(line); offsets.push(from + pos); }
      pos = nl + 1;
    }
    return { lines, offsets, next: from + end + 1 };
  } catch {
    return { lines: [], offsets: [], next: from };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** The one line starting at byte `offset`, read in chunks: a line with a screenshot in it is megabytes long. */
export async function readLineAt(file: string, offset: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const parts: Buffer[] = [];
    for (let pos = offset; ;) {
      const buf = Buffer.alloc(1 << 20);
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (nl >= 0) { parts.push(buf.subarray(0, nl)); break; }
      parts.push(buf.subarray(0, bytesRead));
      pos += bytesRead;
    }
    return Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
  } finally {
    await fh.close();
  }
}

/**
 * An image item that holds no picture, only where it is: line `offset` of `file`, the `n`-th image of that line.
 * `parse` is the provider's own line reader, so the order of images is the one the item list was built with.
 * Transcripts only grow, so an offset stays right for the life of the file.
 */
export function lazyImage(file: string, offset: number, n: number, mime: string, parse: (line: string) => ChatItem[]): ChatItem {
  return {
    kind: 'image', mime,
    load: async () => {
      const img = parse(await readLineAt(file, offset)).filter(i => i.kind === 'image')[n];
      if (img?.kind !== 'image' || !img.data) throw new Error('Image no longer in the transcript');
      return img.data;
    },
  };
}
