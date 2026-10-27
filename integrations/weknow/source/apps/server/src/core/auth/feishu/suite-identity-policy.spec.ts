import { ConfigService } from "@nestjs/config";
import { identityEndpoint, identityRequest } from "./lab-identity-policy";
describe("portable suite identity boundary", () => {
  const issuer = "http://127.0.0.1:49100",
    org = "test-organization",
    id = "12345678-1234-4321-9123-123456789abc";
  const config = () =>
    new ConfigService({
      COBUILD_IDENTITY_MODE: "local",
      LAB_IDENTITY_ORIGIN: issuer,
      LAB_IDENTITY_TENANT_KEY: org,
    });
  const profile = () => ({
    issuer,
    tenantKey: org,
    audience: "knowledge",
    provider: "local",
    unionId: id,
    subject: org + ":" + id,
    name: "Test Member",
    email: "member@example.test",
    role: "member",
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    token: "t".repeat(43),
  });
  afterEach(() => jest.restoreAllMocks());
  test("requires explicit HTTPS or loopback issuer", () => {
    expect(identityEndpoint(config())).toBe(issuer);
    expect(() =>
      identityEndpoint(
        new ConfigService({
          COBUILD_IDENTITY_MODE: "local",
          LAB_IDENTITY_ORIGIN: "http://team.example",
        }),
      ),
    ).toThrow();
    expect(() =>
      identityEndpoint(
        new ConfigService({
          COBUILD_IDENTITY_MODE: "local",
          LAB_IDENTITY_ORIGIN: "https://team.example/path",
        }),
      ),
    ).toThrow();
  });
  test("accepts internal UUID identity without inventing Feishu IDs", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(profile())));
    await expect(
      identityRequest(config(), "exchange", {}),
    ).resolves.toMatchObject({ provider: "local", unionId: id });
    expect(fetch).toHaveBeenCalledWith(
      issuer + "/api/identity/exchange",
      expect.objectContaining({ redirect: "error" }),
    );
  });
  test.each([
    { issuer: "https://other.example" },
    { provider: "feishu" },
    { tenantKey: "other" },
    { audience: "requirements" },
    { subject: "other:" + id },
    { unionId: "on_fictional00000001" },
  ])("rejects native identity mismatch %p", async (patch) => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ...profile(), ...patch })),
      );
    await expect(identityRequest(config(), "exchange", {})).rejects.toThrow();
  });
});
