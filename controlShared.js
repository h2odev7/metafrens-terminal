export const DEFAULT_TARGET_MULTIPLE = 2;
const PRICE_COMPARISON_TOLERANCE = 1e-12;

export const CHAIN_CONFIG = {
  ethereum: {
    key: 'ethereum',
    displayName: 'Ethereum',
    nativeSymbol: 'ETH',
    coingeckoId: 'ethereum',
    coincapId: 'ethereum'
  },
  base: {
    key: 'base',
    displayName: 'Base',
    nativeSymbol: 'ETH',
    coingeckoId: 'ethereum',
    coincapId: 'ethereum'
  },
  arbitrum: {
    key: 'arbitrum',
    displayName: 'Arbitrum',
    nativeSymbol: 'ETH',
    coingeckoId: 'ethereum',
    coincapId: 'ethereum'
  },
  optimism: {
    key: 'optimism',
    displayName: 'Optimism',
    nativeSymbol: 'ETH',
    coingeckoId: 'ethereum',
    coincapId: 'ethereum'
  },
  polygon: {
    key: 'polygon',
    displayName: 'Polygon',
    nativeSymbol: 'MATIC',
    coingeckoId: 'matic-network',
    coincapId: 'polygon'
  }
};

export function getChainConfig(chain) {
  if (!chain) return CHAIN_CONFIG.ethereum;
  const key = String(chain).trim().toLowerCase();
  return CHAIN_CONFIG[key] || null;
}

export function toFiniteNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function formatUsdAmount(value) {
  const num = toFiniteNumber(value);
  if (num == null) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: num >= 1000 ? 0 : 2,
    maximumFractionDigits: num >= 1000 ? 0 : 2
  }).format(num);
}

export function formatNativeAmount(value, symbol = 'ETH') {
  const num = toFiniteNumber(value);
  if (num == null) return null;
  let decimals = 4;
  if (num === 0) decimals = 0;
  else if (num >= 100) decimals = 2;
  else if (num >= 1) decimals = 3;
  else if (num < 0.001) decimals = 6;
  return `${num.toFixed(decimals).replace(/\.?0+$/, '')} ${symbol}`;
}

export function formatNativeUsd(value, { symbol = 'ETH', usdRate = null } = {}) {
  const native = formatNativeAmount(value, symbol);
  if (!native) return null;
  const rate = toFiniteNumber(usdRate);
  if (rate == null) return native;
  const usd = formatUsdAmount(toFiniteNumber(value) * rate);
  return usd ? `${native} (${usd})` : native;
}

export function createPriceInfo({ state = 'unknown', value = null, reason = '', source = '', updatedAt = null, chain = 'ethereum' } = {}) {
  return {
    state,
    value: toFiniteNumber(value),
    reason: reason || '',
    source: source || '',
    updatedAt: updatedAt || null,
    chain: chain || 'ethereum'
  };
}

export function formatPriceStatus(priceInfo, quoteByChain = {}) {
  const info = priceInfo || createPriceInfo();
  const chain = getChainConfig(info.chain) || CHAIN_CONFIG.ethereum;
  if (info.state === 'free') return 'FREE';
  if (info.state !== 'known' || info.value == null) {
    return info.reason ? `unknown (${info.reason})` : 'unknown';
  }
  const quote = quoteByChain[chain.key] || {};
  return formatNativeUsd(info.value, { symbol: chain.nativeSymbol, usdRate: quote.usdRate ?? null });
}

export function extractUrls(text = '') {
  return String(text)
    .match(/https?:\/\/[^\s<>]+/gi)
    ?.map(cleanUrlToken)
    .filter(Boolean) || [];
}

export function cleanUrlToken(value = '') {
  return String(value).trim().replace(/[)>.,!]+$/g, '');
}

export function parseOptionTokens(tokens = []) {
  const options = {};
  const positional = [];
  for (const token of tokens) {
    const trimmed = String(token).trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim().toLowerCase();
      const value = trimmed.slice(eq + 1).trim();
      options[key] = value;
    } else {
      positional.push(trimmed);
    }
  }
  return { options, positional };
}

export function parseTelegramText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'empty', command: null, input: '', options: {}, positional: [] };

  const urls = extractUrls(raw);
  if (!raw.startsWith('/') && urls.length) {
    return {
      kind: 'watch',
      command: 'watch',
      input: urls[0],
      options: {},
      positional: [urls[0]],
      isPlainUrl: true
    };
  }

  const parts = raw.split(/\s+/);
  const head = (parts.shift() || '').toLowerCase();
  const command = head.replace(/^\//, '').split('@')[0];
  const { options, positional } = parseOptionTokens(parts);
  const aliases = {
    rm: 'remove',
    del: 'remove',
    delete: 'remove',
    unwatch: 'remove',
    stop: 'remove',
    ls: 'watches',
    list: 'watches',
    refresh: 'update'
  };
  const normalized = aliases[command] || command;
  const input = positional[0] || urls[0] || '';
  return {
    kind: normalized || 'unknown',
    command: normalized || null,
    input,
    options,
    positional,
    isPlainUrl: false
  };
}

export function normalizeOptions(options = {}) {
  const basis = String(options.basis || 'floor').trim().toLowerCase() === 'mint' ? 'mint' : 'floor';
  const targetMultiple = Math.max(DEFAULT_TARGET_MULTIPLE, toFiniteNumber(options.target) || DEFAULT_TARGET_MULTIPLE);
  const quantity = Math.max(1, Math.floor(toFiniteNumber(options.qty) || 1));
  const manualPrice = toFiniteNumber(options.price);
  const maxPrice = toFiniteNumber(options.maxprice);
  const maxGas = toFiniteNumber(options.maxgas);
  const tip = toFiniteNumber(options.tip);
  return { basis, targetMultiple, quantity, manualPrice, maxPrice, maxGas, tip };
}

export function createWatchRecord({ id, chatId, input, resolved = {}, options = {}, now = new Date().toISOString() } = {}) {
  const normalized = normalizeOptions(options);
  return {
    id: id || `watch_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`,
    chatId: chatId ?? null,
    input: input || resolved.sourceLink || resolved.collectionLink || resolved.contract || '',
    sourceLink: resolved.sourceLink || input || '',
    collectionLink: resolved.collectionLink || '',
    contract: resolved.contract || null,
    slug: resolved.slug || null,
    chain: resolved.chain || 'ethereum',
    name: resolved.name || 'unknown',
    basis: normalized.basis,
    targetMultiple: normalized.targetMultiple,
    quantity: normalized.quantity,
    manualPrice: normalized.manualPrice,
    status: 'waiting_baseline',
    baselineValue: null,
    baselineAt: null,
    baselineSource: normalized.basis,
    mintInfo: resolved.mintInfo || createPriceInfo({ chain: resolved.chain || 'ethereum' }),
    floorInfo: resolved.floorInfo || createPriceInfo({ chain: resolved.chain || 'ethereum' }),
    currentMultiple: null,
    lastCheckAt: null,
    lastError: '',
    notifiedLevels: [],
    autoMint: {
      enabled: false,
      pending: null,
      settings: null
    },
    createdAt: now,
    updatedAt: now
  };
}

export function matchesWatchReference(watch, reference) {
  const ref = String(reference || '').trim().toLowerCase();
  if (!ref) return false;
  const candidates = [watch.id, watch.contract, watch.sourceLink, watch.collectionLink, watch.input]
    .filter(Boolean)
    .map(value => String(value).toLowerCase());
  return candidates.some(value => value === ref || value.includes(ref));
}

function cloneWatch(watch) {
  return JSON.parse(JSON.stringify(watch));
}

export function applyWatchSnapshot(watch, snapshot = {}, now = new Date().toISOString()) {
  const next = cloneWatch(watch);
  next.updatedAt = now;
  next.lastCheckAt = now;
  next.lastError = snapshot.error || '';
  next.name = snapshot.name || next.name;
  next.contract = snapshot.contract || next.contract;
  next.slug = snapshot.slug || next.slug;
  next.collectionLink = snapshot.collectionLink || next.collectionLink;
  next.sourceLink = snapshot.sourceLink || next.sourceLink;
  next.chain = snapshot.chain || next.chain;
  next.mintInfo = snapshot.mintInfo || next.mintInfo;
  next.floorInfo = snapshot.floorInfo || next.floorInfo;

  const basisInfo = next.basis === 'mint'
    ? (next.manualPrice != null
      ? createPriceInfo({ state: 'known', value: next.manualPrice, source: 'manual override', updatedAt: now, chain: next.chain })
      : next.mintInfo)
    : next.floorInfo;

  if (next.basis === 'mint' && next.manualPrice == null) {
    if (basisInfo.state === 'free') {
      next.status = 'rejected';
      next.lastError = 'Mint basis cannot use FREE as a 2x baseline. Provide price=<native> or use basis=floor.';
      return { watch: next, alert: null, stateChanged: true };
    }
    if (basisInfo.state !== 'known' || basisInfo.value == null || basisInfo.value <= 0) {
      next.status = 'waiting_baseline';
      return { watch: next, alert: null, stateChanged: true };
    }
  }

  if (next.baselineValue == null) {
    if (basisInfo.state === 'known' && basisInfo.value != null && basisInfo.value > 0) {
      next.baselineValue = basisInfo.value;
      next.baselineAt = now;
      next.status = 'armed';
    } else {
      next.status = 'waiting_baseline';
      return { watch: next, alert: null, stateChanged: true };
    }
  }

  if (next.floorInfo.state !== 'known' || next.floorInfo.value == null || next.floorInfo.value <= 0) {
    next.currentMultiple = null;
    next.status = 'armed';
    return { watch: next, alert: null, stateChanged: true };
  }

  next.currentMultiple = next.baselineValue > 0 ? next.floorInfo.value / next.baselineValue : null;
  next.status = 'armed';

  if (!next.currentMultiple || next.currentMultiple < next.targetMultiple) {
    next.notifiedLevels = next.notifiedLevels.filter(level => next.currentMultiple && level * next.targetMultiple <= next.currentMultiple + PRICE_COMPARISON_TOLERANCE);
    return { watch: next, alert: null, stateChanged: true };
  }

  const crossedLevel = Math.floor((next.currentMultiple + PRICE_COMPARISON_TOLERANCE) / next.targetMultiple);
  next.notifiedLevels = next.notifiedLevels.filter(level => level <= crossedLevel);
  let alert = null;
  if (crossedLevel > 0 && !next.notifiedLevels.includes(crossedLevel)) {
    next.notifiedLevels = Array.from(new Set([...next.notifiedLevels, crossedLevel])).sort((a, b) => a - b);
    alert = {
      level: crossedLevel,
      thresholdMultiple: crossedLevel * next.targetMultiple,
      currentMultiple: next.currentMultiple,
      floorInfo: next.floorInfo,
      mintInfo: next.mintInfo,
      baselineValue: next.baselineValue,
      baselineAt: next.baselineAt,
      chain: next.chain,
      contract: next.contract,
      name: next.name,
      sourceLink: next.sourceLink,
      collectionLink: next.collectionLink,
      timestamp: now
    };
  }
  return { watch: next, alert, stateChanged: true };
}

export function buildWatchLabel(watch) {
  const contract = watch.contract ? `${watch.contract.slice(0, 8)}…${watch.contract.slice(-4)}` : 'unknown';
  return `${watch.id} · ${watch.name || 'unknown'} · ${contract}`;
}

export function buildWatchSummary(watch, quoteByChain = {}) {
  const chain = getChainConfig(watch.chain) || CHAIN_CONFIG.ethereum;
  const floor = formatPriceStatus(watch.floorInfo, quoteByChain);
  const mint = formatPriceStatus(watch.manualPrice != null
    ? createPriceInfo({ state: 'known', value: watch.manualPrice, source: 'manual override', chain: watch.chain })
    : watch.mintInfo, quoteByChain);
  const baseline = watch.baselineValue != null
    ? formatNativeUsd(watch.baselineValue, {
      symbol: chain.nativeSymbol,
      usdRate: quoteByChain[chain.key]?.usdRate ?? null
    })
    : 'waiting for baseline';
  const multiple = watch.currentMultiple != null ? `${watch.currentMultiple.toFixed(2)}x` : 'n/a';
  return [
    `Watch ${watch.id}`,
    `Name: ${watch.name || 'unknown'}`,
    `Contract: ${watch.contract || 'unknown'}`,
    `Chain: ${chain.displayName}`,
    `Basis: ${watch.basis}`,
    `Target: ${watch.targetMultiple}x`,
    `Mint price: ${mint}`,
    `Floor: ${floor}`,
    `Baseline: ${baseline}`,
    `Current multiple: ${multiple}`,
    `Status: ${watch.status}`,
    `Last check: ${watch.lastCheckAt || 'never'}`
  ].join('\n');
}

export function buildAutomintPrompt(watch) {
  return [
    `Auto-mint is OFF for ${watch.name || watch.id}.`,
    'To prepare a guarded setup, send:',
    `/automint ${watch.id} maxprice=<native> qty=1 target=${watch.targetMultiple} maxgas=80 tip=3`,
    'Nothing is enabled until you explicitly confirm it.'
  ].join('\n');
}

export function buildAutomintConfirmation(watch, settings = {}, browserState = {}) {
  const chain = getChainConfig(watch.chain) || CHAIN_CONFIG.ethereum;
  const risks = [];
  if (watch.mintInfo?.state !== 'known') risks.push('Verified mint price is unknown; max-price checks cannot be enforced safely.');
  if (!watch.contract) risks.push('Contract is unresolved.');
  if (!browserState.walletReady) risks.push('Browser bridge has not reported a ready wallet.');
  if (!browserState.signerReady) risks.push('Browser bridge has not reported signer readiness.');
  const maxPrice = toFiniteNumber(settings.maxPrice);
  if (maxPrice != null && watch.mintInfo?.state === 'known' && watch.mintInfo.value > maxPrice + 1e-12) {
    risks.push(`Configured max price ${formatNativeAmount(maxPrice, chain.nativeSymbol)} is below verified mint price ${formatNativeAmount(watch.mintInfo.value, chain.nativeSymbol)}.`);
  }
  const totalMaxSpend = maxPrice != null ? maxPrice * Math.max(1, settings.quantity || 1) : null;
  return {
    canEnable: risks.length === 0,
    risks,
    text: [
      `Auto-mint confirmation for ${watch.name || watch.id}`,
      `Contract/chain: ${watch.contract || 'unknown'} · ${chain.displayName}`,
      `Quantity: ${Math.max(1, settings.quantity || 1)}`,
      `Max price: ${maxPrice != null ? formatNativeAmount(maxPrice, chain.nativeSymbol) : 'not set'}`,
      `Target: ${settings.targetMultiple || watch.targetMultiple}x`,
      `Max gas / tip: ${settings.maxGas != null ? `${settings.maxGas} gwei` : 'auto'} / ${settings.tip != null ? `${settings.tip} gwei` : 'auto'}`,
      `Wallet ready: ${browserState.walletReady ? 'yes' : 'no'}`,
      `Signer ready: ${browserState.signerReady ? 'yes' : 'no'}`,
      `Maximum spend: ${totalMaxSpend != null ? formatNativeAmount(totalMaxSpend, chain.nativeSymbol) : 'unknown'}`,
      risks.length ? `Unresolved risks: ${risks.join(' ')}` : 'Unresolved risks: none',
      risks.length ? 'Auto-mint remains OFF.' : `Reply with /automint confirm ${watch.id} to enable guarded auto-mint.`
    ].join('\n')
  };
}
