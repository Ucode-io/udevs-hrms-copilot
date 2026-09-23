import { UcodeClient } from "./ucode.client";
import type { CopilotConfig } from "../config/configuration";
import type { CallerContext } from "./ucode.types";

const config: CopilotConfig = {
  port: 8080,
  corsOrigins: [],
  anthropicApiKey: null,
  model: "claude-sonnet-5",
  effort: "high",
  maxConcurrentStreams: 2,
  billing: { serviceSecret: null, quotaCacheMs: 30_000 },
  ucode: {
    baseUrl: "https://ucode.test",
    projectId: "project-1",
    environmentId: "env-1",
    serviceApiKey: "service-key",
  },
  hrms: {
    employeeRoleId: "role-employee",
    clientTypeId: "client-type-1",
    reportsFunction: "reports-fn",
    billingFunction: "billing-fn",
  },
  telegram: {
    botToken: null,
    webhookSecret: null,
    hickvisionFunction: "hickvision-fn",
    webUrl: null,
  },
};

const caller: CallerContext = {
  userId: "user-1",
  companiesId: "company-a",
  projectId: "project-1",
  token: "caller-token",
};

/** Captures what the client put on the wire, and replays canned responses. */
const mockFetch = (
  handler: (url: URL, init: RequestInit) => unknown,
): jest.Mock => {
  const fn = jest.fn(async (input: URL | string, init: RequestInit = {}) => {
    const body = handler(new URL(String(input)), init);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn as unknown as jest.Mock;
};

/**
 * The schema endpoint's shape: live Postgres columns, not ucode field
 * descriptors. The client reads columns from here because `/v2/fields` sits
 * behind the gateway's admin middleware and rejects an app user's token.
 */
const schemaResponse = {
  data: {
    data: {
      columns: [
        { name: "guid", type: "uuid" },
        { name: "first_name", type: "character varying" },
        { name: "birth_date", type: "date" },
        { name: "status", type: "text[]" },
        { name: "departments_id", type: "uuid" },
        { name: "companies_id", type: "uuid" },
        { name: "deleted_at", type: "timestamp without time zone" },
      ],
    },
  },
};

describe("UcodeClient", () => {
  let client: UcodeClient;

  beforeEach(() => {
    client = new UcodeClient(config);
  });

  describe("list", () => {
    it("scopes every query to the caller's Company", async () => {
      // The HRMS SPA adds companies_id in a browser interceptor, so the backend
      // does not enforce it. A list that forgot it would span every company and
      // still look like a normal result.
      let listUrl: URL | null = null;
      mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        listUrl = url;
        return { data: { data: { count: 0, response: [] } } };
      });

      await client.list(caller, "user_base", {});

      const data = JSON.parse(listUrl!.searchParams.get("data")!);
      expect(data.companies_id).toBe("company-a");
      expect(listUrl!.searchParams.get("companies_id")).toBe("company-a");
    });

    it("forwards the caller's own bearer token", async () => {
      let headers: Record<string, string> = {};
      mockFetch((url, init) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        headers = init.headers as Record<string, string>;
        return { data: { data: { count: 0, response: [] } } };
      });

      await client.list(caller, "user_base", {});

      expect(headers.Authorization).toBe("Bearer caller-token");
    });

    it("cannot be talked into another Company by a filter", async () => {
      // The tenant scope is written after the compiled filters precisely so a
      // model-supplied companies_id cannot win.
      let listUrl: URL | null = null;
      mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        listUrl = url;
        return { data: { data: { count: 0, response: [] } } };
      });

      await client.list(caller, "user_base", {
        filters: [{ field: "companies_id", op: "eq", value: "company-b" }],
      });

      const data = JSON.parse(listUrl!.searchParams.get("data")!);
      expect(data.companies_id).toBe("company-a");
    });
  });

  describe("getOne", () => {
    it("hides a row belonging to another Company", async () => {
      // The by-guid endpoint takes the id at face value, so the check has to
      // happen here.
      mockFetch(() => ({
        data: { data: { response: { guid: "x", companies_id: "company-b" } } },
      }));

      await expect(client.getOne(caller, "user_base", "x")).resolves.toBeNull();
    });

    it("returns a row from the caller's own Company", async () => {
      mockFetch(() => ({
        data: { data: { response: { guid: "x", companies_id: "company-a" } } },
      }));

      await expect(client.getOne(caller, "user_base", "x")).resolves.toEqual({
        guid: "x",
        companies_id: "company-a",
      });
    });
  });

  describe("aggregate", () => {
    it("always scopes the generated SQL to the Company and to live rows", async () => {
      // The aggregation path builds its own statement and does not inherit the
      // `deleted_at IS NULL` the item endpoints add.
      let payload: Record<string, unknown> = {};
      mockFetch((url, init) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        payload = (JSON.parse(String(init.body)) as { data: Record<string, unknown> })
          .data;
        return { data: { data: { data: [] } } };
      });

      await client.aggregate(caller, "user_base", {
        groupBy: ["departments_id"],
        metrics: [{ fn: "count", alias: "total" }],
      });

      expect(payload.where).toContain(`"companies_id" = 'company-a'`);
      expect(payload.where).toContain(`"deleted_at" IS NULL`);
      expect(payload.columns).toEqual([`"departments_id"`, `COUNT(*) AS "total"`]);
    });

    it("escapes a quote in a filter value instead of breaking out of the literal", async () => {
      // `where` is raw SQL with no bind parameters, so this is the one place a
      // value could change the statement's shape.
      let payload: Record<string, unknown> = {};
      mockFetch((url, init) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        payload = (JSON.parse(String(init.body)) as { data: Record<string, unknown> })
          .data;
        return { data: { data: { data: [] } } };
      });

      await client.aggregate(caller, "user_base", {
        metrics: [{ fn: "count", alias: "total" }],
        filters: [{ field: "first_name", op: "eq", value: "O'Brien" }],
      });

      expect(payload.where).toContain(`'O''Brien'`);
    });

    it("overlaps an array column instead of comparing it to a bare string", async () => {
      // status/gender/language are Postgres arrays. `"status" = 'active'` makes
      // the server parse 'active' as an array literal and the whole aggregation
      // dies with a 500 — which reads to the person as "grouping is broken".
      let payload: Record<string, unknown> = {};
      mockFetch((url, init) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        payload = (JSON.parse(String(init.body)) as { data: Record<string, unknown> })
          .data;
        return { data: { data: { data: [] } } };
      });

      await client.aggregate(caller, "user_base", {
        groupBy: ["departments_id"],
        metrics: [{ fn: "count", alias: "total" }],
        filters: [{ field: "status", op: "eq", value: "active" }],
      });

      expect(payload.where).toContain(`"status"::text[] && ARRAY['active']::text[]`);
    });

    it("refuses to order an array column", async () => {
      mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        return { data: { data: { data: [] } } };
      });

      await expect(
        client.aggregate(caller, "user_base", {
          metrics: [{ fn: "count", alias: "total" }],
          filters: [{ field: "status", op: "gt", value: "active" }],
        }),
      ).rejects.toThrow(/list of values/);
    });

    it("rejects an unknown column rather than generating SQL for it", async () => {
      mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        return { data: { data: { data: [] } } };
      });

      await expect(
        client.aggregate(caller, "user_base", {
          groupBy: ["age"],
          metrics: [{ fn: "count", alias: "total" }],
        }),
      ).rejects.toThrow(/Unknown column/);
    });
  });

  describe("writes", () => {
    it("wraps a single value written to an array column", async () => {
      // "dismiss this employee" means status: "dismissed" to a model, but the
      // column holds ["dismissed"]. A bare string leaves a row that no query
      // filtering on status will ever match again.
      let payload: Record<string, unknown> = {};
      mockFetch((url, init) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        payload = (JSON.parse(String(init.body)) as { data: Record<string, unknown> })
          .data;
        return { data: { data: { response: {} } } };
      });

      await client.update(caller, "user_base", "e1", { status: "dismissed" });

      expect(payload.status).toEqual(["dismissed"]);
    });

    it("refuses a list written to a single-value column", async () => {
      mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        return { data: { data: { response: {} } } };
      });

      await expect(
        client.update(caller, "user_base", "e1", { first_name: ["А", "Б"] }),
      ).rejects.toThrow(/single value/);
    });
  });

  describe("field cache", () => {
    it("fetches a table's schema once", async () => {
      const fetchMock = mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        return { data: { data: { count: 0, response: [] } } };
      });

      await client.list(caller, "user_base", {});
      await client.list(caller, "user_base", {});

      const schemaCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/schema"),
      );
      expect(schemaCalls).toHaveLength(1);
    });

    it("does not hand one project the schema cached for another", async () => {
      // Two projects can both have a user_base with different columns. Sharing
      // the entry does not fail — it filters on columns that are not there.
      const fetchMock = mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        return { data: { data: { count: 0, response: [] } } };
      });

      await client.list(caller, "user_base", {});
      await client.list({ ...caller, projectId: "project-2" }, "user_base", {});

      const schemaCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("/schema"),
      );
      expect(schemaCalls).toHaveLength(2);
    });
  });

  describe("project scoping", () => {
    it("sends the caller's project, not the configured one", async () => {
      const fetchMock = mockFetch((url) => {
        if (url.pathname.endsWith("/schema")) return schemaResponse;
        return { data: { data: { count: 0, response: [] } } };
      });

      await client.list({ ...caller, projectId: "project-9" }, "user_base", {});

      for (const call of fetchMock.mock.calls) {
        expect(new URL(String(call[0])).searchParams.get("project-id")).toBe(
          "project-9",
        );
      }
    });

    it("pins the bookkeeping key to the configured project", async () => {
      // The service API key is issued against that one project, and an audit
      // trail that follows whichever project the browser named is not one.
      const fetchMock = mockFetch(() => ({ data: { data: {} } }));

      await client.request(null, "GET", "/v2/items/copilot_audit", undefined, {}, {
        serviceKey: true,
      });

      expect(
        new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("project-id"),
      ).toBe("project-1");
    });
  });
});

describe("aggregation envelope", () => {
  /**
   * The aggregation route nests one level deeper than the item routes. Getting
   * this wrong is invisible: no error, just zero rows, and an assistant
   * reporting in good faith that nothing matched.
   */
  it("reads rows out of the real response shape", async () => {
    const client = new UcodeClient(config);
    mockFetch((url) => {
      if (url.pathname.endsWith("/schema")) return schemaResponse;
      return { data: { data: { data: [{ departments_id: "d1", total: 7 }] } } };
    });

    await expect(
      client.aggregate(caller, "user_base", {
        groupBy: ["departments_id"],
        metrics: [{ fn: "count", alias: "total" }],
      }),
    ).resolves.toEqual([{ departments_id: "d1", total: 7 }]);
  });

  it("still reads a bare array, in case the envelope changes back", async () => {
    const client = new UcodeClient(config);
    mockFetch((url) => {
      if (url.pathname.endsWith("/schema")) return schemaResponse;
      return { data: { data: [{ total: 3 }] } };
    });

    await expect(
      client.aggregate(caller, "user_base", {
        metrics: [{ fn: "count", alias: "total" }],
      }),
    ).resolves.toEqual([{ total: 3 }]);
  });
});
