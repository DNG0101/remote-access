import { test, expect } from "@playwright/test";

test("two browser pages connect by code, deliver screen, grant/revoke control, and disconnect", async ({ browser }) => {
  const context = await browser.newContext();
  const browserErrors = [];

  const host = await context.newPage();
  host.on("pageerror", (error) => browserErrors.push("host: " + error.message));

  await host.addInitScript(() => {
    window.__testCaptureStreams = [];
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

      const stream = canvas.captureStream(10);
      window.__testCaptureStreams.push(stream);
      return stream;
    };
  });

  await host.goto("/?signal=ws%3A%2F%2F127.0.0.1%3A4174");
  await expect(host.locator("[data-action='create-host']").first()).toBeVisible();
  await host.locator("[data-action='create-host']").first().click();

  await expect(host.locator("#diagSignaling")).toHaveText("connected", { timeout: 10_000 });
  const code = (await host.locator("#sessionCodeDisplay").innerText()).replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);

  // Start capture before the controller joins so the initial SDP offer must include media.
  await host.locator("[data-action='capture']").click();
  await expect(host.locator("#captureLabel")).toHaveText("Screen sharing");

  const controller = await context.newPage();
  controller.on("pageerror", (error) => browserErrors.push("controller: " + error.message));

  await controller.addInitScript(() => {
    let localClipboard = "clipboard from controller";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => localClipboard,
        writeText: async (value) => { localClipboard = value; }
      }
    });
  });

  await host.addInitScript(() => {
    let hostClipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => hostClipboard,
        writeText: async (value) => {
          hostClipboard = value;
          window.__hostClipboard = value;
        }
      }
    });
  });

  await controller.goto("/?signal=ws%3A%2F%2F127.0.0.1%3A4174#sessions");
  await controller.locator("[data-role='controller']").click();
  await controller.locator("#joinCode").fill(code);
  await controller.locator("[data-action='join-code']").click();

  await expect(host.locator("#peerStatus")).toHaveText("CONNECTED", { timeout: 20_000 });
  await expect(controller.locator("#peerStatus")).toHaveText("CONNECTED", { timeout: 20_000 });

  await expect
    .poll(
      () => controller.locator("#remoteVideo").evaluate((video) => Boolean(video.srcObject?.getVideoTracks?.().length)),
      { timeout: 20_000 }
    )
    .toBe(true);

  await controller.locator("#chatInput").fill("hello from controller");
  await controller.locator("[data-action='send-chat']").click();
  await expect(host.locator("#chatList")).toContainText("hello from controller", { timeout: 10_000 });

  await controller.locator("[data-action='copy-text']").click();
  await expect.poll(() => host.evaluate(() => window.__hostClipboard || "")).toBe("clipboard from controller");

  await host.locator("#fileInput").setInputFiles({
    name: "p2p-desk-test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("P2P DESK FILE TEST")
  });
  await expect(controller.locator("#fileOffer")).toBeVisible({ timeout: 10_000 });
  await expect(controller.locator("#fileOfferName")).toHaveText("p2p-desk-test.txt");

  const downloadPromise = controller.waitForEvent("download");
  await controller.locator("[data-action='accept-file']").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("p2p-desk-test.txt");
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();

  await controller.locator("[data-action='control']").click();
  await expect(host.locator("#consentBanner")).toBeVisible({ timeout: 10_000 });
  await host.locator("[data-action='approve-control']").click();
  await expect(controller.locator("#peerSubtext")).toContainText("Full control granted", { timeout: 10_000 });

  await host.locator("[data-action='control']").click();
  await expect(controller.locator("#peerSubtext")).toContainText("view-only", { timeout: 10_000 });

  await host.locator("[data-action='disconnect']").click();
  await expect(controller.locator("#peerStatus")).toHaveText("DISCONNECTED", { timeout: 10_000 });
  await expect(controller.locator("#globalConnectionState")).toContainText("DISCONNECTED", { timeout: 10_000 });

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);

  await context.close();
});
