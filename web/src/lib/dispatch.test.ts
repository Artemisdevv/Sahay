import { describe, it, expect } from "vitest";
import { buildPayload, defaultProfile, detectPriority, recipients } from "./dispatch";
const incident = {
  type: "medical" as const,
  description: "Unconscious patient",
  location: "Market St",
  landmark: "Floor 4",
  hazards: "None",
  people: 1,
  media: [],
};
describe("Emergency dispatch context", () => {
  it("excludes private medical context without consent", () => {
    expect(buildPayload(defaultProfile, false, incident).medical_context).toBeNull();
  });
  it("merges static profile and live incident with consent", () => {
    const p = buildPayload(defaultProfile, true, incident);
    expect(p.medical_context?.fullName).toBe("Alex Morgan");
    expect(p.incident.people).toBe(1);
  });
  it("routes medical emergencies to hospital agents", () => {
    expect(buildPayload(defaultProfile, true, incident).response_agents).toContain("HospitalAlert");
    expect(recipients("medical")).toBe("City General Hospital ER");
  });
  it("routes fires to fire rescue agents", () => {
    expect(
      buildPayload(defaultProfile, true, { ...incident, type: "fire" }).response_agents,
    ).toContain("FireRescueAlert");
  });
  it("routes rescue to both response teams", () => {
    expect(
      buildPayload(defaultProfile, true, { ...incident, type: "rescue" }).response_agents,
    ).toEqual(["TriageAgent-01", "DispatchRouter-v2", "HospitalAlert", "FireRescueAlert"]);
  });
  it("flags unconscious and severe bleeding as critical", () => {
    expect(detectPriority("Unconscious", "medical")).toBe("Critical");
    expect(detectPriority("Severe Bleeding", "medical")).toBe("Critical");
  });
});
