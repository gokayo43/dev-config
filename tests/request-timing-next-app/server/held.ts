/**
 * The latch a handler waits on midway, so a case can leave while the handler
 * is provably waiting and then let it finish. One handler at a time.
 */
import { latch } from "../../request-timing-fixture.ts";

export const held = latch();
