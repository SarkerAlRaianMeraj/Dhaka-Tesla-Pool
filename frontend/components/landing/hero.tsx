/*
 * Hero from the spec (§4): badge + headline + copy + actions on the left, the
 * illustrated rickshaw photograph on the right. Both halves get the `arrival`
 * fade-up. All booking actions open the disclaimer dialog.
 */
import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import { SessionCta } from "./session-cta";

export function Hero() {
  return (
    <section className="landing-hero" aria-label="Hero">
      <div className="page-container landing-hero-grid">
        <div className="arrival">
          <p className="landing-badge">
            <span className="landing-badge-dot" aria-hidden />
            Shared-seat Tesla rides · Dhaka
          </p>

          <h1 className="landing-h1">
            Share a seat.
            <br />
            Split the fare.
          </h1>

          <p className="landing-hero-copy">
            One Tesla, several riders, one honest split along the route. No surge,
            no guessing — just the seat you need and the fare you pay.
          </p>

          <div className="landing-hero-actions">
            <SessionCta
              href="/login"
              label="Book a seat"
              signedInLabel="Your dashboard"
              className="landing-btn landing-btn-primary"
            >
              <ArrowUpRight size={18} />
            </SessionCta>
            <a href="#how" className="landing-btn landing-btn-outline">
              How the pool works
            </a>
          </div>
        </div>

        <div className="arrival">
          <Image
            src="/tesla-rickshaw.jpg"
            alt="Illustrated white electric three-wheeler on a leafy Gulshan avenue at golden hour"
            width={1024}
            height={1280}
            priority
            sizes="(max-width: 1023px) 100vw, 560px"
            className="hero-photo"
          />
        </div>
      </div>
    </section>
  );
}