import { TelegramCallerService } from "./telegram-caller.service";
import type { CopilotConfig } from "../config/configuration";

const EMPLOYEE_ROLE = "role-employee";

const config = {
  ucode: { projectId: "project-1" },
  hrms: { employeeRoleId: EMPLOYEE_ROLE },
} as CopilotConfig;

const row = (extra: Record<string, unknown>) => ({
  telegram_chat_id: "777",
  first_name: "Нурмухаммад",
  second_name: "Махмудов",
  ...extra,
});

const build = (rows: Array<Record<string, unknown>>) => {
  const ucode = {
    request: jest.fn(async (_ctx, _method, path: string) =>
      path.startsWith("/v2/items/companies/")
        ? { data: { response: { name: `Компания ${path.split("/").pop()}` } } }
        : { data: { response: rows } },
    ),
  };
  return new TelegramCallerService(ucode as never, config);
};

describe("identities", () => {
  it("offers one record per company, preferring the employee card", async () => {
    // Live data: this person holds two cards in the same company — one as an
    // employee, one as an admin. Unfiltered that is two identical buttons in
    // the picker, and whichever is tapped is a coin toss nobody can see.
    const service = build([
      row({ guid: "u1", companies_id: "co-1", role_id: "role-admin" }),
      row({ guid: "u2", companies_id: "co-1", role_id: EMPLOYEE_ROLE }),
      row({ guid: "u3", companies_id: "co-2", role_id: EMPLOYEE_ROLE }),
    ]);

    const identities = await service.identities("777");

    expect(identities).toHaveLength(2);
    // The employee card wins: leave, attendance and payroll hang off that one.
    expect(identities[0].caller.userId).toBe("u2");
    expect(identities[1].caller.userId).toBe("u3");
  });

  it("refuses rows the backend handed back despite the filter", async () => {
    // ucode silently drops a filter naming a column it does not know, and this
    // request runs under the service key across every company.
    const service = build([
      row({ guid: "u1", companies_id: "co-1", telegram_chat_id: "999" }),
    ]);

    expect(await service.identities("777")).toEqual([]);
  });

  it("skips a record with no company, which could not be scoped anyway", async () => {
    const service = build([row({ guid: "u1", companies_id: "" })]);

    expect(await service.identities("777")).toEqual([]);
  });

  it("carries the person's name for the prompt, and the service flag", async () => {
    const service = build([
      row({ guid: "u1", companies_id: "co-1", role_id: EMPLOYEE_ROLE }),
    ]);

    const [identity] = await service.identities("777");

    expect(identity.caller.person).toEqual({
      name: "Махмудов Нурмухаммад",
      surface: "telegram",
    });
    expect(identity.caller.service).toBe(true);
    expect(identity.caller.token).toBe("");
  });
});
