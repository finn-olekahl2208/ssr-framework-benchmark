#!/usr/bin/env node

/**
 * Quantitative Benchmark-Suite für die Bachelorthesis
 * "Evaluierung eines modernen SSR-Frameworks im Kontext
 *  großskaliger E-Commerce-Webarchitekturen"
 *
 * Autor: Finn-Ole Kahl
 *
 * Drei Messphasen pro Szenario:
 *  1. CDP Cold-Cache (Navigation Timing, Performance, Netzwerk)
 *  2. Lighthouse-Audits (Web Vitals, devtools-throttling)
 *  3. Warm-Cache (Cache-Verhalten, Payload-Reduktion)
 */

import puppeteer from "puppeteer";
import lighthouse from "lighthouse";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { createObjectCsvStringifier } from "csv-writer";

// -- Konfiguration laden --------------------------------------------------

const config = JSON.parse(
  await import("fs").then((fs) =>
    fs.promises.readFile(new URL("./config.json", import.meta.url), "utf-8")
  )
);

const {
  scenarios,
  measurement: { runsPerScenario, warmupRuns, cooldownMs, viewportWidth, viewportHeight },
  throttling,
  auth,
  output,
} = config;

// -- Output-Verzeichnis ---------------------------------------------------

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const resultDir = join(output.directory, `run_${timestamp}`);
if (!existsSync(resultDir)) mkdirSync(resultDir, { recursive: true });

// -- Hilfsfunktionen ------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function scenarioRequiresAuth(scenario) {
  return scenario.auth !== false;
}

/** Konvertiert CDP-Throttling (Bytes/s, ms) in Lighthouse-Format (kbps). */
function convertThrottlingForLighthouse(cdpParams) {
  return {
    rttMs: cdpParams.latency,
    throughputKbps: (cdpParams.downloadThroughput * 8) / 1000,
    downloadThroughputKbps: (cdpParams.downloadThroughput * 8) / 1000,
    uploadThroughputKbps: (cdpParams.uploadThroughput * 8) / 1000,
    requestLatencyMs: cdpParams.latency / 2,
    cpuSlowdownMultiplier: 1,
  };
}

// -- Login ----------------------------------------------------------------

async function performLogin(browser) {
  log("Login auf develop.otto.de ...");
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.goto(auth.loginUrl, { waitUntil: "networkidle0", timeout: 60000 });

  try {
    await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
    await page.click('#onetrust-accept-btn-handler');
    await sleep(1000);
  } catch { /* Cookie-Banner nicht sichtbar */ }

  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
  const emailInput = await page.$('input[type="email"]') || await page.$('input[name="email"]');
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(auth.email);

  await page.waitForSelector('input[type="password"], input[name="password"]', { timeout: 15000 });
  const pwInput = await page.$('input[type="password"]') || await page.$('input[name="password"]');
  await pwInput.click({ clickCount: 3 });
  await pwInput.type(auth.password);

  await page.evaluate(() => {
    document.querySelector('form').submit();
  });

  await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 30000 }).catch(() => { });
  await sleep(2000);

  const currentUrl = page.url();
  if (currentUrl.includes("customer-identity/login")) {
    await context.close();
    throw new Error(`Login fehlgeschlagen - nach Login-Versuch noch auf: ${currentUrl}`);
  }

  const cookies = await page.cookies('https://develop.otto.de');
  await context.close();

  log(`  Login erfolgreich (${cookies.length} Cookies gesichert)`);
  return cookies;
}

// -- Netzwerk-Metriken ----------------------------------------------------

async function collectNetworkMetrics(page) {
  const cdp = await page.createCDPSession();
  const requestMap = new Map();

  await cdp.send("Network.enable");

  cdp.on("Network.responseReceived", (params) => {
    const resp = params.response;
    const fromCache = !!(resp.fromDiskCache || resp.fromPrefetchCache || resp.fromServiceWorker);

    requestMap.set(params.requestId, {
      url: resp.url,
      status: resp.status,
      mimeType: resp.mimeType,
      encodedDataLength: 0,
      resourceType: params.type,
      fromCache,
    });
  });

  cdp.on("Network.requestServedFromCache", (params) => {
    const req = requestMap.get(params.requestId);
    if (req) req.fromCache = true;
  });

  cdp.on("Network.loadingFinished", (params) => {
    const req = requestMap.get(params.requestId);
    if (req) req.encodedDataLength = params.encodedDataLength;
  });

  return {
    cdp,
    getResults: () => {
      const requests = [...requestMap.values()];
      const totalPayloadBytes = requests.reduce((sum, r) => sum + (r.encodedDataLength || 0), 0);
      const totalRequests = requests.length;

      const byType = {};
      for (const r of requests) {
        const type = r.resourceType || "Other";
        if (!byType[type]) byType[type] = { count: 0, bytes: 0, cached: 0 };
        byType[type].count++;
        byType[type].bytes += r.encodedDataLength || 0;
        if (r.fromCache) byType[type].cached++;
      }

      const cachedRequests = requests.filter(r => r.fromCache).length;
      const networkPayloadBytes = requests
        .filter(r => !r.fromCache)
        .reduce((sum, r) => sum + (r.encodedDataLength || 0), 0);

      return {
        totalPayloadBytes,
        totalPayloadKB: +(totalPayloadBytes / 1024).toFixed(2),
        totalRequests,
        cachedRequests,
        networkRequests: totalRequests - cachedRequests,
        networkPayloadKB: +(networkPayloadBytes / 1024).toFixed(2),
        byResourceType: byType,
      };
    },
    reset: () => { requestMap.clear(); },
  };
}

// -- Performance-Metriken -------------------------------------------------

async function collectPerformanceMetrics(cdp) {
  const metrics = await cdp.send("Performance.getMetrics");
  const m = {};
  for (const { name, value } of metrics.metrics) m[name] = value;
  return {
    jsHeapUsedSizeMB: +(m.JSHeapUsedSize / (1024 * 1024)).toFixed(2),
    jsHeapTotalSizeMB: +(m.JSHeapTotalSize / (1024 * 1024)).toFixed(2),
    scriptDurationMs: +(m.ScriptDuration * 1000).toFixed(2),
    taskDurationMs: +(m.TaskDuration * 1000).toFixed(2),
    layoutDurationMs: +(m.LayoutDuration * 1000).toFixed(2),
  };
}

// -- CDP-Throttling -------------------------------------------------------

async function applyCdpThrottling(cdp, throttlingParams) {
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: throttlingParams.downloadThroughput,
    uploadThroughput: throttlingParams.uploadThroughput,
    latency: throttlingParams.latency,
  });
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
}

// -- Ressourcen-Dekomposition ---------------------------------------------

function extractResourceDecomposition(networkResults) {
  const byType = networkResults.byResourceType;
  const kb = (type) => (byType[type]?.bytes || 0) / 1024;
  const count = (type) => byType[type]?.count || 0;

  return {
    htmlDocumentKB: +kb("Document").toFixed(2),
    htmlDocumentRequests: count("Document"),
    jsPayloadKB: +kb("Script").toFixed(2),
    jsRequests: count("Script"),
    apiPayloadKB: +(kb("Fetch") + kb("XHR")).toFixed(2),
    apiRequests: count("Fetch") + count("XHR"),
    cssPayloadKB: +kb("Stylesheet").toFixed(2),
    cssRequests: count("Stylesheet"),
    staticAssetKB: +(kb("Font") + kb("Image") + kb("Other")).toFixed(2),
    staticAssetRequests: count("Font") + count("Image") + count("Other"),
  };
}

// -- Lighthouse -----------------------------------------------------------

/** Einzelner Lighthouse-Audit (throttlingMethod: devtools). */
async function runLighthouseAudit(port, url, lhThrottling, requiresAuth = true) {
  const result = await lighthouse(url, {
    port,
    output: "json",
    logLevel: "error",
    onlyCategories: ["performance"],
    formFactor: "desktop",
    screenEmulation: { disabled: true },
    disableStorageReset: true,
    throttlingMethod: "devtools",
    throttling: lhThrottling,
  });

  if (requiresAuth) {
    const finalUrl = result.lhr.finalDisplayedUrl || result.lhr.finalUrl;
    if (finalUrl && (finalUrl.includes("customer-identity/login") || finalUrl.includes("/login"))) {
      throw new Error(`Lighthouse Login-Redirect erkannt: Ziel war ${url}, gelandet auf ${finalUrl}`);
    }
  }

  const audits = result.lhr.audits;

  return {
    performanceScore: +(result.lhr.categories.performance.score * 100).toFixed(0),
    fcpMs: audits["first-contentful-paint"]?.numericValue ?? null,
    lcpMs: audits["largest-contentful-paint"]?.numericValue ?? null,
    ttiMs: audits["interactive"]?.numericValue ?? null,
    tbtMs: audits["total-blocking-time"]?.numericValue ?? null,
    cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
    speedIndex: audits["speed-index"]?.numericValue ?? null,
    serverResponseTime: audits["server-response-time"]?.numericValue ?? null,
  };
}

// -- Einzelmessung (Cold-Cache) -------------------------------------------

async function singleMeasurement(browser, url, runIndex, cookies = [], throttlingParams, requiresAuth = true) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  if (requiresAuth && cookies.length > 0) {
    await page.setCookie(...cookies);
  }

  await page.setViewport({ width: viewportWidth, height: viewportHeight });

  const cdp = await page.createCDPSession();
  await cdp.send("Performance.enable");
  await applyCdpThrottling(cdp, throttlingParams);

  const network = await collectNetworkMetrics(page);

  const navigationStart = Date.now();
  await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });
  const navigationDuration = Date.now() - navigationStart;

  if (requiresAuth) {
    const finalUrl = page.url();
    if (finalUrl.includes("customer-identity/login") || finalUrl.includes("/login")) {
      await cdp.detach();
      await network.cdp.detach();
      await context.close();
      throw new Error(`Login-Redirect erkannt in Run ${runIndex}: Ziel war ${url}, gelandet auf ${finalUrl}`);
    }
  }

  const perfMetrics = await collectPerformanceMetrics(cdp);
  const networkResults = network.getResults();
  const decomposition = extractResourceDecomposition(networkResults);

  const navTiming = await page.evaluate(() => {
    const perf = performance.getEntriesByType("navigation")[0];
    if (!perf) return null;
    return {
      ttfbMs: perf.responseStart - perf.requestStart,
      domContentLoadedMs: perf.domContentLoadedEventEnd - perf.startTime,
      domInteractiveMs: perf.domInteractive - perf.startTime,
      loadEventMs: perf.loadEventEnd - perf.startTime,
      redirectTimeMs: perf.redirectEnd - perf.redirectStart,
      dnsLookupMs: perf.domainLookupEnd - perf.domainLookupStart,
      tcpConnectMs: perf.connectEnd - perf.connectStart,
      tlsNegotiationMs:
        perf.secureConnectionStart > 0
          ? perf.connectEnd - perf.secureConnectionStart
          : 0,
      transferSizeBytes: perf.transferSize,
      decodedBodySizeBytes: perf.decodedBodySize,
      encodedBodySizeBytes: perf.encodedBodySize,
    };
  });

  const browserVitals = await page.evaluate(() => {
    return new Promise((resolve) => {
      const result = { fcp: null, lcp: null };
      const fcpEntries = performance.getEntriesByName("first-contentful-paint");
      if (fcpEntries.length > 0) result.fcp = fcpEntries[0].startTime;
      const lcpEntries = performance.getEntriesByType("largest-contentful-paint");
      if (lcpEntries.length > 0) result.lcp = lcpEntries[lcpEntries.length - 1].startTime;
      resolve(result);
    });
  });

  await cdp.detach();
  await network.cdp.detach();
  await context.close();

  return {
    runIndex,
    timestamp: new Date().toISOString(),
    navigationDurationMs: navigationDuration,
    browserFcpMs: browserVitals?.fcp ?? null,
    browserLcpMs: browserVitals?.lcp ?? null,
    ...navTiming,
    ...perfMetrics,
    totalPayloadKB: networkResults.totalPayloadKB,
    totalPayloadBytes: networkResults.totalPayloadBytes,
    totalRequests: networkResults.totalRequests,
    ...decomposition,
    networkByType: networkResults.byResourceType,
  };
}

// -- Warm-Cache-Messung ---------------------------------------------------

async function warmCacheMeasurement(browser, url, runIndex, cookies = [], throttlingParams, requiresAuth = true) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  if (requiresAuth && cookies.length > 0) {
    await page.setCookie(...cookies);
  }

  await page.setViewport({ width: viewportWidth, height: viewportHeight });

  const cdp = await page.createCDPSession();
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    downloadThroughput: throttlingParams.downloadThroughput,
    uploadThroughput: throttlingParams.uploadThroughput,
    latency: throttlingParams.latency,
  });
  // Cache bleibt aktiviert

  // Cold Load (Cache befüllen)
  const networkCold = await collectNetworkMetrics(page);
  await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });

  if (requiresAuth) {
    const finalUrl = page.url();
    if (finalUrl.includes("customer-identity/login") || finalUrl.includes("/login")) {
      await cdp.detach();
      await networkCold.cdp.detach();
      await context.close();
      throw new Error(`Login-Redirect in Warm-Cache-Run ${runIndex}`);
    }
  }

  const coldResults = networkCold.getResults();
  const coldDecomposition = extractResourceDecomposition(coldResults);
  await networkCold.cdp.detach();

  await sleep(500);

  // Warm Load (Messung)
  const networkWarm = await collectNetworkMetrics(page);

  const warmNavStart = Date.now();
  await page.goto(url, { waitUntil: "networkidle0", timeout: 120000 });
  const warmNavDuration = Date.now() - warmNavStart;

  const warmResults = networkWarm.getResults();
  const warmDecomposition = extractResourceDecomposition(warmResults);

  const warmNavTiming = await page.evaluate(() => {
    const perf = performance.getEntriesByType("navigation")[0];
    if (!perf) return null;
    return {
      ttfbMs: perf.responseStart - perf.requestStart,
      domContentLoadedMs: perf.domContentLoadedEventEnd - perf.startTime,
      domInteractiveMs: perf.domInteractive - perf.startTime,
      loadEventMs: perf.loadEventEnd - perf.startTime,
      transferSizeBytes: perf.transferSize,
      decodedBodySizeBytes: perf.decodedBodySize,
    };
  });

  await cdp.detach();
  await networkWarm.cdp.detach();
  await context.close();

  return {
    runIndex,
    timestamp: new Date().toISOString(),
    coldPayloadKB: coldResults.totalPayloadKB,
    coldRequests: coldResults.totalRequests,
    cold_htmlDocumentKB: coldDecomposition.htmlDocumentKB,
    cold_jsPayloadKB: coldDecomposition.jsPayloadKB,
    cold_apiPayloadKB: coldDecomposition.apiPayloadKB,
    cold_cssPayloadKB: coldDecomposition.cssPayloadKB,
    cold_staticAssetKB: coldDecomposition.staticAssetKB,
    warmNavigationMs: warmNavDuration,
    warmPayloadKB: warmResults.totalPayloadKB,
    warmRequests: warmResults.totalRequests,
    warmCachedRequests: warmResults.cachedRequests,
    warmNetworkRequests: warmResults.networkRequests,
    warmNetworkPayloadKB: warmResults.networkPayloadKB,
    warm_htmlDocumentKB: warmDecomposition.htmlDocumentKB,
    warm_jsPayloadKB: warmDecomposition.jsPayloadKB,
    warm_apiPayloadKB: warmDecomposition.apiPayloadKB,
    warm_cssPayloadKB: warmDecomposition.cssPayloadKB,
    warm_staticAssetKB: warmDecomposition.staticAssetKB,
    warmTtfbMs: warmNavTiming?.ttfbMs ?? null,
    warmDomContentLoadedMs: warmNavTiming?.domContentLoadedMs ?? null,
    warmTransferSizeBytes: warmNavTiming?.transferSizeBytes ?? null,
    cacheHitRate: warmResults.totalRequests > 0
      ? +(warmResults.cachedRequests / warmResults.totalRequests * 100).toFixed(1)
      : 0,
    payloadReductionPct: coldResults.totalPayloadKB > 0
      ? +((1 - warmResults.totalPayloadKB / coldResults.totalPayloadKB) * 100).toFixed(1)
      : 0,
  };
}

// -- Lighthouse-Pass ------------------------------------------------------

/** N Lighthouse-Audits mit Storage-Reset vor jedem Durchlauf. */
async function lighthousePass(browserWSEndpoint, url, runs, cookies = [], throttlingParams, requiresAuth = true) {
  const port = new URL(browserWSEndpoint).port;
  const results = [];

  const lhThrottling = convertThrottlingForLighthouse(throttlingParams);
  log(`    Lighthouse-Throttling: ${lhThrottling.downloadThroughputKbps.toFixed(0)} kbps down, ${lhThrottling.uploadThroughputKbps.toFixed(0)} kbps up, RTT ${lhThrottling.rttMs}ms`);

  for (let i = 0; i < runs; i++) {
    log(`    Lighthouse Audit ${i + 1}/${runs} ...`);
    try {
      const tmpBrowser = await puppeteer.connect({ browserWSEndpoint });
      const page = await tmpBrowser.newPage();
      const cdp = await page.createCDPSession();

      const origin = new URL(url).origin;
      await cdp.send("Storage.clearDataForOrigin", {
        origin,
        storageTypes: "cookies,local_storage,session_storage,indexeddb,websql,cache_storage,service_workers",
      });

      if (requiresAuth && cookies.length > 0) {
        await page.setCookie(...cookies);
      }

      await cdp.detach();
      await page.close();
      tmpBrowser.disconnect();

      const lhResult = await runLighthouseAudit(Number(port), url, lhThrottling, requiresAuth);
      results.push({ runIndex: i + 1, ...lhResult });
    } catch (err) {
      log(`    WARNUNG: Lighthouse Fehler in Run ${i + 1}: ${err.message}`);
      results.push({ runIndex: i + 1, error: err.message });
    }
    await sleep(cooldownMs);
  }

  return results;
}

// -- CSV-Generierung ------------------------------------------------------

function generateCSV(records, filename) {
  if (records.length === 0) return;

  const headers = Object.keys(records[0]).filter(
    (k) => typeof records[0][k] !== "object" || records[0][k] === null
  );

  const csvStringifier = createObjectCsvStringifier({
    header: headers.map((h) => ({ id: h, title: h })),
  });

  const csvContent =
    csvStringifier.getHeaderString() +
    csvStringifier.stringifyRecords(
      records.map((r) => {
        const flat = {};
        for (const h of headers) {
          flat[h] = r[h] ?? "";
        }
        return flat;
      })
    );

  writeFileSync(join(resultDir, filename), csvContent, "utf-8");
  log(`  CSV gespeichert: ${filename}`);
}

// -- Hauptprogramm --------------------------------------------------------

async function main() {
  const profileKeys = Object.keys(throttling.profiles);
  const scenarioEntries = Object.entries(scenarios);

  const authScenarios = scenarioEntries.filter(([, s]) => scenarioRequiresAuth(s));
  const noAuthScenarios = scenarioEntries.filter(([, s]) => !scenarioRequiresAuth(s));

  log("Quantitative Benchmark-Suite -- Bachelorthesis Finn-Ole Kahl");
  log("");
  log("Konfiguration:");
  log(`  Runs pro Szenario:   ${runsPerScenario}`);
  log(`  Warmup-Runs:         ${warmupRuns}`);
  log(`  Throttling-Profile:  ${profileKeys.map(k => throttling.profiles[k].label).join(", ")}`);
  log(`  Cooldown:            ${cooldownMs}ms`);
  log(`  Viewport:            ${viewportWidth}x${viewportHeight}`);
  log(`  Szenarien (auth):    ${authScenarios.map(([k]) => k).join(", ") || "keine"}`);
  log(`  Szenarien (no-auth): ${noAuthScenarios.map(([k]) => k).join(", ") || "keine"}`);
  log(`  Output:              ${resultDir}`);
  log("");

  for (const pk of profileKeys) {
    const p = throttling.profiles[pk];
    const lh = convertThrottlingForLighthouse(p);
    log(`  ${p.label}: CDP ${p.downloadThroughput} B/s -> LH ${lh.downloadThroughputKbps.toFixed(0)} kbps, RTT ${lh.rttMs}ms`);
  }
  log("");

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-first-run",
    ],
  });

  let sessionCookies = [];
  if (authScenarios.length > 0) {
    sessionCookies = await performLogin(browser);
  }
  log("");

  const allResults = {};
  const allWarmCacheResults = {};
  const metadata = {
    startTime: new Date().toISOString(),
    benchmarkVersion: "3.0",
    config: {
      runsPerScenario,
      warmupRuns,
      throttlingProfiles: Object.fromEntries(
        profileKeys.map(k => [k, {
          ...throttling.profiles[k],
          lighthouseThrottling: convertThrottlingForLighthouse(throttling.profiles[k]),
        }])
      ),
      viewport: { width: viewportWidth, height: viewportHeight },
    },
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      chromePath: browser.process()?.spawnfile ?? "unknown",
    },
  };

  for (const profileKey of profileKeys) {
    const profile = throttling.profiles[profileKey];
    log("-----------------------------------------------------------");
    log(`Throttling-Profil: ${profile.label} (${profileKey})`);
    log(`  ${profile.downloadThroughput / 1000} kB/s down, ${profile.uploadThroughput / 1000} kB/s up, Latenz ${profile.latency}ms`);
    log("-----------------------------------------------------------");
    log("");

    for (const [scenarioKey, scenario] of scenarioEntries) {
      const resultKey = `${profileKey}_${scenarioKey}`;
      const requiresAuth = scenarioRequiresAuth(scenario);
      const getCookies = () => requiresAuth ? sessionCookies : [];

      log(`--- Szenario: ${scenario.label} [${profile.label}] ---`);
      log(`    URL:  ${scenario.url}`);
      log(`    Auth: ${requiresAuth ? "Ja" : "Nein"}`);
      log("");

      if (requiresAuth) {
        log("  Session-Cookies erneuern (vor Phase 1) ...");
        sessionCookies = await performLogin(browser);
        log("");
      }

      // Phase 1: CDP-Messungen (Cold-Cache)
      log(`  Phase 1: CDP-Messungen (${warmupRuns} Warmup + ${runsPerScenario} Messungen)`);

      const cdpResults = [];

      for (let i = 0; i < warmupRuns; i++) {
        log(`    Warmup ${i + 1}/${warmupRuns} ...`);
        try {
          await singleMeasurement(browser, scenario.url, -(warmupRuns - i), getCookies(), profile, requiresAuth);
        } catch (err) {
          if (requiresAuth && err.message.includes("Login-Redirect")) {
            log("    Session abgelaufen, erneuere Cookies ...");
            sessionCookies = await performLogin(browser);
            await singleMeasurement(browser, scenario.url, -(warmupRuns - i), getCookies(), profile, requiresAuth);
          } else {
            log(`    WARNUNG: Warmup-Fehler: ${err.message}`);
          }
        }
        await sleep(cooldownMs);
      }

      for (let i = 0; i < runsPerScenario; i++) {
        log(`    Messung ${i + 1}/${runsPerScenario} ...`);
        try {
          const result = await singleMeasurement(browser, scenario.url, i + 1, getCookies(), profile, requiresAuth);
          cdpResults.push(result);
        } catch (err) {
          if (requiresAuth && err.message.includes("Login-Redirect")) {
            log("    Session abgelaufen, erneuere Cookies ...");
            sessionCookies = await performLogin(browser);
            try {
              const result = await singleMeasurement(browser, scenario.url, i + 1, getCookies(), profile, requiresAuth);
              cdpResults.push(result);
            } catch (retryErr) {
              log(`    WARNUNG: Fehler in Messung ${i + 1} (nach Relogin): ${retryErr.message}`);
              cdpResults.push({ runIndex: i + 1, error: retryErr.message });
            }
          } else {
            log(`    WARNUNG: Fehler in Messung ${i + 1}: ${err.message}`);
            cdpResults.push({ runIndex: i + 1, error: err.message });
          }
        }
        await sleep(cooldownMs);
      }

      // Phase 2: Lighthouse-Audits
      log("");
      if (requiresAuth) {
        log("  Session-Cookies erneuern ...");
        sessionCookies = await performLogin(browser);
      }
      log("");
      log(`  Phase 2: Lighthouse-Audits (${runsPerScenario} Durchläufe)`);
      const browserWSEndpoint = browser.wsEndpoint();
      const lhResults = await lighthousePass(
        browserWSEndpoint,
        scenario.url,
        runsPerScenario,
        requiresAuth ? sessionCookies : [],
        profile,
        requiresAuth,
      );

      // Phase 3: Warm-Cache-Messung
      log("");
      if (requiresAuth) {
        log("  Session-Cookies erneuern ...");
        sessionCookies = await performLogin(browser);
      }
      log("");
      log(`  Phase 3: Warm-Cache-Messung (${runsPerScenario} Durchläufe)`);

      const warmCacheResults = [];

      for (let i = 0; i < warmupRuns; i++) {
        log(`    Warmup ${i + 1}/${warmupRuns} ...`);
        try {
          await warmCacheMeasurement(
            browser, scenario.url, -(warmupRuns - i),
            getCookies(), profile, requiresAuth
          );
        } catch (err) {
          if (requiresAuth && err.message.includes("Login-Redirect")) {
            log("    Session abgelaufen, erneuere Cookies ...");
            sessionCookies = await performLogin(browser);
            await warmCacheMeasurement(
              browser, scenario.url, -(warmupRuns - i),
              getCookies(), profile, requiresAuth
            );
          } else {
            log(`    WARNUNG: Warmup-Fehler: ${err.message}`);
          }
        }
        await sleep(cooldownMs);
      }

      for (let i = 0; i < runsPerScenario; i++) {
        log(`    Warm-Cache ${i + 1}/${runsPerScenario} ...`);
        try {
          const result = await warmCacheMeasurement(
            browser, scenario.url, i + 1,
            getCookies(), profile, requiresAuth
          );
          warmCacheResults.push(result);
        } catch (err) {
          if (requiresAuth && err.message.includes("Login-Redirect")) {
            log("    Session abgelaufen, erneuere Cookies ...");
            sessionCookies = await performLogin(browser);
            try {
              const result = await warmCacheMeasurement(
                browser, scenario.url, i + 1,
                getCookies(), profile, requiresAuth
              );
              warmCacheResults.push(result);
            } catch (retryErr) {
              log(`    WARNUNG: Fehler in Warm-Cache ${i + 1} (nach Relogin): ${retryErr.message}`);
              warmCacheResults.push({ runIndex: i + 1, error: retryErr.message });
            }
          } else {
            log(`    WARNUNG: Fehler in Warm-Cache ${i + 1}: ${err.message}`);
            warmCacheResults.push({ runIndex: i + 1, error: err.message });
          }
        }
        await sleep(cooldownMs);
      }

      allWarmCacheResults[resultKey] = warmCacheResults;
      generateCSV(warmCacheResults, `${profileKey}_${scenarioKey}_warm_cache.csv`);

      // Ergebnisse zusammenführen (Phase 1 + 2)
      const merged = cdpResults.map((cdp, idx) => {
        const lh = lhResults[idx] || {};
        return {
          scenario: scenarioKey,
          scenarioLabel: scenario.label,
          throttlingProfile: profileKey,
          throttlingLabel: profile.label,
          requiresAuth,
          ...cdp,
          lh_performanceScore: lh.performanceScore ?? null,
          lh_fcpMs: lh.fcpMs ?? null,
          lh_lcpMs: lh.lcpMs ?? null,
          lh_ttiMs: lh.ttiMs ?? null,
          lh_tbtMs: lh.tbtMs ?? null,
          lh_cls: lh.cls ?? null,
          lh_speedIndex: lh.speedIndex ?? null,
          lh_serverResponseTime: lh.serverResponseTime ?? null,
        };
      });

      allResults[resultKey] = merged;

      const csvRecords = merged.map(({ networkByType, ...rest }) => rest);
      generateCSV(csvRecords, `${profileKey}_${scenarioKey}_raw.csv`);

      const breakdownRecords = merged.flatMap((m) => {
        if (!m.networkByType) return [];
        return Object.entries(m.networkByType).map(([type, data]) => ({
          runIndex: m.runIndex,
          resourceType: type,
          requestCount: data.count,
          sizeBytes: data.bytes,
          sizeKB: +(data.bytes / 1024).toFixed(2),
          cachedCount: data.cached || 0,
        }));
      });
      generateCSV(breakdownRecords, `${profileKey}_${scenarioKey}_network_breakdown.csv`);

      log(`  ${scenario.label} [${profile.label}] abgeschlossen`);
      log("");
    }

    log(`Profil ${profile.label} abgeschlossen.`);
    log("");
  }

  // Kombinierte CSVs
  const combinedRecords = Object.values(allResults)
    .flat()
    .map(({ networkByType, ...rest }) => rest);
  generateCSV(combinedRecords, "combined_all_scenarios.csv");

  const combinedWarmCache = Object.entries(allWarmCacheResults)
    .flatMap(([key, results]) => {
      const firstUnderscore = key.indexOf("_");
      const profileKey = key.substring(0, firstUnderscore);
      const scenarioKey = key.substring(firstUnderscore + 1);
      return results.map((r) => ({
        scenario: scenarioKey,
        scenarioLabel: scenarios[scenarioKey]?.label ?? scenarioKey,
        throttlingProfile: profileKey,
        throttlingLabel: throttling.profiles[profileKey]?.label ?? profileKey,
        ...r,
      }));
    });
  if (combinedWarmCache.length > 0) {
    generateCSV(combinedWarmCache, "combined_warm_cache.csv");
  }

  // Gesamtergebnis als JSON
  const fullOutput = {
    metadata: {
      ...metadata,
      endTime: new Date().toISOString(),
    },
    results: allResults,
    warmCacheResults: allWarmCacheResults,
  };

  writeFileSync(
    join(resultDir, "results_complete.json"),
    JSON.stringify(fullOutput, null, 2),
    "utf-8"
  );
  log("Komplette Rohdaten gespeichert: results_complete.json");

  await browser.close();

  log("");
  log("Messung abgeschlossen. Nächster Schritt:");
  log(`  python3 analyze.py ${resultDir}`);
}

main().catch((err) => {
  console.error("Fataler Fehler:", err);
  process.exit(1);
});
