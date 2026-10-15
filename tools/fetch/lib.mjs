// Shared helpers for the source fetchers: a polite, cached GET, a JSONL writer, and the paths.
// Every response is cached on disk under $SCROLLS_DATA/cache/http, so a re-run costs nothing.
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const DATA = process.env.SCROLLS_DATA || join(homedir(), "Developer", "scrolls-data");
export const SOURCES = join(DATA, "sources");
export const CONTACT = process.env.SCROLLS_CONTACT || "maintainer@example.invalid"; // Set a real project contact before fetching.
export const USER_AGENT = `Scrolls/0.1 (local research tool; mailto:${CONTACT})`;
const CACHE = join(DATA, "cache", "http");

export function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

export function sourceDir(name) {
  const dir = join(SOURCES, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** GET with on-disk caching and backoff. Returns a Buffer, or null after `tries` refusals.
 *  429 / 5xx are waited out (Retry-After honoured) without using up a try. */
export async function fetchCached(url, { pauseMs = 300, tries = 5, timeoutMs = 90_000, headers = {}, cache = true } = {}) {
  const key = createHash("sha1").update(url).digest("hex");
  const path = join(CACHE, key.slice(0, 2), key + ".bin");
  if (cache && existsSync(path)) return readFileSync(path);
  let attempt = 0, waits = 0;
  while (attempt < tries && waits < 30) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 200) {
        const body = Buffer.from(await response.arrayBuffer());
        if (cache) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path + ".part", body);
          renameSync(path + ".part", path);
        }
        await pause(pauseMs);
        return body;
      }
      if (response.status === 429 || response.status >= 500) {
        const retry = Number(response.headers.get("retry-after")) || 10 * (waits + 1);
        log(`  ${response.status} on ${url.slice(0, 120)} — waiting ${retry}s`);
        waits++;
        await pause(Math.min(retry, 600) * 1000);
        continue;
      }
      log(`  ${response.status} on ${url.slice(0, 120)}`);
      return null;
    } catch (error) {
      attempt++;
      log(`  retry ${attempt} after ${error.name}: ${error.message}`);
      await pause(3000 * attempt);
    }
  }
  return null;
}

export async function fetchJSON(url, options) {
  const body = await fetchCached(url, options);
  return body ? JSON.parse(body.toString("utf8")) : null;
}

/** Streams a (possibly gzipped) URL line by line through curl | gzip -dc, never storing it. */
export async function* streamLines(url, { gzip = url.endsWith(".gz") } = {}) {
  const curl = spawn("curl", ["-sS", "-L", "--fail", "-A", USER_AGENT, url], { stdio: ["ignore", "pipe", "inherit"] });
  let source = curl.stdout;
  let unzip = null;
  if (gzip) {
    unzip = spawn("gzip", ["-dc"], { stdio: ["pipe", "pipe", "inherit"] });
    curl.stdout.pipe(unzip.stdin);
    source = unzip.stdout;
  }
  const lines = createInterface({ input: source, crlfDelay: Infinity });
  for await (const line of lines) yield line;
  const code = await new Promise((resolve) => (curl.exitCode !== null ? resolve(curl.exitCode) : curl.on("close", resolve)));
  if (code !== 0) throw new Error(`curl exited ${code} for ${url}`);
}

/** Appends JSON objects one per line; call close() to flush. */
export function jsonlWriter(path) {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { encoding: "utf8" });
  return {
    write: (object) => stream.write(JSON.stringify(object) + "\n"),
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}

/** MANIFEST.json beside every source: where it came from, licence, when, how, counts, caveats. */
export function writeManifest(dir, manifest) {
  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify({ fetched_at: new Date().toISOString(), ...manifest }, null, 2) + "\n");
}
