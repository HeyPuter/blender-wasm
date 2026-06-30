// Playwright verifier. Boots the COOP/COEP static server, loads a page in
// headless Chromium, waits for the page's completion signal, screenshots it,
// and asserts. Usage: node scripts/verify.mjs <page.html> [expectedTitle]
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const page_name = process.argv[2] || "smoke.html";
const expect_title = process.argv[3] || "SMOKE OK";
const PORT = 8091;

const srv = spawn("node", [join(__dirname, "serve.mjs"), WEB, String(PORT)], {
  stdio: ["ignore", "inherit", "inherit"],
});
await new Promise((r) => setTimeout(r, 600));

let exitCode = 1;
const browser = await chromium.launch({
  args: ["--enable-features=SharedArrayBuffer", "--use-gl=swiftshader"],
});
let page;
try {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 700 } });
  page = await ctx.newPage();
  page.on("console", (m) => console.log("[browser]", m.text()));
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.goto(`http://localhost:${PORT}/${page_name}`, { waitUntil: "load", timeout: 30000 });

  // Wait for the page's done signal (set by the harness on success).
  await page.waitForFunction(() => window.__SMOKE_DONE__ || window.__RENDER_DONE__, null, {
    timeout: 180000,
  });
  const result = await page.evaluate(() => window.__SMOKE_DONE__ || window.__RENDER_DONE__);
  const title = await page.title();
  const shotPath = join(WEB, "verify-shot.png");
  await page.screenshot({ path: shotPath });
  console.log("result:", JSON.stringify(result));
  console.log("title :", title, "(expected:", expect_title + ")");
  console.log("shot  :", shotPath);
  if (title === expect_title) { console.log("VERIFY PASS"); exitCode = 0; }
  else console.log("VERIFY FAIL: title mismatch");
} catch (e) {
  console.log("VERIFY FAIL:", e.message);
  try {
    const dump = await page.evaluate(() => ({
      status: window.__STATUS__,
      title: document.title,
      log: (document.getElementById("log") || {}).textContent,
    }));
    console.log("page status:", dump.status, "| title:", dump.title);
    console.log("---- page log ----\n" + (dump.log || "(empty)"));
    await page.screenshot({ path: join(WEB, "verify-shot.png") });
  } catch (_) {}
} finally {
  await browser.close();
  srv.kill();
  process.exit(exitCode);
}
