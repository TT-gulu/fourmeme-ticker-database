#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const FOURMEME_CONTRACT =
  "0x5c952063c7fc8610ffdb798152d69f0b9550762b";
const TOKEN_CREATE_TOPIC =
  "0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20";
const DEFAULT_START_BLOCK = 40000000;
const DEFAULT_CHUNK_SIZE = readInteger(
  process.env.RPC_CHUNK_SIZE,
  100000
);
const MIN_CHUNK_SIZE = 25;
const RPC_CONCURRENCY = Math.max(
  1,
  Math.min(8, readInteger(process.env.RPC_CONCURRENCY, 4))
);
const MAX_ATTEMPTS_PER_RPC = 2;
const REQUEST_TIMEOUT_MS = 30000;
const FINALITY_BLOCKS = 15;

const DEFAULT_RPC_URLS = [
  "https://public-bsc.nownodes.io",
  "https://bnb-mainnet.g.alchemy.com/public",
  "https://1rpc.io/bnb",
  "https://bsc-rpc.publicnode.com"
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const outputPath = path.resolve(
  rootDir,
  process.env.TICKER_DB_PATH || "data/fourmeme-tickers.json"
);
const checkpointPath = path.resolve(
  rootDir,
  process.env.CHECKPOINT_PATH || "data/fourmeme-rpc-checkpoint.json"
);
const rpcUrls = String(process.env.BSC_RPC_URLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (!rpcUrls.length) rpcUrls.push(...DEFAULT_RPC_URLS);

let activeRpcIndex = 0;
let tickerSet = new Set();

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

async function main() {
  const forceRebuild =
    process.env.FORCE_REBUILD === "1" ||
    process.argv.includes("--force-rebuild");
  const existing = forceRebuild ? {} : await readJson(outputPath, {});
  const checkpoint = forceRebuild ? {} : await readJson(checkpointPath, {});
  tickerSet = new Set(
    (Array.isArray(existing.tickers) ? existing.tickers : [])
      .map(normalizeTicker)
      .filter(Boolean)
  );

  const requestedStart = readInteger(
    process.env.START_BLOCK,
    DEFAULT_START_BLOCK
  );
  const databaseNext = existing.source === "bsc-rpc"
    ? readInteger(existing.sourceBlock, requestedStart - 1) + 1
    : requestedStart;
  const checkpointNext = readInteger(checkpoint.nextBlock, databaseNext);
  let nextBlock = Math.max(requestedStart, checkpointNext);
  let chunkSize = readInteger(checkpoint.chunkSize, DEFAULT_CHUNK_SIZE);
  let eventCount = readInteger(checkpoint.eventCount, 0);
  let successfulBatchesAtCurrentSize = 0;

  if (forceRebuild) {
    await fs.rm(checkpointPath, { force: true });
    await writeDatabase(requestedStart - 1, false);
    console.log("强制重建：已清空旧规则数据库。");
  }

  const latestBlock = Number(BigInt(await rpc("eth_blockNumber", [])));
  const requestedEnd = readInteger(process.env.END_BLOCK, latestBlock);
  const endBlock = Math.min(
    requestedEnd,
    Math.max(0, latestBlock - FINALITY_BLOCKS)
  );

  if (nextBlock > endBlock) {
    await writeDatabase(endBlock, true);
    console.log(`数据库已经同步到区块 ${endBlock}。`);
    return;
  }

  console.log(`FourMeme RPC 历史同步：${nextBlock} -> ${endBlock}`);
  console.log(`已有唯一 ticker：${tickerSet.size}`);
  console.log(`公共节点：${rpcUrls.length} 个`);

  while (nextBlock <= endBlock) {
    const ranges = [];
    let rangeStart = nextBlock;
    while (ranges.length < RPC_CONCURRENCY && rangeStart <= endBlock) {
      const rangeEnd = Math.min(rangeStart + chunkSize - 1, endBlock);
      ranges.push({ fromBlock: rangeStart, toBlock: rangeEnd });
      rangeStart = rangeEnd + 1;
    }

    try {
      const results = await Promise.all(
        ranges.map(async (range) => {
          const logs = await rpc("eth_getLogs", [{
            address: FOURMEME_CONTRACT,
            fromBlock: toHex(range.fromBlock),
            toBlock: toHex(range.toBlock),
            topics: [TOKEN_CREATE_TOPIC]
          }]);
          if (!Array.isArray(logs)) {
            throw new Error("eth_getLogs 返回格式无效");
          }
          return { ...range, logs };
        })
      );

      for (const result of results) {
        for (const log of result.logs) {
          const ticker = decodeSymbol(log?.data);
          if (ticker) tickerSet.add(ticker);
        }
        eventCount += result.logs.length;
        console.log(
          `${result.toBlock}: ${result.logs.length} 个创建事件，` +
          `唯一 ticker ${tickerSet.size}`
        );
      }

      nextBlock = ranges.at(-1).toBlock + 1;
      successfulBatchesAtCurrentSize += 1;
      if (
        successfulBatchesAtCurrentSize >= 3 &&
        chunkSize < DEFAULT_CHUNK_SIZE
      ) {
        chunkSize = Math.min(DEFAULT_CHUNK_SIZE, chunkSize * 2);
        successfulBatchesAtCurrentSize = 0;
        console.log(`节点稳定，单次范围恢复为 ${chunkSize} 个区块`);
      }
      await saveProgress(nextBlock, chunkSize, eventCount, endBlock);
    } catch (error) {
      if (chunkSize <= MIN_CHUNK_SIZE) throw error;
      chunkSize = Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
      successfulBatchesAtCurrentSize = 0;
      console.warn(
        `区块 ${nextBlock}-${ranges.at(-1).toBlock} 查询失败，` +
        `范围缩小为 ${chunkSize}：` +
        shortError(error)
      );
      await saveCheckpoint(nextBlock, chunkSize, eventCount, endBlock);
    }
  }

  await writeDatabase(endBlock, tickerSet.size > 0);
  await fs.rm(checkpointPath, { force: true });

  console.log(`完成：读取创建事件 ${eventCount} 条`);
  console.log(`唯一 ticker：${tickerSet.size}`);
  console.log(`输出：${outputPath}`);
}

async function rpc(method, params) {
  let lastError;

  for (let offset = 0; offset < rpcUrls.length; offset += 1) {
    const rpcIndex = (activeRpcIndex + offset) % rpcUrls.length;
    const url = rpcUrls[rpcIndex];

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_RPC; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        }

        const payload = JSON.parse(text);
        if (payload?.error) {
          throw new Error(
            `RPC ${payload.error.code}: ${payload.error.message || "错误"}`
          );
        }

        activeRpcIndex = rpcIndex;
        return payload.result;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS_PER_RPC) {
          await sleep(attempt * 1000);
        }
      }
    }
  }

  throw new Error(`所有公共 RPC 均失败：${shortError(lastError)}`);
}

function decodeSymbol(data) {
  if (!/^0x[0-9a-fA-F]+$/.test(String(data || ""))) return "";

  // TokenCreate 的第 5 个 ABI 参数是 symbol，对应动态字符串偏移。
  const offsetWord = readWord(data, 4);
  if (!offsetWord) return "";

  const offset = safeNumber(offsetWord);
  if (offset === null || offset % 32 !== 0) return "";

  const lengthWord = readWord(data, offset / 32);
  if (!lengthWord) return "";

  const byteLength = safeNumber(lengthWord);
  if (byteLength === null || byteLength < 1 || byteLength > 256) return "";

  const contentStart = 2 + (offset + 32) * 2;
  const contentEnd = contentStart + byteLength * 2;
  if (contentEnd > data.length) return "";

  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(data.slice(contentStart, contentEnd), "hex")
    );
    return normalizeTicker(value);
  } catch {
    return "";
  }
}

function readWord(data, index) {
  const start = 2 + index * 64;
  const word = data.slice(start, start + 64);
  return word.length === 64 ? word : "";
}

function safeNumber(hexWithoutPrefix) {
  try {
    const value = BigInt(`0x${hexWithoutPrefix}`);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  } catch {
    return null;
  }
}

async function saveProgress(next, size, events, targetBlock) {
  await writeDatabase(next - 1, false);
  await saveCheckpoint(next, size, events, targetBlock);
}

async function saveCheckpoint(next, size, events, targetBlock) {
  await writeJson(checkpointPath, {
    version: 1,
    nextBlock: next,
    chunkSize: size,
    eventCount: events,
    targetBlock,
    updatedAt: new Date().toISOString()
  });
}

async function writeDatabase(sourceBlock, ready) {
  const tickers = [...tickerSet].sort(compareTicker);
  await writeJson(outputPath, {
    version: 2,
    ready,
    generatedAt: new Date().toISOString(),
    source: "bsc-rpc",
    sourceBlock,
    tickerCount: tickers.length,
    tickers
  });
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function normalizeTicker(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleUpperCase("en-US");
}

function compareTicker(a, b) {
  return a.localeCompare(b, "en", {
    sensitivity: "variant",
    numeric: true
  });
}

function readInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function toHex(value) {
  return `0x${value.toString(16)}`;
}

function shortError(error) {
  return String(error?.message || error).replace(/\s+/g, " ").slice(0, 240);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export { decodeSymbol, normalizeTicker };
