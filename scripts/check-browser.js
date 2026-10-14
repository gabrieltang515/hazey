import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:8787";
const chrome = process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const profile = await mkdtemp(join(tmpdir(), "hazey-browser-"));
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let socket;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let stderr = "";
      const timer = setTimeout(() => reject(new Error("Chrome did not start within 15 seconds")), 15_000);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited (${code})`)); });
      child.stderr.on("data", chunk => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("message", event => {
      const response = JSON.parse(event.data);
      const task = pending.get(response.id);
      if (!task) return;
      pending.delete(response.id);
      clearTimeout(task.timer);
      response.error ? task.reject(new Error(response.error.message)) : task.resolve(response.result);
    });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Browser timed out: ${method}`)); }, 20_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    for (const viewport of [{ name: "desktop", width: 1440, height: 1100 }, { name: "mobile", width: 390, height: 844 }]) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const evaluate = async expression => {
        const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (result.exceptionDetails) throw new Error("Page JavaScript failed during browser verification");
        return result.result.value;
      };
      await send("Page.enable", {}, sessionId);
      await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.name === "mobile" }, sessionId);
      await send("Page.navigate", { url }, sessionId);
      let readings;
      for (let attempt = 0; attempt < 40; attempt++) {
        readings = await evaluate("Array.from(document.querySelectorAll('.region-value'), e => e.textContent)");
        if (readings?.length === 5 && readings.every(value => /^\d+$/.test(value))) break;
        await delay(500);
      }
      assert.equal(readings?.length, 5, `${viewport.name}: five region cards`);
      assert.ok(readings.every(value => /^\d+$/.test(value)), `${viewport.name}: real readings loaded`);
      const pm25 = await evaluate("Array.from(document.querySelectorAll('.pm25-value'), e => e.textContent)");
      assert.ok(pm25?.length === 5 && pm25.every(value => /^\d+(\.\d+)? µg\/m³$/.test(value)), `${viewport.name}: five 1-hour PM2.5 readings`);
      const layout = await evaluate("({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, time: document.getElementById('reading-time').textContent, pm25Time: document.getElementById('pm25-time').textContent, refreshDisabled: document.getElementById('refresh-button').disabled })");
      assert.ok(layout.scrollWidth <= layout.width, `${viewport.name}: no horizontal overflow`);
      assert.match(layout.time, /SGT/);
      assert.match(layout.pm25Time, /SGT/);
      assert.equal(layout.refreshDisabled, false);
      await evaluate("document.querySelector('.region-card summary').click()");
      assert.equal(await evaluate("document.querySelector('.region-card details').open"), true);
      await evaluate("document.getElementById('refresh-button').click()");
      for (let attempt = 0; attempt < 30; attempt++) {
        if (await evaluate("!document.getElementById('refresh-button').disabled")) break;
        await delay(500);
      }
      assert.equal(await evaluate("document.getElementById('refresh-button').disabled"), false, "refresh completes");
      const screenshot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
      const filename = join(tmpdir(), `hazey-${viewport.name}.png`);
      await writeFile(filename, Buffer.from(screenshot.data, "base64"));
      console.log(`${viewport.name}: 5 live PSI and PM2.5 readings, SGT times, no overflow, details and refresh passed. Screenshot: ${filename}`);
      await send("Target.closeTarget", { targetId });
    }
  } finally {
    socket?.close();
    child.kill("SIGTERM");
    await delay(1000);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
