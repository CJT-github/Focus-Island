/* Controlled Chromium edge analysis. Does not edit the application stylesheet.
   node tools/verify-edge.cjs; optional PLAYWRIGHT_MODULE / BROWSER_EXE. */
const fs=require('node:fs/promises');
const path=require('node:path');
const zlib=require('node:zlib');
const root=path.resolve(__dirname,'..');
function decodePng(buffer) {
  let offset=8,width,height,type,depth,idat=[];
  while(offset<buffer.length) {
    const length=buffer.readUInt32BE(offset),name=buffer.toString('ascii',offset+4,offset+8);
    const data=buffer.subarray(offset+8,offset+8+length);
    if(name==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);depth=data[8];type=data[9];}
    if(name==='IDAT')idat.push(data);
    offset+=length+12;
  }
  if(depth!==8||![2,6].includes(type))throw new Error('Expected 8-bit RGB/RGBA PNG');
  const bpp=type===6?4:3,stride=width*bpp,raw=zlib.inflateSync(Buffer.concat(idat));
  const decoded=Buffer.alloc(height*stride);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)];
    for(let x=0;x<stride;x++){
      const a=x>=bpp?decoded[y*stride+x-bpp]:0,b=y?decoded[(y-1)*stride+x]:0,c=y&&x>=bpp?decoded[(y-1)*stride+x-bpp]:0;
      const prediction=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):NaN;
      if(Number.isNaN(prediction))throw new Error('Unexpected PNG filter');
      decoded[y*stride+x]=(raw[y*(stride+1)+1+x]+prediction)&255;
    }
  }
  if(bpp===4)return{width,height,pixels:decoded};
  const pixels=Buffer.alloc(width*height*4);
  for(let i=0;i<width*height;i++){decoded.copy(pixels,i*4,i*3,i*3+3);pixels[i*4+3]=255;}
  return{width,height,pixels};
}
function encodePng(width,height,pixels) {
  const crc=data=>{let c=0xffffffff;for(const value of data){c^=value;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const label=Buffer.from(name),result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);label.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([label,data])),data.length+8);return result;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const scanlines=Buffer.alloc((width*4+1)*height);
  for(let y=0;y<height;y++)pixels.copy(scanlines,y*(width*4+1)+1,y*width*4,(y+1)*width*4);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]);
}
function alphaAt(png,x,y) {
  x=Math.max(0,Math.min(png.width-1,Math.round(x)));y=Math.max(0,Math.min(png.height-1,Math.round(y)));
  return png.pixels[(y*png.width+x)*4+3];
}
function edgeMetrics(png,dpr,shape) {
  const left=shape==='pill'?224:120,top=120,r=shape==='pill'?19:170;
  const cx=(left+r)*dpr,cy=(top+r)*dpr,rp=r*dpr;
  const errors=[],transitionWidths=[],samples=[];
  for(let y=Math.ceil((top+r*.16)*dpr);y<Math.floor((top+r*.84)*dpr);y++){
    const dy=y+.5-cy,expected=cx-Math.sqrt(rp*rp-dy*dy);
    const inside=alphaAt(png,expected+3*dpr,y),threshold=inside*.5;
    if(inside<30)continue;
    let previous=0,previousX=0,crossing=null,transition=0;
    for(let x=Math.floor(expected-3*dpr);x<=Math.ceil(expected+3*dpr);x++){
      const a=alphaAt(png,x,y);
      if(a>inside*.05&&a<inside*.95)transition++;
      if(crossing===null&&a>=threshold&&previous<threshold)crossing=previousX+.5+(threshold-previous)/(a-previous);
      previous=a;previousX=x;
    }
    if(crossing!==null){errors.push((crossing-expected)/dpr);transitionWidths.push(transition/dpr);}
    if(samples.length<8)samples.push({row:y,expectedEdgePx:+expected.toFixed(3),alpha:Array.from({length:7},(_,i)=>alphaAt(png,Math.floor(expected)+i-3,y))});
  }
  const average=values=>values.reduce((a,b)=>a+b,0)/Math.max(1,values.length);
  const bias=average(errors),rms=Math.sqrt(average(errors.map(e=>(e-bias)**2)));
  const roughness=Math.sqrt(average(errors.slice(1).map((e,i)=>(e-errors[i])**2)));
  return{
    contourRows:errors.length,meanEdgeShiftCssPx:+bias.toFixed(4),
    centeredContourRmsCssPx:+rms.toFixed(4),adjacentRowRoughnessCssPx:+roughness.toFixed(4),
    meanAlphaTransitionWidthCssPx:+average(transitionWidths).toFixed(4),samples
  };
}
function crop(png,dpr,shape) {
  const box=shape==='pill'?{x:224-3,y:120-3,w:32,h:27}:{x:120+31,y:120+31,w:39,h:39};
  const x=Math.round(box.x*dpr),y=Math.round(box.y*dpr),width=Math.round(box.w*dpr),height=Math.round(box.h*dpr),pixels=Buffer.alloc(width*height*4);
  for(let row=0;row<height;row++)png.pixels.copy(pixels,row*width*4,((y+row)*png.width+x)*4,((y+row)*png.width+x+width)*4);
  return{png:encodePng(width,height,pixels),cssWidth:box.w,cssHeight:box.h};
}
const variants=[
  {id:'current',label:'Current',css:''},
  {id:'promote',label:'GPU layer',css:'.island > .island__glass{transform:translateZ(0);will-change:clip-path}'},
  {id:'mask06',label:'Inward mask 0.6px',mask:.6},
  {id:'blur035',label:'Surface blur 0.35px',wrapper:'blur(.35px)',css:'.island__compact::before,.island__expanded::before{filter:blur(.2px)}'},
  {id:'blur045shadow',label:'Blur .45 + shadow',wrapper:'blur(.45px) drop-shadow(0 2px 2px rgba(0,0,0,.24))',css:'.island__compact::before,.island__expanded::before{filter:blur(.2px)}'},
  {id:'mask06shadow',label:'Mask .6 + shadow',mask:.6,wrapper:'drop-shadow(0 2px 2px rgba(0,0,0,.24))'}
];
async function run(options={}) {
  const playwright=options.playwright||require(process.env.PLAYWRIGHT_MODULE||path.resolve(root,'../verify-tools/node_modules/playwright'));
  const out=path.join(root,'tools/verify/edges');await fs.mkdir(out,{recursive:true});
  // Always preserve the pre-fix HTML/CSS as the baseline. Production already
  // contains its surface wrapper and must never receive an experimental wrapper.
  const sources=await Promise.all([
    fs.readFile(path.join(out,'before-index.html'),'utf8'),
    fs.readFile(path.join(out,'before-styles.css'),'utf8'),
    fs.readFile(path.join(root,'ui/index.html'),'utf8'),
    fs.readFile(path.join(root,'ui/styles.css'),'utf8')
  ]);
  const documentFor=(template,css)=>template.replace('/*__CSS__*/',()=>css).replace('__VIEW__','island').replace('/*__GEO__*/','{}').replace('/*__STATE__*/','{}').replace('/*__JS__*/','');
  const baseline=documentFor(sources[0],sources[1]),production=documentFor(sources[2],sources[3]);
  const candidates=options.experiments?variants:[variants[0]];
  const selected=[...candidates,{id:'production',label:'Production: glass blur .4 + shadow',production:true}];
  const browser=await playwright.chromium.launch({headless:true,executablePath:process.env.BROWSER_EXE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const results=[],tiles=[],contentAssertions=[];
  try {
    for(const dpr of [1,1.25,1.5,2]){
      const context=await browser.newContext({viewport:{width:580,height:580},deviceScaleFactor:dpr});
      const page=await context.newPage();
      for(const shape of ['pill','dial'])for(const variant of selected){
        await page.setContent(variant.production?production:baseline);
        await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'+(variant.css||'')});
        await page.evaluate(shape=>document.querySelector('#island').classList.toggle('is-open',shape==='dial'),shape);
        if(variant.mask){
          const f=variant.mask;
          const capsule=(offset)=>[
            'mask-image:radial-gradient(circle closest-side,#000 calc(100% - '+f+'px),transparent 100%),linear-gradient(to bottom,transparent,#000 '+f+'px,#000 calc(100% - '+f+'px),transparent),radial-gradient(circle closest-side,#000 calc(100% - '+f+'px),transparent 100%)',
            'mask-size:38px 38px,94px 38px,38px 38px',
            'mask-position:'+offset+'px 0,'+(offset+19)+'px 0,'+(offset+94)+'px 0',
            'mask-repeat:no-repeat'
          ].join(';');
          const circle='mask-image:radial-gradient(circle closest-side,#000 calc(100% - '+f+'px),transparent 100%);mask-repeat:no-repeat';
          await page.addStyleTag({content:shape==='pill'
            ? '.island > .island__glass{'+capsule(104)+'}.island__compact::before{'+capsule(0)+'}'
            : '.island > .island__glass,.island__expanded::before{'+circle+'}'});
        }
        if(variant.wrapper)await page.evaluate(filter=>{
          const glass=document.querySelector('.island > .island__glass');
          const computed=getComputedStyle(glass);
          const keep={clipPath:computed.clipPath,maskImage:computed.maskImage,maskSize:computed.maskSize,maskPosition:computed.maskPosition,maskRepeat:computed.maskRepeat};
          const wrapper=document.createElement('div');wrapper.className='edge-diagnostic-wrapper';
          wrapper.style.cssText='position:absolute;inset:0;pointer-events:none;filter:'+filter;
          glass.before(wrapper);wrapper.appendChild(glass);Object.assign(glass.style,keep);
        },variant.wrapper);
        if(variant.production){
          const checks=await page.evaluate(()=>{
            const failures=[],content=[];
            const surface=document.querySelector('.island > .island__surface');
            const glass=surface?.querySelector(':scope > .island__glass');
            if(!glass||document.querySelectorAll('.island__surface').length!==1)failures.push('Expected one production surface containing glass');
            const surfaceFilter=surface?getComputedStyle(surface).filter:'';
            if(!surfaceFilter.includes('blur(0.4px)')||!surfaceFilter.includes('drop-shadow('))failures.push('Expected glass-only edge blur and shadow');
            for(const selector of ['.island__time','.readout__task','.readout__digits','.readout__chip','#handHour','#handMinute','#handSecond']){
              const element=document.querySelector(selector),ancestors=[];
              if(!element){failures.push('Missing '+selector);continue;}
              for(let node=element;node;node=node.parentElement){
                const css=getComputedStyle(node),filter=css.filter,backdropFilter=css.backdropFilter||css.webkitBackdropFilter||'none';
                const name=node.id?'#'+node.id:node.tagName.toLowerCase();
                ancestors.push({name,filter,backdropFilter});
                if(filter!=='none'||backdropFilter!=='none')failures.push(selector+' has filtered ancestor '+name);
              }
              content.push({selector,ancestors});
            }
            const bevelFilters=['.island__compact','.island__expanded'].map(selector=>({selector,filter:getComputedStyle(document.querySelector(selector),'::before').filter}));
            if(bevelFilters.some(item=>item.filter!=='blur(0.2px)'))failures.push('Expected decorative bevel-only blur');
            const readoutStyle=getComputedStyle(document.querySelector('.readout__card'));
            const readoutBackground={color:readoutStyle.backgroundColor,image:readoutStyle.backgroundImage};
            return{ok:failures.length===0,failures,surfaceFilter,bevelFilters,readoutBackground,content};
          });
          contentAssertions.push({shape,dpr,...checks});
          if(!checks.ok)throw new Error('Production content isolation failed: '+checks.failures.join('; '));
        }
        const png=await page.screenshot({omitBackground:true});
        const name=shape+'-'+variant.id+'-dpr'+String(dpr).replace('.','_')+'.png';
        await fs.writeFile(path.join(out,name),png);
        const decoded=decodePng(png),detail=edgeMetrics(decoded,dpr,shape),cropped=crop(decoded,dpr,shape);
        const cropName=name.replace('.png','-crop.png');await fs.writeFile(path.join(out,cropName),cropped.png);
        results.push({shape,variant:variant.id,dpr,...detail,file:name,crop:cropName});
        tiles.push({shape,variant:variant.id,label:variant.production?variant.label:variant.id==='current'?'Saved baseline':variant.label,dpr,url:'data:image/png;base64,'+cropped.png.toString('base64'),...cropped});
      }
      await context.close();
    }
    const proof=await browser.newPage({viewport:{width:options.experiments?1440:600,height:900}});
    for(const shape of ['pill','dial']){
      const cells=tiles.filter(t=>t.shape===shape).map(t=>'<figure><figcaption>'+t.label+' · DPR '+t.dpr+'</figcaption><div class="canvas"><img src="'+t.url+'" style="width:'+t.cssWidth*4+'px;height:'+t.cssHeight*4+'px"></div></figure>').join('');
      await proof.setContent('<style>*{box-sizing:border-box}body{margin:0;padding:18px;background:#171c24;color:#e7edf7;font:12px Arial}h1{font-size:18px;margin:0 0 6px}p{margin:0 0 14px;color:#a9b4c5}.grid{display:grid;grid-template-columns:repeat('+selected.length+',1fr);gap:9px}figure{margin:0;padding:7px;background:#242c38;border-radius:7px}figcaption{height:25px;font-size:11px}.canvas{height:160px;display:grid;place-items:center;background:repeating-conic-gradient(#d7dce3 0 25%,#bec7d2 0 50%) 0/16px 16px;border-radius:4px;overflow:hidden}img{image-rendering:pixelated}</style><h1>'+shape+' — outer edge at 4× CSS size</h1><p>Saved baseline vs actual production HTML/CSS. Transparent captures.<br>Text and hands remain unfiltered. Rows: DPR 1, 1.25, 1.5, 2.</p><div class="grid">'+cells+'</div>');
      await proof.screenshot({path:path.join(out,shape+'-production-comparison.png'),fullPage:true});
    }
    const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
    const aggregate=Object.fromEntries(selected.map(variant=>{
      const rows=results.filter(row=>row.variant===variant.id);
      return[variant.id,{
        centeredContourRmsCssPx:+mean(rows.map(r=>r.centeredContourRmsCssPx)).toFixed(5),
        meanAlphaTransitionWidthCssPx:+mean(rows.map(r=>r.meanAlphaTransitionWidthCssPx)).toFixed(5)
      }];
    }));
    const baselineRms=aggregate.current.centeredContourRmsCssPx,productionRms=aggregate.production.centeredContourRmsCssPx;
    const report={ok:true,browser:'headless Edge / Chromium',deviceScaleFactors:[1,1.25,1.5,2],sources:{baseline:['tools/verify/edges/before-index.html','tools/verify/edges/before-styles.css'],production:['ui/index.html','ui/styles.css']},notes:[
      'No application UI source was edited. Production captures use its own wrapper and stylesheet without experimental overrides.',
      'Only animations and transitions are disabled for deterministic static poses; application JavaScript is omitted.',
      'Contour statistics use screenshot alpha normalized to an interior sample; native HRGN clipping is verified separately.',
      'Centered RMS removes systematic edge bias. Shadow changes alpha coverage; the comparison montage is also needed.',
      'Content assertions inspect each text/hand element and every ancestor; decorative pseudo-elements are allowed their own blur.'
    ],aggregate,productionRmsReductionPercent:+((1-productionRms/baselineRms)*100).toFixed(1),contentAssertions,results};
    await fs.writeFile(path.join(out,'production-edge-report.json'),JSON.stringify(report,null,2)+'\n');
    return report;
  }finally{await browser.close();}
}
module.exports={run,decodePng,encodePng};
if(require.main===module)run({experiments:process.argv.includes('--experiments')}).then(r=>console.log(JSON.stringify({ok:r.ok,captures:r.results.length,unfilteredContentChecks:r.contentAssertions.length,aggregate:r.aggregate,productionRmsReductionPercent:r.productionRmsReductionPercent,out:'tools/verify/edges/production-edge-report.json'},null,2))).catch(e=>{console.error(e);process.exitCode=1;});
