/**
 * The lane, as far as an interrupt sees it: one `ran` of the shell script at
 * `argv[2]`, with a deadline no case reaches. `mutation-lane-child.test.ts`
 * signals this process's group, as a terminal's Ctrl-C or a cancelled step does.
 */
import { ran } from "../.github/actions/mutation-lane/child.ts";

const [script = ""] = process.argv.slice(2);

await ran(["sh", "-c", script], process.cwd(), Date.now() + 600_000);
