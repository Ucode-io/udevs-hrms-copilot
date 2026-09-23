import { loadConfig } from "./configuration";

/** The two keys loadConfig refuses to start without. */
const REQUIRED = {
  UCODE_PROJECT_ID: "9a462573-ce11-4288-928a-a6ba754b6998",
  UCODE_ENVIRONMENT_ID: "2f73835f-3a29-46c8-951e-75119db9bfc0",
};

describe("CORS_ORIGINS", () => {
  const saved = process.env;

  beforeEach(() => {
    process.env = { ...saved, ...REQUIRED };
  });

  afterEach(() => {
    process.env = saved;
  });

  it("drops a trailing slash, which an Origin header never carries", () => {
    // The shape a person naturally pastes out of a browser address bar. Kept
    // as-is it matches no origin at all, and the failure surfaces in someone
    // else's browser as the service being down.
    process.env.CORS_ORIGINS = "https://hrms.ucode.co/";

    expect(loadConfig().corsOrigins).toEqual(["https://hrms.ucode.co"]);
  });

  it("takes a comma-separated list, spaces and all", () => {
    process.env.CORS_ORIGINS =
      "https://hrms.ucode.co/ , https://hrms-admin.u-code.io , http://localhost:5173";

    expect(loadConfig().corsOrigins).toEqual([
      "https://hrms.ucode.co",
      "https://hrms-admin.u-code.io",
      "http://localhost:5173",
    ]);
  });

  it("keeps the port, which is part of the origin", () => {
    process.env.CORS_ORIGINS = "http://localhost:5199/";

    expect(loadConfig().corsOrigins).toEqual(["http://localhost:5199"]);
  });

  it("falls back to the local panel when the key is absent", () => {
    delete process.env.CORS_ORIGINS;

    expect(loadConfig().corsOrigins).toEqual(["http://localhost:5199"]);
  });
});
