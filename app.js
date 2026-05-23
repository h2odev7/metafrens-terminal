/**
 * app.js — UI logic only
 * Handles: wallet, prices, URL parsing, collection fetching,
 * task queue, sniper, theme toggle
 * Imports blockchain logic from mintEngine.js
 */

'use strict';

import { executeMint, fetchABI, findMintFunctions, detectPrice } from './mintEngine.js';

const $ = id => document.getElementById(id);

/* ── STATE ── */
const S = {
  provider: null, signer: null, addr: null,
  ethPrice: 0, gasPrice: 0,
  tasks: [], mode: 'manual', pending: null
};

const COL = {
  contract: null, name: '', price: 0,
  supply: 0, minted: 0, slug: '', platform: ''
};

/* ══════════════════════════════════════
   PRICES
══════════════════════════════════════ */
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
    S.ethPrice = d.ethereum.usd;
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
  try {
    const r = await fetch('https://ethereum.publicnode.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 })
    });
    const d = await r.json();
    if (d.result) {
      const g = Math.round(parseInt(d.result, 16) / 1e9);
      S.gasPrice = g;
      $('gasP').textContent = g;
    }
  } catch(e) {}
}

/* ══════════════════════════════════════
   LOG
══════════════════════════════════════ */
function log(msg, t = '') {
  const d = document.createElement('div');
  d.className = 'le ' + t;
  d.innerHTML = `<span class="ts">[${new Date().toLocaleTimeString('en-US', { hour12: false })}]</span>${msg}`;
  const l = $('botLog');
  l.insertBefore(d, l.firstChild);
  while (l.children.length > 80) l.removeChild(l.lastChild);
}

function setStatus(msg, t = '') {
  const el = $('statusMsg');
  el.textContent = msg;
  el.className = 'status-msg ' + t;
}

/* ══════════════════════════════════════
   WALLET — MetaMask via ethers.js
══════════════════════════════════════ */
window.connectWallet = async function() {
  if (!window.ethereum) { alert('Install MetaMask'); return; }
  try {
    S.provider = new ethers.providers.Web3Provider(window.ethereum);
    await S.provider.send('eth_requestAccounts', []);
    S.signer = S.provider.getSigner();
    S.addr   = await S.signer.getAddress();

    const btn = $('walletBtn');
    btn.textContent = S.addr.slice(0, 6) + '…' + S.addr.slice(-4);
    btn.classList.add('connected');

    if ($('mAddr')) $('mAddr').value = S.addr;
    log('Connected: ' + S.addr, 'ok');
  } catch(e) {
    log('Wallet error: ' + e.message, 'err');
  }
};

/* ══════════════════════════════════════
   URL PARSER
══════════════════════════════════════ */
function parseUrl(raw) {
  raw = raw.trim();
  // Strip trailing OpenSea page suffixes: /overview /items /activity /offers etc.
  raw = raw.replace(/\/(overview|items|activity|offers|analytics|traits|holders|mint)(\?.*)?$/, '');
  if (raw.match(/^0x[a-fA-F0-9]{40}$/)) return { type: 'contract', value: raw, platform: 'direct' };

  const maps = [
    [/opensea\.io\/collection\/([^/?#\s]+)/,              'opensea',   'slug'],
    [/opensea\.io\/assets\/ethereum\/(0x[a-fA-F0-9]{40})/, 'opensea',  'contract'],
    [/zora\.co\/collect\/(?:zora|eth):(0x[a-fA-F0-9]{40})/, 'zora',   'contract'],
    [/mint\.fun\/(0x[a-fA-F0-9]{40})/,                    'mintfun',   'contract'],
    [/foundation\.app\/@[^/]+\/([^/?#\s]+)/,              'foundation','slug'],
    [/app\.manifold\.xyz\/c\/([^/?#\s]+)/,                'manifold',  'slug'],
    [/manifold\.gallery\/collection\/([^/?#\s]+)/,        'manifold',  'slug'],
    [/nft\.coinbase\.com\/collection\/ethereum\/(0x[a-fA-F0-9]{40})/, 'coinbase', 'contract'],
    [/rarible\.com\/collection\/(0x[a-fA-F0-9]{40})/,    'rarible',   'contract'],
  ];

  for (const [re, platform, type] of maps) {
    const m = raw.match(re);
    if (m) return { type, value: m[1], platform };
  }

  if (raw.length > 5 && !raw.includes(' ')) return { type: 'slug', value: raw, platform: 'opensea' };
  return null;
}

/* ══════════════════════════════════════
   FETCH COLLECTION — OpenSea + on-chain reads
══════════════════════════════════════ */
$('fetchBtn').addEventListener('click', fetchCollection);
$('urlIn').addEventListener('keydown', e => { if (e.key === 'Enter') fetchCollection(); });

async function fetchCollection() {
  const raw = $('urlIn').value.trim();
  if (!raw) { setStatus('Paste a mint link or 0x contract.', 'err'); return; }

  const parsed = parseUrl(raw);
  if (!parsed) { setStatus('Unrecognised link — try pasting the 0x contract directly.', 'err'); return; }

  setStatus('Fetching collection…');
  $('colCard').classList.remove('show');

  try {
    let contract = null, name = 'Collection';
    let image = '', banner = '', twitterUrl = '', osUrl = '';
    let supply = 0, minted = 0, floor = 0;

    if (parsed.type === 'contract') {
      contract = parsed.value;

      // Read name() from chain
      try {
        const r = await fetch('https://ethereum.publicnode.com', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: contract, data: '0x06fdde03' }, 'latest'], id: 1 })
        });
        const d = await r.json();
        if (d.result && d.result.length > 66) {
          const hex = d.result.slice(130);
          const decoded = hex.match(/../g)?.map(b => String.fromCharCode(parseInt(b, 16))).join('').replace(/\x00/g, '').trim();
          if (decoded && decoded.length > 1) name = decoded;
        }
      } catch(e) {}

      // Read totalSupply, maxSupply, mintPrice
      try {
        const results = await Promise.all([
          '0x18160ddd', '0xd5abeb01', '0xa0712d68'
        ].map(async data => {
          const r = await fetch('https://ethereum.publicnode.com', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: contract, data }, 'latest'], id: 1 })
          });
          return (await r.json()).result;
        }));
        if (results[0] && results[0] !== '0x') minted = parseInt(results[0], 16);
        if (results[1] && results[1] !== '0x') supply = parseInt(results[1], 16);
        if (results[2] && results[2] !== '0x') floor  = parseInt(results[2], 16) / 1e18;
      } catch(e) {}

    } else {
      // Slug → OpenSea API
      for (const px of ['https://corsproxy.io/?url=', 'https://api.allorigins.win/raw?url=']) {
        try {
          const r = await fetch(px + encodeURIComponent('https://api.opensea.io/api/v2/collections/' + parsed.value), {
            headers: { Accept: 'application/json' }
          });
          const d = await r.json();
          if (d && !d.errors && d.name) {
            name       = d.name;
            image      = d.image_url || '';
            banner     = d.banner_image_url || d.image_url || '';
            twitterUrl = d.twitter_username ? 'https://x.com/' + d.twitter_username : '';
            osUrl      = 'https://opensea.io/collection/' + d.collection;
            contract   = d.contracts?.[0]?.address || null;
            supply     = d.total_supply ? parseInt(d.total_supply) : 0;
            try {
              const sr = await fetch(px + encodeURIComponent('https://api.opensea.io/api/v2/collections/' + d.collection + '/stats'), { headers: { Accept: 'application/json' } });
              const sd = await sr.json();
              if (sd.total) {
                // floor_price = current floor in ETH
                floor  = sd.total.floor_price || 0;
                // count = total NFTs minted so far (most accurate)
                minted = sd.total.count        || 0;
              }
              // total_supply from collection data = max supply
              // Fallback: if no total_supply, use num_owners as minted proxy
              if (!supply && d.stats) supply = d.stats.total_supply || 0;
            } catch(e) {}
            break;
          }
        } catch(e) {}
      }
    }

    if (!contract?.match(/^0x[a-fA-F0-9]{40}$/)) {
      setStatus('Could not resolve contract — paste the 0x address directly.', 'err');
      return;
    }

    COL.contract = contract; COL.name = name;
    COL.price    = floor;   COL.supply = supply; COL.minted = minted;
    COL.slug     = parsed.value; COL.platform = parsed.platform;

    renderColCard({ name, image, banner, contract, supply, minted, floor, twitterUrl, osUrl });
    setStatus('');

    // Auto-fill price
    if (floor > 0 && $('mPrc')) $('mPrc').value = floor.toFixed(4);

    // Supply note
    if (supply > 0) {
      $('limitNote').classList.add('show');
      $('limitText').textContent = supply.toLocaleString() + ' total supply · ' + (supply - minted).toLocaleString() + ' remaining';
    }

    log('Loaded: ' + name + ' (' + contract.slice(0, 10) + '…) via ' + parsed.platform, 'ok');

  } catch(e) {
    setStatus('Error: ' + e.message, 'err');
    log('Fetch error: ' + e.message, 'err');
  }
}

function renderColCard({ name, image, banner, contract, supply, minted, floor, twitterUrl, osUrl }) {
  $('colName').textContent     = name;
  $('colAddrText').textContent = contract.slice(0, 6) + '…' + contract.slice(-4).toUpperCase();
  $('colAddr').href            = 'https://etherscan.io/address/' + contract;

  if (banner) { const bi = $('colBannerImg'); bi.src = banner; bi.style.display = 'block'; }

  $('colThumbWrap').innerHTML = image
    ? `<img src="${image}" class="col-thumb" onerror="this.parentElement.innerHTML='<div class=col-thumb-ph>${name.charAt(0)}</div>'"/>`
    : `<div class="col-thumb-ph">${name.charAt(0)}</div>`;

  const pct = supply > 0 ? Math.min(100, Math.round(minted / supply * 100)) : 0;
  $('progressFill').style.width  = pct + '%';
  $('progressLabel').textContent = pct + '% minted';
  $('progressVal').textContent   = minted.toLocaleString() + (supply > 0 ? ' / ' + supply.toLocaleString() : '');

  const links = [];
  if (osUrl)      links.push(`<a class="col-link" href="${osUrl}" target="_blank" rel="noopener">↗ OpenSea</a>`);
  if (twitterUrl) links.push(`<a class="col-link" href="${twitterUrl}" target="_blank" rel="noopener">𝕏 Twitter</a>`);
  links.push(`<a class="col-link" href="https://etherscan.io/address/${contract}" target="_blank" rel="noopener">↗ Etherscan</a>`);
  $('colLinks').innerHTML = links.join('');

  $('phaseList').innerHTML = `
    <div class="phase selected">
      <div class="phase-top">
        <span class="phase-name">${floor === 0 ? 'FREE MINT' : 'PUBLIC MINT'}</span>
        <span class="phase-timer live">LIVE</span>
      </div>
      <div class="phase-meta">
        <span class="phase-pill eth">PRICE · ${floor > 0 ? floor.toFixed(4) + ' Ξ' : 'FREE'}</span>
        <span class="phase-pill">SUPPLY · ${supply > 0 ? supply.toLocaleString() : '—'}</span>
      </div>
    </div>`;

  $('colCard').classList.add('show');
}

/* ══════════════════════════════════════
   MODE TABS
══════════════════════════════════════ */
document.querySelectorAll('#modeBar .mode-tab').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#modeBar .mode-tab').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  S.mode = b.dataset.mode;
  const notes = {
    manual:    'Opens wallet immediately — you sign to mint',
    scheduled: 'Fires at the scheduled time',
    sniper:    'Polls contract every 10s — fires the instant mint goes live'
  };
  $('modeNote').textContent = notes[S.mode];
  $('schedRow').style.display = S.mode === 'scheduled' ? 'block' : 'none';
}));

/* ══════════════════════════════════════
   BUILD TASK
══════════════════════════════════════ */
function getOptions() {
  return {
    maxGas:      parseInt($('mGas').value)   || 50,
    tip:         parseFloat($('mTip').value) || 2,
    manualPrice: COL.price || parseFloat($('mPrc')?.value) || null
  };
}

function buildTask(addr) {
  return {
    id:       Date.now(),
    addr,
    contract: COL.contract,
    name:     COL.name,
    qty:      parseInt($('mQty').value) || 1,
    price:    COL.price,
    options:  getOptions(),
    mode:     S.mode,
    time:     S.mode === 'scheduled' ? new Date($('mTime').value) : null,
    status:   'ready'
  };
}

/* ══════════════════════════════════════
   MINT NOW — calls mintEngine.executeMint
══════════════════════════════════════ */
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
    if (S.signer) {
      setStatus('Minting…');
      try {
        const result = await executeMint(task.contract, S.signer, task.qty, msg => log(msg, 'info'), task.options);
        setStatus(result.success ? 'Mint successful ✅' : 'Done', 'ok');
      } catch(e) {
        setStatus('Error: ' + e.message, 'err');
        log(e.message, 'err');
      }
    } else {
      openModal(task);
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
    log('[SNIPER] Watching ' + COL.contract.slice(0, 12) + '…', 'ok');
  }
});

$('queueBtn').addEventListener('click', () => {
  if (!COL.contract) { setStatus('Fetch a collection first.', 'err'); return; }
  const addr = $('mAddr').value.trim() || S.addr;
  if (!addr?.match(/^0x[a-fA-F0-9]{40}$/)) {
    $('mAddr').focus();
    setStatus('Enter your wallet address first.', 'err');
    return;
  }
  const task = buildTask(addr);
  task.status = 'waiting';
  S.tasks.unshift(task);
  renderTasks();
  log('Queued: ' + COL.name + ' ×' + task.qty, 'ok');
});

/* ══════════════════════════════════════
   RENDER TASKS
══════════════════════════════════════ */
function fmtCD(t) {
  const d = new Date(t) - new Date();
  if (d <= 0) return 'NOW';
  const h = Math.floor(d / 36e5), m = Math.floor((d / 6e4) % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderTasks() {
  $('queueCnt').textContent = S.tasks.length + ' task' + (S.tasks.length !== 1 ? 's' : '');
  const el = $('taskList');
  if (!S.tasks.length) { $('queueSection').classList.remove('show'); return; }
  $('queueSection').classList.add('show');

  el.innerHTML = S.tasks.map(t => `
    <div class="task-card ${t.status}">
      <div class="tc-top">
        <div class="tc-addr">${t.name || t.contract.slice(0, 12) + '…'} ×${t.qty}</div>
        <span class="tc-badge ${t.status}">${t.status.toUpperCase()}</span>
      </div>
      <div class="tc-meta">
        <div class="tc-m"><span class="lk">Mode</span><span class="lv">${t.mode.toUpperCase()}</span></div>
        <div class="tc-m"><span class="lk">Price</span><span class="lv">${t.price > 0 ? t.price.toFixed(4) + 'Ξ' : 'FREE'}</span></div>
        <div class="tc-m"><span class="lk">Gas</span><span class="lv">${t.options.maxGas}</span></div>
        <div class="tc-m"><span class="lk">${t.mode === 'scheduled' ? 'Fires In' : 'State'}</span>
          <span class="lv hi">${t.time ? fmtCD(t.time) : t.mode === 'sniper' ? 'WATCHING' : 'NOW'}</span>
        </div>
      </div>
      <div class="tc-acts">
        <button class="tc-btn fire" data-id="${t.id}" data-a="fire">⚡ Fire</button>
        <button class="tc-btn del"  data-id="${t.id}" data-a="del">✕ Remove</button>
      </div>
    </div>`).join('');

  el.querySelectorAll('.tc-btn').forEach(b => b.addEventListener('click', async () => {
    const t = S.tasks.find(x => x.id == b.dataset.id);
    if (!t) return;
    if (b.dataset.a === 'fire') {
      t.status = 'ready';
      if (S.signer) {
        try {
          await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options);
        } catch(e) { log(e.message, 'err'); }
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

/* ══════════════════════════════════════
   SNIPER — polls contract every 10s
══════════════════════════════════════ */
function tickTasks() {
  S.tasks.forEach(async t => {
    // Scheduled — fire at time
    if (t.mode === 'scheduled' && t.time && t.status === 'waiting' && new Date() >= t.time) {
      t.status = 'ready';
      log('⚡ SCHEDULED: ' + t.name, 'ok');
      if (S.signer) {
        try { await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options); }
        catch(e) { log(e.message, 'err'); }
      } else { openModal(t); }
    }

    // Sniper — poll contract every 10s
    if (t.mode === 'sniper' && t.status === 'watching') {
      const now = Math.floor(Date.now() / 1000);
      if (!t._p || now - t._p >= 10) {
        t._p = now;
        try {
          const r = await fetch('https://ethereum.publicnode.com', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to: t.contract, data: '0x1249c58b' }, 'latest'], id: 1 })
          });
          const d = await r.json();
          if (d.result !== undefined && !d.error) {
            t.status = 'ready';
            log('⚡ SNIPER HIT: ' + t.name + ' is LIVE', 'ok');
            if (S.signer) {
              try { await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options); }
              catch(e) { log(e.message, 'err'); }
            } else { openModal(t); }
          }
        } catch(e) {}
        renderTasks();
      }
    }
  });
  renderTasks();
}

/* ══════════════════════════════════════
   WALLET MODAL — deep-links for non-MM users
══════════════════════════════════════ */
function openModal(task) {
  S.pending = task;
  const tot  = task.price * task.qty;
  const vW   = ethers.utils.parseEther(tot.toFixed(8)).toString();

  $('txPreview').innerHTML = [
    ['Collection', task.name || '—'],
    ['Contract',   task.contract.slice(0, 14) + '…' + task.contract.slice(-4)],
    ['Qty / Value', `${task.qty} × ${task.price > 0 ? task.price.toFixed(4) : '0'}Ξ = ${tot.toFixed(4)}Ξ${S.ethPrice ? ' (~$' + (tot * S.ethPrice).toFixed(2) + ')' : ''}`],
    ['Gas',         `${task.options.maxGas} gwei max · ${task.options.tip} gwei tip`],
  ].map(([k, v]) => `<div class="txr"><span class="txk">${k}</span><span class="txv">${v}</span></div>`).join('');

  $('modalDesc').textContent = S.signer
    ? 'MetaMask connected — sign on-chain directly.'
    : 'Connect MetaMask or use a wallet deep-link below.';
  $('btnMM').style.display = S.signer ? 'block' : 'none';

  $('btnRainbow').href = `https://rnbwapp.com/wc?uri=${encodeURIComponent('ethereum:' + task.contract + '@1?value=' + vW)}`;
  $('btnTrust').href   = `trust://send?address=${task.contract}&amount=${tot}&coin=60`;

  $('overlay').classList.add('open');
}

window.signWithMM = async function() {
  const t = S.pending;
  if (!t || !S.signer) return;
  $('overlay').classList.remove('open');
  setStatus('Minting…');
  try {
    const result = await executeMint(t.contract, S.signer, t.qty, msg => log(msg, 'info'), t.options);
    setStatus(result.success ? 'Mint successful ✅' : 'Done', 'ok');
    S.tasks = S.tasks.filter(x => x.id !== t.id);
    renderTasks();
  } catch(e) {
    setStatus('Error: ' + e.message, 'err');
    log(e.message, 'err');
  }
};

$('modalClose').onclick = () => $('overlay').classList.remove('open');
$('overlay').onclick    = e => { if (e.target.id === 'overlay') $('overlay').classList.remove('open'); };

/* ══════════════════════════════════════
   THEME TOGGLE
══════════════════════════════════════ */
window.toggleTheme = function() {
  const isDark = document.body.classList.toggle('dark');
  $('themeIcon').textContent = isDark ? '☽' : '○';
  localStorage.setItem('mb_theme', isDark ? 'dark' : 'light');
};

// Restore saved theme
(function() {
  if (localStorage.getItem('mb_theme') === 'dark') {
    document.body.classList.add('dark');
    const ic = document.getElementById('themeIcon');
    if (ic) ic.textContent = '☽';
  }
})();

/* ══════════════════════════════════════
   INIT
══════════════════════════════════════ */
async function init() {
  setInterval(tickTasks, 1000);
  setInterval(loadPrices, 30000);
  setInterval(loadGas, 30000);
  const t = new Date(Date.now() + 3600e3);
  if ($('mTime')) $('mTime').value = t.toISOString().slice(0, 16);
  await Promise.all([loadPrices(), loadGas()]);
}

init();
