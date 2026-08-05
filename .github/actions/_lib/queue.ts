/**
 * The labels that mean "the product owner approved this". Shared, because the
 * guard refuses them on the event and the audit re-checks them on a schedule —
 * two halves of one rule, and a set that drifted between them would leave a
 * label enforced at one end only.
 */
export const PROMOTION_LABELS: readonly string[] = ["ready-for-agent", "ready-for-human"];
