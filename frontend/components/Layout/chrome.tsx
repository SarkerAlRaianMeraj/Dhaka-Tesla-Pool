"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Footer } from "./footer";
import { Navbar } from "./navbar";

/**
 * Owns the site chrome that `app/layout.tsx` wraps around every route.
 *
 * Three routes render bare, and the reason differs per route:
 *
 * - `/` is the cinematic 3D landing page: its own full-viewport dark stage,
 *   perimeter frame and nav. The global navbar would sit above a hero that already
 *   leads with its own navigation, and the light themed footer would break the
 *   near-black canvas it ends on.
 * - `/dashboard` is a full-height shell with its own 88px navigation rail, so the top
 *   navbar and the footer would both sit outside a layout that already provides its
 *   own navigation - the rail would be a second, competing menu.
 * - `/login` and `/register` are a single focused task on a single centred panel. A
 *   navbar above them competes with the form's own submit button, and a footer below
 *   pushes the panel off centre on a short viewport.
 *
 * Keeping the list here, in one place, is the point: the alternative is a path check
 * duplicated across `navbar.tsx` and `footer.tsx`, or a `:has()` selector hiding global
 * chrome - neither of which is reviewable.
 *
 * The trade-off: `Footer` was a server component so it would ship no client
 * JavaScript, and rendering it from a client component makes it part of the
 * client bundle. It is ~20 lines of static markup next to React, Next's router
 * and the auth provider, which is a cheaper price than a second navigation on
 * one screen or a `:has()` selector hiding global chrome.
 *
 * Named to match its siblings in this folder, which are lower-case.
 */
const BARE_ROUTES = new Set(["/", "/dashboard", "/login", "/register"]);

export const Chrome = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();

  if (BARE_ROUTES.has(pathname)) return <>{children}</>;

  return (
    <>
      <Navbar />
      {children}
      <Footer />
    </>
  );
};