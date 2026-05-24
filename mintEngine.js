/**
 * mintEngine.js — Blockchain logic
 * ABI fetch · mint detection · price detection · sale status
 * dynamic gas · simulation · retry · multi-wallet · execute
 */
'use strict';

const ETHERSCAN_API_KEY = "YOUR_API_KEY";
const ETH_RPC = 'https://ethereum.publicnode.com';

/* ══════════════════════════════════════
   ABI FETCHING
══════════════════════════════════════ */
export async function fetchABI(address) {
  const url = `https://api.etherscan.io/api?module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;
  for (const src of [url, `https://corsproxy.io/?url=${encodeURIComponent(url)}`, `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`]) {
    try {
      const res = await fetch(src);
      const data = await res.json();
      if (data.status === "1" && data.result) return JSON.parse(data.result);
    } catch(e) {}
  }
  throw new Error("ABI not found — contract may not be verified on Etherscan");
}

/* ══════════════════════════════════════
   MINT FUNCTION DETECTION
   Expanded regex covers allowlist, whitelist, presale, redeem, airdrop
══════════════════════════════════════ */
function rankFunctions(funcs) {
  const priority = ["mint", "public", "buy", "claim", "purchase", "free", "allowlist", "whitelist", "presale", "redeem", "airdrop"];
  return funcs.sort((a, b) => {
    const aScore = priority.findIndex(p => a.name.toLowerCase().includes(p));
    const bScore = priority.findIndex(p => b.name.toLowerCase().includes(p));
    return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
  });
}

export function findMintFunctions(abi) {
  return rankFunctions(abi.filter(fn =>
    fn.type === "function" &&
    (fn.stateMutability === "payable" || fn.stateMutability === "nonpayable") &&
    /mint|buy|claim|purchase|free|allowlist|whitelist|presale|redeem|airdrop/i.test(fn.name)
  ));
}

/* ══════════════════════════════════════
   SALE STATUS CHECK
   Returns { active, paused, reason }
══════════════════════════════════════ */
export async function checkSaleStatus(contractAddress, provider) {
  const abi = [
    "function isSaleActive() view returns (bool)",
    "function paused() view returns (bool)",
    "function saleActive() view returns (bool)",
    "function publicSaleActive() view returns (bool)",
    "function mintingEnabled() view returns (bool)",
    "function isActive() view returns (bool)",
    "function saleIsActive() view returns (bool)",
    "function revealed() view returns (bool)"
  ];
  const contract = new ethers.Contract(contractAddress, abi, provider);
  const result = { active: null, paused: false, reason: "unknown" };

  // Check paused first
  try {
    const p = await contract.paused();
    if (p === true) {
      result.paused = true;
      result.active = false;
      result.reason = "Contract is paused";
      return result;
    }
  } catch(e) {}

  // Check active flags
  for (const fn of ["isSaleActive", "saleActive", "publicSaleActive", "mintingEnabled", "isActive", "saleIsActive"]) {
    try {
      const val = await contract[fn]();
      result.active = val === true;
      result.reason = fn + "() = " + val;
      return result;
    } catch(e) {}
  }

  // No status getter — assume active (will fail at simulation if not)
  result.active = null;
  result.reason = "No status getter found — will attempt mint";
  return result;
}

/* ══════════════════════════════════════
   PRICE DETECTION
══════════════════════════════════════ */
export async function detectPrice(contractAddress, provider) {
  const abi = [
    "function publicSalePrice() view returns (uint256)",
    "function mintPrice() view returns (uint256)",
    "function price() view returns (uint256)",
    "function cost() view returns (uint256)",
    "function getPrice() view returns (uint256)",
    "function publicPrice() view returns (uint256)",
    "function salePrice() view returns (uint256)",
    "function tokenPrice() view returns (uint256)"
  ];
  const contract = new ethers.Contract(contractAddress, abi, provider);
  for (const m of ["publicSalePrice", "mintPrice", "price", "cost", "getPrice", "publicPrice", "salePrice", "tokenPrice"]) {
    try {
      const p = await contract[m]();
      if (p && p.toString() !== "0") return ethers.utils.formatEther(p);
    } catch(e) {}
  }
  return null;
}

/* ══════════════════════════════════════
   DYNAMIC GAS
   Reads base fee from latest block, applies 1.2x buffer
   Priority fee: max(tip, 1 gwei) scaled to congestion
══════════════════════════════════════ */
export async function getDynamicGas(provider, manualMaxGas = null, manualTip = null, gasMode = 'normal') {
  const multipliers = { normal: 1.1, aggressive: 1.3, war: 1.6 };
  const tipGweis    = { normal: 2,   aggressive: 3,   war: 5   };
  const mult = multipliers[gasMode] || 1.1;
  const tipG = tipGweis[gasMode]    || 2;

  try {
    const block = await provider.getBlock('latest');
    const baseFee = block.baseFeePerGas;

    if (baseFee) {
      const baseFeeGwei = parseFloat(ethers.utils.formatUnits(baseFee, 'gwei'));
      const maxGwei = manualMaxGas || Math.max(Math.ceil(baseFeeGwei * mult), 15);
      const tipGwei = manualTip    || Math.max(tipG, 1.5);

      return {
        maxFeePerGas:         ethers.utils.parseUnits(String(maxGwei), 'gwei'),
        maxPriorityFeePerGas: ethers.utils.parseUnits(String(tipGwei), 'gwei'),
        baseFeeGwei, maxGwei, tipGwei, gasMode
      };
    }
  } catch(e) {}

  const maxGwei = manualMaxGas || 50;
  const tipGwei = manualTip    || tipG;
  return {
    maxFeePerGas:         ethers.utils.parseUnits(String(maxGwei), 'gwei'),
    maxPriorityFeePerGas: ethers.utils.parseUnits(String(tipGwei), 'gwei'),
    baseFeeGwei: null, maxGwei, tipGwei, gasMode
  };
}

/* ══════════════════════════════════════
   GAS ESCALATION (Step 8)
   Retries with escalating gas multiplier on failure
══════════════════════════════════════ */
export async function executeWithGasRetry(fn, retries = 3) {
  let multiplier = 1;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn(multiplier);
    } catch(e) {
      if (e.code === 4001 || e.message === 'Rejected by user') throw e;
      multiplier += 0.2;
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 500));
      } else {
        throw e;
      }
    }
  }
}


/* ══════════════════════════════════════
   BUILD ARGS
══════════════════════════════════════ */
export function buildArgs(fn, qty, addr) {
  if (!fn.inputs || fn.inputs.length === 0) return [];
  return fn.inputs.map(inp => {
    const t = inp.type;
    if (t.includes("uint")) return qty;
    if (t === "address")    return addr;
    if (t === "bool")       return true;
    if (t === "bytes")      return "0x";
    return qty;
  });
}

/* ══════════════════════════════════════
   SNIPER — 1-second poll
   Polls callStatic every 1s until mint succeeds or is stopped
   Returns a stopper function
══════════════════════════════════════ */
export function startSniper(contractAddr, signer, qty, log, options = {}, onFire) {
  let stopped = false;
  let attempt = 0;

  const poll = async () => {
    if (stopped) return;
    attempt++;

    try {
      // Try callStatic on most likely mint sig first (fast check)
      const iface = new ethers.utils.Interface(["function mint(uint256) payable"]);
      const data  = iface.encodeFunctionData("mint", [qty]);
      const price = options.manualPrice
        ? ethers.utils.parseEther(String(options.manualPrice))
        : ethers.constants.Zero;

      await signer.provider.call({ to: contractAddr, data, value: price });

      // callStatic passed — mint is open!
      log(`⚡ SNIPER: Mint detected open on attempt ${attempt}! Firing…`, 'ok');
      stopped = true;
      if (onFire) onFire();
    } catch(e) {
      // Still reverted — not live yet
      if (attempt % 5 === 0) log(`Sniper: watching… (${attempt}s)`, 'info');
      if (!stopped) setTimeout(poll, 1000);
    }
  };

  log('Sniper started — polling every 1s', 'info');
  poll();

  return () => {
    stopped = true;
    log('Sniper stopped', 'warn');
  };
}

/* ══════════════════════════════════════
   EXECUTE MINT WITH RETRY
   Wraps executeMint with up to 3 retries on failure
══════════════════════════════════════ */
export { executeWithGasRetry };

export async function executeMintWithRetry(contractAddr, signer, qty, log, options = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await executeMint(contractAddr, signer, qty, log, options);
      return result;
    } catch(e) {
      if (e.code === 4001 || e.message === "Rejected by user") throw e; // Never retry rejection
      if (i < retries - 1) {
        log(`Attempt ${i + 1} failed: ${e.message.slice(0, 60)} — retrying in 1s…`, 'warn');
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw e; // Last attempt — propagate
      }
    }
  }
}

/* ══════════════════════════════════════
   MULTI-WALLET MINT
   Fires executeMint across multiple signers in parallel
══════════════════════════════════════ */
export async function executeMultiWalletMint(contractAddr, signers, qty, log, options = {}) {
  if (!signers || signers.length === 0) throw new Error("No wallets provided");
  log(`Multi-wallet: firing ${signers.length} wallet(s)…`, 'info');

  const results = await Promise.allSettled(
    signers.map(async (signer, i) => {
      const addr = await signer.getAddress();
      const walletLog = (msg, t) => log(`[Wallet ${i + 1} ${addr.slice(0,6)}…] ${msg}`, t);
      return executeMintWithRetry(contractAddr, signer, qty, walletLog, options);
    })
  );

  const succeeded = results.filter(r => r.status === "fulfilled").length;
  const failed    = results.filter(r => r.status === "rejected").length;
  log(`Multi-wallet done: ${succeeded} succeeded, ${failed} failed`, succeeded > 0 ? 'ok' : 'err');

  return results.map((r, i) => ({
    wallet: i + 1,
    status: r.status,
    value:  r.value  || null,
    reason: r.reason?.message || null
  }));
}

/* ══════════════════════════════════════
   EXECUTE MINT — core
   Route 1: ABI-aware + simulation + dynamic gas
   Route 2: Brute-force + dynamic gas
══════════════════════════════════════ */
export async function executeMint(contractAddr, signer, qty, log, options = {}) {
  const { maxGas = null, tip = null, manualPrice = null, gasMode = 'normal' } = options;

  /* ── Network check ── */
  try {
    const network = await signer.provider.getNetwork();
    if (network.chainId !== 1) {
      throw new Error(`Wrong network: "${network.name}" (chain ${network.chainId}). Switch to Ethereum Mainnet.`);
    }
    log("Network: Ethereum Mainnet ✓");
  } catch(e) {
    if (e.message.includes("Wrong network")) throw e;
    log("Could not verify network — proceeding with caution", "warn");
  }

  /* ── Dynamic gas ── */
  const gas = await getDynamicGas(signer.provider, maxGas, tip, gasMode);
  log(`Gas [${gasMode.toUpperCase()}]: base ${gas.baseFeeGwei ? gas.baseFeeGwei.toFixed(1) : '?'} · max ${gas.maxGwei} · tip ${gas.tipGwei} gwei`);
  const { maxFeePerGas, maxPriorityFeePerGas } = gas;

  const addr = await signer.getAddress();

  /* ── Route 1: ABI-aware ── */
  try {
    log("Fetching ABI…");
    const abi      = await fetchABI(contractAddr);
    const contract = new ethers.Contract(contractAddr, abi, signer);
    const mintFns  = findMintFunctions(abi);

    if (mintFns.length === 0) throw new Error("No mint function found in ABI");
    log(`Found ${mintFns.length} mint function(s)`);

    /* Price */
    let unitPrice;
    if (manualPrice !== null && manualPrice > 0) {
      unitPrice = ethers.utils.parseEther(String(manualPrice));
      log("Price (manual): " + manualPrice + " ETH");
    } else {
      const detected = await detectPrice(contractAddr, signer.provider);
      unitPrice = detected ? ethers.utils.parseEther(detected) : ethers.constants.Zero;
      log("Price (detected): " + ethers.utils.formatEther(unitPrice) + " ETH");
    }

    for (const fn of mintFns) {
      try {
        log("Trying: " + fn.name + "()");
        const args  = buildArgs(fn, qty, addr);
        let   value = unitPrice.mul(qty);

        /* Simulate */
        try {
          await contract.callStatic[fn.name](...args, { value });
          log("Simulation passed ✓");
        } catch(simErr) {
          try {
            await contract.callStatic[fn.name](...args);
            value = ethers.constants.Zero;
            log("Simulation passed (free mint) ✓");
          } catch(e) {
            log("Simulation failed — skipping " + fn.name);
            continue;
          }
        }

        /* Estimate gas */
        let gasLimit = 300000;
        try {
          const est = await contract.estimateGas[fn.name](...args, { value });
          gasLimit  = Math.ceil(est.toNumber() * 1.2);
          log("Gas estimated: " + gasLimit);
        } catch(e) {
          log("Gas estimation failed — using 300k fallback", "warn");
        }

        const tx = await contract[fn.name](...args, { value, maxFeePerGas, maxPriorityFeePerGas, gasLimit });
        log("TX sent: " + tx.hash);
        const receipt = await tx.wait();
        log(`✅ Mint confirmed! Block ${receipt.blockNumber} · Gas used: ${receipt.gasUsed}`);
        return { success: true, hash: tx.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed?.toString() };

      } catch(err) {
        if (err.code === 4001) throw new Error("Rejected by user");
        log("Failed: " + fn.name + " — " + (err.reason || err.message).slice(0, 80));
      }
    }
    throw new Error("All ABI functions failed");

  } catch(abiErr) {
    if (abiErr.message === "Rejected by user") throw abiErr;
    log("ABI route failed: " + abiErr.message);
    log("Trying brute-force signatures…");
  }

  /* ── Route 2: Brute-force ── */
  const SIGS = [
    "mint(uint256)", "mint()",
    "publicMint(uint256)", "publicMint()",
    "buy(uint256)", "buy()",
    "claim(uint256)", "claim()",
    "purchase(uint256)",
    "freeMint(uint256)", "freeMint()"
  ];

  const bruteValue = manualPrice
    ? ethers.utils.parseEther(String(manualPrice * qty))
    : ethers.constants.Zero;

  for (const sig of SIGS) {
    try {
      log("Trying: " + sig);
      const iface  = new ethers.utils.Interface(["function " + sig]);
      const fnName = sig.split("(")[0];
      const data   = sig.includes("uint256")
        ? iface.encodeFunctionData(fnName, [qty])
        : iface.encodeFunctionData(fnName);

      let gasLimit = 300000;
      try {
        const est = await signer.estimateGas({ to: contractAddr, value: bruteValue, data });
        gasLimit  = Math.ceil(est.toNumber() * 1.2);
      } catch(e) {}

      const tx = await signer.sendTransaction({ to: contractAddr, value: bruteValue, data, maxFeePerGas, maxPriorityFeePerGas, gasLimit });
      log("TX sent: " + tx.hash);
      const receipt = await tx.wait();
      log(`✅ Mint confirmed! Block ${receipt.blockNumber} · Gas used: ${receipt.gasUsed}`);
      return { success: true, hash: tx.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed?.toString() };

    } catch(err) {
      if (err.code === 4001) throw new Error("Rejected by user");
      log("Failed: " + sig);
    }
  }

  throw new Error("All mint attempts failed");
}

/* ══════════════════════════════════════
   PRIVATE KEY SIGNER
══════════════════════════════════════ */
export function createPrivateKeySigner(privateKey, rpcUrl = ETH_RPC) {
  if (!privateKey?.trim()) throw new Error("Private key is empty");
  const pk = privateKey.trim().startsWith("0x") ? privateKey.trim() : "0x" + privateKey.trim();
  if (pk.length !== 66) throw new Error("Invalid private key length");
  return new ethers.Wallet(pk, new ethers.providers.JsonRpcProvider(rpcUrl));
}

export async function getPrivateKeyAddress(privateKey) {
  return await createPrivateKeySigner(privateKey).getAddress();
}
