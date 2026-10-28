import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createScenes, positioning } from './scenes.mjs';
const out=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(out,'../..');
const require=createRequire(path.join(root,'frontend/package.json'));
const {chromium}=require('@playwright/test');
const sharp=require('sharp');
const theme=await fs.readFile(path.join(out,'palette.css'),'utf8');
const logo='data:image/png;base64,'+(await fs.readFile(path.join(out,'brand/context-logo.png'))).toString('base64');
await fs.mkdir(path.join(out,'png'),{recursive:true});
await fs.mkdir(path.join(out,'html'),{recursive:true});
const css=`${theme}
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden}
body{font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:var(--text);letter-spacing:-1px}
.frame{position:relative;width:1920px;height:1080px;overflow:hidden;background:var(--background)}
.haze{position:absolute;right:-200px;top:-400px;width:1300px;height:1300px;background:radial-gradient(circle,var(--primary-soft),transparent 67%);opacity:.75;pointer-events:none}
.dotgrid{position:absolute;inset:0;background-image:radial-gradient(var(--grid) 1px,transparent 1px);background-size:28px 28px;mask-image:linear-gradient(130deg,transparent 35%,#000);opacity:.7;pointer-events:none}
.rail{position:absolute;left:104px;right:104px;bottom:53px;display:flex;justify-content:space-between;gap:28px;padding-top:20px;border-top:1px solid var(--border);color:var(--text-muted);font-size:22px;line-height:1.4;letter-spacing:-.4px}
.rail>span:last-child{text-align:right}.rail .status{color:var(--secondary);font-weight:600}
.eyebrow{color:var(--primary);font-size:24px;font-weight:700;letter-spacing:2px;line-height:1.5;margin-bottom:29px}
h1,h2,p{margin:0}h1{font-size:91px;line-height:1.22;font-weight:800;letter-spacing:-4px}h1 em{font-style:normal;color:var(--primary)}
.desc{font-size:31px;line-height:1.75;color:var(--text-secondary);letter-spacing:-.65px;margin-top:31px}
.brand{display:block;width:350px;height:122.5px;object-fit:contain;mix-blend-mode:multiply}
.mini-brand{position:absolute;right:104px;top:67px;width:240px;height:84px;object-fit:contain;mix-blend-mode:multiply}
.left-copy{position:absolute;left:104px;top:255px;width:870px}.left-copy.narrow{width:780px}
.opener-copy{position:absolute;left:104px;top:105px}.opener-copy .eyebrow{margin-top:54px}.opener-copy h1{font-size:90px}
.tagline{display:inline-flex;align-items:center;gap:13px;margin-top:44px;color:var(--secondary);font-size:27px;font-weight:600;letter-spacing:-.6px}
.tagline:before{content:'';width:26px;height:3px;background:var(--primary)}
.window{background:var(--surface);border:1px solid var(--border);border-radius:25px;box-shadow:0 28px 80px var(--shadow-elevated-color);overflow:hidden}
.chat-window{position:absolute;left:1010px;right:104px;top:175px}
.window-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:25px 30px;border-bottom:1px solid var(--border-soft);font-size:26px;font-weight:700}
.workspace-strip{display:flex;justify-content:space-between;gap:12px;padding:18px 30px;background:var(--primary-soft);color:var(--primary);font-size:23px;font-weight:650}.draft-heading{font-size:32px;font-weight:750;margin-bottom:12px}.draft-line{font-size:25px;color:var(--text-secondary)}
.head-dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--primary);margin-right:11px}
.head-note{font-size:20px;font-weight:500;color:var(--text-muted)}
.chat-body{padding:29px 30px 30px}.file-chip{display:inline-flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:11px 16px;font-size:23px;font-weight:600;color:var(--text-secondary)}
.file-chip small{font-size:16px;letter-spacing:.5px;color:var(--primary)}
.bubble{padding:22px 24px;border-radius:18px;font-size:29px;line-height:1.65;letter-spacing:-.7px}.bubble.user{background:var(--primary-soft);margin:22px 0 26px 62px;border-bottom-right-radius:5px}.bubble.ai{background:var(--surface-ai);margin-right:24px;border-bottom-left-radius:5px}.ai-label{display:block;margin-bottom:12px;font-size:19px;font-weight:700;color:var(--secondary)}
.mini-diff{margin-top:22px;padding:19px 21px;background:var(--surface);border:1px solid var(--border);border-radius:13px;font-size:24px;line-height:1.65}.mini-diff small{display:block;color:var(--text-muted);font-size:18px;margin-bottom:7px}.mini-diff .plus{color:var(--success)}
.primary-chip{display:inline-flex;background:var(--primary);color:var(--on-primary);border-radius:10px;padding:13px 23px;font-size:23px;font-weight:600}.fake-action{display:flex;justify-content:flex-end;align-items:center;gap:20px;margin-top:23px}.fake-action small{color:var(--text-muted);font-size:19px}
.dark{background:#2A2526;color:#FAF8F5}.dark .haze{display:none}.dark .dotgrid{opacity:.08}.dark .rail{color:#D1BFC1;border-color:#665456}.dark .eyebrow{color:#E2B9BC}.dark h1 em{color:#EDC5C5}.dark .desc{color:#D5C8C8}
.dark-mark{position:absolute;left:104px;top:70px;padding:10px 20px;background:#FFFFFF;border-radius:12px}.dark-mark .brand{width:250px;height:87.5px;mix-blend-mode:normal}
.dark-copy{position:absolute;left:104px;top:277px;width:1080px}.dark-copy h1{font-size:87px}.dark-copy .desc{margin-top:35px}
.manual-stack{position:absolute;right:104px;top:253px;width:540px;display:grid;gap:24px}.manual-row{background:#393033;border:1px solid #655054;border-radius:18px;padding:27px 29px;display:flex;align-items:center;gap:24px;font-size:30px;color:#FAF8F5}.manual-row span{font-size:19px;color:#DCB7BC;letter-spacing:1px}.manual-row:nth-child(2){margin-left:35px}.manual-row:nth-child(3){margin-left:70px}
.crimson{background:var(--primary);color:#FFFFFF}.crimson .haze,.crimson .dotgrid{display:none}.crimson .rail{color:#F1CDCE;border-color:#CA6569}.crimson .rail .status{color:#FFFFFF}.crimson .eyebrow{color:#F2C6C8}.crimson h1 em{color:#F7D9D4}.crimson .desc{color:#F5DADC}.light-brand{display:block;background:#FFFFFF;border-radius:15px;padding:14px 25px;width:380px;margin:auto}.light-brand img{width:330px;height:115.5px;display:block}
.center-copy{position:absolute;left:104px;right:104px;top:156px;text-align:center}.center-copy h1{font-size:102px;margin-top:35px}.center-copy .eyebrow{margin-bottom:20px}.process{display:flex;justify-content:center;align-items:center;gap:25px;margin-top:62px}.process-card{width:365px;background:#FFFFFF;border-radius:18px;padding:26px 28px;color:var(--text);text-align:left}.process-card small{font-size:18px;color:var(--primary);font-weight:700;letter-spacing:1.5px}.process-card strong{font-size:34px;display:block;margin-top:13px}.process-card p{font-size:23px;color:var(--text-muted);margin-top:13px;line-height:1.5}.process-arrow{font-size:32px;color:#E8ADB1}
.folder-window{position:absolute;right:104px;top:194px;width:785px}.folder-path{padding:23px 30px;color:var(--text-muted);font-size:22px;background:var(--surface-subtle);border-bottom:1px solid var(--border-soft)}.folder-list{padding:0 30px}.folder-row{display:flex;align-items:center;gap:19px;min-height:100px;border-bottom:1px solid var(--border-soft);font-size:27px}.folder-row:last-child{border:0}.extension{width:64px;height:50px;display:grid;place-items:center;background:var(--secondary-soft);color:var(--secondary);border-radius:9px;font-size:18px;font-weight:700;letter-spacing:.5px}.folder-row small{margin-left:auto;color:var(--text-muted);font-size:20px}.folder-foot{padding:24px 30px;background:var(--surface-subtle);font-size:22px;color:var(--text-secondary)}
.section-copy{position:absolute;left:104px;top:94px}.section-copy h1{font-size:84px}.section-copy .eyebrow{margin-bottom:19px}.prompt{display:inline-flex;gap:15px;align-items:center;font-size:27px;padding:18px 24px;border:1px solid var(--primary-border);border-radius:13px;background:var(--primary-soft);color:var(--primary);margin-top:26px}.prompt small{font-size:18px;font-weight:700;letter-spacing:1px}
.comparison{position:absolute;left:104px;right:104px;top:453px;display:grid;grid-template-columns:1fr 1fr;gap:28px}.compare-panel{border:1px solid var(--border);border-radius:19px;overflow:hidden;background:var(--surface);min-width:0}.compare-label{padding:20px 27px;font-size:23px;font-weight:700;border-bottom:1px solid var(--border-soft);display:flex;justify-content:space-between;gap:15px}.compare-label small{color:var(--text-muted);font-size:20px;font-weight:500}.compare-content{padding:29px 30px;font-size:30px;line-height:1.75;letter-spacing:-.8px;min-height:304px}.before .compare-content{background:var(--surface-subtle);color:var(--text-secondary)}.after{border-color:var(--primary-border)}.after .compare-label{color:var(--primary)}.after .compare-content{background:var(--surface-ai)}.task{display:flex;gap:21px;align-items:flex-start;margin-bottom:16px}.task:last-child{margin-bottom:0}.task b{min-width:70px;color:var(--secondary)}.task small{font-size:24px;color:var(--text-muted)}
.diff-window{position:absolute;right:104px;top:162px;width:875px}.diff-body{padding:24px 28px}.diff-line{padding:20px 24px;line-height:1.65;font-size:27px;border-radius:12px;margin-bottom:16px}.diff-line.old{background:var(--diff-removed-bg);color:var(--diff-removed)}.diff-line.new{background:var(--diff-added-bg);color:var(--diff-added)}.diff-line small{font-size:18px;display:block;font-weight:700;margin-bottom:9px}.review-pills{display:flex;gap:13px;margin-top:37px}.review-pills span{padding:12px 18px;border:1px solid var(--border);border-radius:10px;font-size:23px;background:var(--surface);color:var(--text-secondary)}
.same-file{position:absolute;left:104px;right:104px;top:452px;display:grid;grid-template-columns:1fr 80px 1fr;align-items:center;gap:20px}.file-view{background:var(--surface);border:1px solid var(--border);border-radius:21px;overflow:hidden}.file-view>header{padding:23px 28px;border-bottom:1px solid var(--border-soft);font-size:28px;font-weight:650}.file-view>section{padding:30px;font-size:29px;line-height:1.75;min-height:245px}.file-view.after-file{border-color:var(--primary-border)}.file-view.after-file>header{color:var(--primary);background:var(--primary-soft)}.next-arrow{text-align:center;color:var(--primary);font-size:44px}.file-note{position:absolute;top:872px;left:104px;font-size:25px;color:var(--text-muted)}
.local-copy{position:absolute;left:104px;top:128px}.local-copy h1{font-size:88px}.local-copy .desc{margin-top:23px}.local-grid{position:absolute;left:104px;right:104px;top:513px;display:grid;grid-template-columns:1.2fr 160px 1fr;gap:28px;align-items:center}.local-box{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:30px;min-height:303px}.local-box h2{font-size:33px;font-weight:750}.local-box p{font-size:25px;line-height:1.9;color:var(--text-secondary);margin-top:20px}.local-box .capsule{display:inline-block;margin-top:24px;font-size:20px;background:var(--primary-soft);color:var(--primary);padding:9px 14px;border-radius:8px}.excerpt{text-align:center;font-size:21px;color:var(--secondary);line-height:1.8}.excerpt span{display:block;font-size:34px;margin:10px 0}.ending{top:108px}.ending h1{font-size:100px;margin-top:48px}.ending .desc{margin-top:25px}.ending .ending-line{margin-top:53px;font-size:27px;color:#F5DADC;letter-spacing:1px}
.overlay{background:transparent}.overlay .haze,.overlay .dotgrid{display:none}.lower{position:absolute;left:104px;bottom:150px;background:rgba(255,255,255,.98);border:1px solid var(--border);border-radius:18px;padding:23px 31px 23px 23px;box-shadow:0 12px 40px var(--shadow-elevated-color);display:flex;align-items:center;gap:23px}.lower .number{width:68px;height:68px;display:grid;place-items:center;border-radius:13px;background:var(--primary-soft);color:var(--primary);font-size:29px;font-weight:750;letter-spacing:0}.lower b{font-size:35px;letter-spacing:-1px;line-height:1.35}.lower p{margin-top:7px;font-size:24px;color:var(--text-muted);line-height:1.45}.lower .concept-tag{font-size:17px;color:var(--secondary);margin-left:14px;font-weight:500;letter-spacing:-.3px}
`;
const rail=(left,right,concept=false)=>`<footer class="rail"><span>${left}</span><span class="${concept?'status':''}">${right}</span></footer>`;
const brand=(type='mini-brand')=>`<img class="${type}" src="${logo}" alt="ConText">`;
const frame=(content,cls='')=>`<!doctype html><html lang="ko"><meta charset="utf-8"><style>${css}</style><body><main class="frame ${cls}"><div class="haze"></div><div class="dotgrid"></div>${content}</main></body></html>`;
const tag=(text)=>`<span class="file-chip"><small>FILE</small>${text}</span>`;
const scenes=createScenes({brand,tag,rail,frame});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
const qa=[];
try{
 for(const scene of scenes){
  await fs.writeFile(path.join(out,'html',scene.name+'.html'),scene.html);
  await page.setContent(scene.html);await page.evaluate(()=>document.fonts.ready);
  await page.locator('img').evaluateAll(images=>Promise.all(images.map(i=>i.decode())));
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('h1,.desc,.rail,.compare-content,.window-head,.prompt,.file-note,.lower')].flatMap(el=>{const r=el.getBoundingClientRect();return r.right>1920.5||r.bottom>1080.5||r.left<0||r.top<0||el.scrollWidth>el.clientWidth+2?[{element:el.className||el.tagName,text:el.textContent.slice(0,70)}]:[]}));
  if(overflow.length)throw new Error(scene.name+' overflow: '+JSON.stringify(overflow));
  const png=path.join(out,'png',scene.name+'.png');
  await page.screenshot({path:png,omitBackground:scene.overlay});
  const m=await sharp(png).metadata();
  if(m.width!==1920||m.height!==1080||(scene.overlay&&!m.hasAlpha))throw new Error('Invalid PNG '+scene.name);
  qa.push({file:'png/'+scene.name+'.png',title:scene.title,width:m.width,height:m.height,transparent:scene.overlay,status:scene.status,sha256:createHash('sha256').update(await fs.readFile(png)).digest('hex')});
  console.log('Rendered '+scene.name);
 }
}finally{await browser.close();}
async function sheet(selected,filename,cols,width){
 const h=width*9/16,gap=16,rows=Math.ceil(selected.length/cols),tiles=[];
 for(let i=0;i<selected.length;i++)tiles.push({input:await sharp(path.join(out,'png',selected[i].name+'.png')).flatten({background:'#F3EFEC'}).resize(width,h).png().toBuffer(),left:gap+(i%cols)*(width+gap),top:gap+Math.floor(i/cols)*(h+gap)});
 await sharp({create:{width:cols*(width+gap)+gap,height:rows*(h+gap)+gap,channels:3,background:'#E8DEDD'}}).composite(tiles).png().toFile(path.join(out,filename));
}
await sheet(scenes.slice(0,12),'preview-storyboard.png',3,640);
await sheet(scenes.slice(12),'preview-overlays.png',2,640);
await sheet([scenes[0],scenes[2],scenes[5],scenes[6],scenes[8],scenes[11]],'preview-highlights.png',2,800);
await fs.writeFile(path.join(out,'manifest.json'),JSON.stringify({theme:'Crimson / Warm White / Charcoal',positioning,assets:qa,validation:{png_count:qa.length,full_frame_count:qa.filter(x=>!x.transparent).length,transparent_overlay_count:qa.filter(x=>x.transparent).length,resolution:'1920x1080',aspect_ratio:'16:9',html_layout_overflow_check:'passed',visual_review:'pending'}},null,2)+'\n');
