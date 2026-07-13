import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

afterEach(cleanup);

describe("Dialog", () => {
  it("traps keyboard focus inside the dialog", () => {
    render(
      <Dialog open title="Keyboard test" onClose={() => {}}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Dialog>,
    );

    const closeButton = screen.getByRole("button", { name: "Close" });
    const lastButton = screen.getByRole("button", { name: "Last action" });

    expect(document.activeElement).toBe(closeButton);
    lastButton.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(lastButton);
  });

  it("closes on Escape, restores focus, and unlocks body scrolling", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">Open dialog</button>
        <Dialog open={false} title="Restore test" onClose={onClose}>
          Dialog content
        </Dialog>
      </>,
    );
    const opener = screen.getByRole("button", { name: "Open dialog" });
    opener.focus();

    rerender(
      <>
        <button type="button">Open dialog</button>
        <Dialog open title="Restore test" onClose={onClose}>
          Dialog content
        </Dialog>
      </>,
    );
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(
      <>
        <button type="button">Open dialog</button>
        <Dialog open={false} title="Restore test" onClose={onClose}>
          Dialog content
        </Dialog>
      </>,
    );

    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  it("respects the backdrop dismissal policy", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog open title="Backdrop test" onClose={onClose} dismissOnBackdrop={false}>
        Dialog content
      </Dialog>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <Dialog open title="Backdrop test" onClose={onClose} dismissOnBackdrop>
        Dialog content
      </Dialog>,
    );
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
