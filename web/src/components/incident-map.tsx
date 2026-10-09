import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type ComponentProps,
} from "react";
import { MapPin } from "lucide-react";

// Leaflet touches `window` when it is imported, which crashes server rendering. Load it in the browser only.
const Inner = lazy(() =>
  import("./incident-map-inner").then((m) => ({ default: m.IncidentMap })),
);

export function IncidentMap(props: ComponentProps<typeof Inner>) {
  const [browser, setBrowser] = useState(false);
  useEffect(() => setBrowser(true), []);
  const placeholder = (
    <div className={`incident-map ${props.className ?? ""}`}>
      <div className="map-state">
        <MapPin size={15} /> Loading map…
      </div>
    </div>
  );
  if (!browser) return placeholder;
  return <Suspense fallback={placeholder}>{<Inner {...props} />}</Suspense>;
}
