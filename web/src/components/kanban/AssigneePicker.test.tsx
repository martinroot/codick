// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssigneePicker } from "@/components/kanban/AssigneePicker";
import { api } from "@/lib/api";
import { kanbanApi, type KanbanRequestOptions } from "@/lib/kanban-api";

// The suite's convention: `react-dom/client` plus `act`, not a testing-library
// dependency this project does not already carry.
let container: HTMLDivElement;
let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const OPTIONS: KanbanRequestOptions = { board: "main" };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function mockProfiles(
  profiles: Array<{ name: string; is_default?: boolean }>,
): void {
  vi.spyOn(api, "getProfiles").mockResolvedValue({
    profiles: profiles.map((p) => ({ is_default: false, ...p })),
  } as never);
}

function draw(node: React.ReactNode): void {
  act(() => root.render(<>{node}</>));
}

const select = (): HTMLSelectElement => {
  const el = container.querySelector("select");
  if (!el) throw new Error("no assignee select rendered");
  return el as HTMLSelectElement;
};

/** Let the profile promise settle inside act(). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function choose(value: string): Promise<void> {
  const el = select();
  el.value = value;
  return act(async () => {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("AssigneePicker", () => {
  it("offers the real profiles, not a free text field", async () => {
    mockProfiles([{ name: "default", is_default: true }, { name: "coder" }]);
    draw(<AssigneePicker taskId="t_1" assignee="default" options={OPTIONS} />);
    await flush();
    const el = select();
    expect(el.value).toBe("default");
    expect(el.querySelector("option[value='coder']")).toBeTruthy();
    // A select cannot accept what is not on the list: that is the whole point.
    expect(el.tagName).toBe("SELECT");
  });

  it("keeps an assignee that is not a profile, and says why", async () => {
    mockProfiles([{ name: "default" }]);
    draw(<AssigneePicker taskId="t_1" assignee="w" options={OPTIONS} />);
    await flush();
    // Not snapped to `default`: the card really does say 'w', and quietly
    // rewriting it would make this control disagree with the board.
    expect(select().value).toBe("w");
    expect(container.textContent).toMatch(/not a Hermes profile/i);
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/profiles/new");
  });

  it("sends a null assignee for unassigned, not an empty string", async () => {
    mockProfiles([{ name: "default" }]);
    const patch = vi
      .spyOn(kanbanApi, "patchTask")
      .mockResolvedValue({ ok: true } as never);
    draw(<AssigneePicker taskId="t_1" assignee="default" options={OPTIONS} />);
    await flush();
    await choose("");
    expect(patch).toHaveBeenCalledWith("t_1", { assignee: null }, OPTIONS);
  });

  it("restores the previous value when the save is refused", async () => {
    mockProfiles([{ name: "default" }, { name: "coder" }]);
    vi.spyOn(kanbanApi, "patchTask").mockRejectedValue(new Error("409"));
    const onSaved = vi.fn();
    draw(
      <AssigneePicker
        taskId="t_1"
        assignee="default"
        options={OPTIONS}
        onSaved={onSaved}
      />,
    );
    await flush();
    await choose("coder");
    expect(container.textContent).toMatch(/not saved/i);
    // The control must not keep showing a write that never happened.
    expect(select().value).toBe("default");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("notifies the board after a successful save", async () => {
    mockProfiles([{ name: "default" }, { name: "coder" }]);
    const patch = vi
      .spyOn(kanbanApi, "patchTask")
      .mockResolvedValue({ ok: true } as never);
    const onSaved = vi.fn();
    draw(
      <AssigneePicker
        taskId="t_1"
        assignee="default"
        options={OPTIONS}
        onSaved={onSaved}
      />,
    );
    await flush();
    await choose("coder");
    expect(patch).toHaveBeenCalledWith("t_1", { assignee: "coder" }, OPTIONS);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("reports a profile list it could not load", async () => {
    vi.spyOn(api, "getProfiles").mockRejectedValue(new Error("500"));
    draw(<AssigneePicker taskId="t_1" assignee="default" options={OPTIONS} />);
    await flush();
    expect(container.textContent).toMatch(/could not load the profile list/i);
  });
});