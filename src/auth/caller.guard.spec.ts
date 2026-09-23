import type { ExecutionContext } from "@nestjs/common";
import { CallerGuard } from "./caller.guard";
import type { CallerService } from "./caller.service";
import type { CopilotConfig } from "../config/configuration";

const config = {
  ucode: { projectId: "configured-project" },
} as CopilotConfig;

const PANEL_PROJECT = "9a462573-ce11-4288-928a-a6ba754b6998";

/** A request with the headers under test, in the shape Nest hands the guard. */
const contextWith = (headers: Record<string, unknown>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

const guardWith = (): { guard: CallerGuard; resolve: jest.Mock } => {
  const resolve = jest.fn(async (_token: string, projectId: string) => ({
    userId: "u1",
    companiesId: "c1",
    projectId,
    token: "t",
  }));
  return {
    guard: new CallerGuard({ resolve } as unknown as CallerService, config),
    resolve,
  };
};

describe("CallerGuard: which project the caller is scoped to", () => {
  it("takes the project the panel names", async () => {
    const { guard, resolve } = guardWith();

    await guard.canActivate(
      contextWith({ authorization: "Bearer tok", "project-id": PANEL_PROJECT }),
    );

    expect(resolve).toHaveBeenCalledWith("tok", PANEL_PROJECT);
  });

  it("falls back to the configured project when the panel sends none", async () => {
    // The panel that is live right now. Without this fallback, shipping the
    // service before rebuilding the panel takes the Copilot down between the
    // two deploys.
    const { guard, resolve } = guardWith();

    await guard.canActivate(contextWith({ authorization: "Bearer tok" }));

    expect(resolve).toHaveBeenCalledWith("tok", "configured-project");
  });

  it("refuses a project id that is not one", async () => {
    // It is pasted into a query string, so it is shape-checked here. Whether
    // the caller may touch the project is ucode's decision, not ours.
    const { guard } = guardWith();

    await expect(
      guard.canActivate(
        contextWith({ authorization: "Bearer tok", "project-id": "../evil" }),
      ),
    ).rejects.toThrow(/must be a uuid/);
  });

  it("treats a blank header as absent rather than as a project", async () => {
    const { guard, resolve } = guardWith();

    await guard.canActivate(
      contextWith({ authorization: "Bearer tok", "project-id": "   " }),
    );

    expect(resolve).toHaveBeenCalledWith("tok", "configured-project");
  });

  it("still demands a bearer token", async () => {
    const { guard } = guardWith();

    await expect(
      guard.canActivate(contextWith({ "project-id": PANEL_PROJECT })),
    ).rejects.toThrow(/Bearer token required/);
  });
});
