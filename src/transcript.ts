import * as fs from 'fs';

/**
 * Complete lines of a JSONL file from byte `from` up to its last newline; `next` is where the following read starts.
 * A half-written last line is left for the next pass. If the file is shorter than `from` it was replaced: read from 0.
 */
export function readLines(file: string, from: number): { lines: string[]; next: number } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < from) from = 0;
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], next: from };
    const lines = buf.toString('utf8', 0, end).split('\n').map(l => l.replace(/\r$/, '')).filter(Boolean);
    return { lines, next: from + end + 1 };
  } catch {
    return { lines: [], next: from };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}
