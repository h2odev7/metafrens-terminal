/**
 * app.js - UI logic only
 * Handles: wallet, prices, URL parsing, collection fetching,
 * task queue, sniper, theme toggle
 */

'use strict';

const OPENSEA_API_KEY = '5ba47a8af05f4082a613832c2dc30bcc';
const OPENSEA_HEADERS = { 'Accept': 'application/json', 'x-api-key': OPENSEA_API_KEY };

import { executeMint, executeMintWithRetry, executeMultiWalletMint, executeWithGasRetry, startSniper, checkSaleStatus, detectPrice, getDynamicGas, createPrivateKeySigner, getPrivateKeyAddress } from './mintEngine.js';

const $ = id => document.getElementById(id);

const RPC_URL = 'https://ethereum.publicnode.com';

const S = {
  provider:  null,
  wallets:   [],   // [{ signer, address, qty }]
  gasMode:   'normal',  // normal | aggressive | war
  ethPrice: 0, gasPrice: 0,
  tasks: [], mode: 'manual', pending: null,
  // convenience getters
  get signer()    { return this.wallets[0]?.signer  || null; },
  get addr()      { return this.wallets[0]?.address || null; },
  get signers()   { return this.wallets.map(w => w.signer); },
  get addresses() { return this.wallets.map(w => w.address); },
};

const COL = {
  contract: null, name: '', price: 0,
  supply: 0, minted: 0, slug: '', platform: '',
  phases: [], soldOut: false
};

let _prevEth = 0;

async function loadPrices() {
  try {
    const c = JSON.parse(localStorage.getItem('mb_p') || '{}');
    if (c.eth) _setEth(c.eth);
  } catch(e) {}
  try {
    const r = await Promise.race([
      fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'),
      new Promise((_, rej) => setTimeout(rej, 5000))
    ]);
    const d = await r.json();
    _setEth(d.ethereum.usd);
    localStorage.setItem('mb_p', JSON.stringify({ eth: d.ethereum.usd }));
  } catch(e) {
    try {
      const r = await fetch('https://api.coincap.io/v2/assets/ethereum');
      const d = await r.json();
      _setEth(parseFloat(d.data.priceUsd));
    } catch(e2) {}
  }
}

function _setEth(p) {
  const el = $('ethP');
  if (!el || !p) return;
  const up = p > _prevEth;
  el.textContent = '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (_prevEth && p !== _prevEth) {
    el.className = 'tb-v ' + (up ? 'up' : 'down');
    setTimeout(() => el.className = 'tb-v', 700);
  }
  _prevEth = p;
  S.ethPrice = p;
}

async function loadGas() {
  const rpcs = [
    'https://ethereum.publicnode.com',
    'https://rpc.ankr.com/eth',
    'https://cloudflare-eth.com'
  ];

  for (const url of rpcs) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 })
      });
      const d = await r.json();
      if (d.result) {
        const g = parseInt(d.result, 16) / 1e9;
        S.gasPrice = g;
        $('gasP').textContent = g >= 10 ? Math.round(g) : g.toFixed(1).replace(/\.0$/, '');
        return;
      }
    } catch(e) {}
  }
  $('gasP').textContent = '--';
}

function log(msg, t = '') {
  const d = document.createElement('div');
  d.className = 'le ' + t;
  d.innerHTML = '<span class="ts">[' + new Date().toLocaleTimeString('en-US', { hour12: false }) + ']</span>' + msg;
  const l = $('botLog');
  l.insertBefore(d, l.firstChild);
  while (l.children.length > 80) l.removeChild(l.lastChild);
}

function setStatus(msg, t = '') {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg ' + t;
}

window.connectWallet = async function({ forcePicker = false } = {}) {
  if (!window.ethereum) { alert('Install MetaMask'); return; }
  try {
    if (forcePicker && window.ethereum.request) {
      try {
        await window.ethereum.request({
          method: 'wallet_requestPermissions',
          params: [{ eth_accounts: {} }]
        });
      } catch(e) {
        if (e.code === 4001) throw e;
      }
    }

    S.provider = new ethers.providers.Web3Provider(window.ethereum);
    await S.provider.send('eth_requestAccounts', []);
    const _mmSigner = S.provider.getSigner();
    const _mmAddr   = await _mmSigner.getAddress();
    // MetaMask = wallet #1
    S.wallets = [{ signer: _mmSigner, address: _mmAddr, qty: 1 }];
    setWalletConnected(_mmAddr);
    if ($('mAddr')) $('mAddr').value = _mmAddr;
    renderWallets();
    log('Connected: ' + _mmAddr, 'ok');
    setStatus('Wallet connected.', 'ok');
  } catch(e) {
    log('Wallet error: ' + (e.message || e), 'err');
    setStatus(e.code === 4001 ? 'Wallet connection cancelled.' : 'Wallet connection failed.', 'err');
  }
};

function setWalletConnected(addr) {
  const btn = $('walletBtn');
  if (!btn) return;
  btn.textContent = addr.slice(0, 6) + '...' + addr.slice(-4);
  btn.classList.add('connected');
  btn.disabled = false;
  btn.title = 'Click to choose a different MetaMask account';
  btn.onclick = () => window.connectWallet({ forcePicker: true });
  if ($('disconnectBtn')) $('disconnectBtn').hidden = false;
}

window.disconnectWallet = async function() {
  try {
    await window.ethereum?.request?.({
      method: 'wallet_revokePermissions',
      params: [{ eth_accounts: {} }]
    });
  } catch(e) {}

  S.provider = null;
  S.wallets  = [];
  const btn = $('walletBtn');
  if (btn) {
    btn.textContent = 'Connect Wallet';
    btn.classList.remove('connected');
    btn.disabled = false;
    btn.title = '';
    btn.onclick = () => window.connectWallet();
  }
  if ($('disconnectBtn')) $('disconnectBtn').hidden = true;
  if ($('mAddr')) $('mAddr').value = '';
  setStatus('Wallet disconnected. Click Connect Wallet to choose an account.', 'ok');
  log('Wallet disconnected', 'info');
};

if (window.ethereum) {
  window.ethereum.on?.('accountsChanged', accounts => {
    if (accounts?.length) {
      S.provider = new ethers.providers.Web3Provider(window.ethereum);
      const _sw  = S.provider.getSigner();
      const _sa  = accounts[0];
      // Replace slot 0 (MetaMask), keep PK wallets
      if (S.wallets.length > 0) {
        S.wallets[0] = { signer: _sw, address: _sa, qty: S.wallets[0]?.qty || 1 };
      } else {
        S.wallets = [{ signer: _sw, address: _sa, qty: 1 }];
      }
      setWalletConnected(_sa);
      if ($('mAddr')) $('mAddr').value = _sa;
      renderWallets();
      log('Wallet switched: ' + _sa, 'info');
    } else {
      window.disconnectWallet();
    }
  });
}

async function ensureSignerMatches(addr) {
  if (!S.wallets.length) {
    await window.connectWallet();
  }
  if (!S.wallets.length) return false;

  const signerAddr = S.wallets[0].address.toLowerCase();
  if (addr && addr.toLowerCase() !== signerAddr) {
    setStatus('MetaMask is connected to a different account. Click the connected wallet button to switch accounts.', 'err');
    log('Wallet mismatch: field has ' + addr + ', MetaMask has ' + signerAddr, 'warn');
    return false;
  }
  if ($('mAddr')) $('mAddr').value = S.wallets[0].address;
  return true;
}

function parseUrl(raw) {
  raw = raw.trim();
  raw = raw.replace(/\/(overview|items|activity|offers|analytics|traits|holders|mint)(\?.*)?$/, '');
  if (raw.match(/^0x[a-fA-F0-9]{40}$/)) return { type: 'contract', value: raw, platform: 'direct' };

  const maps = [
    [/opensea\.io\/collection\/([^/?#\s]+)/, 'opensea', 'slug'],
    [/opensea\.io\/assets\/ethereum\/(0x[a-fA-F0-9]{40})/, 'opensea', 'contract'],
    [/zora\.co\/collect\/(?:zora|eth):(0x[a-fA-F0-9]{40})/, 'zora', 'contract'],
    [/mint\.fun\/(0x[a-fA-F0-9]{40})/, 'mintfun', 'contract'],
    [/foundation\.app\/@[^/]+\/([^/?#\s]+)/, 'foundation', 'slug'],
    [/app\.manifold\.xyz\/c\/([^/?#\s]+)/, 'manifold', 'slug'],
    [/manifold\.gallery\/collection\/([^/?#\s]+)/, 'manifold', 'slug'],
    [/nft\.coinbase\.com\/collection\/ethereum\/(0x[a-fA-F0-9]{40})/, 'coinbase', 'contract'],
    [/rarible\.com\/collection\/(0x[a-fA-F0-9]{40})/, 'rarible', 'contract'],
  ];

  for (const [re, platform, type] of maps) {
    const m = raw.match(re);
    if (m) return { type, value: m[1], platform };
  }

  if (raw.length > 5 && !raw.includes(' ')) return { type: 'slug', value: raw, platform: 'opensea' };
  return null;
}

$('fetchBtn').addEventListener('click', fetchCollection);
$('urlIn').addEventListener('keydown', e => { if (e.key === 'Enter') fetchCollection(); });

async function fetchWithTimeout(url, options = {}, timeoutMs = 6500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithFallback(url, { parse = 'json', timeoutMs = 6500, direct = true, headers = {} } = {}) {
  const proxies = [
    ...(direct ? [''] : []),
    'https://corsproxy.io/?url=',
    'https://api.allorigins.win/raw?url='
  ];
  let lastError = null;
  for (const p of proxies) {
    try {
      const r = await fetchWithTimeout(p ? p + encodeURIComponent(url) : url, { headers }, timeoutMs);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return parse === 'text' ? await r.text() : await r.json();
    } catch(e) {
      lastError = e;
    }
  }
  throw new Error(lastError?.name === 'AbortError' ? 'request timed out' : (lastError?.message || 'Failed to fetch'));
}

/* ── Reservoir — primary source, has images + supply + floor ── */
async function resolveReservoirSlug(slug) {
  for (const ver of ['v7', 'v6']) {
    try {
      const url = 'https://api.reservoir.tools/collections/' + ver + '?slug=' + encodeURIComponent(slug);
      const d = await fetchWithFallback(url, { timeoutMs: 6000 });
      const col = d.collections?.[0];
      if (!col) continue;
      const rawName = (col.name || 'Collection').replace(/\s+\d+\.?\d*\s*(ETH|eth|Ξ)/g, '').trim();
      return {
        contract:   col.primaryContract || col.contract || null,
        name:       rawName || 'Collection',
        image:      col.image || '',
        banner:     col.bannerImageUrl || col.banner || col.image || '',
        floor:      col.floorAsk?.price?.amount?.native || col.floorAsk?.price?.amount?.decimal || 0,
        supply:     parseInt(col.tokenCount) || 0,
        minted:     parseInt(col.mintedCount) || 0,
        twitterUrl: col.twitterUsername ? 'https://x.com/' + col.twitterUsername : '',
        osUrl:      'https://opensea.io/collection/' + slug,
        source:     'Reservoir'
      };
    } catch(e) {}
  }
  return null;
}

/* ── OpenSea API — secondary, fetches stats for accurate supply ── */
async function resolveOpenSeaSlug(slug) {
  // 1. Try Reservoir first — best images + supply data
  try {
    setStatus('Fetching collection data...');
    const res = await resolveReservoirSlug(slug);
    if (res?.contract) {
      log('Resolved via Reservoir', 'ok');
      return res;
    }
  } catch(e) {
    log('Reservoir failed: ' + e.message, 'warn');
  }

  // 2. OpenSea API with CORS proxies
  try {
    setStatus('Trying OpenSea API...');
    const d = await fetchWithFallback('https://api.opensea.io/api/v2/collections/' + slug, { timeoutMs: 6000, headers: OPENSEA_HEADERS });
    if (d?.contracts?.length || d?.name) {
      const collectionId = d.collection || slug;
      let floor = 0, minted = 0;
      // Fetch stats for real supply numbers
      try {
        const sd = await fetchWithFallback('https://api.opensea.io/api/v2/collections/' + collectionId + '/stats', { timeoutMs: 5000, headers: OPENSEA_HEADERS });
        if (sd?.total) { floor = sd.total.floor_price || 0; minted = sd.total.count || 0; }
      } catch(e) {}
      const rawName = (d.name || 'Collection').replace(/\s+\d+\.?\d*\s*(ETH|eth|Ξ)/g, '').trim();
      return {
        contract:   d.contracts?.[0]?.address || null,
        name:       rawName || 'Collection',
        image:      d.image_url || '',
        banner:     d.banner_image_url || d.image_url || '',
        twitterUrl: d.twitter_username ? 'https://x.com/' + d.twitter_username : '',
        osUrl:      'https://opensea.io/collection/' + collectionId,
        supply:     d.total_supply ? parseInt(d.total_supply) : 0,
        minted:     minted,
        floor:      floor,
        source:     'OpenSea'
      };
    }
  } catch(e) {
    log('OpenSea API failed: ' + e.message, 'warn');
  }

  // 3. Jina page mirror — last resort, contract only, no images
  try {
    setStatus('Scanning page mirror...');
    const page = await fetchWithFallback('https://r.jina.ai/https://opensea.io/collection/' + slug, {
      parse: 'text', timeoutMs: 9000, direct: true
    });
    const match = [...(page.matchAll(/0x[a-fA-F0-9]{40}/g))];
    const contract = match[0]?.[0] || null;
    if (contract) {
      const title = page.match(/^Title:\s*(.+)$/m)?.[1]?.replace(/ - Collection \| OpenSea$/, '').replace(/\s+\d+\.?\d*\s*(ETH|eth|Ξ)/g, '').trim() || 'Collection';
      log('Contract found via page mirror — no images available', 'warn');
      return {
        contract, name: title, image: '', banner: '', twitterUrl: '',
        osUrl: 'https://opensea.io/collection/' + slug,
        supply: 0, minted: 0, floor: 0, source: 'page mirror'
      };
    }
  } catch(e) {
    log('Page mirror failed: ' + e.message, 'warn');
  }

  return null;
}

async function fetchCollection() {
  const raw = $('urlIn').value.trim();
  if (!raw) { setStatus('Paste a mint link or contract.', 'err'); return; }

  const parsed = parseUrl(raw);
  if (!parsed) { setStatus('Invalid link - try pasting the 0x address directly.', 'err'); return; }

  setStatus('Resolving ETH collection...');
  log('Resolving: ' + parsed.value);
  $('colCard').classList.remove('show');

  let contract = null, name = 'Collection';
  let image = '', banner = '', twitterUrl = '', osUrl = '';
  let supply = 0, minted = 0, floor = 0;

  try {
    if (parsed.type === 'contract') contract = parsed.value;

    if (!contract && parsed.type === 'slug') {
      const d = await resolveOpenSeaSlug(parsed.value);
      if (d?.contract) {
        contract = d.contract;
        name = d.name || name;
        image = d.image || '';
        banner = d.banner || image;
        floor = d.floor || 0;
        supply = d.supply || 0;
        minted = d.minted || 0;
        twitterUrl = d.twitterUrl || '';
        osUrl = d.osUrl || 'https://opensea.io/collection/' + parsed.value;
        log('Resolved via ' + (d.source || 'OpenSea'), 'ok');
      }
    }

    if (!contract && parsed.type === 'slug') {
      try {
        const d = await resolveReservoirSlug(parsed.value);
        if (d?.contract) {
          contract = d.contract;
          name = d.name || name;
          image = d.image || '';
          banner = d.banner || image;
          floor = d.floor || 0;
          supply = d.supply || 0;
          minted = d.minted || 0;
          twitterUrl = d.twitterUrl || '';
          osUrl = d.osUrl || 'https://opensea.io/collection/' + parsed.value;
          log('Resolved via Reservoir fallback', 'ok');
        }
      } catch(e) { log('Reservoir fallback failed: ' + e.message, 'warn'); }
    }

    if (!contract?.match(/^0x[a-fA-F0-9]{40}$/)) {
      setStatus('Could not resolve this OpenSea collection automatically. Paste the 0x ETH contract address instead.', 'err');
      return;
    }

    // On-chain reads — only override API data if chain returns higher values
    const apiMinted = minted;
    const apiSupply = supply;
    try {
      const provider = window.ethereum
        ? new ethers.providers.Web3Provider(window.ethereum)
        : new ethers.providers.JsonRpcProvider('https://ethereum.publicnode.com');
      const abi = [
        'function name() view returns (string)',
        'function totalSupply() view returns (uint256)',
        'function maxSupply() view returns (uint256)',
      ];
      const con = new ethers.Contract(contract, abi, provider);
      try { const n = await con.name(); if (n && n.length > 0) name = n; } catch(e) {}
      try {
        const ts = (await con.totalSupply()).toNumber();
        // Only use on-chain value if it's credible (> 0 and close to API value)
        if (ts > 0) minted = ts;
      } catch(e) {}
      try {
        const ms = (await con.maxSupply()).toNumber();
        if (ms > 0) supply = ms;
      } catch(e) {}
    } catch(e) {}

    // If on-chain returned 0 but API had real data, trust the API
    if (minted === 0 && apiMinted > 0) minted = apiMinted;
    if (supply === 0 && apiSupply > 0) supply = apiSupply;

    COL.minted = minted > 0 ? minted : 0;
    COL.supply = supply > 0 ? supply : 0;
    COL.contract = contract;
    COL.name = name;
    COL.price = floor;
    COL.slug = parsed.value;
    COL.platform = parsed.type === 'slug' ? 'opensea' : parsed.platform;

    renderColCard({ name, image, banner, contract, supply, minted, floor, twitterUrl, osUrl });
    setStatus('');

    // Fetch phases and detect price in parallel
    const [phases, detectedPrice] = await Promise.all([
      parsed.type === 'slug' ? fetchMintPhases(parsed.value).catch(() => []) : Promise.resolve([]),
      (async () => {
        try {
          const provider = window.ethereum
            ? new ethers.providers.Web3Provider(window.ethereum)
            : new ethers.providers.JsonRpcProvider('https://ethereum.publicnode.com');
          return await detectPrice(contract, provider);
        } catch(e) { return null; }
      })()
    ]);

    COL.phases = phases;

    if (detectedPrice) {
      COL.price = parseFloat(detectedPrice);
      log('Price detected: ' + detectedPrice + ' ETH', 'ok');
    } else if (floor > 0) {
      COL.price = floor;
      log('Price from API: ' + floor.toFixed(4) + ' ETH', 'info');
    } else {
      log('Price not auto-detected — enter manually', 'warn');
    }

    // Render phases with full data
    renderPhases(phases, COL.supply, COL.minted, detectedPrice);

    // Sold out banner
    if (COL.soldOut) {
      setStatus('⚠️ This collection is SOLD OUT (' + minted.toLocaleString() + '/' + supply.toLocaleString() + ' minted)', 'warn');
      log('SOLD OUT: ' + name, 'warn');
    }

    $('limitNote').classList.remove('show');
    if (COL.supply > 0) {
      $('limitNote').classList.add('show');
      const remaining = Math.max(0, COL.supply - COL.minted);
      $('limitText').textContent = COL.supply.toLocaleString() + ' total supply · ' + remaining.toLocaleString() + ' remaining';
    }
    log('Loaded: ' + name + ' (' + contract.slice(0, 10) + '...) via ' + COL.platform, 'ok');

    // Check sale status on-chain
    try {
      const _p = window.ethereum
        ? new ethers.providers.Web3Provider(window.ethereum)
        : new ethers.providers.JsonRpcProvider('https://ethereum.publicnode.com');
      const saleStatus = await checkSaleStatus(contract, _p);
      if (saleStatus.paused) {
        log('⚠️ Contract is PAUSED', 'warn');
      } else if (saleStatus.active === true) {
        log('Sale: ACTIVE (' + saleStatus.reason + ')', 'ok');
      } else if (saleStatus.active === false) {
        log('Sale: INACTIVE (' + saleStatus.reason + ')', 'warn');
      }
    } catch(e) {}
  } catch(e) {
    setStatus('Error: ' + e.message, 'err');
    log(e.message, 'err');
  }
}


/* ══════════════════════════════════════
   FETCH MINT PHASES from OpenSea
══════════════════════════════════════ */
async function fetchMintPhases(slug) {
  try {
    const d = await fetchWithFallback(
      'https://api.opensea.io/api/v2/collections/' + slug + '/mint_stages',
      { timeoutMs: 5000 }
    );
    if (d?.mint_stages?.length) return d.mint_stages;
  } catch(e) {}

  // Fallback: try Reservoir saleConfig
  try {
    const d = await fetchWithFallback(
      'https://api.reservoir.tools/collections/v7?slug=' + encodeURIComponent(slug),
      { timeoutMs: 5000 }
    );
    const col = d?.collections?.[0];
    if (col?.saleConfig) {
      const cfg = col.saleConfig;
      return [{
        stage: 'public-sale',
        price: col.floorAsk?.price?.amount?.native || 0,
        start_time: cfg.publicSaleStart ? new Date(cfg.publicSaleStart * 1000).toISOString() : null,
        end_time: cfg.publicSaleEnd ? new Date(cfg.publicSaleEnd * 1000).toISOString() : null,
        max_per_wallet: cfg.maxSalePurchasePerAddress || null,
      }];
    }
  } catch(e) {}
  return [];
}

function fmtPhaseTime(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  const now = new Date();
  const diff = d - now;
  if (diff <= 0) return null; // already started
  const h = Math.floor(diff / 36e5);
  const m = Math.floor((diff % 36e5) / 6e4);
  if (h > 48) return 'Starts in ' + Math.floor(h/24) + 'd ' + (h%24) + 'h';
  if (h > 0)  return 'Starts in ' + h + 'h ' + m + 'm';
  return 'Starts in ' + m + 'm';
}

function renderPhases(phases, supply, minted, detectedPrice) {
  const soldOut = supply > 0 && minted >= supply;
  COL.soldOut = soldOut;

  // Disable mint button if sold out
  const mintBtn = $('mintBtn');
  if (mintBtn) {
    mintBtn.disabled = soldOut;
    mintBtn.title = soldOut ? 'This collection is sold out' : '';
  }

  if (!phases || phases.length === 0) {
    // Fallback single phase
    renderPhase(detectedPrice || COL.price, supply, soldOut);
    return;
  }

  const html = phases.map((ph, i) => {
    const price = ph.price != null ? parseFloat(ph.price) : (detectedPrice ? parseFloat(detectedPrice) : 0);
    const startTime = fmtPhaseTime(ph.start_time);
    const isLive = !startTime; // no countdown = already started
    const isSoldOut = soldOut && isLive;

    let timerClass = isSoldOut ? 'sold-out' : isLive ? 'live' : 'soon';
    let timerText  = isSoldOut ? 'SOLD OUT' : isLive ? 'LIVE' : startTime;

    const stageName = (ph.stage || ph.name || (i === 0 ? 'PUBLIC MINT' : 'PHASE ' + (i+1)))
      .replace(/-/g, ' ').toUpperCase();

    return '<div class="phase' + (i === 0 ? ' selected' : '') + '" onclick="selectPhase(this,' + price + ',' + (ph.start_time ? JSON.stringify(ph.start_time) : 'null') + ')">' +
      '<div class="phase-top">' +
        '<span class="phase-name">' + stageName + '</span>' +
        '<span class="phase-timer ' + timerClass + '">' + timerText + '</span>' +
      '</div>' +
      '<div class="phase-meta">' +
        '<span class="phase-pill eth">PRICE · ' + (price > 0 ? price.toFixed(4) + ' Ξ' : 'FREE') + '</span>' +
        '<span class="phase-pill">SUPPLY · ' + (supply > 0 ? supply.toLocaleString() : '—') + '</span>' +
        (ph.max_per_wallet ? '<span class="phase-pill">MAX ' + ph.max_per_wallet + '/WALLET</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  $('phaseList').innerHTML = html;
}

window.selectPhase = function(el, price, startTime) {
  document.querySelectorAll('.phase').forEach(p => p.classList.remove('selected'));
  el.classList.add('selected');
  // Update price and scheduled time from this phase
  COL.price = price;
  if (startTime) {
    const t = new Date(startTime);
    if ($('mTime')) $('mTime').value = t.toISOString().slice(0, 16);
    // Auto-switch to scheduled mode if phase hasn't started
    if (t > new Date()) {
      document.querySelectorAll('#modeBar .mode-tab').forEach(b => {
        b.classList.toggle('on', b.dataset.mode === 'scheduled');
      });
      S.mode = 'scheduled';
      $('schedRow').style.display = 'block';
      $('modeNote').textContent = 'Scheduled for phase start time';
      log('Phase start time set: ' + t.toLocaleString(), 'info');
    }
  }
};

function renderPhase(price, supply) {
  const p = price > 0 ? parseFloat(price) : 0;
  $('phaseList').innerHTML =
    '<div class="phase selected">' +
      '<div class="phase-top">' +
        '<span class="phase-name">' + (p === 0 ? 'FREE MINT' : 'PUBLIC MINT') + '</span>' +
        '<span class="phase-timer live">LIVE</span>' +
      '</div>' +
      '<div class="phase-meta">' +
        '<span class="phase-pill eth">PRICE · ' + (p > 0 ? p.toFixed(4) + ' Ξ' : 'FREE') + '</span>' +
        '<span class="phase-pill">SUPPLY · ' + (supply > 0 ? supply.toLocaleString() : '—') + '</span>' +
      '</div>' +
    '</div>';
}

function renderColCard({ name, image, banner, contract, supply, minted, floor, twitterUrl, osUrl }) {
  $('colName').textContent = name;
  $('colAddrText').textContent = contract.slice(0, 6) + '...' + contract.slice(-4).toUpperCase();
  $('colAddr').href = 'https://etherscan.io/address/' + contract;

  const bi = $('colBannerImg');
  if (banner) { bi.src = banner; bi.style.display = 'block'; }
  else { bi.removeAttribute('src'); bi.style.display = 'none'; }

  const initial = (name || '?').charAt(0);
  const thumbWrap = $('colThumbWrap');
  thumbWrap.innerHTML = image
    ? '<img src="' + image + '" class="col-thumb" alt=""/>'
    : '<div class="col-thumb-ph">' + initial + '</div>';
  const thumbImg = thumbWrap.querySelector('img');
  if (thumbImg) {
    thumbImg.onerror = () => {
      thumbWrap.innerHTML = '<div class="col-thumb-ph">' + initial + '</div>';
    };
  }

  const pct = supply > 0 ? Math.min(100, Math.round(minted / supply * 100)) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressLabel').textContent = pct + '% minted';
  $('progressVal').textContent = minted.toLocaleString() + (supply > 0 ? ' / ' + supply.toLocaleString() : '');

  const links = [];
  if (osUrl) links.push('<a class="col-link" href="' + osUrl + '" target="_blank" rel="noopener">OpenSea</a>');
  if (twitterUrl) links.push('<a class="col-link" href="' + twitterUrl + '" target="_blank" rel="noopener">X</a>');
  links.push('<a class="col-link" href="https://etherscan.io/address/' + contract + '" target="_blank" rel="noopener">Etherscan</a>');
  $('colLinks').innerHTML = links.join('');

  renderPhase(floor, supply);

  $('colCard').classList.add('show');
}

document.querySelectorAll('#modeBar .mode-tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#modeBar .mode-tab').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  S.mode = b.dataset.mode;
  const notes = {
    manual: 'Opens wallet immediately - you sign to mint',
    scheduled: 'Fires at the scheduled time',
    sniper: 'Polls contract every 10s - fires the instant mint goes live'
  };
  $('modeNote').textContent = notes[S.mode];
  $('schedRow').style.display = S.mode === 'scheduled' ? 'block' : 'none';
}));

function getOptions() {
  return {
    maxGas: parseInt($('mGas').value) || 50,
    tip: parseFloat($('mTip').value) || 2,
    manualPrice: COL.price || null
  };
}

function buildTask(addr) {
  return {
    id: Date.now(),
    addr,
    contract: COL.contract,
    name: COL.name,
    qty: parseInt($('mQty').value) || 1,
    price: COL.price,
    options: getOptions(),
    mode: S.mode,
    time: S.mode === 'scheduled' ? new Date($('mTime').value) : null,
    wallets: S.wallets.map(w => ({ ...w })),  // snapshot with per-wallet qty
    status: 'ready'
  };
}

$('mintBtn').addEventListener('click', async () => {
  if (!COL.contract) { setStatus('Fetch a collection first.', 'err'); return; }
  const addr = $('mAddr').value.trim() || S.addr;
  if (!addr?.match(/^0x[a-fA-F0-9]{40}$/)) {
    $('mAddr').focus();
    setStatus('Enter your wallet address first.', 'err');
    return;
  }

  const task = buildTask(addr);
  if (S.mode === 'manual') {
    if (await ensureSignerMatches(addr)) {
      setStatus('Opening MetaMask for signature...');
      try {
        const _mWallets = (task.wallets?.length ? task.wallets : S.wallets);
        const results = await Promise.allSettled(
          _mWallets.map(async (w) => {
            const { signer, address, qty: wQty } = w;
            try {
              log(`Minting ${wQty} with ${address.slice(0,6)}…`, 'info');
              const res = await executeMint(
                task.contract, signer, wQty,
                msg => log(`[${address.slice(0,6)}] ${msg}`, 'info'),
                { ...task.options, gasMode: S.gasMode }
              );
              return { success: true, address, res };
            } catch(e) {
              return { success: false, address, error: e.message };
            }
          })
        );
        results.forEach(r => {
          if (r.status === 'fulfilled') {
            if (r.value.success) log(`✅ ${r.value.address.slice(0,6)}… minted`, 'ok');
            else log(`❌ ${r.value.address.slice(0,6)}…: ${r.value.error}`, 'err');
          } else { log('❌ Wallet error: ' + r.reason, 'err'); }
        });
        const result = { success: results.some(r => r.status === 'fulfilled' && r.value?.success) };
        if (result.success) {
          const link = '<a href="https://etherscan.io/tx/' + result.hash + '" target="_blank" rel="noopener">' + result.hash.slice(0,14) + '…</a>';
          setStatus('Mint confirmed ✅', 'ok');
          log('TX confirmed: ' + link + ' · Block ' + result.block, 'ok');
        }
      } catch(e) {
        setStatus('Error: ' + e.message, 'err');
        log(e.message, 'err');
      }
    } else {
      setStatus('Connect MetaMask to sign this mint.', 'err');
    }
  } else if (S.mode === 'scheduled') {
    task.status = 'waiting';
    S.tasks.unshift(task);
    renderTasks();
    log('[SCHED] Queued for ' + new Date(task.time).toLocaleTimeString(), 'ok');
  } else {
    task.status = 'watching';
    S.tasks.unshift(task);
    renderTasks();
    log('[SNIPER] Watching ' + COL.contract.slice(0, 12) + '...', 'ok');
  }
});

$('queueBtn').addEventListener('click', async () => {
  if (!COL.contract) { setStatus('Fetch a collection first.', 'err'); return; }
  const addr = $('mAddr').value.trim() || S.addr;
  if (!addr?.match(/^0x[a-fA-F0-9]{40}$/)) {
    $('mAddr').focus();
    setStatus('Enter your wallet address first.', 'err');
    return;
  }
  const task = buildTask(addr);
  if (S.signer && !(await ensureSignerMatches(addr))) return;
  task.status = 'waiting';
  S.tasks.unshift(task);
  renderTasks();
  log('Queued: ' + COL.name + ' x' + task.qty, 'ok');
});

function fmtCD(t) {
  const d = new Date(t) - new Date();
  if (d <= 0) return 'NOW';
  const h = Math.floor(d / 36e5), m = Math.floor((d / 6e4) % 60);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function persistTasks() {
  try {
    localStorage.setItem('mb_tasks', JSON.stringify(S.tasks));
  } catch(e) {}
}

function renderTasks() {
  persistTasks();
  $('queueCnt').textContent = S.tasks.length + ' task' + (S.tasks.length !== 1 ? 's' : '');
  const el = $('taskList');
  if (!S.tasks.length) { $('queueSection').classList.remove('show'); return; }
  $('queueSection').classList.add('show');

  el.innerHTML = S.tasks.map(t =>
    '<div class="task-card ' + t.status + '">' +
      '<div class="tc-top">' +
        '<div class="tc-addr">' + (t.name || t.contract.slice(0, 12) + '...') + ' x' + t.qty + '</div>' +
        '<span class="tc-badge ' + t.status + '">' + t.status.toUpperCase() + '</span>' +
      '</div>' +
      '<div class="tc-meta">' +
        '<div class="tc-m"><span class="lk">Mode</span><span class="lv">' + t.mode.toUpperCase() + '</span></div>' +
        '<div class="tc-m"><span class="lk">Price</span><span class="lv">' + (t.price > 0 ? t.price.toFixed(4) + ' ETH' : 'FREE') + '</span></div>' +
        '<div class="tc-m"><span class="lk">Gas</span><span class="lv">' + t.options.maxGas + '</span></div>' +
        '<div class="tc-m"><span class="lk">' + (t.mode === 'scheduled' ? 'Fires In' : 'State') + '</span><span class="lv hi">' + (t.time ? fmtCD(t.time) : t.mode === 'sniper' ? 'WATCHING' : 'NOW') + '</span></div>' +
      '</div>' +
      '<div class="tc-acts">' +
        '<button class="tc-btn fire" data-id="' + t.id + '" data-a="fire">Fire</button>' +
        '<button class="tc-btn del" data-id="' + t.id + '" data-a="del">Remove</button>' +
      '</div>' +
    '</div>'
  ).join('');

  el.querySelectorAll('.tc-btn').forEach(b => b.addEventListener('click', async () => {
    const t = S.tasks.find(x => x.id == b.dataset.id);
    if (!t) return;
    if (b.dataset.a === 'fire') {
      t.status = 'ready';
      if (S.wallets.length) {
        try { await executeMultiWalletMint(t.contract, S.signers, t.qty, msg => log(msg, 'info'), t.options); }
        catch(e) { log(e.message, 'err'); }
      } else {
        openModal(t);
      }
    }
    if (b.dataset.a === 'del') {
      S.tasks = S.tasks.filter(x => x.id != b.dataset.id);
      renderTasks();
    }
  }));
}

function tickTasks() {
  S.tasks.forEach(async t => {
    if (t.mode === 'scheduled' && t.time && t.status === 'waiting' && new Date() >= t.time) {
      t.status = 'ready';
      log('SCHEDULED: ' + t.name, 'ok');
      if (S.wallets.length) {
        try { await executeMultiWalletMint(t.contract, S.signers, t.qty, msg => log(msg, 'info'), t.options); }
        catch(e) { log(e.message, 'err'); }
      } else { openModal(t); }
    }

    if (t.mode === 'sniper' && t.status === 'watching' && !t._sniperStop) {
      if (!S.wallets.length) { t.status = 'waiting'; return; }
      t._sniperStop = startSniper(
        t.contract, S.wallets[0].signer, t.qty,
        (msg, type) => log(msg, type || 'info'),
        t.options,
        async () => {
          t.status = 'ready';
          renderTasks();
          try {
            const wallets = [S.signer, ...(S.wallets || [])];
            if (wallets.length > 1) {
              await executeMultiWalletMint(t.contract, wallets, t.qty, msg => log(msg, 'info'), t.options);
            } else {
              await executeMintWithRetry(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options, 3);
            }
            setStatus('✅ Sniper mint confirmed!', 'ok');
          } catch(e) { log(e.message, 'err'); if (!S.wallets.length) openModal(t); }
        }
      );
    }
  });
  renderTasks();
}

function openModal(task) {
  S.pending = task;
  const tot = task.price * task.qty;
  const vW = ethers.utils.parseEther(tot.toFixed(8)).toString();

  $('txPreview').innerHTML = [
    ['Collection', task.name || '-'],
    ['Contract', task.contract.slice(0, 14) + '...' + task.contract.slice(-4)],
    ['Qty / Value', task.qty + ' x ' + (task.price > 0 ? task.price.toFixed(4) : '0') + ' ETH = ' + tot.toFixed(4) + ' ETH' + (S.ethPrice ? ' (~$' + (tot * S.ethPrice).toFixed(2) + ')' : '')],
    ['Gas', task.options.maxGas + ' gwei max - ' + task.options.tip + ' gwei tip'],
  ].map(([k, v]) => '<div class="txr"><span class="txk">' + k + '</span><span class="txv">' + v + '</span></div>').join('');

  $('modalDesc').textContent = S.wallets.length > 0
    ? 'MetaMask connected - sign on-chain directly.'
    : 'Connect MetaMask or use a wallet deep-link below.';
  $('btnMM').style.display = S.wallets.length > 0 ? 'block' : 'none';
  $('btnRainbow').href = 'https://rnbwapp.com/wc?uri=' + encodeURIComponent('ethereum:' + task.contract + '@1?value=' + vW);
  $('btnTrust').href = 'trust://send?address=' + task.contract + '&amount=' + tot + '&coin=60';
  $('overlay').classList.add('open');
}

window.signWithMM = async function() {
  const t = S.pending;
  if (!t) return;
  if (!(await ensureSignerMatches(t.addr))) return;
  $('overlay').classList.remove('open');
  setStatus('Minting...');
  try {
    const taskWallets = t.wallets?.length ? t.wallets : S.wallets;
    const result = await Promise.allSettled(taskWallets.map(w => executeMint(t.contract, w.signer, w.qty, msg => log(msg,'info'), { ...t.options, gasMode: S.gasMode })));
    const _r, msg => log(msg, 'info'), t.options);
    const r = { success: result.some(x => x.status === 'fulfilled' && x.value?.success) };
    setStatus(result.success ? 'Mint successful' : 'Done', 'ok');
    S.tasks = S.tasks.filter(x => x.id !== t.id);
    renderTasks();
  } catch(e) {
    setStatus('Error: ' + e.message, 'err');
    log(e.message, 'err');
  }
};

$('modalClose').onclick = () => $('overlay').classList.remove('open');
$('overlay').onclick = e => { if (e.target.id === 'overlay') $('overlay').classList.remove('open'); };

window.toggleTheme = function() {
  const isDark = document.documentElement.classList.toggle('dark');
  document.body.classList.toggle('dark', isDark);
  $('themeIcon').textContent = isDark ? '☽' : '○';
  localStorage.setItem('mb_theme', isDark ? 'dark' : 'light');
};

(function() {
  if (localStorage.getItem('mb_theme') === 'dark') {
    document.documentElement.classList.add('dark');
    document.body.classList.add('dark');
    const ic = document.getElementById('themeIcon');
    if (ic) ic.textContent = '☽';
  }
})();


/* ══════════════════════════════════════
   PRIVATE KEY MODE
══════════════════════════════════════ */
window.connectPrivateKey = async function() {
  const pkInput = $('pkInput');
  if (!pkInput) return;
  const pk = pkInput.value.trim();
  if (!pk) { setStatus('Enter a private key.', 'err'); return; }
  try {
    const signer = createPrivateKeySigner(pk, RPC_URL);
    const address = await signer.getAddress();

    if (S.wallets.find(w => w.address.toLowerCase() === address.toLowerCase())) {
      pkInput.value = '';
      setStatus('Wallet already added: ' + address.slice(0,10) + '…', 'warn');
      return;
    }

    S.wallets.push({ signer, address, qty: 1 });

    pkInput.value = '';
    pkInput.placeholder = '✓ Key loaded — add another or close';

    if (S.wallets.length === 1) {
      setWalletConnected(address);
      if ($('mAddr')) $('mAddr').value = address;
    }

    renderWallets();
    setStatus('Added wallet #' + S.wallets.length + ': ' + address.slice(0,10) + '…', 'ok');
    log('Added PK wallet #' + S.wallets.length + ': ' + address, 'ok');
  } catch(e) { setStatus('Invalid key: ' + e.message, 'err'); log(e.message, 'err'); }
};

function renderWallets() {
  const el = $('walletList');
  if (!el) return;
  if (!S.wallets.length) { el.innerHTML = ''; return; }
  el.innerHTML = S.wallets.map((w, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--b0);">
      <span style="font-size:11px;">${i === 0 ? '🦊' : '🔑'} ${w.address.slice(0,6)}…${w.address.slice(-4)}</span>
      <label style="font-size:9px;color:var(--t2);">QTY</label>
      <input type="number" value="${w.qty}" min="1" max="20"
        style="width:48px;background:var(--card2);border:1px solid var(--b1);color:var(--t0);
               padding:3px 6px;border-radius:4px;font-size:11px;text-align:center;"
        onchange="updateWalletQty(${i}, this.value)"/>
      <button onclick="removeWallet(${i})"
        style="background:none;border:none;color:var(--err);cursor:pointer;font-size:11px;margin-left:auto;">✕</button>
    </div>`
  ).join('');
}

function updateWalletQty(i, val) {
  if (S.wallets[i]) S.wallets[i].qty = Math.max(1, parseInt(val) || 1);
}

window.removeWallet = function(i) {
  if (i === 0 && S.provider) {
    setStatus('Use Disconnect to remove the MetaMask wallet.', 'warn');
    return;
  }
  const addr = S.wallets[i]?.address;
  S.wallets.splice(i, 1);
  renderWallets();
  log('Removed wallet: ' + (addr || ''), 'info');
};

window.togglePKSection = function() {
  const s = $('pkSection');
  if (s) s.style.display = s.style.display === 'none' ? 'block' : 'none';
};

async function init() {
  // Restore persisted tasks
  try {
    const saved = JSON.parse(localStorage.getItem('mb_tasks') || '[]');
    if (Array.isArray(saved) && saved.length) {
      // Restore time objects
      S.tasks = saved.map(t => ({ ...t, time: t.time ? new Date(t.time) : null }));
      renderTasks();
      log('Restored ' + S.tasks.length + ' task(s) from previous session', 'info');
    }
  } catch(e) {}
  setInterval(tickTasks, 1000);
  setInterval(loadPrices, 30000);
  setInterval(loadGas, 30000);
  const t = new Date(Date.now() + 3600e3);
  if ($('mTime')) $('mTime').value = t.toISOString().slice(0, 16);
  await Promise.all([loadPrices(), loadGas()]);
}

init();
