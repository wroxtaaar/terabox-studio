import fs from "fs";

const filePath = "server/terabox.ts";
const source = fs.readFileSync(filePath, "utf8");

const start = source.indexOf("let browserResolverInProgress = false;");
const end = source.indexOf("\nexport async function resolveTeraboxLink", start);

if (start < 0 || end < 0) {
  console.log("Chromium resolver patch: source already patched or marker not found; skipping.");
  process.exit(0);
}

const replacement = String.raw`let chromiumQueue: Promise<void> = Promise.resolve();

async function withChromiumSlot<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = chromiumQueue;
  chromiumQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function getChromiumExecutablePath(): string {
  return (
    process.env.TERABOX_CHROMIUM_PATH?.trim() ||
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim() ||
    "/usr/bin/chromium"
  );
}

function extractChromiumToken(value: string): string {
  if (!value) return "";

  const patterns = [
    /[?&]jsToken=([^&"'\\s]+)/i,
    /(?:jsToken|jstoken|js_token)[\\s"'=:]+([A-Za-z0-9_-]{8,})/i,
    /fn\\s*\\(\\s*["']([A-Za-z0-9_-]{8,})["']\\s*\\)/i,
    /fn%28%22([^%"]{8,})%22%29/i,
    /window\\.jsToken\\s*=\\s*["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1]) return match[1];
  }

  return "";
}

async function resolveTeraboxViaChromium(rawUrl: string): Promise<ResolvedMetadata> {
  return withChromiumSlot(async () => {
    const shortCode = extractSurl(rawUrl);
    if (!shortCode) {
      throw new Error("Could not extract a TeraBox share code for Chromium resolution.");
    }

    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

    try {
      browser = await chromium.launch({
        executablePath: getChromiumExecutablePath(),
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-features=Translate,BackForwardCache",
        ],
        timeout: 15000,
      });

      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1280, height: 720 },
        serviceWorkers: "allow",
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const page = await context.newPage();
      page.setDefaultTimeout(10000);

      let jsToken = "";
      let capturedInfo: any = null;
      const capturedItems: any[] = [];
      const networkErrors: string[] = [];
      const responseSummary: string[] = [];
      const pendingResponses: Promise<void>[] = [];

      const consumeResponse = async (response: any) => {
        const url = response.url();
        const lower = url.toLowerCase();

        if (lower.includes("jstoken=")) {
          jsToken ||= extractChromiumToken(url);
        }

        const interesting =
          lower.includes("/api/shorturlinfo") ||
          lower.includes("/share/list") ||
          lower.includes("/share/download") ||
          lower.includes("/share/streaming");

        if (!interesting) return;

        responseSummary.push(response.status() + " " + url.slice(0, 260));

        try {
          const text = await response.text();
          jsToken ||= extractChromiumToken(url + " " + text);

          if (!text) return;
          let payload: any = null;
          try {
            payload = JSON.parse(text);
          } catch {
            return;
          }

          if (lower.includes("/api/shorturlinfo")) {
            const errno = Number(payload?.errno ?? -1);
            console.log(
              "Chromium shorturlinfo response status=" + response.status() +
              " errno=" + errno +
              " items=" + (Array.isArray(payload?.list) ? payload.list.length : 0)
            );
            if (errno === 0) {
              capturedInfo = payload;
              if (Array.isArray(payload?.list)) capturedItems.push(...payload.list);
            }
          }

          if (lower.includes("/share/list")) {
            const errno = Number(payload?.errno ?? -1);
            console.log(
              "Chromium share/list response status=" + response.status() +
              " errno=" + errno +
              " items=" + (Array.isArray(payload?.list) ? payload.list.length : 0)
            );
            if (errno === 0 && Array.isArray(payload?.list)) capturedItems.push(...payload.list);
          }

          if (Array.isArray(payload?.dlink)) {
            for (const item of payload.dlink) {
              if (typeof item === "string") {
                capturedItems.push({ dlink: item });
              }
            }
          } else if (typeof payload?.dlink === "string") {
            capturedItems.push({ dlink: payload.dlink });
          }
        } catch {
          // Some streaming/download responses are binary or unavailable after navigation.
        }
      };

      page.on("request", (request: any) => {
        const url = request.url();
        const token = extractChromiumToken(url);
        if (token) jsToken ||= token;
      });

      page.on("response", (response: any) => {
        const pending = consumeResponse(response).catch((error) => {
          networkErrors.push("response-handler: " + (error instanceof Error ? error.message : String(error)));
        });
        pendingResponses.push(pending);
      });

      page.on("requestfailed", (request: any) => {
        const failure = request.failure()?.errorText || "request failed";
        const url = request.url();
        if (/terabox|1024tera|dubox/i.test(url)) {
          networkErrors.push(failure + " " + url.slice(0, 220));
        }
      });

      console.log("Chromium resolver: opening TeraBox share page");

      const navigation = await page.goto(rawUrl, {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });

      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2500);

      const finalUrl = page.url();
      const pageText = await page.content();

      jsToken ||= extractChromiumToken(pageText);

      const storage = await page
        .evaluate(() => {
          const read = (store: Storage) => {
            const values: Record<string, string> = {};
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              if (!key) continue;
              try {
                values[key] = String(store.getItem(key) || "");
              } catch {}
            }
            return values;
          };

          return {
            local: read(window.localStorage),
            session: read(window.sessionStorage),
            title: document.title,
            text: document.body?.innerText?.slice(0, 5000) || "",
          };
        })
        .catch(() => ({ local: {}, session: {}, title: "", text: "" }));

      const storageText = JSON.stringify(storage);
      jsToken ||= extractChromiumToken(storageText);

      const browserCookies = await context.cookies();
      const cookieHeader = browserCookies
        .map((cookie) => cookie.name + "=" + cookie.value)
        .join("; ");

      let apiOrigin = "https://www.terabox.app";
      try {
        const origin = new URL(finalUrl).origin;
        if (origin.includes("terabox")) apiOrigin = origin;
      } catch {}

      console.log(
        "Chromium page loaded host=" +
          (() => {
            try { return new URL(finalUrl).host; } catch { return "unknown"; }
          })() +
          " status=" + (navigation?.status() ?? "unknown") +
          " jsToken=" + (jsToken ? "yes" : "no") +
          " cookies=" + (cookieHeader ? "yes" : "no") +
          " responses=" + responseSummary.length
      );

      // If the page itself did not call the share APIs, use a second browser
      // page in the same context. This keeps the request browser-native and
      // carries the cookies/challenge state from the share page.
      if (!capturedInfo || capturedItems.length === 0) {
        const apiPage = await context.newPage();
        apiPage.setDefaultTimeout(10000);

        apiPage.on("request", (request: any) => {
          const token = extractChromiumToken(request.url());
          if (token) jsToken ||= token;
        });
        apiPage.on("response", (response: any) => {
          const pending = consumeResponse(response).catch((error) => {
            networkErrors.push("api-response-handler: " + (error instanceof Error ? error.message : String(error)));
          });
          pendingResponses.push(pending);
        });

        const variants = [
          shortCode,
          shortCode.startsWith("1") ? shortCode.slice(1) : "1" + shortCode,
        ].filter((value, index, values) => value && values.indexOf(value) === index);

        for (const variant of variants) {
          if (!capturedInfo) {
            try {
              const infoUrl = new URL("/api/shorturlinfo", apiOrigin);
              infoUrl.searchParams.set("app_id", "250528");
              infoUrl.searchParams.set("shorturl", variant);
              infoUrl.searchParams.set("root", "1");
              infoUrl.searchParams.set("web", "1");
              infoUrl.searchParams.set("channel", "dubox");
              infoUrl.searchParams.set("clienttype", "0");
              if (jsToken) infoUrl.searchParams.set("jsToken", jsToken);
              await apiPage.goto(infoUrl.toString(), {
                waitUntil: "domcontentloaded",
                timeout: 12000,
              }).catch(() => {});
              await apiPage.waitForTimeout(500);
            } catch {}
          }
        }

        await apiPage.close().catch(() => {});
      }

      // Response events are asynchronous. Wait for every captured API body
      // before converting the captured payloads into files.
      if (pendingResponses.length > 0) {
        await Promise.allSettled(pendingResponses);
      }

      const allItems = [...capturedItems];

      // A few versions expose the token in inline scripts or storage only.
      // Once it is available, try the API from the browser page as a final
      // same-origin attempt; this is intentionally after network observation.
      if (jsToken && (!capturedInfo || allItems.length === 0)) {
        const browserApiResult = await page.evaluate(
          async ({ origin, shortCode, jsToken }) => {
            const variants = [
              shortCode,
              shortCode.startsWith("1") ? shortCode.slice(1) : "1" + shortCode,
            ].filter((value, index, values) => value && values.indexOf(value) === index);

            const result: { info: any | null; list: any[]; errors: string[] } = {
              info: null,
              list: [],
              errors: [],
            };

            for (const variant of variants) {
              try {
                const url = new URL("/api/shorturlinfo", origin);
                url.searchParams.set("app_id", "250528");
                url.searchParams.set("shorturl", variant);
                url.searchParams.set("root", "1");
                url.searchParams.set("web", "1");
                url.searchParams.set("channel", "dubox");
                url.searchParams.set("clienttype", "0");
                url.searchParams.set("jsToken", jsToken);

                const response = await fetch(url.toString(), {
                  credentials: "include",
                  headers: {
                    Accept: "application/json, text/plain, */*",
                    "X-Requested-With": "XMLHttpRequest",
                  },
                });

                const text = await response.text();
                let payload: any = null;
                try { payload = text ? JSON.parse(text) : null; } catch {}

                if (response.ok && Number(payload?.errno ?? -1) === 0) {
                  result.info = payload;
                  if (Array.isArray(payload?.list)) result.list.push(...payload.list);
                  break;
                }

                result.errors.push(
                  "shorturlinfo " + variant + " HTTP " + response.status +
                  " errno=" + String(payload?.errno ?? "unknown")
                );
              } catch (error) {
                result.errors.push(
                  "shorturlinfo " + variant + ": " +
                  (error instanceof Error ? error.message : String(error))
                );
              }
            }

            if (result.info) {
              try {
                const listUrl = new URL("/share/list", origin);
                listUrl.searchParams.set("app_id", "250528");
                listUrl.searchParams.set("web", "1");
                listUrl.searchParams.set("channel", "0");
                listUrl.searchParams.set("clienttype", "0");
                listUrl.searchParams.set("jsToken", jsToken);
                listUrl.searchParams.set(
                  "shorturl",
                  result.info.shorturl || shortCode
                );
                listUrl.searchParams.set("page", "1");
                listUrl.searchParams.set("num", "100");
                listUrl.searchParams.set("by", "name");
                listUrl.searchParams.set("order", "asc");
                listUrl.searchParams.set("root", "1");

                const response = await fetch(listUrl.toString(), {
                  credentials: "include",
                  headers: {
                    Accept: "application/json, text/plain, */*",
                    "X-Requested-With": "XMLHttpRequest",
                  },
                });
                const text = await response.text();
                let payload: any = null;
                try { payload = text ? JSON.parse(text) : null; } catch {}

                if (response.ok && Number(payload?.errno ?? -1) === 0) {
                  if (Array.isArray(payload?.list)) result.list.push(...payload.list);
                } else {
                  result.errors.push(
                    "share/list HTTP " + response.status +
                    " errno=" + String(payload?.errno ?? "unknown")
                  );
                }
              } catch (error) {
                result.errors.push(
                  "share/list: " + (error instanceof Error ? error.message : String(error))
                );
              }
            }

            return result;
          },
          { origin: apiOrigin, shortCode, jsToken }
        );

        if (!capturedInfo && browserApiResult.info) capturedInfo = browserApiResult.info;
        allItems.push(...browserApiResult.list);
      }

      const info = capturedInfo;
      const uniqueItems = new Map<string, any>();
      for (const item of allItems) {
        const key = item?.fs_id
          ? "fs:" + item.fs_id
          : item?.dlink
            ? "dlink:" + item.dlink
            : "path:" + (item?.path || item?.server_filename || item?.filename || JSON.stringify(item));
        if (!uniqueItems.has(key)) uniqueItems.set(key, item);
      }

      const shareId = info?.shareid ? String(info.shareid) : undefined;
      const uk = info?.uk ? String(info.uk) : undefined;
      const sign = info?.sign ? String(info.sign) : undefined;
      const timestamp = info?.timestamp ? String(info.timestamp) : undefined;
      const randsk = info?.randsk ? decodeURIComponent(String(info.randsk)) : undefined;
      const files: ResolvedTeraboxFile[] = [];

      for (const item of uniqueItems.values()) {
        const file = createTeraboxFileMetadata(item, shareId, uk, sign, timestamp);
        if (file) files.push(file);
      }

      if (shareId && uk && sign && timestamp) {
        for (const file of files) {
          if (file.downloadUrl || !file.fsId) continue;
          file.downloadUrl = await fetchTeraboxDownloadUrl(
            shareId,
            uk,
            sign,
            timestamp,
            file.fsId,
            jsToken,
            cookieHeader,
            finalUrl
          );
        }
      }

      const downloadableFiles = files.filter((file) => file.downloadUrl || file.streamUrl);

      if (downloadableFiles.length === 0) {
        throw new Error(
          "Chromium resolver found no downloadable files (jsToken=" +
            (jsToken ? "yes" : "no") +
            "; items=" + uniqueItems.size +
            "; responses=" + responseSummary.slice(-8).join(" | ") +
            "; networkErrors=" + networkErrors.slice(-5).join(" | ") +
            ")"
        );
      }

      console.log(
        "Chromium resolver succeeded: files=" +
          downloadableFiles.length +
          " cookies=" + (cookieHeader ? "yes" : "no") +
          " jsToken=" + (jsToken ? "yes" : "no")
      );

      return {
        shareId,
        uk,
        sign,
        timestamp,
        randsk,
        title: info?.title
          ? cleanFilename(String(info.title))
          : downloadableFiles[0]?.filename || "TeraBox Files",
        files: downloadableFiles,
        directDownloadPossible: true,
        cookies: cookieHeader,
        refererUrl: finalUrl,
      };
    } finally {
      try { await browser?.close(); } catch {}
    }
  });
}`;

const nextSource = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(filePath, nextSource);
console.log("Chromium resolver patch applied: network interception + browser-native API fallback + request queue.");
