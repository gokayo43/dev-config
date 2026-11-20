/**
 * Runs the command in `argv` and becomes the parent of whatever it leaves
 * behind, reaping none of it, so a process it leaves that then dies stays a
 * zombie, as one does under a starved `systemd --user` or PID 1. Prints the
 * command's exit status and output as one line of JSON, then holds what it
 * adopted until its stdin closes, reaps what has died, and exits.
 *
 * `dev-server.test.ts` runs `up` under it, so the server `up` detaches is this
 * process's to reap. Bun reaps the children it spawns and never one it adopted,
 * measured on 1.4.4, which is what leaves a dead server unreaped here.
 *
 * Linux with glibc: `PR_SET_CHILD_SUBREAPER` is a `prctl` of Linux 3.4 and
 * later, reached through `libc.so.6`, and either missing fails here by name.
 */
import { dlopen, FFIType } from "bun:ffi";

const PR_SET_CHILD_SUBREAPER = 36;
const WNOHANG = 1;

const libc = dlopen("libc.so.6", {
  prctl: {
    args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.i32,
  },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
});

if (libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) !== 0) {
  throw new Error("prctl(PR_SET_CHILD_SUBREAPER) failed: this needs Linux 3.4 or later");
}

const command = Bun.spawn(process.argv.slice(2), {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, code] = await Promise.all([
  new Response(command.stdout).text(),
  new Response(command.stderr).text(),
  command.exited,
]);
process.stdout.write(`${JSON.stringify({ code, stdout, stderr })}\n`);

for await (const chunk of Bun.stdin.stream()) void chunk;
// Every adopted child that has died, and none that still runs: those go on to
// whatever adopts them next when this exits.
while (libc.symbols.waitpid(-1, null, WNOHANG) > 0);
