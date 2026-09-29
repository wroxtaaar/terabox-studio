import path from "path";
import fs from "fs";
import { pipeline } from "stream/promises";
import unzipper from "unzipper";
import { execFile } from "child_process";
import { promisify } from "util";
import { chromium, type Browser, type Page } from "playwright-core";

const execFileAsync = promisify(execFile);

export const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v",
  ".mpeg", ".mpg", ".3gp", ".ts", ".flv",
]);

export const TERABOX_DOMAINS_PATTERN =
  /(?:terabox|terashare|terafileshare|1024tera|1024-tera|tera-box|nephobox|mirrobox|mirrorbox|momerybox|tibibox|gibibox|pebibox|4funbox|dubox|bestclouddrive)/i;

export function isTeraboxUrl(text: string): boolean {
  if (!text) return false;
  if (TERABOX_DOMAINS_PATTERN.test(text)) return true;
  return /(?:\/s\/|\/share\/init|\/sharing\/link)\?.*?(?:surl=|s\/1)[a-zA-Z0-9_-]+|\/s\/1[a-zA-Z0-9_-]{10,}/i.test(text);
}

export function extractUrlFromText(text: string): string | null {
  const direct = text.match(/https?:\/\/\S+/i);
  if (direct) return direct[0].replace(/[).,\]]+$/, "");
  const bare = text.match(/(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/\S+/i);
  return bare ? "https://" + bare[0].replace(/^[a-z]+:\/\//i, "").replace(/[).,\]]+$/, "") : null;
}

export function cleanFilename(filename: string): string {
  if (!filename) return "terabox_download";
  try { filename = decodeURIComponent(filename); } catch {}
  filename = path.basename(filename);
  filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/^[. ]+|[. ]+$/g, "");
  return filename || "terabox_download";
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const i = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + " " + sizes[i];
}

export function detectExtensionFromBuffer(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return ".mp4";
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return buffer.subarray(0, 128).toString("binary").toLowerCase().includes("webm") ? ".webm" : ".mkv";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "AVI ") return ".avi";
  if (buffer.subarray(0, 3).toString("ascii") === "ID3" || (buffer[0] === 0xff && [0xfb,0xf3,0xf2].includes(buffer[1]))) return ".mp3";
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return ".zip";
  if (buffer.subarray(0, 4).toString("ascii") === "Rar!" && buffer[4] === 0x1a && buffer[5] === 0x07) return ".rar";
  if (buffer[0] === 0x37 && buffer[1] === 0x7a && buffer[2] === 0xbc && buffer[3] === 0xaf && buffer[4] === 0x27 && buffer[5] === 0x1c) return ".7z";
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") return ".pdf";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return ".png";
  return null;
}

export function extractSurl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    const value = u.searchParams.get("surl");
    if (value) return value;
    const match = rawUrl.match(/\/s\/([a-zA-Z0-9_-]+)/i);
    if (match) return match[1];
  } catch {
    const match = rawUrl.match(/(?:surl=|s\/)([a-zA-Z0-9_-]+)/i);
    if (match) return match[1];
  }
  return null;
}

export interface ResolvedTeraboxFile {
  filename: string;
  sizeBytes: number;
  sizeFormatted: string;
  isVideo: boolean;
  isZip: boolean;
  downloadUrl?: string;
  fsId?: string;
  path?: string;
  streamUrl?: string;
  thumbs?: Record<string, string>;
  sign?: string;
  timestamp?: string;
  duration?: number;
}

export interface ResolvedMetadata {
  shareId?: string;
  uk?: string;
  sign?: string;
  timestamp?: string;
  randsk?: string;
  title?: string;
  files: ResolvedTeraboxFile[];
  directDownloadPossible: boolean;
  cookies?: string;
  refererUrl?: string;
}

let chromiumQueue: Promise<void> = Promise.resolve();

async function withChromiumSlot<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = chromiumQueue;
  chromiumQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await fn(); }
  finally { release(); }
}

function chromiumPath(): string {
  return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim()
    || process.env.TERABOX_CHROMIUM_PATH?.trim()
    || "/usr/bin/chromium";
}

function isInterestingUrl(url: string): boolean {
  return /(?:terabox|terashare|1024tera|dubox)/i.test(url) &&
    /(?:api\/|share\/|download|stream|file|list|dlink|shorturl)/i.test(url);
}

function valueAsString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function mergeFile(
  files: Map<string, ResolvedTeraboxFile>,
  file: ResolvedTeraboxFile
): void {
  const key = file.fsId ? "fs:" + file.fsId : "file:" + file.filename + ":" + file.sizeBytes;
  const previous = files.get(key);
  files.set(key, {
    ...previous,
    ...file,
    downloadUrl: file.downloadUrl || previous?.downloadUrl,
    streamUrl: file.streamUrl || previous?.streamUrl,
  });
}

function fileFromObject(item: any, metadata: Partial<ResolvedMetadata>): ResolvedTeraboxFile | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  if (String(item.isdir ?? item.isDir ?? "0") === "1") return null;

  const filename = cleanFilename(
    valueAsString(item.server_filename) ||
    valueAsString(item.filename) ||
    valueAsString(item.name) ||
    ""
  );

  const hasIdentity =
    !!item.fs_id || !!item.fsId ||
    item.size !== undefined ||
    !!item.dlink || !!item.download_url ||
    (typeof item.url === "string" && /(?:download|dlink|m3u8|streaming)/i.test(item.url));

  if (!hasIdentity || filename === "terabox_download") return null;

  const size = Number(item.size ?? item.sizeBytes ?? 0) || 0;
  const ext = path.extname(filename).toLowerCase();

  let downloadUrl =
    valueAsString(item.dlink) ||
    valueAsString(item.download_url);

  let streamUrl =
    valueAsString(item.m3u8) ||
    valueAsString(item.stream_url);

  if (!streamUrl && typeof item.url === "string" && /(?:m3u8|streaming)/i.test(item.url)) {
    streamUrl = item.url;
  }

  // The URL is built only from metadata observed inside the real browser session.
  if (!streamUrl && metadata.shareId && metadata.uk && metadata.sign && metadata.timestamp && (item.fs_id || item.fsId) && VIDEO_EXTENSIONS.has(ext)) {
    streamUrl =
      "https://www.terabox.app/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0" +
      "&shareid=" + encodeURIComponent(metadata.shareId) +
      "&uk=" + encodeURIComponent(metadata.uk) +
      "&fid=" + encodeURIComponent(String(item.fs_id ?? item.fsId)) +
      "&sign=" + encodeURIComponent(metadata.sign) +
      "&timestamp=" + encodeURIComponent(metadata.timestamp) +
      "&type=M3U8_AUTO_480";
  }

  return {
    filename,
    sizeBytes: size,
    sizeFormatted: size ? formatBytes(size) : "Unknown size",
    isVideo: VIDEO_EXTENSIONS.has(ext),
    isZip: /\.(zip|rar|7z)$/i.test(filename),
    downloadUrl,
    fsId: valueAsString(item.fs_id ?? item.fsId),
    path: valueAsString(item.path),
    streamUrl,
    thumbs: item.thumbs && typeof item.thumbs === "object" ? item.thumbs : undefined,
    sign: valueAsString(item.sign) || metadata.sign,
    timestamp: valueAsString(item.timestamp) || metadata.timestamp,
    duration: Number(item.duration) > 0 ? Number(item.duration) : undefined,
  };
}

function collectMetadataAndFiles(
  value: any,
  metadata: Partial<ResolvedMetadata>,
  files: Map<string, ResolvedTeraboxFile>,
  depth = 0
): void {
  if (value === null || value === undefined || depth > 8) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 2000)) {
      collectMetadataAndFiles(item, metadata, files, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  const shareId = valueAsString(value.shareid ?? value.shareId ?? value.share_id);
  const uk = valueAsString(value.uk);
  const sign = valueAsString(value.sign);
  const timestamp = valueAsString(value.timestamp);
  const randsk = valueAsString(value.randsk);
  const title = valueAsString(value.title ?? value.share_title);

  if (shareId) metadata.shareId = shareId;
  if (uk) metadata.uk = uk;
  if (sign) metadata.sign = sign;
  if (timestamp) metadata.timestamp = timestamp;
  if (randsk) metadata.randsk = randsk;
  if (title && !metadata.title) metadata.title = title;

  const file = fileFromObject(value, metadata);
  if (file) mergeFile(files, file);

  for (const [key, child] of Object.entries(value)) {
    if (/^(headers|requestHeaders|responseHeaders)$/i.test(key)) continue;
    if (typeof child === "object" && child !== null) {
      collectMetadataAndFiles(child, metadata, files, depth + 1);
    }
  }
}

function collectUrlsFromValue(
  value: any,
  downloadUrls: string[],
  streamUrls: string[],
  depth = 0
): void {
  if (value === null || value === undefined || depth > 8) return;

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 2000)) {
      collectUrlsFromValue(item, downloadUrls, streamUrls, depth + 1);
    }
    return;
  }

  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /^https?:\/\//i.test(child)) {
      if (/(?:dlink|download)/i.test(key) || /(?:download|dlink)/i.test(child)) {
        if (!downloadUrls.includes(child)) downloadUrls.push(child);
      }
      if (/(?:m3u8|streaming|stream_url)/i.test(key) || /(?:m3u8|streaming)/i.test(child)) {
        if (!streamUrls.includes(child)) streamUrls.push(child);
      }
    } else if (typeof child === "object" && child !== null) {
      collectUrlsFromValue(child, downloadUrls, streamUrls, depth + 1);
    }
  }
}

async function parseResponse(
  response: any,
  metadata: Partial<ResolvedMetadata>,
  files: Map<string, ResolvedTeraboxFile>,
  downloadUrls: string[],
  streamUrls: string[],
  summaries: string[]
): Promise<void> {
  const url = response.url();
  if (!isInterestingUrl(url)) return;

  const status = response.status();
  summaries.push(status + " " + url.slice(0, 320));

  if (/(?:download|dlink)/i.test(url) && /^https?:/i.test(url)) {
    if (!downloadUrls.includes(url)) downloadUrls.push(url);
  }
  if (/(?:m3u8|streaming)/i.test(url) && /^https?:/i.test(url)) {
    if (!streamUrls.includes(url)) streamUrls.push(url);
  }

  try {
    const contentType = String(response.headers()["content-type"] || "").toLowerCase();
    if (!contentType.includes("json") && !/(?:shorturlinfo|share\/list|share\/download|streaming)/i.test(url)) {
      return;
    }

    const body = await response.text();
    if (!body || body.length > 2_000_000) return;

    let payload: any = null;
    try {
      payload = JSON.parse(body);
    } catch {
      const urls = body.match(/https?:\\?\/\\?\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+/g) || [];
      for (const raw of urls) {
        const cleaned = raw.replace(/\\\//g, "/").replace(/[\"'<>\s]+$/g, "");
        if (/(?:download|dlink)/i.test(cleaned) && !downloadUrls.includes(cleaned)) downloadUrls.push(cleaned);
        if (/(?:m3u8|streaming)/i.test(cleaned) && !streamUrls.includes(cleaned)) streamUrls.push(cleaned);
      }
      return;
    }

    collectMetadataAndFiles(payload, metadata, files);
    collectUrlsFromValue(payload, downloadUrls, streamUrls);
  } catch (error) {
    console.warn("Chromium response parse failed:", error);
  }
}

async function scrapeDom(
  page: Page,
  metadata: Partial<ResolvedMetadata>,
  files: Map<string, ResolvedTeraboxFile>,
  downloadUrls: string[],
  streamUrls: string[]
): Promise<void> {
  const data = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll(
      "a,button,[role='button'],[data-fsid],[data-fs-id],[data-url],[data-download-url]"
    )).map((el: any) => ({
      text: String(el.innerText || el.textContent || "").trim().slice(0, 400),
      href: typeof el.href === "string" ? el.href : "",
      fsId: String(el.getAttribute("data-fsid") || el.getAttribute("data-fs-id") || ""),
      url: String(el.getAttribute("data-url") || el.getAttribute("data-download-url") || ""),
      download: /download/i.test(String(el.innerText || el.textContent || "")),
    }));

    const globals: Record<string, unknown> = {};
    for (const key of [
      "__INITIAL_STATE__",
      "__INITIAL_DATA__",
      "initialState",
      "initialData",
      "initData",
      "yunData",
      "shareInfo",
      "pageData",
    ]) {
      try {
        const value = (window as any)[key];
        if (value !== undefined) globals[key] = value;
      } catch {}
    }

    return {
      title: document.title || "",
      bodyText: document.body?.innerText?.slice(0, 16000) || "",
      nodes,
      jsonScripts: Array.from(document.querySelectorAll("script[type='application/json']"))
        .map((s) => (s.textContent || "").slice(0, 500000)),
      globals,
    };
  });

  if (data.title && data.title !== "TeraBox") metadata.title = data.title;

  for (const text of data.jsonScripts) {
    try {
      collectMetadataAndFiles(JSON.parse(text), metadata, files);
    } catch {}
  }

  collectMetadataAndFiles(data.globals, metadata, files);

  for (const node of data.nodes) {
    const candidateUrl = node.href || node.url;
    if (candidateUrl && /^https?:/i.test(candidateUrl)) {
      if (/(?:download|dlink)/i.test(candidateUrl) && !downloadUrls.includes(candidateUrl)) downloadUrls.push(candidateUrl);
      if (/(?:m3u8|streaming)/i.test(candidateUrl) && !streamUrls.includes(candidateUrl)) streamUrls.push(candidateUrl);
    }

    if (!node.fsId) continue;
    const file = {
      filename: cleanFilename(node.text.replace(/\bdownload\b/ig, "").trim()),
      sizeBytes: 0,
      sizeFormatted: "Unknown size",
      isVideo: VIDEO_EXTENSIONS.has(path.extname(node.text).toLowerCase()),
      isZip: /\.(zip|rar|7z)$/i.test(node.text),
      fsId: node.fsId,
      downloadUrl: /(?:download|dlink)/i.test(candidateUrl) ? candidateUrl : undefined,
      streamUrl: /(?:m3u8|streaming)/i.test(candidateUrl) ? candidateUrl : undefined,
    };

    if (file.filename !== "terabox_download") mergeFile(files, file);
  }
}

async function maybeTriggerDownloadAction(
  page: Page,
  downloadUrls: string[]
): Promise<void> {
  const buttons = page.getByRole("button", { name: /download/i });
  const count = await buttons.count();
  if (!count) return;

  for (let i = 0; i < Math.min(count, 2); i++) {
    const button = buttons.nth(i);
    if (!(await button.isVisible().catch(() => false))) continue;

    const before = downloadUrls.length;
    console.log("Chromium resolver: attempting visible Download action");
    await button.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(2500);
    if (downloadUrls.length > before) return;
  }
}

async function resolveTeraboxViaChromium(rawUrl: string): Promise<ResolvedMetadata> {
  const shortCode = extractSurl(rawUrl);
  if (!shortCode) throw new Error("Could not extract a TeraBox share code.");

  return withChromiumSlot(async () => {
    let browser: Browser | null = null;

    try {
      browser = await chromium.launch({
        executablePath: chromiumPath(),
        headless: true,
        timeout: 30000,
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
          "--disable-features=Translate,BackForwardCache",
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });

      const context = await browser.newContext({
        locale: "en-US",
        timezoneId: "Asia/Kolkata",
        viewport: { width: 1366, height: 768 },
        screen: { width: 1366, height: 768 },
        colorScheme: "light",
        serviceWorkers: "allow",
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
          DNT: "1",
        },
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
        Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 4 });
        Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });

        const chrome = (globalThis as any).chrome;
        if (!chrome) {
          Object.defineProperty(globalThis, "chrome", {
            configurable: false,
            enumerable: true,
            value: { runtime: {} },
          });
        }

        try {
          Object.defineProperty(navigator, "plugins", {
            get: () => [
              { name: "Chrome PDF Plugin" },
              { name: "Chrome PDF Viewer" },
              { name: "Native Client" },
            ],
          });
        } catch {}

        try {
          const originalQuery = navigator.permissions?.query?.bind(navigator.permissions);
          if (originalQuery) {
            Object.defineProperty(navigator.permissions, "query", {
              value: (parameters: PermissionDescriptor) => {
                if (parameters?.name === "notifications") {
                  return Promise.resolve({ state: Notification.permission });
                }
                return originalQuery(parameters);
              },
            });
          }
        } catch {}
      });

      const page = await context.newPage();
      page.setDefaultTimeout(15000);

      const metadata: Partial<ResolvedMetadata> = {};
      const files = new Map<string, ResolvedTeraboxFile>();
      const downloadUrls: string[] = [];
      const streamUrls: string[] = [];
      const summaries: string[] = [];
      const networkErrors: string[] = [];
      const responseJobs = new Set<Promise<void>>();

      page.on("download", (download) => {
        const url = download.url();
        if (url && /^https?:\/\//i.test(url) && !downloadUrls.includes(url)) {
          downloadUrls.push(url);
          console.log("Chromium browser download captured:", url.slice(0, 320));
        }
      });

      page.on("console", (msg) => {
        if (/error|warning/i.test(msg.type())) {
          console.log("Chromium page console:", msg.text().slice(0, 500));
        }
      });

      page.on("request", (request) => {
        const url = request.url();
        if (!isInterestingUrl(url)) return;
        if (/(?:download|dlink)/i.test(url) && !downloadUrls.includes(url)) downloadUrls.push(url);
        if (/(?:m3u8|streaming)/i.test(url) && !streamUrls.includes(url)) streamUrls.push(url);
      });

      page.on("response", (response) => {
        const job = parseResponse(response, metadata, files, downloadUrls, streamUrls, summaries)
          .catch((error) => {
            networkErrors.push("response-handler: " + (error instanceof Error ? error.message : String(error)));
          })
          .finally(() => responseJobs.delete(job));
        responseJobs.add(job);
      });

      page.on("requestfailed", (request) => {
        const url = request.url();
        if (isInterestingUrl(url)) {
          networkErrors.push((request.failure()?.errorText || "request failed") + " " + url.slice(0, 250));
        }
      });

      console.log("TeraBox resolver mode: Playwright + Chromium only");
      console.log("Chromium executable:", chromiumPath());
      console.log("Chromium browser version:", browser.version());
      console.log("Chromium resolver: bootstrapping browser session");

      // Start from a real TeraBox origin first so the browser gets the same
      // session/bootstrap cookies and frontend state as a normal Chrome visit.
      const warmupOrigins = [
        "https://www.terabox.app/",
        "https://www.terabox.com/",
      ];
      for (const origin of warmupOrigins) {
        try {
          const warmup = await page.goto(origin, {
            waitUntil: "domcontentloaded",
            timeout: 12000,
          });
          console.log("Chromium warmup status=" + (warmup?.status() ?? "none") + " url=" + page.url());
          await page.waitForTimeout(1200);
        } catch (error) {
          console.log(
            "Chromium warmup failed:",
            error instanceof Error ? error.message : String(error)
          );
        }
      }

      console.log("Chromium resolver: opening TeraBox share page");

      const navigation = await page.goto(rawUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      console.log(
        "Chromium navigation status=" + (navigation?.status() ?? "none") +
        " url=" + page.url()
      );

      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(5000);

      await Promise.allSettled([...responseJobs]);
      await scrapeDom(page, metadata, files, downloadUrls, streamUrls);

      // Give lazy-loaded rows a chance to render.
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 1000);
        await page.waitForTimeout(800);
      }

      await Promise.allSettled([...responseJobs]);
      await scrapeDom(page, metadata, files, downloadUrls, streamUrls);

      // Some current TeraBox builds do not expose the share API in a way that
      // our response observer can see. Ask the same Chromium page to execute
      // the share APIs with real browser credentials, and try both public shorturl
      // forms because different share domains normalize the leading "1".
      if (files.size === 0) {
        const browserApi = await page.evaluate(async (rawShortCode) => {
          const values = [
            rawShortCode,
            rawShortCode.startsWith("1") ? rawShortCode.slice(1) : "1" + rawShortCode,
          ].filter((value, index, array) => value && array.indexOf(value) === index);

          const errors: string[] = [];
          const tokenSources: Record<string, string> = {};

          const addToken = (name: string, value: unknown) => {
            if (value === undefined || value === null) return;
            const text = String(value).trim();
            if (text && !tokenSources[name]) tokenSources[name] = text;
          };

          const tokenText = [
            document.documentElement?.innerHTML || "",
            document.documentElement?.textContent || "",
          ].join("\\n");

          const tokenPatterns: Array<[string, RegExp]> = [
            ["jsToken", /(?:window\.)?jsToken\s*[=:]\s*["']([^"']+)["']/i],
            ["jsTokenFn", /fn\(["']([A-F0-9]+)["']\)/i],
            ["dpLogId", /(?:dp-logid|dpLogId)\s*[=:]\s*["']?([0-9]+)/i],
            ["bdstoken", /bdstoken\s*[=:]\s*["']([^"']+)["']/i],
          ];

          for (const [name, pattern] of tokenPatterns) {
            const match = tokenText.match(pattern);
            if (match?.[1]) addToken(name, match[1]);
          }

          for (const storageName of ["localStorage", "sessionStorage"]) {
            try {
              const storage = storageName === "localStorage" ? window.localStorage : window.sessionStorage;
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (!key) continue;
                const value = storage.getItem(key) || "";
                if (/jstoken/i.test(key)) addToken("jsToken", value);
                if (/dp.?log/i.test(key)) addToken("dpLogId", value);
                if (/bdstoken/i.test(key)) addToken("bdstoken", value);
              }
            } catch {}
          }

          for (const key of Object.keys(window)) {
            if (/(?:token|share|yunData|initData|initialData|initialState)/i.test(key)) {
              try {
                const value = (window as any)[key];
                if (typeof value === "string") {
                  if (/jstoken/i.test(key)) addToken("jsToken", value);
                  if (/bdstoken/i.test(key)) addToken("bdstoken", value);
                  if (/dp.?log/i.test(key)) addToken("dpLogId", value);
                }
              } catch {}
            }
          }

          const callJson = async (path: string, params: Record<string, string>) => {
            const url = new URL(path, location.origin);
            for (const [key, value] of Object.entries(params)) {
              if (value) url.searchParams.set(key, value);
            }

            const response = await fetch(url.toString(), {
              method: "GET",
              credentials: "include",
              cache: "no-store",
              headers: {
                Accept: "application/json, text/plain, */*",
                "X-Requested-With": "XMLHttpRequest",
              },
            });

            const text = await response.text();
            let payload: any = null;
            try { payload = text ? JSON.parse(text) : null; } catch {}

            return {
              status: response.status,
              payload,
              text: text.slice(0, 1200),
            };
          };

          let info: any = null;
          const lists: any[] = [];

          for (const variant of values) {
            try {
              const params: Record<string, string> = {
                app_id: "250528",
                shorturl: variant,
                root: "1",
                web: "1",
                channel: "dubox",
                clienttype: "0",
              };
              if (tokenSources.jsToken) params.jsToken = tokenSources.jsToken;
              if (tokenSources.dpLogId) params["dp-logid"] = tokenSources.dpLogId;

              const result = await callJson("/api/shorturlinfo", params);
              errors.push(
                "shorturlinfo=" + variant +
                " HTTP=" + result.status +
                " errno=" + String(result.payload?.errno ?? "unknown")
              );

              if (result.status >= 200 && result.status < 300 &&
                  Number(result.payload?.errno ?? 0) === 0 &&
                  Array.isArray(result.payload?.list)) {
                info = result.payload;
                break;
              }
            } catch (error) {
              errors.push(
                "shorturlinfo=" + variant +
                " " + (error instanceof Error ? error.message : String(error))
              );
            }
          }

          const listShortUrl =
            info?.shorturl ||
            info?.shorturlinfo?.shorturl ||
            values[0] ||
            rawShortCode;

          for (const variant of [listShortUrl, ...values]) {
            if (lists.length) break;
            try {
              const params: Record<string, string> = {
                app_id: "250528",
                web: "1",
                channel: "0",
                clienttype: "0",
                shorturl: variant,
                page: "1",
                num: "100",
                by: "name",
                order: "asc",
                root: "1",
              };
              if (tokenSources.jsToken) params.jsToken = tokenSources.jsToken;
              if (tokenSources.dpLogId) params["dp-logid"] = tokenSources.dpLogId;

              const result = await callJson("/share/list", params);
              errors.push(
                "share/list=" + variant +
                " HTTP=" + result.status +
                " errno=" + String(result.payload?.errno ?? "unknown")
              );

              if (result.status >= 200 && result.status < 300 &&
                  Number(result.payload?.errno ?? 0) === 0 &&
                  Array.isArray(result.payload?.list)) {
                lists.push(...result.payload.list);
              }
            } catch (error) {
              errors.push(
                "share/list=" + variant +
                " " + (error instanceof Error ? error.message : String(error))
              );
            }
          }

          return { info, lists, tokens: tokenSources, errors };
        }, shortCode);

        console.log(
          "Chromium in-page resolver:",
          "tokens=" + Object.keys(browserApi.tokens).join(",") || "none",
          "info=" + (browserApi.info ? "yes" : "no"),
          "listItems=" + browserApi.lists.length,
          "errors=" + browserApi.errors.slice(-6).join(" | ")
        );

        if (browserApi.info || browserApi.lists.length) {
          collectMetadataAndFiles(browserApi.info, metadata, files);
          collectMetadataAndFiles(browserApi.lists, metadata, files);
        }
      }

      if (files.size === 0 && downloadUrls.length === 0 && streamUrls.length === 0) {
        await maybeTriggerDownloadAction(page, downloadUrls);
        await page.waitForTimeout(2500);
        await Promise.allSettled([...responseJobs]);
        await scrapeDom(page, metadata, files, downloadUrls, streamUrls);
      }

      // Associate browser-observed download/stream URLs with metadata in the
      // same order when the site's API returns URLs separately from file rows.
      const fileList = [...files.values()];
      for (let i = 0; i < downloadUrls.length && i < fileList.length; i++) {
        if (!fileList[i].downloadUrl) fileList[i].downloadUrl = downloadUrls[i];
      }
      for (let i = 0; i < streamUrls.length; i++) {
        const video = fileList.find((file) => file.isVideo && !file.streamUrl);
        if (video) video.streamUrl = streamUrls[i];
      }

      const cookies = await context.cookies();
      const cookieHeader = cookies.map((cookie) => cookie.name + "=" + cookie.value).join("; ");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const verificationDetected = /(?:captcha|verify|robot|unusual traffic|human verification|安全验证|人机)/i.test(bodyText);

      const downloadable = fileList.filter((file) => file.downloadUrl || file.streamUrl);

      console.log(
        "Chromium resolver result:",
        "metadataFiles=" + fileList.length,
        "downloadable=" + downloadable.length,
        "downloadUrls=" + downloadUrls.length,
        "streamUrls=" + streamUrls.length,
        "cookies=" + (cookieHeader ? "yes" : "no"),
        "verification=" + (verificationDetected ? "yes" : "no"),
        "interestingResponses=" + summaries.length
      );

      if (!downloadable.length) {
        throw new Error(
          "Playwright/Chromium could not resolve the link: " +
          [
            "surl=" + shortCode,
            "page=" + page.url(),
            "metadataFiles=" + fileList.length,
            "downloadUrls=" + downloadUrls.length,
            "streamUrls=" + streamUrls.length,
            "verification=" + (verificationDetected ? "yes" : "no"),
            "body=" + bodyText.slice(0, 700).replace(/\s+/g, " "),
            "responses=" + summaries.slice(-15).join(" | "),
            "networkErrors=" + networkErrors.slice(-8).join(" | "),
          ].join("; ")
        );
      }

      return {
        shareId: metadata.shareId,
        uk: metadata.uk,
        sign: metadata.sign,
        timestamp: metadata.timestamp,
        randsk: metadata.randsk,
        title: cleanFilename(metadata.title || downloadable[0].filename || "TeraBox Files"),
        files: downloadable,
        directDownloadPossible: downloadable.some((file) => !!file.downloadUrl),
        cookies: cookieHeader || undefined,
        refererUrl: page.url(),
      };
    } finally {
      try { await browser?.close(); } catch {}
    }
  });
}

export async function resolveTeraboxLink(rawUrl: string): Promise<ResolvedMetadata> {
  return resolveTeraboxViaChromium(rawUrl.trim());
}

export async function downloadM3u8Stream(
  m3u8Url: string,
  outputMp4Path: string,
  refererUrl: string,
  cookieHeader?: string,
  onProgress?: (percent: number, current: number, total: number) => void,
  metadata?: {
    duration?: number;
    shareId?: string;
    uk?: string;
    sign?: string;
    timestamp?: string;
    fsId?: string;
    randsk?: string;
    beforeChunk?: () => Promise<void>;
  }
): Promise<void> {
  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Referer: refererUrl || "https://www.terabox.app/",
  };

  const effectiveCookies = [
    cookieHeader || "",
    metadata?.randsk ? "TSID=" + metadata.randsk : "",
  ].filter(Boolean).join("; ");

  if (effectiveCookies) headers.Cookie = effectiveCookies;

  const discovered = new Map<number, { url: string; size: number }>();

  const parseSegments = (playlist: string) => {
    const lines = playlist.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const segment of lines) {
      try {
        const parsed = new URL(segment, m3u8Url);
        const indexMatch = parsed.pathname.match(/_(\d+)_ts\b/i);
        const index = indexMatch ? Number(indexMatch[1]) : discovered.size + 1;
        const size = Number(parsed.searchParams.get("ts_size") || 0);
        if (!discovered.has(index)) {
          if (size > 0) {
            parsed.searchParams.set("range", "0-" + (size - 1));
            parsed.searchParams.set("len", String(size));
          }
          discovered.set(index, { url: parsed.toString(), size });
        }
      } catch {}
    }
  };

  const first = await fetch(m3u8Url, { headers });
  if (!first.ok) throw new Error("Failed to fetch M3U8 playlist: HTTP " + first.status);
  parseSegments(await first.text());

  const parsed = new URL(m3u8Url);
  const uk = metadata?.uk || parsed.searchParams.get("uk");
  const shareid = metadata?.shareId || parsed.searchParams.get("shareid");
  const fid = metadata?.fsId || parsed.searchParams.get("fid");
  const sign = metadata?.sign || parsed.searchParams.get("sign");
  const timestamp = metadata?.timestamp || parsed.searchParams.get("timestamp");

  if (uk && shareid && fid && sign && timestamp) {
    const maxScanTime = metadata?.duration && metadata.duration > 0 ? metadata.duration + 30 : 3600;
    let emptyStreak = 0;

    for (let t = 25; t <= maxScanTime; t += 25) {
      try {
        await metadata?.beforeChunk?.();

        const probe = new URL("https://www.terabox.app/share/streaming");
        probe.searchParams.set("app_id", "250528");
        probe.searchParams.set("web", "1");
        probe.searchParams.set("channel", "dubox");
        probe.searchParams.set("clienttype", "0");
        probe.searchParams.set("shareid", shareid);
        probe.searchParams.set("uk", uk);
        probe.searchParams.set("fid", fid);
        probe.searchParams.set("sign", sign);
        probe.searchParams.set("timestamp", timestamp);
        probe.searchParams.set("type", "M3U8_AUTO_480");
        probe.searchParams.set("time", String(t));
        probe.searchParams.set("esl", "1");
        probe.searchParams.set("isplayer", "1");
        probe.searchParams.set("ehps", "1");

        const response = await fetch(probe, { headers });
        if (!response.ok) continue;

        const before = discovered.size;
        parseSegments(await response.text());
        if (discovered.size === before) emptyStreak++;
        else emptyStreak = 0;

        if (!metadata?.duration && emptyStreak >= 4 && discovered.size) break;
      } catch {}
    }
  }

  const indices = [...discovered.keys()].sort((a, b) => a - b);
  if (!indices.length) throw new Error("M3U8 playlist contained no video segments");

  const tempTsPath = outputMp4Path + ".temp.ts";
  const out = fs.createWriteStream(tempTsPath);

  try {
    for (let i = 0; i < indices.length; i++) {
      await metadata?.beforeChunk?.();
      const chunk = discovered.get(indices[i])!;
      const response = await fetch(chunk.url, {
        headers: {
          "User-Agent": headers["User-Agent"],
          Referer: headers.Referer,
          ...(effectiveCookies ? { Cookie: effectiveCookies } : {}),
        },
      });

      if (!response.ok) throw new Error("Failed to fetch segment " + (i + 1) + "/" + indices.length);

      out.write(Buffer.from(await response.arrayBuffer()));
      onProgress?.(Math.round(((i + 1) / indices.length) * 100), i + 1, indices.length);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }

  try {
    await execFileAsync("ffmpeg", ["-y", "-i", tempTsPath, "-c", "copy", outputMp4Path]);
  } catch (error) {
    console.warn("FFmpeg remux failed; keeping TS data:", error);
    fs.copyFileSync(tempTsPath, outputMp4Path);
  } finally {
    if (fs.existsSync(tempTsPath)) fs.unlinkSync(tempTsPath);
  }
}

export async function unpackZipArchive(
  zipPath: string,
  targetDir: string
): Promise<{ path: string; filename: string; size: number }[]> {
  const results: { path: string; filename: string; size: number }[] = [];
  fs.mkdirSync(targetDir, { recursive: true });

  try {
    const directory = await unzipper.Open.file(zipPath);
    const usedNames = new Set<string>();

    for (const entry of directory.files) {
      if (entry.type === "Directory" || entry.path.startsWith("__MACOSX/")) continue;

      const baseName = cleanFilename(path.basename(entry.path));
      let filename = baseName;
      let suffix = 1;

      while (usedNames.has(filename)) {
        const ext = path.extname(baseName);
        const stem = ext ? baseName.slice(0, -ext.length) : baseName;
        filename = stem + "_" + suffix++ + ext;
      }

      usedNames.add(filename);

      const outputPath = path.join(targetDir, filename);
      await pipeline(entry.stream(), fs.createWriteStream(outputPath));
      results.push({
        path: outputPath,
        filename,
        size: fs.statSync(outputPath).size,
      });
    }
  } catch (error) {
    console.error("ZIP unpack error:", error);
  }

  return results;
}
