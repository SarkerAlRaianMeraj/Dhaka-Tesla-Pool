"use client";

/*
 * The footer's CTA pair, which knows whether a visitor is signed in.
 *
 * Signed out: "Create account" to /register and "Sign in" to /login, matching
 * the spec's visual pair. Signed in: "Go to dashboard" (role-branched) and
 * "Sign out", which clears the httpOnly cookie and returns to the landing.
 * The guest pair is the server-rendered default; it flips to the signed-in pair
 * once the provider's /auth/me check settles, so a signed-in visitor is relabelled
 * rather than blocked while the session is being looked up.
 */
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useCallback } from "react";
import { useAuth } from "@/lib/auth-context";

export function FooterActions() {
  const { user, logout } = useAuth();
  const onSignOut = useCallback(() => void logout(), [logout]);

  return user ? (
    <>
      <Link href="/dashboard" className="landing-btn landing-btn-white">
        Go to dashboard
      </Link>
      <button
        type="button"
        onClick={onSignOut}
        className="landing-btn landing-btn-dark-outline"
      >
        Sign out
      </button>
    </>
  ) : (
    <>
      <Link href="/register" className="landing-btn landing-btn-white">
        Create account
        <ArrowUpRight size={18} />
      </Link>
      <Link href="/login" className="landing-btn landing-btn-dark-outline">
        Sign in
      </Link>
    </>
  );
}