/**
 * mintEngine.js — Blockchain logic only
 * Handles: ABI fetching, mint function detection,
 * price detection, arg building, simulation, tx execution
 */

'use strict';

const ETHERSCAN_API_KEY = "YOUR_API_KEY"; // ← replace with your key from etherscan.io

/* ══════════════════════════════════════
   ABI FETCHING
   Direct → CORS proxy fallbacks
══════════════════════════════════════ */
export async function fetchABI(address) {
  const url = `https://api.etherscan.io/api?module=contract&action=getabi&address=${address}&apikey=${ETHERSCAN_API_KEY}`;

  const sources = [
    url,
    `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];

  for (const src of sources) {
    try {
      const res = await fetch(src);
      const data = await res.json();
      if (data.status === "1" && data.result) {
        return JSON.parse(data.result);
      }
    } catch(e) {}
  }

  throw new Error("ABI not found — contract may not be verified on Etherscan");
}

/* ══════════════════════════════════════
   MINT FUNCTION DETECTION
   Filters payable functions, ranks by priority
══════════════════════════════════════ */
function rankFunctions(funcs) {
  const priority = ["mint", "public", "buy", "claim", "purchase", "free"];
  return funcs.sort((a, b) => {
    const aScore = priority.findIndex(p => a.name.toLowerCase().includes(p));
    const bScore = priority.findIndex(p => b.name.toLowerCase().includes(p));
    return (aScore === -1 ? 99 : aScore) - (bScore === -1 ? 99 : bScore);
  });
}

export function findMintFunctions(abi) {
  const funcs = abi.filter(fn =>
    fn.type === "function" &&
    (fn.stateMutability === "payable" || fn.stateMutability === "nonpayable") &&
    /mint|buy|claim|purchase|free/i.test(fn.name)
  );
  return rankFunctions(funcs);
}

/* ══════════════════════════════════════
   PRICE DETECTION
   Tries common price getter names
══════════════════════════════════════ */
export async function detectPrice(contract) {
  const priceFns = [
    "publicPrice", "cost", "mintPrice", "price",
    "PRICE", "mintCost", "salePrice", "tokenPrice"
  ];
  for (const fn of priceFns) {
    try {
      if (contract[fn]) {
        const p = await contract[fn]();
        if (p && p > 0n) return p;
      }
    } catch(e) {}
  }
  return 0n;
}

/* ══════════════════════════════════════
   BUILD ARGS
   Constructs calldata args from ABI input types
══════════════════════════════════════ */
export function buildArgs(fn, qty, addr) {
  if (!fn.inputs || fn.inputs.length === 0) return [];
  return fn.inputs.map(inp => {
    const t = inp.type;
    if (t.includes("uint")) return qty;
    if (t === "address")   return addr;
    if (t === "bool")      return true;
    if (t === "bytes")     return "0x";
    return qty;
  });
}

/* ══════════════════════════════════════
   EXECUTE MINT — main entry point
   Route 1: ABI-aware + simulation
   Route 2: Brute-force signatures fallback
══════════════════════════════════════ */
export async function executeMint(contractAddr, signer, qty, log, options = {}) {
  const {
    maxGas    = 50,
    tip       = 2,
    manualPrice = null   // ETH as number e.g. 0.08
  } = options;

  const maxFeePerGas         = ethers.utils.parseUnits(String(maxGas), "gwei");
  const maxPriorityFeePerGas = ethers.utils.parseUnits(String(tip), "gwei");
  const addr                 = await signer.getAddress();

  /* ── Route 1: ABI-aware ── */
  try {
    log("Fetching ABI…");
    const abi      = await fetchABI(contractAddr);
    const contract = new ethers.Contract(contractAddr, abi, signer);
    const mintFns  = findMintFunctions(abi);

    if (mintFns.length === 0) throw new Error("No mint function found in ABI");
    log(`Found ${mintFns.length} mint function(s)`);

    // Price — use manual override if provided, otherwise detect from contract
    let unitPrice;
    if (manualPrice !== null && manualPrice > 0) {
      unitPrice = ethers.utils.parseEther(String(manualPrice));
      log("Price (manual): " + manualPrice + " ETH");
    } else {
      unitPrice = await detectPrice(contract);
      log("Price (detected): " + ethers.utils.formatEther(unitPrice) + " ETH");
    }

    for (const fn of mintFns) {
      try {
        log("Trying: " + fn.name + "()");
        const args  = buildArgs(fn, qty, addr);
        let   value = unitPrice * BigInt(qty);

        // Simulate first
        try {
          await contract[fn.name].staticCall(...args, { value });
          log("Simulation passed ✓");
        } catch(simErr) {
          // Retry as free mint (no value)
          try {
            await contract[fn.name].staticCall(...args);
            value = 0n;
            log("Simulation passed (free mint) ✓");
          } catch(e) {
            log("Simulation failed — skipping " + fn.name);
            continue;
          }
        }

        const tx = await contract[fn.name](...args, {
          value,
          maxFeePerGas,
          maxPriorityFeePerGas,
          gasLimit: 300000
        });

        log("TX sent: " + tx.hash);
        await tx.wait();
        log("✅ Mint confirmed!");
        return { success: true, hash: tx.hash };

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
    : ethers.utils.parseEther("0");

  for (const sig of SIGS) {
    try {
      log("Trying: " + sig);
      const iface  = new ethers.utils.Interface(["function " + sig]);
      const fnName = sig.split("(")[0];
      const data   = sig.includes("uint256")
        ? iface.encodeFunctionData(fnName, [qty])
        : iface.encodeFunctionData(fnName);

      const tx = await signer.sendTransaction({
        to: contractAddr,
        value: bruteValue,
        data,
        maxFeePerGas,
        maxPriorityFeePerGas,
        gasLimit: 300000
      });

      log("TX sent: " + tx.hash);
      await tx.wait();
      log("✅ Mint confirmed!");
      return { success: true, hash: tx.hash };

    } catch(err) {
      if (err.code === 4001) throw new Error("Rejected by user");
      log("Failed: " + sig);
    }
  }

  throw new Error("All mint attempts failed");
}
