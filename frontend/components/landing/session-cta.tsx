"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";

/**
 * A session-aware landing CTA.
 *
 * Signed-out visitors go to the given auth route (/login by default, /register
 * for account creation); a signed-in visitor goes straight to /dashboard, which
 * role-branches to the passenger booking screen or the driver home. That single
 * destination keeps the landing honest about the session (D15: the browser has
 * no token, so "am I signed in?" is answered by the /auth/me call the provider
 * makes on load).
 */
export function SessionCta({
  href = "/login",
  label,
  signedInLabel = "Go to dashboard",
  className = "",
  children,
}: {
  href?: string;
  label: string;
  signedInLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const { user } = useAuth();
  const isSignedIn = user !== null;

  return (
    <Link
      href={isSignedIn ? "/dashboard" : href}
      className={className}
      aria-label={isSignedIn ? signedInLabel : label}
    >
      {isSignedIn ? signedInLabel : label}
      {children}
    </Link>
  );
}