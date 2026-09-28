import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

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
    window.__setHostClipboard = (value) => { hostClipboard = value; };
  });

  await host.goto("/?signal=ws%3A%2F%2F127.0.0.1%3A4174&agent=ws%3A%2F%2F127.0.0.1%3A4175");
  await expect(host.locator("[data-action='create-host']").first()).toBeVisible();
  await host.locator("[data-action='create-host']").first().click();

  await expect(host.locator("#diagSignaling")).toHaveText("connected", { timeout: 10_000 });
  const code = (await host.locator("#sessionCodeDisplay").innerText()).replace(/\s/g, "");
  expect(code).toMatch(/^\d{6}$/);

  // Start capture before the controller joins so the initial SDP offer must include media.
  await host.locator("[data-action='capture']").click();
  await expect(host.locator("#captureLabel")).toHaveText("Screen sharing");
  await host.locator("label.toggle-row").filter({ hasText: "Allow clipboard sharing" }).click();

  const controller = await context.newPage();
  controller.on("pageerror", (error) => browserErrors.push("controller: " + error.message));

  await controller.addInitScript(() => {
    let localClipboard = "clipboard from controller";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => localClipboard,
        writeText: async (value) => {
          localClipboard = value;
          window.__controllerClipboard = value;
        }
      }
    });
    window.__setControllerClipboard = (value) => { localClipboard = value; };
  });

  await controller.goto("/?signal=ws%3A%2F%2F127.0.0.1%3A4174#sessions");
  await expect.poll(async () => controller.evaluate(() => JSON.stringify({
    ready: Boolean(window.__P2P_DESK_READY__),
    bootError: window.__P2P_DESK_BOOT_ERROR__,
    hash: location.hash,
    routeClass: document.querySelector("#route-sessions")?.className || ""
  })), { timeout: 10_000 }).toBe('{"ready":true,"bootError":null,"hash":"#sessions","routeClass":"route"}');
  await expect(controller.locator("#route-sessions")).toBeVisible();
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

  await host.evaluate(() => {
    const track = window.__testCaptureStreams[0].getVideoTracks()[0];
    track.stop();
    track.dispatchEvent(new Event("ended"));
  });
  await expect(controller.locator("#videoPlaceholder")).toBeVisible({ timeout: 10_000 });
  await host.locator("[data-action='capture']").click();
  await expect
    .poll(
      () => controller.locator("#remoteVideo").evaluate((video) => Boolean(video.srcObject?.getVideoTracks?.().some((track) => track.readyState === "live"))),
      { timeout: 15_000 }
    )
    .toBe(true);

  await controller.locator("#chatInput").fill("hello from controller");
  await controller.locator("[data-action='send-chat']").click();
  await expect(host.locator("#chatList")).toContainText("hello from controller", { timeout: 10_000 });

  await controller.locator("[data-action='copy-text']").click();
  await expect(host.locator("[data-action='copy-text']")).toHaveText(/Copy peer clipboard/);
  await host.locator("[data-action='copy-text']").click();
  await expect.poll(() => host.evaluate(() => window.__hostClipboard || "")).toBe("clipboard from controller");

  await controller.locator("[data-action='copy-text']").click();

  await host.locator("#fileInput").setInputFiles({
    name: "p2p-desk-test.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("P2P DESK FILE TEST")
  });
  await expect(controller.locator("#fileOffer")).toBeVisible({ timeout: 10_000 });
  await expect(controller.locator("#fileOfferName")).toHaveText("p2p-desk-test.txt");

  await controller.locator("[data-action='accept-file']").click();
  await expect(controller.locator("#fileProgressValue")).toHaveText("100%");
  await expect(controller.locator("[data-action='save-file']")).toBeVisible({ timeout: 10_000 });
  const downloadPromise = controller.waitForEvent("download");
  await controller.locator("[data-action='save-file']").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("p2p-desk-test.txt");
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  expect(await fs.readFile(downloadedPath, "utf8")).toBe("P2P DESK FILE TEST");

  await controller.locator("#fileInput").setInputFiles({
    name: "controller-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("CONTROLLER FILE TEST")
  });
  await expect(host.locator("#fileOffer")).toBeVisible({ timeout: 10_000 });
  await expect(host.locator("#fileOfferName")).toHaveText("controller-upload.txt");

  await host.locator("[data-action='accept-file']").click();
  await expect(host.locator("#fileProgressValue")).toHaveText("100%");
  await expect(host.locator("[data-action='save-file']")).toBeVisible({ timeout: 10_000 });
  const reverseDownloadPromise = host.waitForEvent("download");
  await host.locator("[data-action='save-file']").click();
  const reverseDownload = await reverseDownloadPromise;
  expect(reverseDownload.suggestedFilename()).toBe("controller-upload.txt");
  const reversePath = await reverseDownload.path();
  expect(reversePath).toBeTruthy();
  expect(await fs.readFile(reversePath, "utf8")).toBe("CONTROLLER FILE TEST");

  await controller.locator("[data-action='control']").click();
  await expect(host.locator("#consentBanner")).toBeVisible({ timeout: 10_000 });
  await host.locator("[data-action='approve-control']").click();
  await expect(controller.locator("#peerSubtext")).toContainText("Full control granted", { timeout: 10_000 });
  await expect(host.locator("#nativeStatus")).toHaveText("CONNECTED", { timeout: 10_000 });

  await controller.locator("#remoteVideo").hover({ position: { x: 320, y: 180 } });
  await controller.locator("#remoteVideo").click({
    position: { x: 320, y: 180 },
    button: "left"
  });
  await expect.poll(async () => {
    const response = await host.evaluate(() => fetch("/agent-events").then((r) => r.json()));
    return response.inputs.some((packet) =>
      packet?.type === "mouse_button" &&
      packet?.action === "down" &&
      Number.isFinite(packet?.x) &&
      Number.isFinite(packet?.y)
    );
  }).toBe(true);

  await controller.locator("[data-action='mobile-keyboard']").click();
  await expect(controller.locator("#mobileKeyboardPanel")).toBeVisible();
  await controller.locator("#mobileTextInput").fill("MOBILE TEXT TEST");
  await controller.locator("[data-action='send-mobile-text']").click();
  await expect.poll(async () => {
    const response = await host.evaluate(() => fetch("/agent-events").then((r) => r.json()));
    return response.inputs.some((packet) =>
      packet?.type === "text_input" &&
      packet?.text === "MOBILE TEXT TEST"
    );
  }).toBe(true);
  await controller.locator("[data-mobile-shortcut='CTRL+C']").click();
  await expect.poll(async () => {
    const response = await host.evaluate(() => fetch("/agent-events").then((r) => r.json()));
    const inputs = response.inputs;
    return inputs.some((packet) => packet?.type === "keyboard" && packet?.code === "ControlLeft" && packet?.action === "down") &&
      inputs.some((packet) => packet?.type === "keyboard" && packet?.code === "KeyC" && packet?.action === "down" && packet?.modifiers?.includes("CTRL")) &&
      inputs.some((packet) => packet?.type === "keyboard" && packet?.code === "ControlLeft" && packet?.action === "up");
  }).toBe(true);
  await controller.locator("[data-action='close-keyboard']").click();

  await host.locator("[data-action='control']").click();
  await expect(controller.locator("#peerSubtext")).toContainText("view-only", { timeout: 10_000 });

  await host.locator("[data-action='disconnect']").click();
  await expect(controller.locator("#peerStatus")).toHaveText("DISCONNECTED", { timeout: 10_000 });
  await expect(controller.locator("#globalConnectionState")).toContainText("DISCONNECTED", { timeout: 10_000 });

  expect(browserErrors, browserErrors.join("\n")).toEqual([]);

  await context.close();
});
