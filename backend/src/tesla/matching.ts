/**
 * The pooling rule from `PRD_Dhaka_Tesla_Pool.md` §6.1, as a pure function.
 *
 * **The rule, in full:** two requests may share one Tesla if and only if their
 * pickup zones are identical AND their destination corridors overlap — meaning
 * they share at least one zone.
 *
 * ## Why a destination is not simply "in one corridor"
 *
 * A zone may belong to several corridors, and one of them decides the whole demo.
 * Mohakhali is in both `banani_gulshan` and `dhanmondi_farmgate`; Dhanmondi is in
 * both `dhanmondi_farmgate` and `bashundhara_east`. That is the only reason
 * Nusrat (Banani to Mohakhali), Rafiq (Banani to Gulshan 1), and Shirin (Banani to
 * Dhanmondi) can ride together in one Bullet: Mohakhali's pair with Dhanmondi
 * resolves through `dhanmondi_farmgate`, which both share with Mohakhali.
 *
 * An implementation that stored a single corridor per zone would call that third
 * pairing incompatible, and the failure would be invisible until Phase 4 tried to
 * pool three real riders. So the input here is a zone's *set* of corridors, and
 * corridor overlap is computed as set intersection over the zones each corridor
 * contains.
 *
 * ## Why the rule has three callers
 *
 * The rule is pairwise — it answers "may these two requests share a Tesla",
 * which needs two requests. In Phase 3 a driver has no pool and therefore no
 * first request to compare against, so the feed lists `REQUESTED` rides and the
 * predicate has no caller (D27). Phase 4 gives it an anchor, and with one it is
 * now used in three places:
 *
 * - **the driver feed** (`TeslaService.listMatchableRides`): once a first
 *   request anchors the pool, every request it lists must share with every
 *   member already aboard (PRD §5.3 D, US-D3);
 * - **the matcher** (`MatchingService.reconcile`): a ride is `MATCHED` only
 *   while at least one online Tesla could carry it, judged by the same pairwise
 *   rule against that Tesla's pool;
 * - **the claim** (`PoolService.claim`): the server still refuses, with the rule
 *   stated back, a request a stale feed has already hidden (D13's single path).
 *
 * It is written and verified now rather than in Phase 9 because it is the rule
 * most likely to be got subtly wrong; `PRD` §5.4's traceability table lists a
 * "matching unit" as part of D3's evidence.
 */

/** A request reduced to the only two facts the matching rule reads. */
export type MatchableRequest = {
  readonly pickupZoneCode: string;
  readonly destinationZoneCode: string;
};

/** The zone data the rule needs, in the shape `ZoneService` already returns. */
export type ZoneWithCorridors = {
  readonly code: string;
  readonly corridors: readonly { readonly code: string }[];
};

/**
 * Both directions of the corridor relationship.
 *
 * `corridorsByZone` is the direction "which corridors could this destination use".
 * `zonesByCorridor` exists because overlap is about shared *zones* — two corridors
 * with nothing in common in their membership do not overlap even if their names
 * look related.
 */
export type CorridorIndex = {
  readonly corridorsByZone: ReadonlyMap<string, readonly string[]>;
  readonly zonesByCorridor: ReadonlyMap<string, readonly string[]>;
};

/**
 * Inverts the zone-to-corridor relation into both directions.
 *
 * Built once per request rather than per comparison: the feed is a list, and
 * rebuilding this for every pair would be quadratic over eight zones for no gain.
 */
export function buildCorridorIndex(
  zones: readonly ZoneWithCorridors[],
): CorridorIndex {
  const corridorsByZone = new Map<string, string[]>();
  const zonesByCorridor = new Map<string, string[]>();

  for (const zone of zones) {
    corridorsByZone.set(zone.code, [...zone.corridors.map((c) => c.code)]);
    for (const corridor of zone.corridors) {
      const members = zonesByCorridor.get(corridor.code) ?? [];
      members.push(zone.code);
      zonesByCorridor.set(corridor.code, members);
    }
  }

  return { corridorsByZone, zonesByCorridor };
}

/** Do two corridors share at least one zone? */
function corridorsOverlap(a: string, b: string, index: CorridorIndex): boolean {
  const zonesOfA = index.zonesByCorridor.get(a) ?? [];
  const zonesOfB = index.zonesByCorridor.get(b);
  if (zonesOfB === undefined) {
    return false;
  }

  return zonesOfA.some((zone) => zonesOfB.includes(zone));
}

/**
 * May these two requests share one Tesla? (PRD §6.1)
 *
 * False whenever the pickups differ, and false when no pair of the two
 * destinations' corridors shares a zone.
 *
 * An unknown zone code yields false rather than throwing: the rule's question is
 * "do these fit together", and a zone the rule cannot place is not a pairing it
 * can endorse. Callers that need a zone to exist resolve it before reaching here.
 */
export function canShare(
  a: MatchableRequest,
  b: MatchableRequest,
  index: CorridorIndex,
): boolean {
  if (a.pickupZoneCode !== b.pickupZoneCode) {
    return false;
  }

  const corridorsOfA = index.corridorsByZone.get(a.destinationZoneCode) ?? [];
  const corridorsOfB = index.corridorsByZone.get(b.destinationZoneCode) ?? [];

  return corridorsOfA.some((first) =>
    corridorsOfB.some((second) => corridorsOverlap(first, second, index)),
  );
}
