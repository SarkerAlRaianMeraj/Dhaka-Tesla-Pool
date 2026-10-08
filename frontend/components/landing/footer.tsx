/*
 * Footer from the spec (§4): dark green block with the closing question, CTA
 * pair and the bottom bar. The two CTAs are session-aware (FooterActions): a
 * guest is sent to the real /register and /login pages, a signed-in visitor to
 * /dashboard or straight out via /auth/logout.
 */
import { FooterActions } from "./footer-actions";

export function Footer() {
  return (
    <footer className="landing-footer">
      <div className="page-container">
        <p className="landing-footer-eyebrow">Dhaka · A shared way forward</p>
        <h2 className="landing-footer-h2">A city in motion?</h2>
        <p className="landing-footer-copy">
          Your route is inside it. Share a seat, and keep the city moving.
        </p>

        <div className="landing-footer-actions">
          <FooterActions />
        </div>

        <div className="landing-footer-bar">
          <span className="landing-footer-brand">Dhaka Tesla Pool</span>
          <span>Shared-seat Tesla rides across Dhaka</span>
        </div>
      </div>
    </footer>
  );
}