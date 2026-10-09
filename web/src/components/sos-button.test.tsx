import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SosButton } from "./citizen-portal";

// The SOS must need a deliberate 2 second hold: a tap or a pocket press must never send a report.
describe("SosButton", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const hold = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("sends once after a full 2 second hold", () => {
    const onTrigger = vi.fn();
    render(<SosButton disabled={false} onTrigger={onTrigger} />);
    const button = screen.getByRole("button", { name: /SOS/ });
    fireEvent.keyDown(button, { key: " " });
    hold(1900);
    expect(onTrigger).not.toHaveBeenCalled();
    hold(300);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    hold(3000);
    expect(onTrigger).toHaveBeenCalledTimes(1); // no repeat
  });

  it("does nothing when released early (a tap or a press in a pocket)", () => {
    const onTrigger = vi.fn();
    render(<SosButton disabled={false} onTrigger={onTrigger} />);
    const button = screen.getByRole("button", { name: /SOS/ });
    fireEvent.keyDown(button, { key: "Enter" });
    hold(1500);
    fireEvent.keyUp(button, { key: "Enter" });
    hold(3000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it("ignores key repeat and does not work while a report is being saved", () => {
    const onTrigger = vi.fn();
    const { rerender } = render(
      <SosButton disabled={true} onTrigger={onTrigger} />,
    );
    const button = screen.getByRole("button", { name: /SOS/ });
    fireEvent.keyDown(button, { key: " " });
    hold(3000);
    expect(onTrigger).not.toHaveBeenCalled();
    rerender(<SosButton disabled={false} onTrigger={onTrigger} />);
    fireEvent.keyDown(button, { key: " " });
    fireEvent.keyDown(button, { key: " ", repeat: true });
    hold(2100);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });
});
