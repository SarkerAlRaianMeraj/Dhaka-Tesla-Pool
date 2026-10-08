import type { Metadata } from "next";
import { LandingPage } from "@/components/landing/landing-page";

export const metadata: Metadata = {
  title: "Dhaka Tesla Pool — Share a seat. Split the fare.",
  description:
    "Explore shared-seat Tesla rides in Dhaka. Compatible routes, upfront fares, and seats held with care.",
  openGraph: {
    title: "Dhaka Tesla Pool — Share a seat. Split the fare.",
    description: "One Tesla, a shared route, and an honest fare. Discover the Dhaka Tesla Pool.",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
};

const Home = () => <LandingPage />;

export default Home;