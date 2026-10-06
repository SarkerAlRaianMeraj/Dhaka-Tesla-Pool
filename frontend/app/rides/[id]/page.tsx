"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormError } from "@/components/form-controls";
import { Layout } from "@/components/Layout/layout";
import { Eyebrow, Panel } from "@/components/ui/panel";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { apiClient, getErrorMessage, isUnauthorized } from "@/lib/apiClient";
import { useAuth } from "@/lib/auth-context";
import {
  formatDistance,
  formatPoysha,
  formatSeats,
  formatTimestamp,
} from "@/lib/format";
import type { Ride } from "@/lib/types";

/**
 * One ride, with the fare breakdown and its status history (FR-P4.2, FR-P4.3).
 *
 * The history is rendered as a plain list rather than a progress tracker. Phase 5
 * owns the full tracker with plain-language explanations for every state; this
 * shows the trail as recorded so a passenger can see when a ride was requested and,
 * if it was cancelled, when.
 *
 * The Cancel button's visibility comes from `ride.cancellable`, which the API
 * computes. The browser does not re-derive the rule, so the button can never offer
 * something the server will then refuse.
 */
const RideDetailPage = () => {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const rideId = params.id;
  const { user, isLoading } = useAuth();

  const [ride, setRide] = useState<Ride | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | undefined>(undefined);

  /**
   * Which ride id the current `ride` state belongs to.
   *
   * "Loading" is derived from it rather than stored: navigating from one ride to
   * another reuses this component instance, so a stored `isLoading` flag would go
   * stale and briefly show the previous ride under the new URL. Comparing ids keeps
   * the skeleton showing for exactly as long as the fetch is outstanding, with no
   * state written from inside an effect.
   */
  const [settledRideId, setSettledRideId] = useState<string | null>(null);
  const isLoadingRide = settledRideId !== rideId;

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }

    let cancelled = false;

    const fetchRide = async (): Promise<void> => {
      try {
        const response = await apiClient.get<Ride>(`/rides/${rideId}`);
        if (!cancelled) {
          setRide(response.data);
          setError(undefined);
        }
      } catch (caught) {
        if (cancelled) return;
        if (isUnauthorized(caught)) {
          router.replace("/login");
          return;
        }
        setRide(null);
        setError(getErrorMessage(caught, "Could not load that ride."));
      } finally {
        if (!cancelled) setSettledRideId(rideId);
      }
    };

    void fetchRide();
    return () => {
      cancelled = true;
    };
  }, [isLoading, user, rideId, router]);

  const handleCancel = async (): Promise<void> => {
    setIsCancelling(true);
    setError(undefined);
    try {
      const response = await apiClient.post<Ride>(`/rides/${rideId}/cancel`);
      setRide(response.data);
    } catch (caught) {
      // A refusal here is a normal outcome, not a failure: the ride may have
      // started between rendering the button and clicking it. The server's
      // explanation is shown as-is.
      setError(
        getErrorMessage(caught, "Could not cancel that ride."),
      );
    } finally {
      setIsCancelling(false);
    }
  };

  /**
   * Joins this ride to an open Tesla's pool along the same route (PRD A2, D7).
   *
   * Whether the ride *can* join is decided on the server each click, because the
   * pool's seat count moves underneath the page. The button is only the offer —
   * and "no open pool yet", "these routes cannot share", and the E1 last-seat
   * refusal are all expected outcomes shown as the server's own words.
   */
  const isJoinable = ride?.status === "REQUESTED" || ride?.status === "MATCHED";

  const handleJoin = async (): Promise<void> => {
    setIsJoining(true);
    setJoinError(undefined);
    try {
      const response = await apiClient.post<Ride>(`/rides/${rideId}/join`);
      setRide(response.data);
    } catch (caught) {
      if (isUnauthorized(caught)) {
        router.replace("/login");
        return;
      }
      setJoinError(getErrorMessage(caught, "Could not join that ride."));
    } finally {
      setIsJoining(false);
    }
  };

  if (isLoading) {
    return (
      <Layout>
        <p className="text-sm text-ink/60">Checking your session...</p>
      </Layout>
    );
  }

  if (!user) return null;

  return (
    <Layout width="narrow">
      {isLoadingRide ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-1/2" label="Loading this ride" />
          <Panel className="px-7 py-6">
            <Skeleton className="h-4 w-2/3" label="Loading this ride" />
            <Skeleton className="mt-3 h-4 w-1/2" label="Loading this ride" />
          </Panel>
        </div>
      ) : !ride ? (
        <>
          <FormError>{error}</FormError>
          <p className="text-sm text-ink/60">
            That ride is not available. It may belong to another passenger, or it
            may never have existed &mdash; the API does not say which (NFR-1).
          </p>
          <Link
            href="/rides"
            className="inline-flex min-h-[44px] w-fit items-center justify-center rounded-2xl border border-forest/20 px-5 font-display text-sm font-semibold text-forest transition hover:border-forest/35 hover:bg-white/60"
          >
            Back to your rides
          </Link>
        </>
      ) : (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <Eyebrow>Ride detail</Eyebrow>
              <h1 className="font-display flex items-center gap-2 text-2xl font-semibold tracking-tight text-ink">
                <span>{ride.pickupZone.name}</span>
                <span aria-hidden className="text-mint">
                  &rarr;
                </span>
                <span>{ride.destinationZone.name}</span>
              </h1>
              <p className="text-sm text-ink/60">
                Requested {formatTimestamp(ride.createdAt)}
              </p>
            </div>
            <StatusPill status={ride.status} label={ride.statusLabel} />
          </header>

          <Panel as="section" className="animate-rise">
            <div className="flex flex-col gap-4 px-7 py-6">
              <h2 className="font-display text-base font-semibold text-ink">Trip</h2>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-ink/60">Pickup</dt>
                <dd className="font-medium text-ink">{ride.pickupZone.name}</dd>
                <dt className="text-ink/60">Destination</dt>
                <dd className="font-medium text-ink">
                  {ride.destinationZone.name}
                </dd>
                <dt className="text-ink/60">Seats</dt>
                <dd className="font-medium text-ink">
                  {formatSeats(ride.seatsRequested)}
                </dd>
                <dt className="text-ink/60">Distance</dt>
                <dd className="font-medium tabular-nums text-ink">
                  {formatDistance(ride.distanceKm)} km
                </dd>
              </dl>
            </div>
          </Panel>

          <Panel as="section" className="animate-rise [animation-delay:60ms]">
            <div className="flex flex-col gap-3 px-7 py-6">
              <h2 className="font-display text-base font-semibold text-ink">
                Fare breakdown
              </h2>
              <dl className="flex flex-col gap-1.5 text-sm">
                <div className="flex justify-between">
                  <dt className="text-ink/60">Base fare</dt>
                  <dd className="tabular-nums text-ink">
                    {formatPoysha(ride.baseFarePoysha)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink/60">
                    Distance charge ({formatDistance(ride.distanceKm)} km)
                  </dt>
                  <dd className="tabular-nums text-ink">
                    {formatPoysha(ride.distanceChargePoysha)}
                  </dd>
                </div>
                <div className="mt-1 flex justify-between border-t border-ink/8 pt-3 font-semibold">
                  <dt className="font-display text-ink">Estimated fare</dt>
                  <dd className="tabular-nums font-display text-ink">
                    {formatPoysha(ride.fareEstimatePoysha)} Taka
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-ink/55">
                A 20% sharing discount applies to the distance charge if your trip
                starts with other passengers.
              </p>
            </div>
          </Panel>

          {isJoinable ? (
            <Panel as="section" className="animate-rise [animation-delay:80ms]">
              <div className="flex flex-col gap-3 px-7 py-6">
                <div className="flex flex-col gap-1">
                  <h2 className="font-display text-base font-semibold text-ink">
                    Get aboard
                  </h2>
                  <p className="text-sm text-ink/60">
                    If a Tesla is already carrying riders on your route, joining
                    takes the next free seat. Otherwise a driver accepts your
                    request from their feed.
                  </p>
                </div>
                {/*
                  A join is self-service (D7), so its refusals are ordinary
                  outcomes and are shown here, on the action they concern, rather
                  than inheriting the page's shared error line.
                */}
                <FormError>{joinError}</FormError>
                <button
                  type="button"
                  disabled={isJoining}
                  onClick={() => void handleJoin()}
                  className="inline-flex min-h-[50px] w-full items-center justify-center rounded-2xl bg-mint px-6 font-display text-sm font-semibold text-ink shadow-[0_10px_24px_color-mix(in_oklab,var(--color-mint)_28%,transparent)] transition hover:translate-y-[-2px] hover:shadow-[0_14px_30px_color-mix(in_oklab,var(--color-mint)_36%,transparent)] active:translate-y-0 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-55"
                >
                  {isJoining ? "Joining..." : "Join an open Tesla"}
                </button>
                <p className="text-xs text-ink/55">
                  Once a Tesla carries you, your ride becomes Accepted and the
                  seat is yours until you cancel it.
                </p>
              </div>
            </Panel>
          ) : ride.status === "ACCEPTED" ? (
            <Panel as="section" className="animate-rise [animation-delay:80ms]">
              <div className="flex flex-col gap-1 px-7 py-6">
                <h2 className="font-display text-base font-semibold text-ink">
                  Seat reserved
                </h2>
                <p className="text-sm text-ink/60">
                  A Tesla now carries you. Watch this ride&rsquo;s history for what
                  happens next.
                </p>
              </div>
            </Panel>
          ) : null}

          <Panel as="section" className="animate-rise [animation-delay:120ms]">
            <div className="flex flex-col gap-3 px-7 py-6">
              <h2 className="font-display text-base font-semibold text-ink">
                Status history
              </h2>
              {/*
                Recorded as it happened rather than derived from the current
                status, so the entries cannot disagree with each other.
              */}
              <ol className="flex flex-col gap-3">
                {ride.statusHistory.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 text-sm">
                    <span
                      aria-hidden="true"
                      className="mt-1.5 size-2 shrink-0 rounded-full bg-mint"
                    />
                    {/*
                      Each entry is described with its own label and timestamp.
                      Using the ride's current label here would relabel an old
                      entry every time the status changed.
                    */}
                    <span className="text-ink">
                      {entry.statusLabel}{" "}
                      <span className="text-ink/55">
                        &middot; {formatTimestamp(entry.changedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ol>
              {ride.status === "CANCELLED" ? (
                <p className="text-xs text-ink/55">
                  This ride was cancelled. The entries above are the record of it.
                </p>
              ) : null}
            </div>
          </Panel>

          <FormError>{error}</FormError>

          {ride.cancellable ? (
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={isCancelling}
              className="inline-flex min-h-[50px] w-full items-center justify-center rounded-2xl border border-destructive/35 bg-transparent px-6 font-display text-sm font-semibold text-destructive transition hover:border-destructive/60 hover:bg-destructive/6 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {isCancelling ? "Cancelling..." : "Cancel this ride"}
            </button>
          ) : (
            <p className="text-xs text-ink/55">
              This ride can no longer be cancelled.
            </p>
          )}

          <Link
            href="/rides"
            className="w-fit font-display text-sm font-semibold text-forest underline decoration-mint decoration-2 underline-offset-4 hover:decoration-forest"
          >
            Back to your rides
          </Link>
        </>
      )}
    </Layout>
  );
};

export default RideDetailPage;