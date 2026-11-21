export function createAwarenessPolicy({ awarenessProtocol, MAX_AWARENESS_IDS_PER_CONNECTION, MAX_AWARENESS_CLIENTS_PER_ROOM, MAX_AWARENESS_ROOM_BYTES }) {
  const awarenessPolicies = new WeakMap();
  const awarenessPolicyFor = (doc) => {
    let policy = awarenessPolicies.get(doc);
    if (!policy) {
      policy = {
        owners: new Map(),
        bytesById: new Map(),
        totalBytes: 0,
      };
      awarenessPolicies.set(doc, policy);
    }
    return policy;
  };

  const isForeignEntry = (doc, conn, context, proposedOwners, entry) => {
    if (entry.clientId === doc.awareness.clientID) throw new Error('reserved awareness id');
    if (context.expectedAwarenessClientId !== null
        && entry.clientId !== context.expectedAwarenessClientId) {
      return true;
    }
    const owner = proposedOwners.get(entry.clientId);
    if ((owner && owner !== conn) || (!owner && entry.stateIsNull)) {
      return true;
    }
    return false;
  };

  const proposeEntry = (doc, conn, proposal, entry) => {
    const { proposedIds, proposedOwners, proposedBytes, mutations } = proposal;
    const owner = proposedOwners.get(entry.clientId);
    const currentMeta = doc.awareness.meta.get(entry.clientId);
    const currentClock = currentMeta === undefined ? 0 : currentMeta.clock;
    const willApply = currentClock < entry.clock
      || (currentClock === entry.clock
        && entry.stateIsNull
        && doc.awareness.states.has(entry.clientId));
    if (!willApply) return;

    if (!owner) {
      if (proposedIds.size >= MAX_AWARENESS_IDS_PER_CONNECTION
          || proposedOwners.size >= MAX_AWARENESS_CLIENTS_PER_ROOM) {
        throw new Error('awareness identity limit');
      }
      proposedIds.add(entry.clientId);
      proposedOwners.set(entry.clientId, conn);
    }

    const previousBytes = proposedBytes.get(entry.clientId) || 0;
    const nextBytes = entry.stateIsNull ? 0 : entry.stateBytes;
    proposal.totalBytes += nextBytes - previousBytes;
    if (proposal.totalBytes > MAX_AWARENESS_ROOM_BYTES) throw new Error('awareness room size limit');
    if (nextBytes > 0) proposedBytes.set(entry.clientId, nextBytes);
    else proposedBytes.delete(entry.clientId);
    mutations.push({ ...entry, nextBytes });
  };

  const planAwarenessUpdate = (doc, conn, context, entries) => {
    const policy = awarenessPolicyFor(doc);
    const proposedIds = new Set(context.awarenessClientIds);
    const proposedOwners = new Map(policy.owners);
    const proposedBytes = new Map(policy.bytesById);
    const totalBytes = policy.totalBytes;
    const mutations = [];

    // Standard y-websocket clients echo server snapshots, BroadcastChannel
    // relays, and removal announcements over their own socket. Never let such
    // a relay overwrite another connection's first-claimed identity. An
    // already-unowned null is likewise a harmless stale removal; feeding it to
    // y-protocols would retain useless metadata. Drop the whole mixed frame so
    // upstream parsing remains atomic and cannot take ownership as a side
    // effect.
    for (const entry of entries) {
      if (isForeignEntry(doc, conn, context, proposedOwners, entry)) return { dropFrame: true };
    }

    const proposal = {
      dropFrame: false,
      policy,
      proposedIds,
      proposedOwners,
      proposedBytes,
      totalBytes,
      mutations,
    };
    for (const entry of entries) proposeEntry(doc, conn, proposal, entry);
    return proposal;
  };

  const commitAwarenessPlan = (context, plan) => {
    if (plan.mutations.length === 0) return;
    context.awarenessClientIds = plan.proposedIds;
    plan.policy.owners = plan.proposedOwners;
    plan.policy.bytesById = plan.proposedBytes;
    plan.policy.totalBytes = plan.totalBytes;
  };

  const releaseAwarenessForConnection = (doc, conn, context) => {
    const policy = awarenessPolicies.get(doc);
    if (!policy) return;
    const remainingStates = [];
    for (const clientId of context.awarenessClientIds) {
      if (policy.owners.get(clientId) === conn && doc.awareness.states.has(clientId)) {
        remainingStates.push(clientId);
      }
    }
    // y-websocket stops tracking an ID after a null update and classifies a
    // later non-null update as `updated`, not `added`. Its own close hook can
    // therefore miss a re-added state. Remove any authoritative leftovers while
    // metadata still exists so the removal can be encoded and broadcast safely.
    if (remainingStates.length > 0) {
      awarenessProtocol.removeAwarenessStates(doc.awareness, remainingStates, null);
    }
    for (const clientId of context.awarenessClientIds) {
      if (policy.owners.get(clientId) !== conn) continue;
      policy.owners.delete(clientId);
      policy.totalBytes = Math.max(0, policy.totalBytes - (policy.bytesById.get(clientId) || 0));
      policy.bytesById.delete(clientId);
      // y-protocols intentionally retains clocks in `meta`. Once the owning
      // socket has been removed there is no identity continuity to preserve,
      // and retaining every reconnect forever is an avoidable memory leak.
      doc.awareness.meta.delete(clientId);
    }
  };

  return { planAwarenessUpdate, commitAwarenessPlan, releaseAwarenessForConnection };
}
