import { test, expect } from "@playwright/test";

test("two browser pages connect by six-digit code, deliver screen, grant control, and disconnect", async ({ browser }) => {
  const context = await browser.newContext();
  const browserErrors = [];
  const host = await context.newPage();
  host.on("pageerror", (error) => browserErrors.push(error.message));

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

  await host.goto("/?signal=ws%3A%2F%2F127.0.0.1%3A4174");
  await expect(host.locator("[data-action='create-host']").first()).toBeVisible();
  await host.locator("[data-action='create-host']").first().click();

  await expect(host.locator("#diagSignaling")).toHaveText("connected", { timeout: 10_000 });
  expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  const code = (await host.locator("#sessionCodeDisplay").innerText()).replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);

  const controller = await context.newPage();
  await controller.goto("/?signal=ws%3A%2F%2F127.0.0.1%3A4174#sessions");
  await controller.locator("[data-role='controller']").click();
  await controller.locator("#joinCode").fill(code);
  await controller.locator("[data-action='join-code']").click();

  await expect(host.locator("#peerStatus")).toHaveText("CONNECTED", { timeout: 20_000 });
  await expect(controller.locator("#peerStatus")).toHaveText("CONNECTED", { timeout: 20_000 });

  await host.locator("[data-action='capture']").click();
  await expect
    .poll(
      () => controller.locator("#remoteVideo").evaluate((video) => Boolean(video.srcObject?.getVideoTracks?.().length)),
      { timeout: 20_000 }
    )
    .toBe(true);

  await controller.locator("[data-action='control']").click();
  await expect(host.locator("#consentBanner")).toBeVisible({ timeout: 10_000 });
  await host.locator("[data-action='approve-control']").click();
  await expect(controller.locator("#peerSubtext")).toContainText("Full control granted", { timeout: 10_000 });

  await host.locator("[data-action='disconnect']").click();
  await expect(controller.locator("#peerStatus")).toHaveText("DISCONNECTED", { timeout: 10_000 });

  await context.close();
});
