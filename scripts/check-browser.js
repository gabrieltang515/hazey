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
      // Start from a light system theme whatever the host uses, so the theme toggle check is deterministic.
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
      await send("Page.navigate", { url }, sessionId);
      let readings;
      for (let attempt = 0; attempt < 40; attempt++) {
        // Cards start with a "000" placeholder, so wait until they have finished loading.
        readings = await evaluate("document.querySelector('.region-card.is-loading') ? null : Array.from(document.querySelectorAll('.reading-value'), e => e.textContent)");
        if (readings?.length === 5 && readings.every(value => /^\d+$/.test(value))) break;
        await delay(500);
      }
      assert.equal(readings?.length, 5, `${viewport.name}: five region cards`);
      assert.ok(readings.every(value => /^\d+$/.test(value)), `${viewport.name}: real readings loaded`);
      const pm25 = await evaluate("Array.from(document.querySelectorAll('.other-value'), e => e.textContent)");
      assert.ok(pm25?.length === 5 && pm25.every(value => /^\d+(\.\d+)? µg\/m³$/.test(value)), `${viewport.name}: five 1-hour PM2.5 readings`);
      const wording = await evaluate("({ verdict: document.getElementById('verdict-detail').textContent, announcer: Boolean(document.getElementById('announcer')), inPanel: Boolean(document.getElementById('announcer')?.closest('#telegram-panel')) })");
      assert.ok(wording.announcer && !wording.inPanel, `${viewport.name}: screen-reader announcer sits outside the Telegram panel`);
      assert.match(wording.verdict, /, in (the .+ regions?|all five regions)\.$/, `${viewport.name}: verdict names regions naturally`);
      const mapBands = await evaluate("Array.from(document.querySelectorAll('.map-region'), e => e.dataset.band)");
      assert.ok(mapBands.length === 5 && mapBands.every(band => band !== "unknown"), `${viewport.name}: map shows five banded regions`);
      for (let attempt = 0; attempt < 20; attempt++) {
        if (await evaluate("document.querySelectorAll('.spark svg, .spark-empty').length === 5 && !document.querySelector('.spark-empty')?.textContent.startsWith('Loading')")) break;
        await delay(500);
      }
      const trends = await evaluate("({ charts: document.querySelectorAll('.spark svg .spark-line').length, rows: document.querySelectorAll('#history-body tr').length })");
      assert.ok(trends.charts === 5 || trends.charts === 0, `${viewport.name}: trend charts render together`);
      await evaluate("document.querySelector('#metric-switch [data-metric=pm25]').click()");
      const switched = await evaluate("({ primary: Array.from(document.querySelectorAll('.reading-value'), e => e.textContent), other: Array.from(document.querySelectorAll('.other-value'), e => e.textContent), unit: document.querySelector('.reading-unit').textContent })");
      assert.ok(switched.primary.every(value => /^\d+(\.\d+)?$/.test(value)) && switched.other.every(value => /^\d+$/.test(value)), `${viewport.name}: PM2.5 view swaps readings`);
      assert.match(switched.unit, /µg\/m³/);
      await delay(800);
      if (viewport.name === "desktop") {
        const pm25Shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
        await writeFile(join(tmpdir(), "hazey-desktop-pm25.png"), Buffer.from(pm25Shot.data, "base64"));
      }
      await evaluate("document.querySelector('#metric-switch [data-metric=psi]').click()");
      const layout = await evaluate("({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, time: document.getElementById('reading-time').textContent, pm25Time: document.getElementById('pm25-time').textContent, refreshDisabled: document.getElementById('refresh-button').disabled })");
      assert.ok(layout.scrollWidth <= layout.width, `${viewport.name}: no horizontal overflow`);
      assert.match(layout.time, /SGT/);
      assert.match(layout.pm25Time, /SGT/);
      assert.equal(layout.refreshDisabled, false);

      const overview = await evaluate("({ hidden: document.getElementById('heat').hidden, rows: Array.from(document.querySelectorAll('#heat-table tbody tr'), row => row.querySelectorAll('td').length), banded: document.querySelectorAll('#heat-table td:not([data-band=unknown])').length, summary: document.getElementById('overview-summary').textContent })");
      if (trends.charts === 5) {
        assert.ok(!overview.hidden && overview.rows.length === 5 && overview.rows.every(cells => cells === 25), `${viewport.name}: PM2.5 overview has five regions by 25 hours`);
        assert.ok(overview.banded >= 100, `${viewport.name}: most overview cells carry a PM2.5 band`);
        assert.match(overview.summary, /^Highest: \d+(\.\d+)? µg\/m³/);
        await evaluate("document.getElementById('heat').focus()");
        await evaluate("document.getElementById('heat').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))");
        const tip = await evaluate("({ hidden: document.getElementById('heat-tip').hidden, text: document.getElementById('heat-tip').textContent, active: document.querySelectorAll('#heat-table td.is-active').length })");
        assert.ok(!tip.hidden && tip.active === 1 && /µg\/m³|No reading/.test(tip.text), `${viewport.name}: overview cells read out on keyboard focus`);
        assert.match(await evaluate("document.getElementById('announcer').textContent"), /µg\/m³|no reading/, `${viewport.name}: keyboard readouts are announced`);
        await evaluate("document.getElementById('heat').blur()");
      } else {
        assert.ok(overview.hidden, `${viewport.name}: overview waits for history`);
      }

      // Shelter finder: device location (emulated at 572 Hougang St 51), then postal code and bad input.
      await send("Browser.grantPermissions", { permissions: ["geolocation"], origin: new URL(url).origin });
      await send("Emulation.setGeolocationOverride", { latitude: 1.37827, longitude: 103.88749, accuracy: 30 }, sessionId);
      const shelters = async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = await evaluate("({ busy: document.getElementById('postal-button').disabled, names: Array.from(document.querySelectorAll('.shelter-name'), e => e.textContent), distances: Array.from(document.querySelectorAll('.shelter-distance'), e => e.textContent), message: document.getElementById('shelter-message').textContent })");
          if (!result.busy && result.names.length) return result;
          await delay(400);
        }
        throw new Error(`${viewport.name}: shelter results did not appear`);
      };
      await evaluate("document.getElementById('locate-button').click()");
      const located = await shelters();
      assert.equal(located.names.length, 5, `${viewport.name}: five nearest shelters`);
      assert.equal(located.names[0], "Ang Mo Kio-Hougang Pinetree RN");
      assert.equal(located.distances[0], "Under 100 m");
      assert.match(located.message, /your location/);
      await evaluate("document.getElementById('postal-input').value = '12'; document.getElementById('postal-form').requestSubmit()");
      assert.equal(await evaluate("document.getElementById('postal-input').getAttribute('aria-invalid')"), "true", `${viewport.name}: short postal code is flagged`);
      assert.match(await evaluate("document.getElementById('shelter-message').textContent"), /six-digit/);
      await evaluate("document.getElementById('postal-input').value = '089774'; document.getElementById('postal-form').requestSubmit()");
      const byPostal = await shelters();
      assert.equal(byPostal.names[0], "Tanjong Pagar CC", `${viewport.name}: postal code lookup finds the nearest shelter`);
      assert.match(byPostal.message, /postal code 089774/);
      const shelterLayout = await evaluate("({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })");
      assert.ok(shelterLayout.scrollWidth <= shelterLayout.width, `${viewport.name}: no horizontal overflow with shelter results`);

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
      await evaluate("document.getElementById('theme-toggle').click()");
      assert.equal(await evaluate("document.documentElement.dataset.theme"), "dark", `${viewport.name}: theme toggles to dark`);
      await delay(600);
      const dark = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId);
      await writeFile(join(tmpdir(), `hazey-${viewport.name}-dark.png`), Buffer.from(dark.data, "base64"));
      await evaluate("document.getElementById('theme-toggle').click()");
      console.log(`${viewport.name}: ${trends.charts} trend charts (${trends.rows} table rows), ${overview.hidden ? "overview waiting for history" : "PM2.5 overview"}, shelter finder (location, postal code, bad input), map, PSI/PM2.5 switch, dark theme, 5 live readings, SGT times, no overflow, details and refresh passed. Screenshot: ${filename}`);
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
