// Windows paths in the forward-slash form the rest of the collector reads, so a session run on
// Windows (C:\code\app) is matched, classified and redacted like one run on a Mac.
// Anything that is not Windows-shaped is returned unchanged: a backslash inside a regex in a Grep
// pattern or a shell command stays as it was.
import path from 'node:path';

const DRIVE = /^([A-Za-z]):[\\/]/;   // C:\x or C:/x
const UNC = /^\\\\/;                 // \\server\share
const CLIMB = /^\.{1,2}\\/;          // ..\x or .\x

/** "C:\code\app" → "/c/code/app", "\\srv\share\x" → "//srv/share/x", "..\x" → "../x". */
export function toPosix(p) {
  if (typeof p !== 'string') return p;
  const drive = DRIVE.exec(p);
  if (drive) return `/${drive[1].toLowerCase()}/${p.slice(3).replace(/\\/g, '/')}`;
  if (UNC.test(p) || CLIMB.test(p)) return p.replace(/\\/g, '/');
  return p;
}

/** Absolute on either system, whichever this one is. */
export const isAbsoluteAny = p => typeof p === 'string' && (path.posix.isAbsolute(p) || path.win32.isAbsolute(p));
