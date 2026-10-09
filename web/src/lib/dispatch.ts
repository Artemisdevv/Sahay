export const defaultProfile = {
  fullName: "Alex Morgan",
  bloodGroup: "O+",
  age: "32",
  language: "English",
  contactName: "Jordan Morgan",
  relation: "Spouse",
  phone: "+1 (415) 555-0148",
  conditions: "Asthma",
  allergies: "Penicillin",
  medications: "Albuterol inhaler",
  devices: "None",
  address: "124 Market Street, San Francisco, CA",
  access: "Apartment 4B · Gate code 2048",
  mobility: "None",
};
export type EmergencyProfile = typeof defaultProfile;
export type IncidentType = "medical" | "fire" | "rescue" | "other";
export function detectPriority(description: string, type: IncidentType) {
  return /unconscious|severe bleeding|trapped|gas leak|not breathing/i.test(description)
    ? "Critical"
    : type === "fire" || type === "rescue" || /smoke|chest pain/i.test(description)
      ? "High"
      : description.trim()
        ? "Standard"
        : "Pending assessment";
}
export function buildPayload(
  profile: EmergencyProfile,
  consent: boolean,
  incident: {
    type: IncidentType;
    description: string;
    location: string;
    landmark: string;
    hazards: string;
    people: number;
    media: string[];
  },
) {
  return {
    mode: "simulation",
    medical_context: consent ? profile : null,
    sharing_consent: consent,
    incident: { ...incident, priority: detectPriority(incident.description, incident.type) },
    response_agents:
      incident.type === "medical"
        ? ["TriageAgent-01", "DispatchRouter-v2", "HospitalAlert"]
        : incident.type === "fire"
          ? ["TriageAgent-01", "DispatchRouter-v2", "FireRescueAlert"]
          : incident.type === "rescue"
            ? ["TriageAgent-01", "DispatchRouter-v2", "HospitalAlert", "FireRescueAlert"]
            : ["TriageAgent-01", "DispatchRouter-v2", "ServiceCoordinator"],
  };
}
export function recipients(type: IncidentType) {
  return type === "medical"
    ? "City General Hospital ER"
    : type === "fire"
      ? "Metro Fire Station 4"
      : type === "rescue"
        ? "City General Hospital ER and Metro Fire Station 4"
        : "Community Assistance Team";
}
export function pageHead(title: string, description: string) {
  return {
    meta: [
      { title: `${title} — Aegis Dispatch` },
      { name: "description", content: description },
      { property: "og:title", content: `${title} — Aegis Dispatch` },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  };
}
