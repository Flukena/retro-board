// What each account plan may do. Owner decision 2026-11-06: free and pro start
// with the same entitlements; the table is where they diverge later.
export const PLAN = Object.freeze({ FREE: 'free', PRO: 'pro' });

const NO_ENTITLEMENTS = Object.freeze({ canCreateLockedRoom: false });
const ENTITLEMENTS_BY_PLAN = Object.freeze({
  [PLAN.FREE]: Object.freeze({ canCreateLockedRoom: true }),
  [PLAN.PRO]: Object.freeze({ canCreateLockedRoom: true }),
});

// Own keys only, so prototype names such as 'toString' are not plans.
export const isKnownPlan = (plan) => typeof plan === 'string' && Object.hasOwn(ENTITLEMENTS_BY_PLAN, plan);

export const entitlementsFor = (plan) => (isKnownPlan(plan) ? ENTITLEMENTS_BY_PLAN[plan] : NO_ENTITLEMENTS);
