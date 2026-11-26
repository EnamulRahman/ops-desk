// Browser test: plays every ticket through the real UI (typing commands, using the editor, pressing Resolve).
const { chromium } = require("playwright");
const path = require("path"), SOL = require("./solutions");
(async () => {
  const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("file://" + path.join(__dirname, "..", "index.html"));
  await page.evaluate(() => localStorage.clear()); await page.reload();
  await page.fill("#nm", "Tester"); await page.click("#start button");
  const ids = await page.evaluate(() => OD.TICKETS.map((t) => t.id)); let fail = 0;
  for (const id of ids) {
    await page.click(`.tk[data-id="${id}"]`);
    await page.click("#resolve"); // before fixing: must fail
    if (!(await page.locator("#grade .no").count())) { console.log(`✗ ${id} passed before the fix`); fail++; }
    for (const step of SOL[id]) {
      const line = typeof step === "string" ? step : step.edit;
      await page.fill("#cmd", line); await page.press("#cmd", "Enter");
      if (typeof step !== "string") {
        await page.waitForSelector("#edt");
        const text = await page.inputValue("#edt");
        const next = await page.evaluate(([src, t]) => eval(src)(t, window.jsyaml), [step.fn.toString(), text]);
        await page.fill("#edt", next); await page.click("#eds");
        await page.waitForSelector("#edt", { state: "detached" });
      }
    }
    await page.click("#resolve");
    const ok = await page.locator(".win").count();
    if (!ok) { console.log(`✗ ${id}: ${await page.locator("#grade").innerText()}`); fail++; continue; }
    if (id === "PW-105") await page.screenshot({ path: process.env.SHOTS + "/win.png" });
    await page.click("#cl");
  }
  const xp = await page.evaluate(() => OD.game.progress());
  console.log(`done: ${Object.keys(xp.done).length}/${ids.length}, rank: ${await page.locator(".rank").innerText()}`);
  if (errors.length) { console.log("page errors:", errors); fail++; }
  await browser.close(); process.exit(fail ? 1 : 0);
})();
