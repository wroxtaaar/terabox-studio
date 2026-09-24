import path from "path";
import fs from "fs";
import { pipeline } from "stream/promises";
import unzipper from "unzipper";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".m4v",
  ".mpeg",
  ".mpg",
  ".3gp",
  ".ts",
  ".flv",
]);

export const TERABOX_DOMAINS_PATTERN =
  /(?:terabox|terashare|terafileshare|1024tera|1024-tera|tera-box|nephobox|mirrobox|mirrorbox|momerybox|tibibox|gibibox|pebibox|4funbox|dubox|bestclouddrive)/i;

export const DISKWALA_DOMAINS_PATTERN =
  /(?:diskwala|thediskwala|diskwala\.fun|dw\.link|diskflow\.me)/i;

export function isTeraboxUrl(text: string): boolean {
  if (!text) return false;
  if (TERABOX_DOMAINS_PATTERN.test(text)) return true;
  if (
    /(?:\/s\/|\/share\/init|\/sharing\/link)\?.*?(?:surl=|s\/1)[a-zA-Z0-9_-]+|\/s\/1[a-zA-Z0-9_-]{10,}/i.test(
      text
    )
  ) {
    return true;
  }
  return false;
}

export function isDiskwalaUrl(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (DISKWALA_DOMAINS_PATTERN.test(trimmed)) return true;
  if (/^[a-fA-F0-9]{20,32}$/.test(trimmed)) return true;
  if (/https?:\/\/.*/i.test(trimmed) && /(?:diskwala|dw\.link|diskflow)/i.test(trimmed)) return true;
  return false;
}

export function extractDiskwalaId(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (/^[a-fA-F0-9]{20,32}$/.test(trimmed)) return trimmed;

  const patterns = [
    /https?:\/\/(?:www\.)?diskwala\.com\/(?:app|file)\/([a-zA-Z0-9_\-]+)/i,
    /https?:\/\/(?:www\.)?diskwala\.com\/([a-zA-Z0-9_\-]+)/i,
    /https?:\/\/(?:www\.)?thediskwala\.com\/(?:app|file)?\/([a-zA-Z0-9_\-]+)/i,
    /https?:\/\/(?:www\.)?diskwala\.fun\/(?:diskwala\/)?([a-zA-Z0-9_\-]+)/i,
    /https?:\/\/(?:www\.)?dw\.link\/([a-zA-Z0-9_\-]+)/i,
    /https?:\/\/(?:www\.)?diskflow\.me\/([a-zA-Z0-9_\-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1];
  }

  try {
    const urlObj = new URL(trimmed);
    const pathParts = urlObj.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart.length >= 8 && !/[?#]/.test(lastPart)) return lastPart;
  } catch {
    // ignore invalid URLs
  }

  return null;
}

export function extractUrlFromText(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/i);
  if (match) return match[0].replace(/[).,\]]+$/, "");
  const match2 = text.match(/(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\/\S+/i);
  if (match2) return "https://" + match2[0].replace(/^[a-z]+:\/\//i, "").replace(/[).,\]]+$/, "");
  return null;
}

export function cleanFilename(filename: string): string {
  if (!filename) return "terabox_download";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // ignore decode error
  }
  filename = path.basename(filename);
  filename = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  filename = filename.trim().replace(/^[. ]+|[. ]+$/g, "");
  return filename || "terabox_download";
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function detectExtensionFromBuffer(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 12) return null;

  // ftyp -> mp4 or mov
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (brand === "qt  " || brand === "moov") return ".mov";
    return ".mp4";
  }

  // Matroska / WebM
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    const textHeader = buffer.subarray(0, 64).toString("binary");
    if (textHeader.includes("webm")) return ".webm";
    return ".mkv";
  }

  // AVI
  if (
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "AVI "
  ) {
    return ".avi";
  }

  // MP3
  if (
    buffer.subarray(0, 3).toString("ascii") === "ID3" ||
    (buffer[0] === 0xff && (buffer[1] === 0xfb || buffer[1] === 0xf3 || buffer[1] === 0xf2))
  ) {
    return ".mp3";
  }

  // ZIP
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
    return ".zip";
  }

  // RAR
  if (
    buffer.subarray(0, 4).toString("ascii") === "Rar!" &&
    buffer[4] === 0x1a &&
    buffer[5] === 0x07
  ) {
    return ".rar";
  }

  // 7z
  if (
    buffer[0] === 0x37 &&
    buffer[1] === 0x7a &&
    buffer[2] === 0xbc &&
    buffer[3] === 0xaf &&
    buffer[4] === 0x27 &&
    buffer[5] === 0x1c
  ) {
    return ".7z";
  }

  // PDF
  if (buffer.subarray(0, 4).toString("ascii") === "%PDF") {
    return ".pdf";
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return ".jpg";
  }

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return ".png";
  }

  return null;
}

export function extractSurl(rawUrl: string): string | null {
  try {
    const urlObj = new URL(rawUrl);
    const surlParam = urlObj.searchParams.get("surl");
    if (surlParam) return surlParam;
    const match = rawUrl.match(/\/s\/([a-zA-Z0-9_-]+)/i);
    if (match) return match[1];
  } catch {
    const m = rawUrl.match(/(?:surl=|s\/)([a-zA-Z0-9_-]+)/i);
    if (m) return m[1];
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

function parseDiskwalaSize(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value !== "string") return 0;

  const text = value.trim();
  if (!text) return 0;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) return Math.max(0, Math.trunc(numeric));

  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return 0;

  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier =
    unit === "TB" ? 1024 ** 4 :
    unit === "GB" ? 1024 ** 3 :
    unit === "MB" ? 1024 ** 2 :
    unit === "KB" ? 1024 :
    1;

  return Number.isFinite(amount) ? Math.max(0, Math.trunc(amount * multiplier)) : 0;
}

function isUsableHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

function normalizeDiskwalaFile(
  rawFile: any,
  fallbackIndex: number
): ResolvedTeraboxFile | null {
  const file = rawFile || {};
  const filename = cleanFilename(
    file.name ||
    file.filename ||
    file.fileName ||
    file.file_name ||
    file.title ||
    `diskwala_file_${fallbackIndex + 1}.bin`
  );

  const downloadUrlCandidate =
    file.url ||
    file.downloadUrl ||
    file.download_url ||
    file.direct_link ||
    file.directLink ||
    file.fast_download;

  const streamUrlCandidate =
    file.m3u8_url ||
    file.m3u8Url ||
    file.stream_url ||
    file.streamUrl ||
    file.hls_url ||
    file.hlsUrl;

  const downloadUrl = isUsableHttpUrl(downloadUrlCandidate)
    ? downloadUrlCandidate.trim()
    : undefined;
  const streamUrl = isUsableHttpUrl(streamUrlCandidate)
    ? streamUrlCandidate.trim()
    : undefined;

  if (!downloadUrl && !streamUrl) return null;

  const size = parseDiskwalaSize(
    file.sizebytes ??
    file.sizeBytes ??
    file.size ??
    file.file_size ??
    file.fileSize
  );

  const ext = path.extname(filename).toLowerCase();
  const isVideo = VIDEO_EXTENSIONS.has(ext) ||
    /\.(mp4|mkv|webm|avi|mov|m4v|mpeg|mpg|3gp|ts|flv|m3u8)$/i.test(filename);
  const isZip = /\.(zip|rar|7z|tar|gz)$/i.test(filename);

  return {
    filename,
    sizeBytes: size,
    sizeFormatted: size > 0 ? formatBytes(size) : "Unknown size",
    isVideo,
    isZip,
    downloadUrl,
    streamUrl,
  };
}

function parseDiskwalaResponse(data: any): ResolvedTeraboxFile[] {
  const candidates: any[] = [];

  if (Array.isArray(data)) {
    candidates.push(...data);
  }

  if (data?.fileInfo) {
    candidates.push(data.fileInfo);
  }

  if (Array.isArray(data?.files)) {
    candidates.push(...data.files);
  }

  if (Array.isArray(data?.result)) {
    candidates.push(...data.result);
  } else if (data?.result && typeof data.result === "object") {
    candidates.push(data.result);
  }

  const files: ResolvedTeraboxFile[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    const parsed = normalizeDiskwalaFile(candidates[i], i);
    if (!parsed) continue;
    const key = `${parsed.filename}|${parsed.downloadUrl || ""}|${parsed.streamUrl || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(parsed);
  }

  return files;
}

async function requestDiskwalaProxy(
  endpoint: string,
  normalizedUrl: string,
  apiKey: string,
  timeoutMs: number,
  label: string
): Promise<ResolvedTeraboxFile[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-api-key": apiKey,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ url: normalizedUrl }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let data: any = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail =
        data?.detail ||
        data?.message ||
        data?.error ||
        (rawText ? rawText.slice(0, 300) : `HTTP ${response.status}`);
      throw new Error(`${label} returned HTTP ${response.status}: ${detail}`);
    }

    const files = parseDiskwalaResponse(data);
    if (files.length === 0) {
      throw new Error(`${label} returned no usable direct media URL`);
    }

    return files;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveDiskwalaViaPublicPage(normalizedUrl: string, id: string): Promise<ResolvedMetadata | null> {
  const candidateUrls = [
    normalizedUrl,
    `https://www.diskwala.com/file/${id}`,
    `https://www.diskwala.com/app/${id}`,
  ];

  for (const pageUrl of [...new Set(candidateUrls)]) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const pageRes = await fetch(pageUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!pageRes.ok) continue;

      const html = await pageRes.text();
      const titleMatch =
        html.match(/<meta property="og:title" content="([^"]+)"/i) ||
        html.match(/<meta name="title" content="([^"]+)"/i) ||
        html.match(/<title>([^<]+)<\/title>/i);
      const descriptionMatch = html.match(/<meta property="og:description" content="([^"]+)"/i);
      const mediaMatches = html.match(
        /https?:\/\/[^\s"'<>]+?\.(?:mp4|mkv|webm|avi|mov|m4v|ts|flv|m3u8|zip|rar|7z|pdf|mp3|m4a|jpg|jpeg|png)(?:[^\s"'<>]*)/gi
      ) || [];

      const directMediaUrl = mediaMatches.find(isUsableHttpUrl);
      if (!directMediaUrl) continue;

      const rawTitle =
        titleMatch?.[1]?.trim() ||
        descriptionMatch?.[1]?.trim() ||
        `Diskwala_File_${id}`;
      const fileTitle =
        rawTitle.replace(/\s*[-|–]\s*DiskWala.*$/i, "").trim() ||
        `Diskwala_File_${id}`;
      const fileName = cleanFilename(
        /\.[a-z0-9]{2,5}$/i.test(fileTitle)
          ? fileTitle
          : `${fileTitle}.mp4`
      );
      const isVideo = VIDEO_EXTENSIONS.has(path.extname(fileName).toLowerCase());

      return {
        title: fileName,
        files: [{
          filename: fileName,
          sizeBytes: 0,
          sizeFormatted: "Unknown size",
          isVideo,
          isZip: /\.(zip|rar|7z|tar|gz)$/i.test(fileName),
          downloadUrl: directMediaUrl.replace(/[),.;]+$/, ""),
        }],
        directDownloadPossible: true,
        cookies: undefined,
        refererUrl: pageUrl,
      };
    } catch (err) {
      console.warn("Diskwala public page fallback failed:", err);
    }
  }

  return null;
}

export async function resolveDiskwalaLink(rawUrl: string): Promise<ResolvedMetadata> {
  const cleanUrl = rawUrl.trim();
  const id = extractDiskwalaId(cleanUrl);

  if (!id) {
    throw new Error("Invalid Diskwala URL format. Supported examples: diskwala.com/app/<id>, dw.link/<id>");
  }

  const normalizedUrl =
    /^https?:\/\//i.test(cleanUrl) && /diskwala/i.test(cleanUrl)
      ? cleanUrl
      : `https://www.diskwala.com/app/${id}`;

  const failures: string[] = [];
  const apiKey = process.env.DISKWALA_API_KEY?.trim();

  // Primary path: the scraper-proxy architecture used by the maintained
  // open-source Diskwala downloader. It returns fileInfo.url and authenticates
  // using the x-api-key header.
  const proxyUrl = process.env.DISKWALA_PROXY_URL?.trim();
  if (proxyUrl && apiKey) {
    try {
      const files = await requestDiskwalaProxy(
        proxyUrl,
        normalizedUrl,
        apiKey,
        600000,
        "Diskwala proxy"
      );
      return {
        title: files[0].filename,
        files,
        directDownloadPossible: files.some((file) => !!file.downloadUrl || !!file.streamUrl),
        cookies: undefined,
        refererUrl: normalizedUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(message);
      console.warn("Diskwala configured proxy failed:", err);
    }
  } else {
    failures.push("DISKWALA_PROXY_URL and/or DISKWALA_API_KEY not configured");
  }

  // Optional API-compatible path for providers exposing POST
  // /api/v1/diskwala/extract with the same X-API-Key header.
  const apiUrl = process.env.DISKWALA_API_URL?.trim();
  if (apiUrl && apiKey) {
    try {
      const files = await requestDiskwalaProxy(
        apiUrl,
        normalizedUrl,
        apiKey,
        120000,
        "Diskwala API"
      );
      return {
        title: files[0].filename,
        files,
        directDownloadPossible: files.some((file) => !!file.downloadUrl || !!file.streamUrl),
        cookies: undefined,
        refererUrl: normalizedUrl,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(message);
      console.warn("Diskwala configured API failed:", err);
    }
  }

  // Compatibility fallback for the existing shared endpoint. Only accept an
  // actual direct media/HLS URL; never return the Diskwala page as downloadUrl.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const apiRes = await fetch("https://diskwala.fun/api/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://diskwala.fun",
        Referer: "https://diskwala.fun/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
      body: JSON.stringify({ url: normalizedUrl }),
      signal: controller.signal,
    });

    const rawText = await apiRes.text();
    clearTimeout(timeout);

    let data: any = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }

    if (!apiRes.ok) {
      throw new Error(`Shared Diskwala resolver returned HTTP ${apiRes.status}`);
    }

    const files = parseDiskwalaResponse(data);
    if (files.length > 0) {
      return {
        title: files[0].filename,
        files,
        directDownloadPossible: true,
        cookies: undefined,
        refererUrl: "https://diskwala.fun/",
      };
    }

    if (data?.error === "quota_exceeded") {
      failures.push(`Shared Diskwala resolver quota exceeded: ${data.message || "quota exceeded"}`);
    } else {
      failures.push("Shared Diskwala resolver returned no usable direct media URL");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(message);
    console.warn("Diskwala shared resolver failed:", err);
  }

  const publicPageFallback = await resolveDiskwalaViaPublicPage(normalizedUrl, id);
  if (publicPageFallback) return publicPageFallback;

  throw new Error(
    `Diskwala link could not be resolved to a downloadable media URL. ${failures.join(" | ")}`
  );
}

async function fetchTeraboxDownloadUrl(
  shareId: string,
  uk: string,
  sign: string,
  timestamp: string,
  fsId: string,
  jsToken: string,
  cookieHeader: string,
  refererUrl: string
): Promise<string | undefined> {
  const origins = [
    (() => {
      try {
        const origin = new URL(refererUrl).origin;
        return origin.includes("terabox") ? origin : "https://www.terabox.app";
      } catch {
        return "https://www.terabox.app";
      }
    })(),
    "https://www.terabox.app",
    "https://www.terabox.com",
    "https://www.1024terabox.com",
  ];
  const uniqueOrigins = [...new Set(origins)];

  for (const origin of uniqueOrigins) {
    try {
      const endpoint = new URL("/share/download", origin);
      endpoint.searchParams.set("app_id", "250528");
      endpoint.searchParams.set("web", "1");
      endpoint.searchParams.set("channel", "dubox");
      endpoint.searchParams.set("clienttype", "0");
      if (jsToken) endpoint.searchParams.set("jsToken", jsToken);
      endpoint.searchParams.set("shareid", shareId);
      endpoint.searchParams.set("sign", sign);
      endpoint.searchParams.set("timestamp", timestamp);

      const body = new URLSearchParams({
        product: "share",
        nozip: "0",
        fid_list: "[" + fsId + "]",
        uk,
        primaryid: shareId,
      });

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: refererUrl || origin + "/",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
        body,
      });

      if (!response.ok) {
        console.warn("TeraBox share/download returned HTTP " + response.status + " from " + origin);
        continue;
      }

      const data = (await response.json()) as any;
      if (data?.errno !== undefined && Number(data.errno) !== 0) {
        console.warn(
          "TeraBox share/download failed for fs_id=" + fsId + ": errno=" + data.errno + " " + (data.errmsg || "")
        );
        continue;
      }

      const dlink = Array.isArray(data?.dlink) ? data.dlink[0] : data?.dlink;
      if (!dlink || typeof dlink !== "string") continue;

      try {
        const redirectResponse = await fetch(dlink, {
          method: "GET",
          redirect: "manual",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Referer: refererUrl || origin + "/",
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
        });
        const location = redirectResponse.headers.get("location");
        if (location) return new URL(location, dlink).toString();
        if (redirectResponse.ok) return dlink;
      } catch (redirectError) {
        console.warn("Could not resolve TeraBox download redirect for fs_id=" + fsId + ":", redirectError);
        return dlink;
      }
    } catch (error) {
      console.warn("TeraBox share/download request failed for fs_id=" + fsId + ":", error);
    }
  }
  return undefined;
}

async function fetchTeraboxShareList(
  origin: string,
  shortUrl: string,
  jsToken: string,
  cookieHeader: string,
  refererUrl: string,
  dir?: string,
  dpLogId?: string
): Promise<any[]> {
  const origins = [origin, "https://www.terabox.app", "https://www.terabox.com", "https://www.1024tera.com"]
    .filter(Boolean);
  const uniqueOrigins = [...new Set(origins)];
  let lastError = "";

  for (const apiOrigin of uniqueOrigins) {
    try {
      const endpoint = new URL("/share/list", apiOrigin);
      endpoint.searchParams.set("app_id", "250528");
      endpoint.searchParams.set("web", "1");
      endpoint.searchParams.set("channel", "0");
      endpoint.searchParams.set("clienttype", "0");
      endpoint.searchParams.set("jsToken", jsToken);
      endpoint.searchParams.set("shorturl", shortUrl);
      endpoint.searchParams.set("page", "1");
      endpoint.searchParams.set("num", "100");
      endpoint.searchParams.set("by", "name");
      endpoint.searchParams.set("order", "asc");
      endpoint.searchParams.set("site_referer", "");
      if (dpLogId) endpoint.searchParams.set("dp-logid", dpLogId);
      if (dir) endpoint.searchParams.set("dir", dir);
      else endpoint.searchParams.set("root", "1");

      const response = await fetch(endpoint, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,hi;q=0.8",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
          "Upgrade-Insecure-Requests": "1",
          "X-Requested-With": "XMLHttpRequest",
          Referer: refererUrl || apiOrigin + "/",
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      });

      if (!response.ok) {
        lastError = "HTTP " + response.status;
        continue;
      }

      const data = (await response.json()) as any;
      const errno = Number(data?.errno ?? 0);
      if (errno !== 0) {
        lastError = "errno=" + errno + " " + (data?.errmsg || "");
        console.warn(
          "TeraBox share/list failed on " + apiOrigin + " for shorturl=" + shortUrl + ": " + lastError
        );
        continue;
      }
      return Array.isArray(data?.list) ? data.list : [];
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.warn("TeraBox share/list request failed on " + apiOrigin + ":", error);
    }
  }

  throw new Error("TeraBox share/list failed: " + lastError);
}
function createTeraboxFileMetadata(
  item: any,
  shareId?: string,
  uk?: string,
  sign?: string,
  timestamp?: string
): ResolvedTeraboxFile | null {
  if (String(item?.isdir ?? "0") === "1") return null;
  const filename = cleanFilename(item?.server_filename || item?.filename || "file");
  const size = Number.parseInt(String(item?.size ?? "0"), 10) || 0;
  const ext = path.extname(filename).toLowerCase();
  let streamUrl: string | undefined;
  if (shareId && uk && sign && timestamp && item?.fs_id) {
    streamUrl = "https://www.terabox.app/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=" +
      shareId + "&uk=" + uk + "&fid=" + item.fs_id + "&sign=" + encodeURIComponent(sign) +
      "&timestamp=" + timestamp + "&type=M3U8_AUTO_480";
  }
  return {
    filename,
    sizeBytes: size,
    sizeFormatted: formatBytes(size),
    isVideo: VIDEO_EXTENSIONS.has(ext),
    isZip: ext === ".zip" || ext === ".rar" || ext === ".7z",
    downloadUrl: typeof item?.dlink === "string" && item.dlink ? item.dlink : undefined,
    fsId: item?.fs_id ? String(item.fs_id) : undefined,
    path: item?.path,
    streamUrl,
    thumbs: item?.thumbs,
    sign,
    timestamp,
    duration: item?.duration ? Number.parseInt(String(item.duration), 10) : undefined,
  };
}

export async function resolveTeraboxLink(rawUrl: string): Promise<ResolvedMetadata> {
  const cleanUrl = rawUrl.trim();
  const shortCode = extractSurl(cleanUrl);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.terabox.app/",
  };

  let pageText = "";
  let finalUrl = cleanUrl;
  let cookieHeader = "";
  try {
    const response = await fetch(cleanUrl, { headers, redirect: "follow" });
    finalUrl = response.url || cleanUrl;
    pageText = await response.text();
    const setCookieValues = (response.headers as any).getSetCookie?.() || [];
    const rawCookies = setCookieValues.length
      ? setCookieValues.join(", ")
      : response.headers.get("set-cookie") || "";
    if (rawCookies) {
      cookieHeader = rawCookies
        .split(/,(?=[^;,]+=)/)
        .map((c) => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
    }
  } catch (fetchErr) {
    console.warn("Error fetching initial TeraBox page:", fetchErr);
  }

  // Keep the leading "1" from the public share URL. Current TeraBox share/list
  // implementations expect the original shorturl value (for example 1abc...).
  const finalSurl = extractSurl(finalUrl) || shortCode || "";
  const jsTokenMatch =
    pageText.match(/fn\("([A-F0-9]+)"\)/i) ||
    pageText.match(/fn%28%22([^%"]+)%22%29/i) ||
    pageText.match(/window\.jsToken\s*=\s*["']([^"']+)["']/i);
  const jsToken = jsTokenMatch ? jsTokenMatch[1] : "";
  const dpLogIdMatch =
    pageText.match(/dp-logid[=\\"]([^&\\"]+)/i) ||
    pageText.match(/dpLogId[\\":=]+([0-9]+)/i);
  const dpLogId = dpLogIdMatch ? dpLogIdMatch[1] : "";
  let apiOrigin = "https://www.terabox.app";
  try {
    const origin = new URL(finalUrl).origin;
    if (origin.includes("terabox")) apiOrigin = origin;
  } catch {}

  const allItems: any[] = [];
  let shareId: string | undefined;
  let uk: string | undefined;
  let sign: string | undefined;
  let timestamp: string | undefined;
  let randsk: string | undefined;
  let title = "";

  if (finalSurl) {
    const variations = [finalSurl, finalSurl.startsWith("1") ? finalSurl.slice(1) : "1" + finalSurl]
      .filter((value, index, values) => value && values.indexOf(value) === index);
    const infoOrigins = [...new Set([
      apiOrigin,
      "https://www.terabox.app",
      "https://www.terabox.com",
      "https://www.1024tera.com",
    ])];

    for (const surlVariant of variations) {
      let infoResolved = false;
      for (const infoOrigin of infoOrigins) {
        try {
          const infoUrl = new URL("/api/shorturlinfo", infoOrigin);
          infoUrl.searchParams.set("app_id", "250528");
          infoUrl.searchParams.set("shorturl", surlVariant);
          infoUrl.searchParams.set("root", "1");
          infoUrl.searchParams.set("web", "1");
          infoUrl.searchParams.set("channel", "dubox");
          infoUrl.searchParams.set("clienttype", "0");
          if (jsToken) infoUrl.searchParams.set("jsToken", jsToken);
          if (dpLogId) infoUrl.searchParams.set("dp-logid", dpLogId);

          const apiRes = await fetch(infoUrl, {
            headers: {
              ...headers,
              Accept: "application/json, text/plain, */*",
              "X-Requested-With": "XMLHttpRequest",
              Referer: finalUrl,
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
          });

          if (!apiRes.ok) {
            console.warn(
              "TeraBox shorturlinfo HTTP " + apiRes.status +
              " origin=" + infoOrigin + " shorturl=" + surlVariant
            );
            continue;
          }

          const apiData = (await apiRes.json()) as any;
          const infoErrno = Number(apiData?.errno ?? 0);
          if (infoErrno !== 0 || !Array.isArray(apiData?.list)) {
            console.warn(
              "TeraBox shorturlinfo rejected origin=" + infoOrigin +
              " shorturl=" + surlVariant +
              " errno=" + infoErrno +
              " errmsg=" + (apiData?.errmsg || "none")
            );
            continue;
          }

          console.log(
            "TeraBox shorturlinfo resolved origin=" + infoOrigin +
            " shorturl=" + surlVariant +
            " items=" + apiData.list.length
          );

          shareId = apiData.shareid ? String(apiData.shareid) : undefined;
          uk = apiData.uk ? String(apiData.uk) : undefined;
          sign = apiData.sign ? String(apiData.sign) : undefined;
          timestamp = apiData.timestamp ? String(apiData.timestamp) : undefined;
          randsk = apiData.randsk ? decodeURIComponent(String(apiData.randsk)) : undefined;
          title = apiData.title ? cleanFilename(String(apiData.title)) : "";
          allItems.push(...apiData.list);
          infoResolved = true;
          break;
        } catch (error) {
          console.warn(
            "TeraBox shorturlinfo request failed origin=" + infoOrigin +
            " shorturl=" + surlVariant + ":",
            error
          );
        }
      }
      if (infoResolved) break;
    }
  }

  if (finalSurl && jsToken) {
    try {
      // The share/list endpoint is the primary resolver. Unlike shorturlinfo,
      // it is still used by current open-source clients with the original
      // "1..." shorturl and returns dlink/server_filename directly.
      const rootItems = await fetchTeraboxShareList(apiOrigin, finalSurl, jsToken, cookieHeader, finalUrl, undefined, dpLogId);
      allItems.push(...rootItems);
      const pendingDirs = rootItems.filter((item) => String(item?.isdir ?? "0") === "1");
      const visitedDirs = new Set<string>();
      let foldersScanned = 0;
      while (pendingDirs.length > 0 && foldersScanned < 50) {
        const directory = pendingDirs.shift();
        const dirPath = String(directory?.path || "");
        if (!dirPath || visitedDirs.has(dirPath)) continue;
        visitedDirs.add(dirPath);
        foldersScanned++;
        try {
          const children = await fetchTeraboxShareList(apiOrigin, finalSurl, jsToken, cookieHeader, finalUrl, dirPath, dpLogId);
          allItems.push(...children);
          for (const child of children) {
            if (String(child?.isdir ?? "0") === "1") pendingDirs.push(child);
          }
        } catch (folderErr) {
          console.warn("Could not inspect TeraBox folder " + dirPath + ":", folderErr);
        }
      }
    } catch (listErr) {
      console.warn("TeraBox share/list fallback failed:", listErr);
    }
  }

  const uniqueItems = new Map<string, any>();
  for (const item of allItems) {
    const key = item?.fs_id
      ? "fs:" + item.fs_id
      : "path:" + (item?.path || item?.server_filename || item?.filename || JSON.stringify(item));
    if (!uniqueItems.has(key)) uniqueItems.set(key, item);
  }

  const files: ResolvedTeraboxFile[] = [];
  for (const item of uniqueItems.values()) {
    const file = createTeraboxFileMetadata(item, shareId, uk, sign, timestamp);
    if (file) files.push(file);
  }

  if (files.length === 0 && pageText) {
    const listMatch =
      pageText.match(/window\.initData\s*=\s*({.*?});/s) ||
      pageText.match(/list:\s*(\[\{.*?\}\])/s) ||
      pageText.match(/"list":\s*(\[\{.*?\}\])/s);
    if (listMatch) {
      try {
        const parsed = JSON.parse(listMatch[1]);
        const items = Array.isArray(parsed) ? parsed : parsed.list || [];
        for (const item of items) {
          const file = createTeraboxFileMetadata(item, shareId, uk, sign, timestamp);
          if (file) files.push(file);
        }
      } catch {}
    }
  }

  if (shareId && uk && sign && timestamp) {
    for (const file of files) {
      if (file.downloadUrl || !file.fsId) continue;
      file.downloadUrl = await fetchTeraboxDownloadUrl(
        shareId, uk, sign, timestamp, file.fsId, jsToken, cookieHeader, finalUrl
      );
    }
  }

  const downloadableFiles = files.filter((file) => file.downloadUrl || file.streamUrl);
  if (downloadableFiles.length === 0) {
    const diagnostic = [
      "surl=" + (finalSurl || "missing"),
      "jsToken=" + (jsToken ? "yes" : "no"),
      "items=" + uniqueItems.size,
      "shareid=" + (shareId ? "yes" : "no"),
      "uk=" + (uk ? "yes" : "no"),
      "sign=" + (sign ? "yes" : "no"),
      "timestamp=" + (timestamp ? "yes" : "no"),
      "dpLogId=" + (dpLogId ? "yes" : "no"),
      "cookies=" + (cookieHeader ? "yes" : "no"),
      "finalHost=" + (() => { try { return new URL(finalUrl).host; } catch { return "unknown"; } })(),
    ].join(", ");
    throw new Error("No downloadable files were found in this TeraBox link (" + diagnostic + ").");
  }

  return {
    shareId,
    uk,
    sign,
    timestamp,
    randsk,
    title: title || downloadableFiles[0]?.filename || "TeraBox Files",
    files: downloadableFiles,
    directDownloadPossible: downloadableFiles.some((file) => !!file.downloadUrl || !!file.streamUrl),
    cookies: cookieHeader,
    refererUrl: finalUrl,
  };
}

/**
 * Downloads an HLS / M3U8 stream into a local MP4 file.
 * To bypass TeraBox's 30-second preview limit on unauthenticated/web streams,
 * this function scans across the entire video timeline (in increments of 25 seconds)
 * using the `time` parameter to discover all chunks for the entire video duration,
 * expands each segment's byte-range to download the full chunk, and muxes them into a complete MP4.
 */
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
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: refererUrl || "https://www.terabox.app/",
  };
  
  const effectiveCookies = [
    cookieHeader || "",
    metadata?.randsk ? `TSID=${metadata.randsk}` : ""
  ].filter(Boolean).join("; ");

  if (effectiveCookies) {
    headers["Cookie"] = effectiveCookies;
  }

  // Map to store unique video chunks by index: chunkIndex -> { url: string; size: number }
  const discoveredChunks = new Map<number, { url: string; size: number }>();

  // Helper to extract segments from an M3U8 response text
  const parseSegmentsFromM3u8 = (playlistText: string) => {
    const lines = playlistText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    for (const segUrl of lines) {
      try {
        const parsed = new URL(segUrl);
        // Look for chunk index in URL path (e.g. _1_ts/, _2_ts/, etc.)
        const match = parsed.pathname.match(/_(\d+)_ts\b/i);
        const chunkIdx = match ? parseInt(match[1], 10) : discoveredChunks.size + 1;
        const tsSizeStr = parsed.searchParams.get("ts_size");
        const tsSize = tsSizeStr ? parseInt(tsSizeStr, 10) : 0;

        if (!discoveredChunks.has(chunkIdx)) {
          if (tsSize > 0) {
            // Expand the byte-range to download the full segment instead of a 30s slice
            parsed.searchParams.set("range", `0-${tsSize - 1}`);
            parsed.searchParams.set("len", String(tsSize));
          }
          discoveredChunks.set(chunkIdx, {
            url: parsed.toString(),
            size: tsSize,
          });
        }
      } catch {
        // Fallback for relative or non-standard URLs
        const chunkIdx = discoveredChunks.size + 1;
        if (!discoveredChunks.has(chunkIdx)) {
          discoveredChunks.set(chunkIdx, { url: segUrl, size: 0 });
        }
      }
    }
  };

  // 1. Fetch initial M3U8
  const res = await fetch(m3u8Url, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch M3U8 playlist: HTTP ${res.status}`);
  }
  const initialPlaylistText = await res.text();
  parseSegmentsFromM3u8(initialPlaylistText);

  // 2. Multi-chunk discovery across video timeline if streaming parameters are available
  const parsedM3u8Url = new URL(m3u8Url);
  const uk = metadata?.uk || parsedM3u8Url.searchParams.get("uk");
  const shareid = metadata?.shareId || parsedM3u8Url.searchParams.get("shareid");
  const fid = metadata?.fsId || parsedM3u8Url.searchParams.get("fid");
  const sign = metadata?.sign || parsedM3u8Url.searchParams.get("sign");
  const timestamp = metadata?.timestamp || parsedM3u8Url.searchParams.get("timestamp");

  if (uk && shareid && fid && sign && timestamp) {
    // If we have duration, probe in 25-second increments to cover the full duration
    // If duration is unknown, probe up to 7200s (2 hours) or until 3 consecutive steps yield no new chunks
    const maxScanTime = metadata?.duration && metadata.duration > 0
      ? metadata.duration + 30
      : 7200;

    let emptyStreak = 0;
    const stepSeconds = 25;

    for (let t = stepSeconds; t <= maxScanTime; t += stepSeconds) {
      try {
        if (metadata?.beforeChunk) {
          await metadata.beforeChunk();
        }
        const timeStreamUrl = `https://www.terabox.app/share/streaming?app_id=250528&web=1&channel=dubox&clienttype=0&shareid=${shareid}&uk=${uk}&fid=${fid}&sign=${encodeURIComponent(
          sign
        )}&timestamp=${timestamp}&type=M3U8_AUTO_480&time=${t}&esl=1&isplayer=1&ehps=1`;

        const timeRes = await fetch(timeStreamUrl, { headers });
        if (timeRes.ok) {
          const timeText = await timeRes.text();
          const prevCount = discoveredChunks.size;
          parseSegmentsFromM3u8(timeText);
          if (discoveredChunks.size > prevCount) {
            emptyStreak = 0;
          } else {
            emptyStreak++;
            // If duration wasn't known and we haven't found any new chunks for 4 consecutive intervals (~100s), stop scanning
            if (!metadata?.duration && emptyStreak >= 4 && discoveredChunks.size > 0) {
              break;
            }
          }
        }
      } catch (scanErr) {
        console.warn(`Timeline probe failed at t=${t}:`, scanErr);
      }
    }
  }

  // Sort discovered chunks by index
  const sortedChunkIndices = Array.from(discoveredChunks.keys()).sort((a, b) => a - b);
  if (sortedChunkIndices.length === 0) {
    throw new Error("M3U8 playlist contained no video segments");
  }

  console.log(`Discovered ${sortedChunkIndices.length} video chunks across timeline`);

  const tempTsPath = `${outputMp4Path}.temp.ts`;
  const outWriteStream = fs.createWriteStream(tempTsPath);

  try {
    for (let i = 0; i < sortedChunkIndices.length; i++) {
      if (metadata?.beforeChunk) {
        await metadata.beforeChunk();
      }
      const idx = sortedChunkIndices[i];
      const chunk = discoveredChunks.get(idx)!;

      const segRes = await fetch(chunk.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Referer: refererUrl || "https://www.terabox.app/",
        },
      });

      if (!segRes.ok) {
        throw new Error(`Failed to fetch segment ${i + 1}/${sortedChunkIndices.length}`);
      }

      const arrayBuffer = await segRes.arrayBuffer();
      outWriteStream.write(Buffer.from(arrayBuffer));

      if (onProgress) {
        const percent = Math.round(((i + 1) / sortedChunkIndices.length) * 100);
        onProgress(percent, i + 1, sortedChunkIndices.length);
      }
    }
  } finally {
    await new Promise<void>((resolve) => {
      outWriteStream.end(() => resolve());
    });
  }

  // Remux .ts into .mp4 using ffmpeg for optimal streaming and compatibility
  try {
    await execFileAsync("ffmpeg", ["-y", "-i", tempTsPath, "-c", "copy", outputMp4Path]);
  } catch (ffmpegErr) {
    console.warn("FFmpeg remux warning, keeping original ts file:", ffmpegErr);
    fs.copyFileSync(tempTsPath, outputMp4Path);
  } finally {
    if (fs.existsSync(tempTsPath)) {
      fs.unlinkSync(tempTsPath);
    }
  }
}

export async function unpackZipArchive(
  zipPath: string,
  targetDir: string
): Promise<{ path: string; filename: string; size: number }[]> {
  const results: { path: string; filename: string; size: number }[] = [];
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    const directory = await unzipper.Open.file(zipPath);
    const usedNames = new Set<string>();

    for (const entry of directory.files) {
      if (entry.type === "Directory" || entry.path.startsWith("__MACOSX/")) continue;

      const baseName = cleanFilename(path.basename(entry.path));
      let filename = baseName;
      let suffix = 1;
      while (usedNames.has(filename)) {
        const extension = path.extname(baseName);
        const stem = extension ? baseName.slice(0, -extension.length) : baseName;
        filename = `${stem}_${suffix++}${extension}`;
      }
      usedNames.add(filename);

      const outputPath = path.join(targetDir, filename);
      await pipeline(entry.stream(), fs.createWriteStream(outputPath));
      const stats = fs.statSync(outputPath);
      results.push({
        path: outputPath,
        filename,
        size: stats.size,
      });
    }
  } catch (err: any) {
    console.error("ZIP Unpack error:", err);
  }
  return results;
}
