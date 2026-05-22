'use strict';
const $=id=>document.getElementById(id);

/* ── STATE ── */
const S={
  provider:null, signer:null, walletAddr:null,
  ethPrice:0, gasPrice:0,
  tasks:[], mode:'scheduled',
  pendingTask:null
};

/* ── PRICES ── */
let _prev=0;
async function loadPrices(){
  try{const c=JSON.parse(localStorage.getItem('mb_p')||'{}');if(c.eth)_setEth(c.eth);}catch(e){}
  try{
    const r=await Promise.race([fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'),new Promise((_,rej)=>setTimeout(rej,5e3))]);
    const d=await r.json();const p=d.ethereum.usd;
    _setEth(p);S.ethPrice=p;localStorage.setItem('mb_p',JSON.stringify({eth:p}));
  }catch(e){
    try{const r=await fetch('https://api.coincap.io/v2/assets/ethereum');const d=await r.json();_setEth(parseFloat(d.data.priceUsd));}catch(e2){}
  }
}
function _setEth(p){
  const el=$('ethP');if(!el||!p)return;
  const up=p>_prev;
  el.textContent='$'+p.toLocaleString('en-US',{maximumFractionDigits:0});
  if(_prev&&p!==_prev){el.className='sv '+(up?'up':'down');setTimeout(()=>el.className='sv',700);}
  _prev=p;S.ethPrice=p;
}
async function loadGas(){
  try{
    const r=await fetch('https://ethereum.publicnode.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'eth_gasPrice',params:[],id:1})});
    const d=await r.json();
    if(d.result){const g=Math.round(parseInt(d.result,16)/1e9);S.gasPrice=g;$('gasP').textContent=g;}
  }catch(e){}
}

/* ── CLOCK ── */
function tick(){$('clk').textContent=new Date().toLocaleTimeString('en-US',{hour12:false});}

/* ── LOG ── */
function log(msg,t=''){
  const d=document.createElement('div');d.className='le '+(t||'');
  d.innerHTML=`<span class="ts">[${new Date().toLocaleTimeString('en-US',{hour12:false})}]</span>${msg}`;
  const l=$('botLog');l.insertBefore(d,l.firstChild);
  while(l.children.length>80)l.removeChild(l.lastChild);
}

/* ── WALLET CONNECTION (ethers.js) ── */
async function connectWallet(){
  if(!window.ethereum){
    alert('MetaMask not detected. Install MetaMask to mint on-chain.');
    return;
  }
  try{
    S.provider=new ethers.providers.Web3Provider(window.ethereum);
    await S.provider.send('eth_requestAccounts',[]);
    S.signer=S.provider.getSigner();
    S.walletAddr=await S.signer.getAddress();
    $('walletBtn').textContent=S.walletAddr.slice(0,6)+'…'+S.walletAddr.slice(-4);
    $('walletBtn').classList.add('connected');
    $('uAddr')&&($('uAddr').value=S.walletAddr);
    log('Wallet connected: '+S.walletAddr,'ok');
    // Auto-fill wallet address in any address fields
    document.querySelectorAll('input[placeholder="0x…"]').forEach(inp=>{
      if(inp.id!=='cAddr'&&inp.id!=='mdUrl')inp.value=S.walletAddr;
    });
  }catch(e){log('Wallet connection failed: '+e.message,'err');}
}

/* ── CONTRACT ANALYZE ── */
async function analyze(){
  const addr=$('cAddr').value.trim();
  if(!addr.match(/^0x[a-fA-F0-9]{40}$/)){log('Invalid contract address','err');return;}
  log('Analyzing contract '+addr.slice(0,10)+'…','info');
  $('analyzeBtn').textContent='…';

  const calls=[
    {id:'price',  data:'0xa0712d68'}, // mintPrice() / price()
    {id:'price2', data:'0x1f931c1c'}, // cost()
    {id:'supply', data:'0xd5abeb01'}, // maxSupply()
    {id:'supply2',data:'0x18160ddd'}, // totalSupply()
    {id:'paused', data:'0x5c975abb'}, // paused()
    {id:'minted', data:'0x70a08231'}, // balanceOf stub
  ];

  const results={};
  await Promise.all(calls.map(async c=>{
    try{
      const r=await fetch('https://ethereum.publicnode.com',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',method:'eth_call',params:[{to:addr,data:c.data+(S.walletAddr?S.walletAddr.slice(2).padStart(64,'0'):'0'.repeat(64))},'latest'],id:1})});
      const d=await r.json();results[c.id]=d.result;
    }catch(e){}
  }));

  // Parse price
  let price=0;
  if(results.price&&results.price!=='0x'&&results.price.length>=66)price=parseInt(results.price,16)/1e18;
  if(!price&&results.price2&&results.price2!=='0x'&&results.price2.length>=66)price=parseInt(results.price2,16)/1e18;

  // Parse supply
  let maxSupply=0,totalMinted=0;
  if(results.supply&&results.supply!=='0x')maxSupply=parseInt(results.supply,16);
  if(results.supply2&&results.supply2!=='0x')totalMinted=parseInt(results.supply2,16);

  // Parse paused
  let paused=false;
  if(results.paused&&results.paused!=='0x')paused=parseInt(results.paused,16)===1;

  // Risk score
  let risk='LOW',riskClass='risk-low';
  if(paused){risk='HIGH — PAUSED';riskClass='risk-high';}
  else if(maxSupply>0&&totalMinted>=maxSupply){risk='HIGH — SOLD OUT';riskClass='risk-high';}
  else if(price>1){risk='MEDIUM — HIGH PRICE';riskClass='risk-med';}

  // Auto-fill price
  if(price>0)$('mPrc').value=price.toFixed(4);

  // Show results
  $('aPrice').textContent=price>0?price.toFixed(4)+' Ξ':'Not detected';
  $('aPrice').className='analysis-val '+(price>0?'ok':'warn');
  $('aFn').textContent=$('mFn').value;
  $('aSupply').textContent=maxSupply>0?maxSupply.toLocaleString():'Not detected';
  $('aMinted').textContent=totalMinted>0?totalMinted.toLocaleString():'Not detected';
  $('aPaused').textContent=paused?'Yes':'No';
  $('aPaused').className='analysis-val '+(paused?'err':'ok');
  $('aRisk').innerHTML=`<span class="risk-badge ${riskClass}">${risk}</span>`;

  $('analysisPanel').classList.add('show');
  $('analyzeBtn').textContent='Analyze';
  log('Analysis complete — price: '+(price>0?price.toFixed(4)+'Ξ':'unknown')+' · risk: '+risk,'ok');
}

/* ── MINT NOW via ethers.js ── */
async function mintNow(){
  if(!S.signer){log('Connect wallet first','err');return;}
  const contract=$('cAddr').value.trim();
  if(!contract.match(/^0x[a-fA-F0-9]{40}$/)){log('Invalid contract address','err');return;}
  const qty=parseInt($('mQty').value)||1;
  const price=parseFloat($('mPrc').value)||0;
  const gasLimit=parseInt($('mGas').value)||200000;
  const tip=parseFloat($('mTip').value)||2;
  const fn=$('mFn').value.trim()||'mint(uint256)';

  log('Preparing on-chain mint: '+contract.slice(0,10)+'… ×'+qty,'info');

  try{
    // Build minimal ABI from function signature
    const abi=[`function ${fn}`];
    const c=new ethers.Contract(contract,abi,S.signer);
    const fnName=fn.split('(')[0];
    const value=ethers.utils.parseEther((price*qty).toFixed(8));
    const maxFeePerGas=ethers.utils.parseUnits(gasLimit.toString(),'gwei');
    const maxPriorityFeePerGas=ethers.utils.parseUnits(tip.toString(),'gwei');

    log('Sending tx — confirm in MetaMask…','warn');
    const tx=await c[fnName](qty,{value,maxFeePerGas,maxPriorityFeePerGas,gasLimit:300000});
    log('TX sent: <a class="tx-link" href="https://etherscan.io/tx/'+tx.hash+'" target="_blank">'+tx.hash.slice(0,18)+'…</a>','ok');

    // Wait for confirmation
    log('Waiting for confirmation…','info');
    const receipt=await tx.wait();
    log('✓ Mint confirmed! Block '+receipt.blockNumber+' · Gas used: '+receipt.gasUsed.toString(),'ok');
  }catch(e){
    if(e.code===4001)log('Transaction rejected by user','warn');
    else log('Mint failed: '+(e.reason||e.message),'err');
  }
}

/* ── MODES ── */
document.querySelectorAll('#modeBar .mtab').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('#modeBar .mtab').forEach(x=>x.classList.remove('on'));
  b.classList.add('on');S.mode=b.dataset.mode;
  const n={scheduled:'Fires at the scheduled time',sniper:'Polls every 10s — fires the instant mint goes live',manual:'Queued — hit ⚡ Fire anytime'};
  $('mNote').textContent=n[S.mode];
  $('schFld').style.display=S.mode==='scheduled'?'block':'none';
}));

/* ── ADD TASK ── */
$('addTask').addEventListener('click',()=>{
  const contract=$('cAddr').value.trim();
  if(!contract.match(/^0x[a-fA-F0-9]{40}$/)){log('Invalid contract address','err');return;}
  const addr=S.walletAddr||'0x0000000000000000000000000000000000000000';
  const t={id:Date.now(),addr,contract,
    fn:$('mFn').value.trim()||'mint(uint256)',
    qty:parseInt($('mQty').value)||1,
    price:parseFloat($('mPrc').value)||0,
    maxGas:parseInt($('mGas').value)||50,
    tip:parseFloat($('mTip').value)||2,
    mode:S.mode,
    time:S.mode==='scheduled'?new Date($('mTime').value):null,
    status:S.mode==='manual'?'ready':'waiting'};
  S.tasks.unshift(t);renderTasks();
  log(`[${S.mode.toUpperCase()}] Queued: ${contract.slice(0,10)}… ×${t.qty} @ ${t.price}Ξ`,'ok');
});

/* ── RENDER TASKS ── */
function fmtCD(t){const d=new Date(t)-new Date();if(d<=0)return'NOW';const h=Math.floor(d/36e5),m=Math.floor((d/6e4)%60),s=Math.floor((d/1e3)%60);return h>0?`${h}h ${m}m`:`${m}m ${s}s`;}

function renderTasks(){
  $('tskCnt').textContent=S.tasks.length+' task'+(S.tasks.length!==1?'s':'');
  const el=$('actTasks');
  if(!S.tasks.length){
    el.innerHTML='<div class="empty"><div class="empty-ico">⚡</div><div class="empty-h">No tasks queued</div><div class="empty-p">Add a task from the form, or use Mint Direct below.</div></div>';
    return;
  }
  el.innerHTML=S.tasks.map(t=>`
    <div class="tcard ${t.status}">
      <div class="tc-top">
        <div><div class="tc-addr">${t.contract.slice(0,14)}…${t.contract.slice(-4)}</div>
          <div class="tc-from">${t.addr!=='0x0000000000000000000000000000000000000000'?'FROM '+t.addr.slice(0,10)+'…'+t.addr.slice(-4)+' · ':''} ${t.mode.toUpperCase()}</div></div>
        <span class="tc-badge ${t.status}">${t.status.toUpperCase()}</span>
      </div>
      <div class="tc-meta">
        <div><span class="tcml">Function</span><span class="tcmv">${t.fn.slice(0,14)}</span></div>
        <div><span class="tcml">Qty</span><span class="tcmv">${t.qty}</span></div>
        <div><span class="tcml">Price</span><span class="tcmv">${t.price}Ξ</span></div>
        <div><span class="tcml">${t.mode==='scheduled'?'Fires In':'State'}</span><span class="tcmv hi">${t.time?fmtCD(t.time):t.mode==='sniper'?'WATCHING':'ON DEMAND'}</span></div>
      </div>
      <div class="tc-acts">
        <button class="tbtn fire" data-id="${t.id}" data-a="fire">⚡ Fire</button>
        <button class="tbtn del" data-id="${t.id}" data-a="del">✕</button>
      </div>
    </div>`).join('');
  el.querySelectorAll('.tbtn').forEach(b=>b.addEventListener('click',()=>{
    const t=S.tasks.find(x=>x.id==b.dataset.id);if(!t)return;
    if(b.dataset.a==='fire'){t.status='ready';openModal(t);}
    if(b.dataset.a==='del'){S.tasks=S.tasks.filter(x=>x.id!=b.dataset.id);renderTasks();log('Task cancelled','warn');}
  }));
}

/* ── SNIPER ── */
function tickTasks(){
  S.tasks.forEach(t=>{
    if(t.mode==='scheduled'&&t.time&&t.status==='waiting'&&new Date()>=t.time){
      t.status='ready';log('⚡ SCHEDULED FIRED: '+t.contract.slice(0,12)+'…','ok');openModal(t);
    }
    if(t.mode==='sniper'&&t.status==='waiting'){
      const now=Math.floor(Date.now()/1e3);
      if(!t._p||now-t._p>=10){
        t._p=now;t.status='watching';
        fetch('https://ethereum.publicnode.com',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({jsonrpc:'2.0',method:'eth_call',params:[{to:t.contract,data:'0x1249c58b'},'latest'],id:1})})
          .then(r=>r.json()).then(d=>{
            // 0x1249c58b = mint() no args — if it doesn't revert, mint is open
            if(d.result!==undefined&&!d.error){
              t.status='ready';log('⚡ SNIPER HIT: '+t.contract.slice(0,12)+'… mint is LIVE','ok');openModal(t);
            }else t.status='waiting';renderTasks();
          }).catch(()=>{t.status='waiting';});
      }
    }
  });
  renderTasks();
}

/* ── OPEN MODAL ── */
function openModal(t){
  S.pendingTask=t;
  const tot=t.price*t.qty;
  const data=buildCalldata(t.fn,t.qty);
  const vW=ethers.utils.parseEther(tot.toFixed(8));

  $('txPrev').innerHTML=[
    ['To',t.contract.slice(0,16)+'…'+t.contract.slice(-4)],
    ['Function',t.fn],
    ['Qty / Value',`${t.qty} × ${t.price}Ξ = ${tot.toFixed(4)}Ξ${S.ethPrice?' (~$'+(tot*S.ethPrice).toFixed(2)+')':''}`],
    ['Gas',`${t.maxGas} gwei max · ${t.tip} gwei tip`],
    ['Calldata',data.slice(0,18)+'…'],
  ].map(([k,v])=>`<div class="txr"><span class="txk">${k}</span><span class="txv">${v}</span></div>`).join('');

  // Wallet deep-links as fallback
  $('btnRainbow').href=`https://rnbwapp.com/wc?uri=${encodeURIComponent('ethereum:'+t.contract+'@1?value='+vW.toString()+'&data='+data)}`;
  $('btnTrust').href=`trust://send?address=${t.contract}&amount=${tot}&coin=60&data=${data}`;

  // If MetaMask is connected, preferred action is sign directly
  if(S.signer){
    $('modalDesc').textContent='MetaMask connected — sign the pre-built transaction directly.';
    $('btnSignMM').style.display='block';
  }else{
    $('modalDesc').textContent='No wallet connected — use a deep-link to open in your wallet app.';
    $('btnSignMM').style.display='none';
  }

  $('overlay').classList.add('open');
  log('Modal opened for '+t.contract.slice(0,12)+'…','info');
}

/* ── SIGN WITH METAMASK ── */
async function signWithMetaMask(){
  const t=S.pendingTask;
  if(!t||!S.signer){log('No wallet or task','err');return;}
  const tot=t.price*t.qty;
  const data=buildCalldata(t.fn,t.qty);
  const value=ethers.utils.parseEther(tot.toFixed(8));
  const maxFeePerGas=ethers.utils.parseUnits(t.maxGas.toString(),'gwei');
  const maxPriorityFeePerGas=ethers.utils.parseUnits(t.tip.toString(),'gwei');
  try{
    log('Confirm in MetaMask…','warn');
    const tx=await S.signer.sendTransaction({to:t.contract,value,data,maxFeePerGas,maxPriorityFeePerGas,gasLimit:300000});
    $('overlay').classList.remove('open');
    log('TX sent: <a class="tx-link" href="https://etherscan.io/tx/'+tx.hash+'" target="_blank">'+tx.hash.slice(0,18)+'…</a>','ok');
    S.tasks=S.tasks.filter(x=>x.id!==t.id);renderTasks();
    tx.wait().then(r=>log('✓ Confirmed! Block '+r.blockNumber,'ok')).catch(e=>log('TX failed: '+e.message,'err'));
  }catch(e){
    if(e.code===4001)log('Rejected by user','warn');
    else log('TX error: '+(e.reason||e.message),'err');
  }
}

function buildCalldata(fn,qty){
  // Encode function selector + uint256 arg
  const sig=fn.trim();
  const selector=ethers.utils.id(sig).slice(0,10);
  const encoded=ethers.utils.defaultAbiCoder.encode(['uint256'],[qty]);
  return selector+encoded.slice(2);
}

$('mdClose').onclick=()=>$('overlay').classList.remove('open');
$('overlay').onclick=e=>{if(e.target.id==='overlay')$('overlay').classList.remove('open');};

/* ── MINT DIRECT ── */
const MD={contract:null,price:0,name:''};
function parseUrl(raw){
  raw=raw.trim();
  if(raw.match(/^0x[a-fA-F0-9]{40}$/))return{type:'contract',value:raw,platform:'direct'};
  const maps=[
    [/opensea\.io\/collection\/([^/?#]+)/,'opensea','slug'],
    [/opensea\.io\/assets\/ethereum\/(0x[a-fA-F0-9]{40})/,'opensea','contract'],
    [/zora\.co\/collect\/(?:zora|eth):(0x[a-fA-F0-9]{40})/,'zora','contract'],
    [/mint\.fun\/(0x[a-fA-F0-9]{40})/,'mintfun','contract'],
    [/foundation\.app\/@[^/]+\/([^/?#]+)/,'foundation','slug'],
    [/app\.manifold\.xyz\/c\/([^/?#]+)/,'manifold','slug'],
    [/nft\.coinbase\.com\/collection\/ethereum\/(0x[a-fA-F0-9]{40})/,'coinbase','contract'],
    [/rarible\.com\/collection\/(0x[a-fA-F0-9]{40})/,'rarible','contract'],
  ];
  for(const[re,platform,type]of maps){const m=raw.match(re);if(m)return{type,value:m[1],platform};}
  if(raw.length>3&&!raw.includes(' '))return{type:'slug',value:raw,platform:'opensea'};
  return null;
}
function mdSt(msg,t=''){const el=$('mdStatus');el.style.display='block';el.className='md-st'+(t?' '+t:'');el.textContent=msg;}

$('mdFetch').addEventListener('click',async()=>{
  const raw=$('mdUrl').value.trim();
  if(!raw){mdSt('Paste a mint link or 0x address.','err');return;}
  const parsed=parseUrl(raw);
  if(!parsed){mdSt('Unrecognised — try pasting the 0x contract address.','err');return;}
  mdSt('Fetching…');$('mdResult').style.display='none';
  try{
    let contract=null,name='',floor=0,supply='—';
    if(parsed.type==='contract'){
      contract=parsed.value;
      try{
        const r=await fetch('https://ethereum.publicnode.com',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'eth_call',params:[{to:contract,data:'0x06fdde03'},'latest'],id:1})});
        const d=await r.json();
        if(d.result&&d.result.length>66){const hex=d.result.slice(130);name=hex.match(/../g)?.map(b=>String.fromCharCode(parseInt(b,16))).join('').replace(/\x00/g,'').trim()||'';}
      }catch(e){}
      if(!name)name='Contract '+contract.slice(0,8)+'…';
    }else{
      for(const px of['https://corsproxy.io/?url=','https://api.allorigins.win/raw?url=']){
        try{
          const r=await fetch(px+encodeURIComponent('https://api.opensea.io/api/v2/collections/'+parsed.value),{headers:{Accept:'application/json'}});
          const d=await r.json();
          if(d&&!d.errors){
            contract=d.contracts?.[0]?.address||null;name=d.name||parsed.value;
            supply=d.total_supply?parseInt(d.total_supply).toLocaleString():'—';
            try{const sr=await fetch(px+encodeURIComponent('https://api.opensea.io/api/v2/collections/'+d.collection+'/stats'),{headers:{Accept:'application/json'}});const sd=await sr.json();floor=sd.total?.floor_price||0;}catch(e){}
            break;
          }
        }catch(e){}
      }
    }
    if(!contract?.match(/^0x[a-fA-F0-9]{40}$/)){mdSt('Could not resolve — paste 0x address directly.','err');return;}
    MD.contract=contract;MD.price=floor;MD.name=name;
    $('mdMeta').innerHTML=[['Collection',name.slice(0,20)||'—'],['Contract',contract.slice(0,10)+'…'+contract.slice(-4)],['Floor',floor>0?floor.toFixed(4)+' Ξ':'—'],['Supply',supply]]
      .map(([l,v])=>`<div class="mdc"><span class="mdcl">${l}</span><span class="mdcv">${v}</span></div>`).join('');
    $('mdResult').style.display='block';
    mdSt('✓ Resolved — review and mint.','ok');
    // Auto-fill contract
    $('cAddr').value=contract;if(floor>0)$('mPrc').value=floor.toFixed(4);
    log('Mint Direct: '+name+' via '+parsed.platform,'ok');
  }catch(e){mdSt('Error: '+e.message,'err');}
});

$('mdMintNow').addEventListener('click',async()=>{
  if(!MD.contract){mdSt('Fetch a contract first.','err');return;}
  $('cAddr').value=MD.contract;if(MD.price>0)$('mPrc').value=MD.price.toFixed(4);
  if(S.signer){await mintNow();}
  else{
    const t={id:Date.now(),addr:S.walletAddr||'0x0000000000000000000000000000000000000000',
      contract:MD.contract,fn:'mint(uint256)',
      qty:parseInt($('mQty').value)||1,price:MD.price||parseFloat($('mPrc').value)||0,
      maxGas:parseInt($('mGas').value)||50,tip:parseFloat($('mTip').value)||2,
      mode:'manual',time:null,status:'ready'};
    openModal(t);log('Mint Direct ⚡ '+MD.name+' ×'+t.qty,'ok');
  }
});

$('mdQueue').addEventListener('click',()=>{
  if(!MD.contract){mdSt('Fetch a contract first.','err');return;}
  $('cAddr').value=MD.contract;if(MD.price>0)$('mPrc').value=MD.price.toFixed(4);
  mdSt('✓ Pre-filled — set mode and add to queue.','ok');
  log('Pre-filled form for '+MD.name,'info');
});

/* ── INIT ── */
async function init(){
  tick();setInterval(tick,1e3);setInterval(tickTasks,1e3);
  setInterval(loadPrices,30e3);setInterval(loadGas,30e3);
  const t=new Date();t.setHours(t.getHours()+1);$('mTime').value=t.toISOString().slice(0,16);
  renderTasks();
  await Promise.all([loadPrices(),loadGas()]);
}
init();