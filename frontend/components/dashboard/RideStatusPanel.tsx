"use client";

import Link from "next/link";
import type { Ride, RideStatus } from "@/lib/types";

/**
 * The four stages the design's progress track showed.
 *
 * They are mapped from the API's `RideStatus` union rather than invented, so the
 * track cannot claim a stage the server does not have. `ACCEPTED` and
 * `DRIVER_ARRIVED` are internal steps of "Arrived" from a passenger's point of
 * view: nobody needs to be told a driver accepted before they need to know the
 * driver is at the door.
 */
const STAGES: { label: string; reached: RideStatus[] }[] = [
  { label: "Requested", reached: ["REQUESTED"] },
  { label: "Matched", reached: ["MATCHED", "ACCEPTED"] },
  { label: "Arrived", reached: ["DRIVER_ARRIVED"] },
  { label: "Started", reached: ["STARTED", "COMPLETED"] },
];

const stageIndexFor = (status: RideStatus): number => {
  const index = STAGES.findIndex((stage) => stage.reached.includes(status));
  return index === -1 ? 0 : index;
};

/**
 * The one line that names where the trip stands without a named driver.
 *
 * `Ride` still carries no driver until a full assignment exists, so the avatar
 * and ETA stay "—". But Phase 4 gives the ride states the line used to lie about:
 * "No driver assigned yet" is false once a Tesla has been matched or a seat
 * taken, and the centre of the panel is the cheapest place to say so.
 */
const assignmentLabelFor = (status: RideStatus): string => {
  switch (status) {
    case "MATCHED":
      return "A Tesla has room for this ride";
    case "ACCEPTED":
      return "You have a seat aboard a Tesla";
    case "DRIVER_ARRIVED":
      return "A driver is at the door";
    case "STARTED":
      return "Your trip is under way";
    case "COMPLETED":
      return "Trip complete";
    default:
      return "No driver assigned yet";
  }
};

/**
 * Where the passenger's current trip has got to.
 *
 * A ride reaches `REQUESTED` when made, `MATCHED` once an online Tesla has room
 * for it, and `ACCEPTED` when a driver begins carrying it — so the track can
 * complete two stages in Phase 4. The design filled this panel with a named
 * driver, a plate, a star rating and a 4-minute ETA; none of that has a data
 * source, because `Ride` carries no driver until a full assignment exists.
 * Showing "—" is the honest answer, and inventing a driver on a signed-in
 * screen would be worse than an empty field.
 */
export const RideStatusPanel = ({ ride }: { ride: Ride | undefined }) => {
  if (!ride) {
    return (
      <section
        aria-labelledby="status-heading"
        className="animate-rise rounded-[26px] border border-ink/6 bg-white px-[27px] py-[23px] shadow-[0_20px_48px_color-mix(in_oklab,var(--color-ink)_5%,transparent)]"
        style={{ animationDelay: "0.16s" }}
      >
        <div className="mb-[17px] text-center">
          <p className="text-[10px] font-bold tracking-[.18em] text-forest/55 uppercase">
            Ride status
          </p>
          <h2
            id="status-heading"
            className="mt-1 font-display text-[17px] font-semibold text-ink"
          >
            Ready to request
          </h2>
          <p className="mt-1 text-[10px] font-bold tracking-[.08em] text-mint uppercase">
            3 seats open
          </p>
        </div>
        <p className="text-center text-sm text-forest/50">
          Plan a route above and your request appears here with live status.
        </p>
      </section>
    );
  }

  const currentStage = stageIndexFor(ride.status);

  return (
    <section
      aria-labelledby="status-heading"
      className="animate-rise rounded-[26px] border border-ink/6 bg-white px-[27px] py-[23px] shadow-[0_20px_48px_color-mix(in_oklab,var(--color-ink)_5%,transparent)]"
      style={{ animationDelay: "0.16s" }}
    >
      <div className="mb-[17px] text-center">
        <p className="text-[10px] font-bold tracking-[.18em] text-forest/55 uppercase">
          Ride status
        </p>
        <h2
          id="status-heading"
          className="mt-1 font-display text-[17px] font-semibold text-ink"
        >
          {/* The API's plain-language label, never the raw enum. */}
          {ride.statusLabel}
        </h2>
        <p className="mt-1 text-[10px] font-bold tracking-[.08em] text-mint uppercase">
          {ride.seatsRequested} {ride.seatsRequested === 1 ? "seat" : "seats"}{" "}
          requested
        </p>
      </div>

      <div className="flex items-center gap-[13px]">
        <div className="relative">
          <span className="grid size-[46px] place-items-center rounded-full bg-forest/7 font-display font-bold text-forest">
            <span aria-hidden>&mdash;</span>
          </span>
          <span className="absolute right-px bottom-px size-[10px] rounded-full border-[3px] border-white bg-mint" />
        </div>
        <div>
          <p className="text-sm font-semibold text-ink">
            {assignmentLabelFor(ride.status)}
          </p>
          <p className="text-[11px] text-forest/50">
            {ride.pickupZone.name} &rarr; {ride.destinationZone.name}
          </p>
        </div>
        <div className="ml-auto text-right">
          <p className="text-[9px] font-bold text-forest/45 uppercase">ETA</p>
          <p className="font-display text-[16px] text-ink">&mdash;</p>
        </div>
      </div>

      <ol className="mt-[21px] grid grid-cols-4">
        {STAGES.map((stage, index) => {
          const complete = index <= currentStage;
          const isCurrent = index === currentStage;
          return (
            <li key={stage.label} className="relative flex flex-col items-center">
              {/*
                The connector sits between dots and stops short of the next one.
                The final stage has no outgoing connector, so it is skipped.
              */}
              {index < STAGES.length - 1 ? (
                <span
                  aria-hidden
                  className={[
                    "absolute top-1 left-[7px] h-0.5 w-[calc(100%-5px)]",
                    index < currentStage ? "bg-mint" : "bg-forest/9",
                  ].join(" ")}
                />
              ) : null}
              <span
                aria-hidden
                className={[
                  "relative z-10 size-[10px] rounded-full border-2 border-white",
                  complete
                    ? "bg-mint"
                    : "bg-forest/18 shadow-[0_0_0_1px_color-mix(in_oklab,var(--color-forest)_10%,transparent)]",
                ].join(" ")}
              />
              <span
                className={[
                  "mt-1.5 text-[9px]",
                  complete
                    ? "font-bold text-forest"
                    : "text-forest/45",
                  isCurrent ? "underline decoration-mint decoration-2 underline-offset-2" : "",
                ].join(" ")}
              >
                {stage.label}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="mt-4 text-center text-xs text-forest/50">
        <Link className="link" href={`/rides/${ride.id}`}>
          Open this ride
        </Link>
      </p>
    </section>
  );
};