#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const sourcePath = path.join(rootDir, "data/fourmeme-tickers.json");
const outputDir = path.join(rootDir, "outputs/remote-database");
const databaseName = "fourmeme-tickers.json";
const manifestName = "fourmeme-update.json";

const bytes = await fs.readFile(sourcePath);
const payload = JSON.parse(bytes.toString("utf8"));

if (
  payload?.ready !== true ||
  !Array.isArray(payload?.tickers) ||
  payload.tickers.length !== Number(payload.tickerCount || 0)
) {
  throw new Error("本地数据库未就绪或 tickerCount 不一致");
}

const normalizedTickers = payload.tickers
  .map(normalizeTicker)
  .filter(Boolean);
const tickerSet = new Set(normalizedTickers);
if (tickerSet.size !== payload.tickers.length) {
  throw new Error("本地数据库包含重复、无效或未标准化 ticker");
}

const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const manifest = {
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  databaseUrl: `./${databaseName}`,
  sha256,
  sourceBlock: Number(payload.sourceBlock || 0),
  tickerCount: payload.tickers.length
};

await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(path.join(outputDir, databaseName), bytes);
await fs.writeFile(
  path.join(outputDir, manifestName),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

console.log(`数据库：${path.join(outputDir, databaseName)}`);
console.log(`清单：${path.join(outputDir, manifestName)}`);
console.log(`SHA-256：${sha256}`);

function normalizeTicker(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleUpperCase("en-US");
}
