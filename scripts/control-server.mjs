#!/usr/bin/env node
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CHAIN_CONFIG,
  applyWatchSnapshot,
  buildAutomintConfirmation,
  buildAutomintPrompt,
  buildWatchSummary,
  cleanUrlToken,
  createPriceInfo,
  createWatchRecord,
  extractUrls,
  formatNativeAmount,
  formatPriceStatus,
  formatUsdAmount,
  getChainConfig,
  matchesWatchReference,
  normalizeOptions,
  parseTelegramText,
  toFiniteNumber
} from '../controlShared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const DEFAULT_STATE_PATH = join(REPO_ROOT, '.metabot-control-state.json');
const DEFAULT_PORT = 8787;
const DEFAULT_POLL_MS = 45000;
const LONG_POLL_TIMEOUT = 25;
const OPENSEA_HEADERS = { Accept: 'application/json' };

const PRICE_GETTERS = [
  ['publicSalePrice()', '0x9b6860c8'],
  ['mintPrice()', '0x6817c76c'],
  ['price()', '0xa035b1fe'],
  ['cost()', '0x13faede6'],
  ['getPrice()', '0x98d5fdca'],
  ['publicPrice()', '0xa945bf80'],
  ['salePrice()', '0xf51f96dd'],
  ['tokenPrice()', '0x7ff9b596'],
  ['PRICE()', '0x8d859f3e'],
  ['MINT_PRICE()', '0xc002d23d'],
  ['currentPrice()', '0x9d1b464a'],
  ['getMintPrice()', '0xa7f93ebd'],
  ['pricePerToken()', '0x7b1b1de6'],
  ['mintCost()', '0xbdb4b848'],
  ['presalePrice()', '0x000e7fa8']
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadDotEnv(rootPath = REPO_ROOT) {
  const envPath = join(rootPath, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function buildRuntimeConfig() {
  loadDotEnv(REPO_ROOT);
  if (process.env.OPENSEA_API_KEY) OPENSEA_HEADERS['x-api-key'] = process.env.OPENSEA_API_KEY;
  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedChatIds: String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || process.env.TELEGRAM_CHAT_ID || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    statePath: isAbsolute(process.env.CONTROL_STATE_FILE || '')
      ? process.env.CONTROL_STATE_FILE
      : (process.env.CONTROL_STATE_FILE ? join(REPO_ROOT, process.env.CONTROL_STATE_FILE) : DEFAULT_STATE_PATH),
    port: Math.max(1, Math.floor(toFiniteNumber(process.env.CONTROL_SERVER_PORT) || DEFAULT_PORT)),
    pollMs: Math.max(5000, Math.floor(toFiniteNumber(process.env.CONTROL_POLL_MS) || DEFAULT_POLL_MS)),
    rpcUrl: process.env.DEFAULT_RPC_URL || 'https://ethereum.publicnode.com',
    priceCacheMs: Math.max(30000, Math.floor(toFiniteNumber(process.env.CONTROL_PRICE_CACHE_MS) || 300000)),
    verbose: truthy(process.env.CONTROL_VERBOSE)
  };
}

function defaultState() {
  return {
    telegram: {
      lastUpdateId: 0,
      lastPollAt: null,
      lastPollOkAt: null,
      lastError: ''
    },
    browser: {
      lastSeenAt: null,
      walletReady: false,
      signerReady: false,
      address: null,
      activeCollection: null,
      ethPrice: null,
      gasPrice: null
    },
    quotes: {},
    watches: [],
    lastWatchCheckAt: null
  };
}

export function loadStateFromFile(statePath = DEFAULT_STATE_PATH) {
  if (!existsSync(statePath)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      ...defaultState(),
      ...parsed,
      telegram: { ...defaultState().telegram, ...(parsed.telegram || {}) },
      browser: { ...defaultState().browser, ...(parsed.browser || {}) },
      quotes: parsed.quotes || {},
      watches: Array.isArray(parsed.watches) ? parsed.watches : []
    };
  } catch {
    return defaultState();
  }
}

export function saveStateToFile(statePath = DEFAULT_STATE_PATH, state = defaultState()) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function log(config, message, extra = '') {
  const line = `[control-server] ${message}${extra ? ` ${extra}` : ''}`;
  console.log(line.replaceAll(config.telegramToken || '', '[redacted]'));
}

function ageText(isoString) {
  if (!isoString) return 'never';
  const delta = Date.now() - new Date(isoString).getTime();
  if (!Number.isFinite(delta) || delta < 0) return 'just now';
  if (delta < 60000) return `${Math.round(delta / 1000)}s ago`;
  if (delta < 3600000) return `${Math.round(delta / 60000)}m ago`;
  return `${Math.round(delta / 3600000)}h ago`;
}

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 9000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  return response.json();
}

async function fetchText(url, options = {}, timeoutMs = 9000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  return response.text();
}

async function fetchPageMirror(url) {
  const targets = [
    url,
    `https://r.jina.ai/http://${cleanUrlToken(url).replace(/^https?:\/\//i, '')}`
  ];
  let lastError = null;
  for (const target of targets) {
    try {
      return await fetchText(target, {}, 12000);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Unable to fetch page');
}

function parseDirectReference(input) {
  const cleaned = cleanUrlToken(input || '');
  if (!cleaned) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(cleaned)) {
    return { contract: cleaned, chain: 'ethereum', sourceLink: cleaned };
  }
  try {
    const url = new URL(cleaned);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const path = url.pathname.replace(/\/$/, '');
    const matchContract = cleaned.match(/0x[a-fA-F0-9]{40}/);
    if ((host === 'x.com' || host === 'twitter.com') && path) {
      return { xUrl: cleaned, sourceLink: cleaned };
    }
    if ((host === 'etherscan.io' || host === 'basescan.org' || host === 'arbiscan.io' || host === 'polygonscan.com') && matchContract) {
      return { contract: matchContract[0], chain: 'ethereum', sourceLink: cleaned };
    }
    if (host === 'opensea.io') {
      const collectionMatch = path.match(/^\/collection\/([^/?#]+)/);
      if (collectionMatch) return { slug: collectionMatch[1], chain: 'ethereum', sourceLink: cleaned, collectionLink: cleaned };
      if (matchContract) return { contract: matchContract[0], chain: 'ethereum', sourceLink: cleaned };
    }
    if (host === 'mint.fun' && matchContract) return { contract: matchContract[0], chain: 'ethereum', sourceLink: cleaned };
    if (host === 'zora.co' && matchContract) return { contract: matchContract[0], chain: 'ethereum', sourceLink: cleaned };
    if (host === 'foundation.app' && matchContract) return { contract: matchContract[0], chain: 'ethereum', sourceLink: cleaned };
    return { sourceLink: cleaned, pageUrl: cleaned, chain: 'ethereum' };
  } catch {
    if (!cleaned.includes(' ') && cleaned.length > 3) {
      return {
        slug: cleaned,
        chain: 'ethereum',
        sourceLink: `https://opensea.io/collection/${cleaned}`,
        collectionLink: `https://opensea.io/collection/${cleaned}`
      };
    }
    return null;
  }
}

function extractPageHints(pageText) {
  const contract = pageText.match(/0x[a-fA-F0-9]{40}/)?.[0] || null;
  const slug = pageText.match(/opensea\.io\/collection\/([^\s"')]+)/i)?.[1] || null;
  const url = extractUrls(pageText).find(candidate => !/^(https?:\/\/)?(x|twitter)\.com\//i.test(candidate)) || null;
  const title = pageText.match(/<title>([^<]+)<\/title>/i)?.[1]
    || pageText.match(/^Title:\s*(.+)$/m)?.[1]
    || pageText.match(/"name"\s*:\s*"([^"]+)"/i)?.[1]
    || null;
  return {
    contract,
    slug,
    title: title ? title.replace(/\s*[-|].*$/, '').trim() : null,
    linkedUrl: url
  };
}

async function expandWatchInput(input, config) {
  const direct = parseDirectReference(input);
  if (!direct) return { error: 'No watchable contract, collection, or mint URL was found.' };

  if (direct.xUrl) {
    try {
      const page = await fetchPageMirror(direct.xUrl);
      const hint = extractPageHints(page);
      const nextInput = hint.linkedUrl || hint.contract || (hint.slug ? `https://opensea.io/collection/${hint.slug}` : null);
      if (!nextInput) {
        return { error: 'X post did not expose a mint link, collection link, or contract address.' };
      }
      const expanded = await expandWatchInput(nextInput, config);
      return {
        ...expanded,
        sourceLink: direct.xUrl,
        sourceTitle: hint.title || expanded.sourceTitle || null
      };
    } catch (error) {
      return { error: `Could not read the X post: ${error.message}` };
    }
  }

  if (direct.pageUrl && !direct.contract && !direct.slug) {
    try {
      const page = await fetchPageMirror(direct.pageUrl);
      const hint = extractPageHints(page);
      return {
        contract: hint.contract || null,
        slug: hint.slug || null,
        name: hint.title || null,
        chain: direct.chain,
        sourceLink: direct.sourceLink,
        pageUrl: direct.pageUrl,
        collectionLink: hint.slug ? `https://opensea.io/collection/${hint.slug}` : '',
        error: !hint.contract && !hint.slug ? 'Mint page did not expose a contract or marketplace collection link.' : ''
      };
    } catch (error) {
      return { error: `Mint page scan failed: ${error.message}` };
    }
  }

  return {
    ...direct,
    name: null,
    error: ''
  };
}

async function resolveReservoirCollection(reference) {
  const urls = [];
  if (reference.contract) {
    urls.push(`https://api.reservoir.tools/collections/v7?id=${encodeURIComponent(reference.contract)}`);
    urls.push(`https://api.reservoir.tools/collections/v7?contract=${encodeURIComponent(reference.contract)}`);
  }
  if (reference.slug) {
    urls.push(`https://api.reservoir.tools/collections/v7?slug=${encodeURIComponent(reference.slug)}`);
  }
  let lastError = null;
  for (const url of urls) {
    try {
      const data = await fetchJson(url, {}, 9000);
      const collection = data.collections?.[0];
      if (!collection) continue;
      const floorNative = toFiniteNumber(collection.floorAsk?.price?.amount?.native ?? collection.floorAsk?.price?.amount?.decimal);
      return {
        name: collection.name || reference.name || 'unknown',
        contract: collection.primaryContract || collection.contract || reference.contract || null,
        slug: collection.slug || reference.slug || null,
        chain: (collection.chain || reference.chain || 'ethereum').toLowerCase(),
        collectionLink: collection.slug ? `https://opensea.io/collection/${collection.slug}` : (reference.collectionLink || reference.sourceLink || ''),
        floorInfo: floorNative != null && floorNative > 0
          ? createPriceInfo({ state: 'known', value: floorNative, source: 'Reservoir floor ask', updatedAt: new Date().toISOString(), chain: reference.chain || 'ethereum' })
          : createPriceInfo({ state: 'unknown', reason: 'No live floor ask yet', source: 'Reservoir', updatedAt: new Date().toISOString(), chain: reference.chain || 'ethereum' })
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Collection lookup failed');
}

async function resolveOpenSeaFloor(slug) {
  if (!slug) return createPriceInfo({ state: 'unknown', reason: 'No OpenSea slug available', source: 'OpenSea' });
  try {
    const stats = await fetchJson(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, { headers: OPENSEA_HEADERS }, 9000);
    const value = toFiniteNumber(stats?.total?.floor_price);
    return value != null && value > 0
      ? createPriceInfo({ state: 'known', value, source: 'OpenSea stats', updatedAt: new Date().toISOString(), chain: 'ethereum' })
      : createPriceInfo({ state: 'unknown', reason: 'OpenSea has no live floor yet', source: 'OpenSea stats', updatedAt: new Date().toISOString(), chain: 'ethereum' });
  } catch (error) {
    return createPriceInfo({ state: 'unknown', reason: `OpenSea floor lookup failed: ${error.message}`, source: 'OpenSea stats', updatedAt: new Date().toISOString(), chain: 'ethereum' });
  }
}

function pickMintStage(stages = []) {
  const now = Date.now();
  const normalized = stages.map(stage => ({
    price: toFiniteNumber(stage.price),
    source: stage.source || 'stage',
    startAt: stage.start_time ? new Date(stage.start_time).getTime() : null,
    endAt: stage.end_time ? new Date(stage.end_time).getTime() : null,
    name: stage.name || stage.stage || 'stage'
  }));
  return normalized.find(stage => (stage.startAt == null || stage.startAt <= now) && (stage.endAt == null || stage.endAt > now) && stage.price != null)
    || normalized.find(stage => stage.price != null)
    || null;
}

async function resolveMintFromSlug(slug) {
  const now = new Date().toISOString();
  const endpoints = [
    async () => {
      const data = await fetchJson(`https://api.opensea.io/api/v2/drops/${encodeURIComponent(slug)}`, { headers: OPENSEA_HEADERS }, 9000);
      const stages = Array.isArray(data?.stages) ? data.stages.map(stage => ({
        ...stage,
        price: stage.price != null ? Number(stage.price) : null,
        source: 'OpenSea drops'
      })) : [];
      return pickMintStage(stages);
    },
    async () => {
      const data = await fetchJson(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/mint_stages`, { headers: OPENSEA_HEADERS }, 9000);
      const stages = Array.isArray(data?.mint_stages) ? data.mint_stages.map(stage => ({
        ...stage,
        price: stage.price_per_token && stage.price_per_token !== '0'
          ? Number(BigInt(stage.price_per_token)) / 1e18
          : (stage.price != null ? Number(stage.price) : 0),
        source: 'OpenSea mint stages'
      })) : [];
      return pickMintStage(stages);
    },
    async () => {
      const data = await fetchJson(`https://api.reservoir.tools/collections/v7?slug=${encodeURIComponent(slug)}&includeMintStages=true`, {}, 9000);
      const collection = data.collections?.[0];
      const stages = Array.isArray(collection?.mintStages) ? collection.mintStages.map(stage => ({
        ...stage,
        price: toFiniteNumber(stage.price?.amount?.native),
        start_time: stage.startTime ? new Date(stage.startTime * 1000).toISOString() : null,
        end_time: stage.endTime ? new Date(stage.endTime * 1000).toISOString() : null,
        source: 'Reservoir mint stages'
      })) : [];
      return pickMintStage(stages);
    }
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const stage = await endpoint();
      if (!stage) continue;
      if (stage.price === 0) {
        return createPriceInfo({ state: 'free', value: 0, source: stage.source, updatedAt: now, chain: 'ethereum' });
      }
      if (stage.price != null && stage.price > 0) {
        return createPriceInfo({ state: 'known', value: stage.price, source: stage.source, updatedAt: now, chain: 'ethereum' });
      }
    } catch (error) {
      lastError = error;
    }
  }
  return createPriceInfo({ state: 'unknown', reason: lastError ? lastError.message : 'No verified mint phase was found', source: 'mint phase APIs', updatedAt: now, chain: 'ethereum' });
}

async function ethCall(rpcUrl, contract, data) {
  const payload = {
    jsonrpc: '2.0',
    method: 'eth_call',
    params: [{ to: contract, data }, 'latest'],
    id: 1
  };
  const result = await fetchJson(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 9000);
  if (result.error) throw new Error(result.error.message || 'eth_call failed');
  return result.result;
}

function decodeUint256(result) {
  if (!result || result === '0x') return null;
  return Number(BigInt(result));
}

async function detectOnChainMintPrice(contract, config) {
  const now = new Date().toISOString();
  for (const [signature, selector] of PRICE_GETTERS) {
    try {
      const value = decodeUint256(await ethCall(config.rpcUrl, contract, selector));
      if (value == null) continue;
      if (value > 0) {
        return createPriceInfo({ state: 'known', value: value / 1e18, source: `on-chain ${signature}`, updatedAt: now, chain: 'ethereum' });
      }
    } catch {
      continue;
    }
  }
  return createPriceInfo({ state: 'unknown', reason: 'No verified mint phase or on-chain price getter returned a price', source: 'on-chain getters', updatedAt: now, chain: 'ethereum' });
}

async function resolveMintInfo(reference, config) {
  if (reference.slug) {
    const fromSlug = await resolveMintFromSlug(reference.slug);
    if (fromSlug.state !== 'unknown') return fromSlug;
    if (reference.contract) {
      const onChain = await detectOnChainMintPrice(reference.contract, config);
      return onChain.state !== 'unknown' ? onChain : fromSlug;
    }
    return fromSlug;
  }
  if (reference.contract) return detectOnChainMintPrice(reference.contract, config);
  return createPriceInfo({ state: 'unknown', reason: 'No contract or verified mint API was available', source: 'resolver', updatedAt: new Date().toISOString(), chain: reference.chain || 'ethereum' });
}

async function resolveWatchSnapshot(inputOrReference, config) {
  const expanded = typeof inputOrReference === 'string'
    ? await expandWatchInput(inputOrReference, config)
    : { ...inputOrReference };
  if (expanded.error) return { error: expanded.error, sourceLink: expanded.sourceLink || String(inputOrReference || '') };

  let collection = null;
  try {
    collection = await resolveReservoirCollection(expanded);
  } catch {
    collection = {
      name: expanded.name || expanded.sourceTitle || 'unknown',
      contract: expanded.contract || null,
      slug: expanded.slug || null,
      chain: expanded.chain || 'ethereum',
      collectionLink: expanded.collectionLink || '',
      floorInfo: expanded.slug ? await resolveOpenSeaFloor(expanded.slug) : createPriceInfo({ state: 'unknown', reason: 'No marketplace floor could be verified yet', source: 'resolver', updatedAt: new Date().toISOString(), chain: expanded.chain || 'ethereum' })
    };
  }

  const mintInfo = await resolveMintInfo({ ...expanded, ...collection }, config);
  const floorInfo = collection.floorInfo?.state === 'unknown' && collection.slug
    ? await resolveOpenSeaFloor(collection.slug)
    : collection.floorInfo;

  return {
    name: collection.name || expanded.name || expanded.sourceTitle || 'unknown',
    contract: collection.contract || expanded.contract || null,
    slug: collection.slug || expanded.slug || null,
    chain: collection.chain || expanded.chain || 'ethereum',
    sourceLink: expanded.sourceLink || String(inputOrReference || ''),
    collectionLink: collection.collectionLink || expanded.collectionLink || '',
    floorInfo,
    mintInfo
  };
}

async function getUsdQuote(chainKey, state, config) {
  const chain = getChainConfig(chainKey) || CHAIN_CONFIG.ethereum;
  const cached = state.quotes[chain.key];
  if (cached?.usdRate && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < config.priceCacheMs) {
    return cached;
  }
  const now = new Date().toISOString();
  const sources = [
    async () => {
      const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(chain.coingeckoId)}&vs_currencies=usd`, {}, 7000);
      const usdRate = toFiniteNumber(data?.[chain.coingeckoId]?.usd);
      if (usdRate == null) throw new Error('CoinGecko returned no USD quote');
      return { usdRate, source: 'CoinGecko', fetchedAt: now };
    },
    async () => {
      const data = await fetchJson(`https://api.coincap.io/v2/assets/${encodeURIComponent(chain.coincapId)}`, {}, 7000);
      const usdRate = toFiniteNumber(data?.data?.priceUsd);
      if (usdRate == null) throw new Error('CoinCap returned no USD quote');
      return { usdRate, source: 'CoinCap', fetchedAt: now };
    }
  ];
  for (const source of sources) {
    try {
      const quote = await source();
      state.quotes[chain.key] = quote;
      return quote;
    } catch {
      continue;
    }
  }
  if (state.browser.ethPrice && chain.nativeSymbol === 'ETH') {
    state.quotes[chain.key] = { usdRate: state.browser.ethPrice, source: 'browser bridge', fetchedAt: state.browser.lastSeenAt || now };
    return state.quotes[chain.key];
  }
  state.quotes[chain.key] = { usdRate: null, source: 'unavailable', fetchedAt: now };
  return state.quotes[chain.key];
}

function quoteMapFromState(state) {
  return Object.fromEntries(Object.entries(state.quotes).map(([key, value]) => [key, value]));
}

export function buildResolutionMessage(input, reason) {
  return [
    `Watch rejected`,
    `Input: ${input}`,
    `Reason: ${reason}`,
    'Action: send a mint URL, OpenSea collection URL, contract address, or X post that clearly contains one of those.'
  ].join('\n');
}

function buildWatchCreatedMessage(watch, state) {
  const quotes = quoteMapFromState(state);
  const lines = [buildWatchSummary(watch, quotes)];
  lines.push('');
  if (watch.status === 'waiting_baseline') {
    lines.push('Watch armed but waiting for the first verified floor baseline.');
  } else if (watch.status === 'rejected') {
    lines.push(`Watch rejected: ${watch.lastError}`);
  } else {
    lines.push('Watch armed. Alerts will trigger once per threshold crossing and re-arm after price drops back below that threshold.');
  }
  lines.push('');
  lines.push(buildAutomintPrompt(watch));
  return lines.join('\n');
}

function buildAlertMessage(alert, state) {
  const chain = getChainConfig(alert.chain) || CHAIN_CONFIG.ethereum;
  const quotes = quoteMapFromState(state);
  const floorLine = formatPriceStatus(alert.floorInfo, quotes);
  const mintLine = formatPriceStatus(alert.mintInfo, quotes);
  const baselineLine = formatNativeAmount(alert.baselineValue, chain.nativeSymbol)
    + (state.quotes[chain.key]?.usdRate ? ` (${formatUsdAmount(alert.baselineValue * state.quotes[chain.key].usdRate)})` : '');
  return [
    `🚨 ${alert.name || 'Collection'} hit ${alert.thresholdMultiple.toFixed(2).replace(/\.00$/, '')}x floor`,
    `Contract: ${alert.contract || 'unknown'}`,
    `Chain: ${chain.displayName}`,
    `Mint price: ${mintLine}`,
    `Baseline floor: ${baselineLine}`,
    `Current floor: ${floorLine}`,
    `Current multiple: ${alert.currentMultiple.toFixed(2)}x`,
    `Source: ${alert.floorInfo?.source || 'unknown'}`,
    `Timestamp: ${alert.timestamp}`,
    `Link: ${alert.collectionLink || alert.sourceLink || 'n/a'}`
  ].join('\n');
}

export function buildStatusMessage(state, config) {
  const telegramHealth = state.telegram.lastError
    ? `error (${state.telegram.lastError})`
    : (config.telegramToken ? `ok (${ageText(state.telegram.lastPollOkAt)})` : 'disabled');
  const browserHealth = state.browser.lastSeenAt ? `ok (${ageText(state.browser.lastSeenAt)})` : 'offline';
  const ethQuote = state.quotes.ethereum;
  const priceHealth = ethQuote?.fetchedAt ? `${ethQuote.source} (${ageText(ethQuote.fetchedAt)})` : 'unavailable';
  return [
    'MetaBot control status',
    `Telegram polling: ${telegramHealth}`,
    `Browser bridge: ${browserHealth}`,
    `Browser wallet ready: ${state.browser.walletReady ? 'yes' : 'no'}`,
    `Browser signer ready: ${state.browser.signerReady ? 'yes' : 'no'}`,
    `Browser address: ${state.browser.address || 'unknown'}`,
    `Price feed freshness: ${priceHealth}`,
    `Active watches: ${state.watches.length}`,
    `Last watch check: ${state.lastWatchCheckAt || 'never'}`,
    `Server-side resolution: available`
  ].join('\n');
}

function buildHelpMessage() {
  return [
    'Telegram commands',
    '/status',
    '/help',
    '/watch <mint|collection|contract|x-link> [target=2] [basis=floor|mint] [price=<native>]',
    '/watches',
    '/remove <watch-id|contract|url>',
    '/update <watch-id|contract|url>',
    '/automint <watch-id|url> maxprice=<native> qty=1 target=2 maxgas=80 tip=3',
    '/automint confirm <watch-id>',
    '',
    'Plain pasted URLs are treated like /watch. Default behavior is basis=floor target=2, using the first verified floor as the baseline.'
  ].join('\n');
}

async function sendTelegramMessage(config, chatId, text) {
  if (!config.telegramToken || !chatId) return;
  await fetchJson(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
  }, 15000);
}

async function telegramApi(config, method, body) {
  return fetchJson(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 40000);
}

function isAllowedChat(config, chatId) {
  if (!config.allowedChatIds.length) return true;
  return config.allowedChatIds.includes(String(chatId));
}

async function createOrRefreshWatch(state, config, chatId, input, options = {}) {
  const normalized = normalizeOptions(options);
  const existing = state.watches.find(watch => watch.chatId === chatId && matchesWatchReference(watch, input));
  const snapshot = await resolveWatchSnapshot(existing || input, config);
  if (snapshot.error) {
    return { ok: false, text: buildResolutionMessage(input, snapshot.error) };
  }

  let watch = existing || createWatchRecord({
    chatId,
    input,
    resolved: snapshot,
    options: {
      basis: normalized.basis,
      target: normalized.targetMultiple,
      qty: normalized.quantity,
      price: normalized.manualPrice
    }
  });

  watch.quantity = normalized.quantity;
  watch.targetMultiple = normalized.targetMultiple;
  watch.basis = normalized.basis;
  watch.manualPrice = normalized.manualPrice;
  const applied = applyWatchSnapshot(watch, snapshot, new Date().toISOString());
  watch = applied.watch;

  if (watch.basis === 'mint' && watch.baselineValue == null) {
    return {
      ok: false,
      text: buildResolutionMessage(input, watch.lastError || 'Mint price is not verified yet. Use basis=floor or provide price=<native>.')
    };
  }

  if (existing) {
    const index = state.watches.findIndex(item => item.id === existing.id);
    state.watches[index] = watch;
  } else {
    state.watches.push(watch);
  }
  return { ok: true, watch, text: buildWatchCreatedMessage(watch, state) };
}

async function refreshAllWatches(state, config) {
  const alerts = [];
  for (let index = 0; index < state.watches.length; index += 1) {
    const watch = state.watches[index];
    const snapshot = await resolveWatchSnapshot(watch, config);
    if (snapshot.error) {
      state.watches[index] = {
        ...watch,
        status: 'failed_resolution',
        lastError: snapshot.error,
        lastCheckAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      continue;
    }
    const applied = applyWatchSnapshot(watch, snapshot, new Date().toISOString());
    state.watches[index] = applied.watch;
    if (applied.alert) alerts.push({ chatId: watch.chatId, message: buildAlertMessage(applied.alert, state) });
  }
  state.lastWatchCheckAt = new Date().toISOString();
  return alerts;
}

async function handleAutomintCommand(state, config, chatId, parsed) {
  if (parsed.positional[0] === 'confirm') {
    const watch = state.watches.find(item => item.chatId === chatId && matchesWatchReference(item, parsed.positional[1] || ''));
    if (!watch) return 'No matching watch was found to confirm.';
    if (!watch.autoMint.pending) return 'No pending auto-mint setup exists for that watch.';
    const confirmation = buildAutomintConfirmation(watch, watch.autoMint.pending, state.browser);
    if (!confirmation.canEnable) return confirmation.text;
    watch.autoMint.enabled = true;
    watch.autoMint.settings = { ...watch.autoMint.pending };
    watch.autoMint.pending = null;
    watch.updatedAt = new Date().toISOString();
    return `${confirmation.text}\n\nGuarded auto-mint is now ENABLED for ${watch.id}.`;
  }

  const reference = parsed.input;
  if (!reference) return 'Usage: /automint <watch-id|url> maxprice=<native> qty=1 target=2 maxgas=80 tip=3';
  const watch = state.watches.find(item => item.chatId === chatId && matchesWatchReference(item, reference));
  if (!watch) return 'Create the watch first with /watch or paste the link, then run /automint against that watch.';
  const options = normalizeOptions(parsed.options);
  const settings = {
    maxPrice: options.maxPrice,
    quantity: options.quantity,
    targetMultiple: options.targetMultiple,
    maxGas: options.maxGas,
    tip: options.tip
  };
  watch.autoMint.pending = settings;
  watch.updatedAt = new Date().toISOString();
  return buildAutomintConfirmation(watch, settings, state.browser).text;
}

async function handleTelegramText(state, config, message) {
  const chatId = message.chat?.id;
  const text = message.text || message.caption || '';
  if (!isAllowedChat(config, chatId)) {
    return 'This chat is not allowed to control MetaBot.';
  }

  const parsed = parseTelegramText(text);
  switch (parsed.command) {
    case 'help':
    case 'start':
      return buildHelpMessage();
    case 'status':
      return buildStatusMessage(state, config);
    case 'watch': {
      if (!parsed.input) return 'Usage: /watch <mint|collection|contract|x-link> [target=2] [basis=floor|mint] [price=<native>]';
      const created = await createOrRefreshWatch(state, config, chatId, parsed.input, parsed.options);
      return created.text;
    }
    case 'watches':
      return state.watches.filter(watch => watch.chatId === chatId).length
        ? state.watches.filter(watch => watch.chatId === chatId).map(watch => buildWatchSummary(watch, quoteMapFromState(state))).join('\n\n')
        : 'No active watches.';
    case 'remove': {
      const reference = parsed.input || parsed.positional[0];
      if (!reference) return 'Usage: /remove <watch-id|contract|url>';
      const before = state.watches.length;
      state.watches = state.watches.filter(watch => !(watch.chatId === chatId && matchesWatchReference(watch, reference)));
      return state.watches.length === before ? 'No matching watch found.' : `Removed watch ${reference}.`;
    }
    case 'update': {
      const reference = parsed.input || parsed.positional[0];
      if (!reference) return 'Usage: /update <watch-id|contract|url>';
      const watch = state.watches.find(item => item.chatId === chatId && matchesWatchReference(item, reference));
      if (!watch) return 'No matching watch found.';
      const snapshot = await resolveWatchSnapshot(watch, config);
      if (snapshot.error) {
        watch.status = 'failed_resolution';
        watch.lastError = snapshot.error;
        watch.updatedAt = new Date().toISOString();
        return buildResolutionMessage(reference, snapshot.error);
      }
      const applied = applyWatchSnapshot(watch, snapshot, new Date().toISOString());
      Object.assign(watch, applied.watch);
      return buildWatchSummary(watch, quoteMapFromState(state));
    }
    case 'automint':
      return handleAutomintCommand(state, config, chatId, parsed);
    case null:
    case 'unknown':
      return extractUrls(text).length ? (await createOrRefreshWatch(state, config, chatId, extractUrls(text)[0], {})).text : buildHelpMessage();
    default:
      return buildHelpMessage();
  }
}

async function pollTelegram(state, config) {
  if (!config.telegramToken) return;
  while (true) {
    state.telegram.lastPollAt = new Date().toISOString();
    try {
      const data = await telegramApi(config, 'getUpdates', {
        offset: state.telegram.lastUpdateId + 1,
        timeout: LONG_POLL_TIMEOUT,
        allowed_updates: ['message']
      });
      state.telegram.lastPollOkAt = new Date().toISOString();
      state.telegram.lastError = '';
      for (const update of data.result || []) {
        state.telegram.lastUpdateId = Math.max(state.telegram.lastUpdateId, update.update_id);
        if (!update.message?.text && !update.message?.caption) continue;
        const reply = await handleTelegramText(state, config, update.message);
        if (reply) await sendTelegramMessage(config, update.message.chat.id, reply);
        saveStateToFile(config.statePath, state);
      }
    } catch (error) {
      state.telegram.lastError = error.message;
      saveStateToFile(config.statePath, state);
      await sleep(4000);
    }
  }
}

export async function startControlServer(runtimeConfig = buildRuntimeConfig()) {
  const config = runtimeConfig;
  const state = loadStateFromFile(config.statePath);
  await getUsdQuote('ethereum', state, config);
  saveStateToFile(config.statePath, state);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
        jsonResponse(res, 200, { ok: true, status: buildStatusMessage(state, config) });
        return;
      }
      if (req.method === 'POST' && req.url === '/bridge/heartbeat') {
        const body = await readJsonBody(req);
        state.browser = {
          ...state.browser,
          lastSeenAt: new Date().toISOString(),
          walletReady: Boolean(body.walletReady),
          signerReady: Boolean(body.signerReady),
          address: typeof body.address === 'string' ? body.address : state.browser.address,
          activeCollection: body.activeCollection || state.browser.activeCollection,
          ethPrice: toFiniteNumber(body.ethPrice),
          gasPrice: toFiniteNumber(body.gasPrice)
        };
        if (state.browser.ethPrice) {
          state.quotes.ethereum = {
            usdRate: state.browser.ethPrice,
            source: 'browser bridge',
            fetchedAt: state.browser.lastSeenAt
          };
        }
        saveStateToFile(config.statePath, state);
        jsonResponse(res, 200, { ok: true });
        return;
      }
      jsonResponse(res, 404, { ok: false, error: 'Not found' });
    } catch (error) {
      jsonResponse(res, 500, { ok: false, error: error.message });
    }
  });

  server.listen(config.port, '127.0.0.1', () => {
    log(config, `Listening on http://127.0.0.1:${config.port}`);
    log(config, `State file ${config.statePath}`);
    if (!config.telegramToken) log(config, 'Telegram polling disabled (set TELEGRAM_BOT_TOKEN to enable)');
  });

  setInterval(async () => {
    try {
      await getUsdQuote('ethereum', state, config);
      const alerts = await refreshAllWatches(state, config);
      for (const alert of alerts) {
        await sendTelegramMessage(config, alert.chatId, alert.message);
      }
      saveStateToFile(config.statePath, state);
    } catch (error) {
      if (config.verbose) log(config, 'Watch refresh failed', error.message);
    }
  }, config.pollMs);

  void pollTelegram(state, config);
  return { server, state, config };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startControlServer().catch(error => {
    console.error('[control-server] Fatal:', error);
    process.exitCode = 1;
  });
}
