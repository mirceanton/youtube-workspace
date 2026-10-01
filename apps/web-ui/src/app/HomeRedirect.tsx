import { Compass } from "lucide-react";
import { Navigate } from "react-router";
import { EmptyState } from "@/kit/states.tsx";
import { useSession } from "@/lib/session.ts";
import { navEntriesFor, type FeatureDefinition } from "./features.ts";

/** `/`: send the user to the first screen they may open (the dashboard, once it exists). */
export function HomeRedirect({ features }: { features: readonly FeatureDefinition[] }) {
  const first = navEntriesFor(features, useSession())[0];
  if (first) return <Navigate to={first.to} replace />;
  return (
    <EmptyState
      icon={Compass}
      title="Nothing to show here yet"
      description="No screens are available for your access levels."
    />
  );
}
