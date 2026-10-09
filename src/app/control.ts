/**
 * The pipe protocol between `deno task app`'s supervisor (supervisor.ts) and the app it runs
 * (main.ts), for restarting into an update without locking the case (ADR 22, amendment).
 *
 * One JSON message per line, each line starting with `CONTROL_PREFIX`. Anything else on the app's
 * stdout is ordinary output, passed through. The pipes are the child process's own stdin and
 * stdout: no file, port or socket another process could reach.
 *
 * supervisor → app (stdin):
 *   { resume: Handoff | null }   first line, before the app listens
 *   { handOff: true }            close the case, reply, exit
 * app → supervisor (stdout):
 *   { ready: { port } }          listening
 *   { handOff: Handoff | null }  the case is closed and its writes are done; exiting
 */
import type { Handoff } from "./state.ts";

export const CONTROL_PREFIX = "@@casefile ";

export type ToApp = { resume: Handoff | null } | { handOff: true };
export type FromApp = { ready: { port: number } } | { handOff: Handoff | null };

export function controlLine(msg: ToApp | FromApp): string {
  return CONTROL_PREFIX + JSON.stringify(msg) + "\n";
}

/** Lines from a byte stream. */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buf = "";
  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf;
}

/** The message on a control line, or null for ordinary output. */
export function parseControl<T>(line: string): T | null {
  if (!line.startsWith(CONTROL_PREFIX)) return null;
  try {
    return JSON.parse(line.slice(CONTROL_PREFIX.length)) as T;
  } catch {
    return null;
  }
}
