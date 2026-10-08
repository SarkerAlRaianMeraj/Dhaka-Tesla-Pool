"use client";

/*
 * Sticky glass header from the spec (§4): logo mark + brand, center nav to the
 * pool sections, the "Book a seat" pill and a mobile hamburger that toggles a
 * wrapping nav row with a top border.
 */
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { SessionCta } from "./session-cta";

const NAV = [
  { label: "The route", href: "#route" },
  { label: "How it works", href: "#how" },
  { label: "Fare", href: "#fare" },
];

export function Header() {
  const [open, setOpen] = useState(false);

  return (
    <header className="landing-header">
      <div className="page-container landing-header-inner">
        <a href="#" className="landing-logo" aria-label="Dhaka Tesla Pool - home">
          <span className="landing-logo-mark">T</span>
          <span className="landing-brand">Dhaka Tesla Pool</span>
        </a>

        <nav className="landing-nav" aria-label="Landing">
          {NAV.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <div className="landing-header-actions">
          <SessionCta
            href="/login"
            label="Book a seat"
            signedInLabel="Your dashboard"
            className="landing-pill-btn"
          />
          <button
            type="button"
            className="landing-icon-btn"
            aria-expanded={open}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="page-container landing-mobile-nav">
          {NAV.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
              {item.label}
            </a>
          ))}
        </div>
      )}
    </header>
  );
}