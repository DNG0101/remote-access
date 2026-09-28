import { test, expect } from "@playwright/test";

test("host and controller build a WebRTC connection, deliver screen, grant control, and disconnect", async ({ browser }) => {
  const context = await browser.newContext();

  const host = await context.newPage();
  await host.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#111827";
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#78f0c0";
      ctx.font = "bold 42px sans-serif";
      ctx.fillText("P2P DESK TEST", 150, 190);
      return canvas.captureStream(10);
    };
  });

  await host.goto("/");
  await host.locator("[data-action='create-host']").first().click();
  await expect(host.locator("#diagSignaling")).toHaveText("connected", { timeout: 20_000 });

  const inviteUrl = await host.locator("[data-action='copy-invite']").getAttribute("data-invite-url");
  expect(inviteUrl).toContain("join=");
  expect(inviteUrl).toContain("code=");

  const controller = await context.newPage();
  await controller.goto(inviteUrl);

  await expect(host.locator("#peerStatus")).toHaveText("CONNECTED", { timeout: 30_000 });
  await expect(controller.locator("#peerStatus")).toHaveText("CONNECTED", { timeout: 30_000 });

  await host.locator("[data-action='capture']").click();
  await expect
    .poll(() => controller.locator("#remoteVideo").evaluate((video) => Boolean(video.srcObject?.getVideoTracks?.().length)), { timeout: 30_000 })
    .toBe(true);

  await controller.locator("[data-action='control']").click();
  await expect(host.locator("#consentBanner")).toBeVisible({ timeout: 10_000 });
  await host.locator("[data-action='approve-control']").click();
  await expect(controller.locator("#peerSubtext")).toContainText("Full control granted", { timeout: 10_000 });

  await host.locator("[data-action='disconnect']").click();
  await expect(controller.locator("#peerStatus")).toHaveText("DISCONNECTED", { timeout: 10_000 });

  await context.close();
});
