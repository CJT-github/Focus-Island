// Desktop-compositor regression: real clicks, sampled desktop pixels, native HWND/region invariants.
// Run outside the sandbox desktop. Close other Focus Island instances before running.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||path.resolve(__dirname,'../../verify-tools/node_modules/playwright'));
const root=path.resolve(__dirname,'..'),out=path.join(root,'tools/verify');
const label=process.argv[2]||'after';assert(/^[a-z0-9-]+$/.test(label));
const exe=path.resolve(process.argv[3]||path.join(root,'target/verified/release/focus-island.exe'));
const baseline=process.argv.includes('--baseline'),port=9469;
fs.mkdirSync(out,{recursive:true});
const profile=fs.mkdtempSync(path.join(out,'flicker-'));
const frames=path.join(out,'flicker-'+label+'-frames');fs.mkdirSync(frames,{recursive:true});
for(const filename of fs.readdirSync(frames))if(/^frame-[0-9]{5}\.png$/.test(filename))fs.unlinkSync(path.join(frames,filename));
const report={label,exe,baseline,checks:[],errors:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child,browser,page;
function check(name,condition,details){report.checks.push({name,passed:!!condition,details});if(!baseline)assert(condition,name+': '+JSON.stringify(details));}
async function connect(){
 for(let n=0;n<100&&!browser;n++){try{browser=await chromium.connectOverCDP('http://127.0.0.1:'+port);}catch{await delay(200);}}
 assert(browser,'CDP endpoint');
 for(let n=0;n<100&&!page;n++){
  for(const context of browser.contexts())for(const candidate of context.pages())if(await candidate.evaluate(()=>document.body?.dataset.view).catch(()=>null)==='island')page=candidate;
  if(!page)await delay(100);
 }
 assert(page,'Island WebView');
 page.on('pageerror',error=>report.errors.push(error.message));
 await page.waitForFunction(()=>typeof window.__isOpen==='function');
}
(async()=>{
 try{
  fs.writeFileSync(path.join(profile,'state.json'),JSON.stringify({tasks:[{id:'flicker',name:'动画闪烁回归',sec:1500}],current_id:'flicker',duration_sec:1500,settings:{showHands:true,showSecond:true,sound:false,notify:false,alwaysOnTop:true,reduceMotion:false}}));
  child=spawn(exe,['--debug-port',String(port),'--data-dir',profile,'--verbose','--log-file',path.join(profile,'diagnostic.log')],{cwd:root,windowsHide:true});
  child.on('error',error=>report.errors.push(error.message));
  await connect();await delay(500);
  const dpr=await page.evaluate(()=>devicePixelRatio);
  await page.evaluate(()=>{
   const sample=window.__flicker={live:true,frames:[],clicks:[]};
   document.querySelector('#island').addEventListener('click',()=>sample.clicks.push(performance.now()),true);
   function frame(t){if(!sample.live)return;sample.frames.push({ms:t,width:innerWidth,height:innerHeight,open:window.__isOpen(),classes:document.querySelector('#island').className});requestAnimationFrame(frame);}requestAnimationFrame(frame);
  });
  const captured=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'tools/capture-flicker.ps1'),'-AppProcessId',String(child.pid),'-OutputDirectory',frames,'-ToggleCount','10'],{cwd:root,windowsHide:true,timeout:25000,maxBuffer:4*1024*1024});
  report.desktop=JSON.parse(captured.stdout);report.webview=await page.evaluate(()=>{__flicker.live=false;return __flicker;});
  const samples=report.desktop.samples,first=samples[0];assert(samples.length,'Desktop frames captured');
  const unique=key=>[...new Set(samples.map(s=>s[key]))];
  const maxGap=Math.max(...samples.slice(1).map((s,i)=>s.ms-samples[i].ms));
  const greenMax=Math.max(...samples.map(s=>s.g));
  check('Real native mouse clicks reach island ten times',report.webview.clicks.length===10,report.webview.clicks.length);
  check('Desktop frames sampled across every transition',samples.length>400&&maxGap<100,{frames:samples.length,maxGap});
  check('Bright backing remains visible outside island',samples.every(s=>s.backingGreen===240),unique('backingGreen'));
  check('Glass never flashes white or exposes bright backing',greenMax<160,{maxGreen:greenMax,minGreen:Math.min(...samples.map(s=>s.g)),brightFrames:samples.filter(s=>s.g>=160).map(s=>s.ms)});
  check('Native position, size and extended style stay constant',samples.every(s=>['left','top','width','height','style'].every(k=>s[k]===first[k])),Object.fromEntries(['left','top','width','height','style'].map(k=>[k,unique(k)])));
  check('Native and WebView retain fixed 580 canvas',Math.abs(first.width-580*dpr)<=1&&Math.abs(first.height-580*dpr)<=1&&report.webview.frames.every(s=>s.width===580&&s.height===580),{native:[first.width,first.height],dpr,webviewSizes:[...new Set(report.webview.frames.map(s=>s.width+'x'+s.height))]});
  check('No layered or transparent style toggles',samples.every(s=>(s.style&(0x80000|0x20))===0),unique('style'));
  check('Native region covers glass and excludes transparent canvas',samples.every(s=>s.region>0&&s.regionCenter&&!s.regionOutside),{regionKinds:unique('region')});
  check('Glass receives input and transparent corners pass through',samples.every(s=>s.centerHitsIsland&&!s.outsideHitsIsland),{centerMisses:samples.filter(s=>!s.centerHitsIsland).length,outsideHits:samples.filter(s=>s.outsideHitsIsland).length});
  check('Final collapse state is retained',report.webview.frames.at(-1).open===false,report.webview.frames.at(-1));
  check('No frontend errors',report.errors.length===0,report.errors);
  report.passed=report.checks.every(check=>check.passed);
  console.log(JSON.stringify({label,passed:report.passed,checks:report.checks},null,2));
 }finally{
  if(page&&!page.isClosed())await page.evaluate(()=>window.ipc.postMessage(JSON.stringify({type:'quit'}))).catch(()=>{});
  await delay(500);if(browser)await browser.close().catch(()=>{});if(child&&child.exitCode===null)child.kill();
  if(fs.existsSync(path.join(profile,'diagnostic.log')))fs.copyFileSync(path.join(profile,'diagnostic.log'),path.join(out,'flicker-'+label+'-ipc.log'));
  fs.writeFileSync(path.join(out,'flicker-'+label+'.json'),JSON.stringify(report,null,2)+'\n');
  const actual=fs.realpathSync(profile),parent=fs.realpathSync(out);
  if(path.dirname(actual).toLowerCase()===parent.toLowerCase()&&/^flicker-[A-Za-z0-9]{6}$/.test(path.basename(actual))){try{fs.rmSync(actual,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{}}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
