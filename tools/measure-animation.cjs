// Native WebView2 animation measurements; isolates application state.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(__dirname,'../../verify-tools/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),out=path.join(root,'tools/verify');
const label=process.argv[2]||'current';
assert(/^[a-z0-9-]+$/.test(label));
const exe=path.resolve(process.argv[3]||path.join(root,'dist/FocusIsland.exe'));
const profile=fs.mkdtempSync(path.join(out,'perf-'));
const state={tasks:[{id:'perf',name:'动画验证',sec:1500}],current_id:'perf',duration_sec:1500,settings:{showHands:true,showSecond:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false}};
fs.writeFileSync(path.join(profile,'state.json'),JSON.stringify(state));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child,browser,page,cdp;
const report={label,exe,cases:[],errors:[]};
async function metrics(){return Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));}
async function measure(name,action){
 await page.evaluate(()=>{
  const sample=window.__measure={frames:[],last:0,writes:0,live:true};
  const secondHand=document.querySelector('#handSecond');
  let lastTransform=secondHand.style.transform||secondHand.getAttribute('transform');
  window.__measureObserver=new MutationObserver(()=>{const transform=secondHand.style.transform||secondHand.getAttribute('transform');if(transform!==lastTransform){sample.writes++;lastTransform=transform;}});
  __measureObserver.observe(secondHand,{attributes:true,attributeFilter:['transform','style']});
  const frame=t=>{if(!sample.live)return;if(sample.last)sample.frames.push(t-sample.last);sample.last=t;requestAnimationFrame(frame);};
  requestAnimationFrame(frame);
 });
 const before=await metrics(),begin=Date.now();
 await action();
 const after=await metrics();
 const samples=await page.evaluate(()=>{__measure.live=false;__measureObserver.disconnect();return __measure;});
 const sorted=samples.frames.slice().sort((a,b)=>a-b),sum=samples.frames.reduce((a,b)=>a+b,0);
 const stats={name,elapsedMs:Date.now()-begin,frames:sorted.length,averageFrameMs:+(sum/Math.max(1,sorted.length)).toFixed(2),p95FrameMs:+(sorted[Math.floor(sorted.length*.95)]||0).toFixed(2),maxFrameMs:+(sorted.at(-1)||0).toFixed(2),framesOver34ms:sorted.filter(t=>t>34).length,secondHandUpdates:samples.writes};
 for(const key of ['LayoutCount','RecalcStyleCount','LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration'])stats[key]=+(after[key]-before[key]).toFixed(6);
 report.cases.push(stats);console.log(JSON.stringify(stats));
}
(async()=>{
 try{
  child=spawn(exe,['--debug-port','9461','--data-dir',profile],{cwd:root,windowsHide:true});
  for(let n=0;n<100;n++){
   try{browser=await chromium.connectOverCDP('http://127.0.0.1:9461');break;}catch{await delay(200);}
  }
  assert(browser,'Native CDP starts');
  for(let n=0;n<100&&!page;n++){
   for(const context of browser.contexts())for(const candidate of context.pages())if(await candidate.evaluate(()=>document.body?.dataset.view).catch(()=>null)==='island')page=candidate;
   if(!page)await delay(100);
  }
  assert(page,'Island loaded');
  page.on('pageerror',error=>report.errors.push(error.message));
  await page.waitForFunction(()=>typeof window.__fromRust==='function');
  cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  report.browser=await (await browser.newBrowserCDPSession()).send('Browser.getVersion');
  await delay(600);
  await measure('collapsed-idle',()=>delay(1200));
  await measure('eight-expand-collapse',async()=>{for(let n=0;n<8;n++){await page.evaluate(()=>document.querySelector('#island').click());await delay(700);}});
  await page.evaluate(()=>window.__selftestOpen());await delay(700);
  await measure('expanded-clock',()=>delay(1200));
  await page.evaluate(s=>window.__applyState({...s,duration_sec:1},true),state);await delay(300);
  await measure('one-second-countdown-and-completion',async()=>{
   await page.evaluate(()=>window.__fromRust('toggleTimer'));
   await page.waitForFunction(()=>document.querySelector('#island').classList.contains('is-finishing'));
   await page.waitForFunction(()=>!document.querySelector('#island').classList.contains('is-finishing'));
   await delay(100);
  });
  assert.deepEqual(report.errors,[]);report.passed=true;
 }finally{
  if(page&&!page.isClosed())await page.evaluate(()=>window.ipc.postMessage(JSON.stringify({type:'quit'}))).catch(()=>{});
  await delay(500);if(browser)await browser.close().catch(()=>{});if(child&&child.exitCode===null)child.kill();
  fs.writeFileSync(path.join(out,'animation-'+label+'.json'),JSON.stringify(report,null,2)+'\n');
  const actual=fs.realpathSync(profile),parent=fs.realpathSync(out);
  if(path.dirname(actual).toLowerCase()===parent.toLowerCase()&&/^perf-[A-Za-z0-9]{6}$/.test(path.basename(actual))){try{fs.rmSync(actual,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
