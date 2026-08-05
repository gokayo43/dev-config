/**
 * The one place a gate shells out to `gh`. The CLI is on every runner and
 * carries the job's token, which is why it is preferred to a hand-rolled REST
 * call — but a gate that ignored its exit code would report an empty queue as a
 * clean one, so a failure is thrown rather than returned.
 */
export async function gh(args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

/**
 * `gh` stops at `--limit` and exits 0, so a queue that outgrew the limit reads
 * as a short and tidy one. Anything at the limit is treated as truncated: the
 * gate cannot tell a full page from a cut-off one, and guessing wrong means
 * auditing a subset while reporting on the whole.
 */
export function whole<T>(items: T[], limit: number, what: string): T[] {
  if (items.length < limit) return items;
  throw new Error(
    `gh returned ${items.length} ${what} at its --limit of ${limit} and truncates silently — raise the limit`,
  );
}
