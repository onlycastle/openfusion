import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

const { harnessStatusMock, harnessReadMock, updateModelMock, updateEscMock, listConfigsMock, cardUpdateMock, cardApproveMock } = vi.hoisted(() => ({
  harnessStatusMock: vi.fn(), harnessReadMock: vi.fn(), updateModelMock: vi.fn(), updateEscMock: vi.fn(), listConfigsMock: vi.fn(),
  cardUpdateMock: vi.fn(), cardApproveMock: vi.fn(),
}));
vi.mock("../engineClient", () => ({
  engineClient: {
    harnessStatus: harnessStatusMock, harnessRead: harnessReadMock,
    harnessUpdateAgentModel: updateModelMock, harnessUpdateEscalation: updateEscMock,
    harnessCardUpdate: cardUpdateMock, harnessCardApprove: cardApproveMock,
  },
  listProviderConfigs: listConfigsMock,
}));
vi.mock("../ProjectContext", () => ({ useProject: () => ({ activeProjectDir: "/r/alpha" }) }));

import { HarnessSettingPanel } from "./HarnessSettingPanel";

afterEach(cleanup);
beforeEach(() => {
  for (const m of [harnessStatusMock, harnessReadMock, updateModelMock, updateEscMock, listConfigsMock, cardUpdateMock, cardApproveMock]) m.mockReset();
  harnessStatusMock.mockResolvedValue({ present: true, structural: "pass", headSha: "abc", card: null });
  harnessReadMock.mockResolvedValue({
    agents: [
      { name: "coder", role: "writes code", taskClasses: ["codegen"], model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" } },
      { name: "fallback", role: "default", taskClasses: ["docs"], model: "frontier" },
    ],
    defaultAgent: "fallback", escalation: 2, card: null,
  });
  listConfigsMock.mockResolvedValue([
    { id: "deepseek", kind: "deepseek", model: "deepseek-v4-flash" },
    { id: "moonshot", kind: "moonshot", model: "kimi-k2.7-code" },
  ]);
  updateModelMock.mockResolvedValue({ updated: true });
  updateEscMock.mockResolvedValue({ updated: true });
  cardUpdateMock.mockResolvedValue(undefined);
  cardApproveMock.mockResolvedValue(undefined);
});

const draftCard = { digest: "This project is a CLI tool for X.", body: "# Project Card\n\nThis project is a CLI tool for X.\n\n## Stripped at generation\n\n- secrets.json", state: "draft" as const };
const approvedCard = { ...draftCard, state: "approved" as const };

describe("HarnessSettingPanel", () => {
  it("renders the agent team with model selects once ready", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    expect(screen.getByText("fallback")).toBeTruthy();
    // task-class chips are read-only text
    expect(screen.getByText("codegen")).toBeTruthy();
  });

  it("reassigns an agent's model on select change (optimistic)", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    const select = screen.getByLabelText(/model for coder/i);
    fireEvent.change(select, { target: { value: "moonshot" } });
    await waitFor(() => expect(updateModelMock).toHaveBeenCalledWith(
      "/r/alpha", "coder", { kind: "moonshot", model: "kimi-k2.7-code", providerId: "moonshot" },
    ));
  });

  it("updates escalation on change", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/escalate to frontier/i), { target: { value: "3" } });
    await waitFor(() => expect(updateEscMock).toHaveBeenCalledWith("/r/alpha", 3));
  });

  it("shows a generate prompt when no harness exists", async () => {
    harnessStatusMock.mockResolvedValue({ present: false, structural: "pass", headSha: "abc", card: null });
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText(/no harness yet/i)).toBeTruthy());
  });

  it("renders no Project card section when team.card is null", async () => {
    render(<HarnessSettingPanel />);
    await waitFor(() => expect(screen.getByText("coder")).toBeTruthy());
    expect(screen.queryByText("Project card")).toBeNull();
  });

  describe("project card", () => {
    beforeEach(() => {
      harnessReadMock.mockResolvedValue({
        agents: [
          { name: "coder", role: "writes code", taskClasses: ["codegen"], model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" } },
          { name: "fallback", role: "default", taskClasses: ["docs"], model: "frontier" },
        ],
        defaultAgent: "fallback", escalation: 2, card: draftCard,
      });
    });

    it("renders the draft card section with a Draft badge, editable textarea, and enabled Approve", async () => {
      render(<HarnessSettingPanel />);
      await waitFor(() => expect(screen.getByText("Project card")).toBeTruthy());
      expect(screen.getByText("Draft")).toBeTruthy();
      const textarea = screen.getByLabelText("Project card digest") as HTMLTextAreaElement;
      expect(textarea.value).toBe(draftCard.digest);
      expect(textarea.disabled).toBe(false);
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
      // Save draft starts disabled — textarea untouched.
      expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(true);
      // Full card detail is present but collapsed behind <details>.
      expect(screen.getByText("Full card")).toBeTruthy();
    });

    it("typing in the textarea disables Approve and enables Save draft", async () => {
      render(<HarnessSettingPanel />);
      await waitFor(() => expect(screen.getByText("Project card")).toBeTruthy());
      const textarea = screen.getByLabelText("Project card digest");
      fireEvent.change(textarea, { target: { value: "Edited digest text." } });
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("Save draft calls harnessCardUpdate with the edited text then reloads", async () => {
      cardUpdateMock.mockResolvedValue(undefined);
      render(<HarnessSettingPanel />);
      await waitFor(() => expect(screen.getByText("Project card")).toBeTruthy());
      const textarea = screen.getByLabelText("Project card digest");
      fireEvent.change(textarea, { target: { value: "Edited digest text." } });
      fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
      await waitFor(() => expect(cardUpdateMock).toHaveBeenCalledWith("/r/alpha", "Edited digest text."));
      // reconcile-by-reload: harnessRead called again after the save.
      await waitFor(() => expect(harnessReadMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    });

    it("Approve calls harnessCardApprove and after reload shows Approved badge + disabled textarea", async () => {
      cardApproveMock.mockResolvedValue(undefined);
      render(<HarnessSettingPanel />);
      await waitFor(() => expect(screen.getByText("Project card")).toBeTruthy());
      harnessReadMock.mockResolvedValue({
        agents: [
          { name: "coder", role: "writes code", taskClasses: ["codegen"], model: { kind: "deepseek", model: "deepseek-v4-flash", providerId: "deepseek" } },
          { name: "fallback", role: "default", taskClasses: ["docs"], model: "frontier" },
        ],
        defaultAgent: "fallback", escalation: 2, card: approvedCard,
      });
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(cardApproveMock).toHaveBeenCalledWith("/r/alpha"));
      await waitFor(() => expect(screen.getByText("Approved")).toBeTruthy());
      const textarea = screen.getByLabelText("Project card digest") as HTMLTextAreaElement;
      expect(textarea.disabled).toBe(true);
    });

    it("a failing approve shows an error message and stays draft", async () => {
      cardApproveMock.mockRejectedValue(new Error("card not approvable"));
      render(<HarnessSettingPanel />);
      await waitFor(() => expect(screen.getByText("Project card")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("card not approvable"));
      expect(screen.getByText("Draft")).toBeTruthy();
    });
  });
});
