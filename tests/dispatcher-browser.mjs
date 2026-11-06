// Real installed browser, artificial workspace. No remote debugging or user browser profile.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createServer} from 'node:http';import path from 'node:path';import os from 'node:os';
const temp=await mkdtemp(path.join(os.tmpdir(),'frontsmith-dispatcher-browser-'));
process.env.FRONTSMITH_BUSINESS_ROOT=path.join(temp,'business');await mkdir(process.env.FRONTSMITH_BUSINESS_ROOT);
const profile={businessName:'Синтетическая компания',blueprint:'generic-service',timeZone:'Europe/Moscow',currency:'RUB',contact:{},services:[]};
await writeFile(path.join(process.env.FRONTSMITH_BUSINESS_ROOT,'business.json'),JSON.stringify(profile));
const {openOfficeDb,migrate}=await import('../office/lib/db.mjs');const {syncBusinessProjection}=await import('../office/lib/import.mjs');
const db=openOfficeDb();migrate(db);syncBusinessProjection(db,profile);db.close();
const {createOfficeServer}=await import('../office/server.mjs');
const options={port:43189,connectProvider:async()=>({provider:{name:'synthetic',capabilities:{},resolveDisplayData:async()=>new Map()},stop:async()=>{}})};
let office=createOfficeServer(options);
const harness=`
(async()=>{
 if(location.search.includes('mobile'))document.documentElement.style.width='390px';
 const pause=()=>new Promise(r=>setTimeout(r,50));
 const wait=async(test)=>{for(let i=0;i<100;i++){if(test())return;await pause()}throw new Error('UI timeout: '+document.body.innerText)};
 const button=text=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);
 const check=(condition,message)=>{if(!condition)throw new Error(message)};
 try {
  await wait(()=>document.querySelector('.dispatcher-editor'));
  const about=document.querySelector('.dispatcher-field textarea');about.value='Синтетическая парикмахерская: работаем по записи';about.dispatchEvent(new Event('input',{bubbles:true}));
  check(button('Утвердить сохранённый черновик').disabled,'Unsaved draft must not activate');
  if(!Array.from(document.querySelectorAll('legend')).some(e=>e.textContent==='Услуга')){
    button('Добавить описание услуги').click();
    const row=Array.from(document.querySelectorAll('fieldset')).find(e=>e.querySelector('legend').textContent==='Услуга');
    const inputs=row.querySelectorAll('input');inputs[0].value='cut';inputs[1].value='Стрижка';inputs[4].value='45';inputs[0].dispatchEvent(new Event('input',{bubbles:true}));
  }
  const schedule=Array.from(document.querySelectorAll('fieldset')).find(e=>e.querySelector('legend').textContent==='4. Локальное расписание');
  schedule.querySelector('input[type=checkbox]').checked=true;const times=schedule.querySelectorAll('input[type=time]');times[0].value='10:00';times[1].value='20:00';
  Array.from(schedule.querySelectorAll('input[type=checkbox][value]')).forEach(d=>d.checked=true);schedule.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));
  button('Сохранить черновик').click();await wait(()=>document.querySelector('[role=status]').textContent.includes('Черновик сохранён'));
  button('Утвердить сохранённый черновик').click();await wait(()=>document.querySelector('[role=status]').textContent.includes('Подтвердите'));
  Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Я проверил')).querySelector('input').click();
  button('Добавить новые услуги в каталог записи').click();await wait(()=>document.body.innerText.includes('Новые услуги добавлены в каталог'));
  Array.from(document.querySelectorAll('label')).find(l=>l.textContent.includes('Я проверил')).querySelector('input').click();
  button('Утвердить сохранённый черновик').click();await wait(()=>document.body.innerText.includes('Сохранённая версия утверждена'));
  check((location.search.includes('mobile')?document.body.scrollWidth<=390:document.documentElement.scrollWidth<=window.innerWidth),'Horizontal overflow '+JSON.stringify({width:innerWidth,scroll:document.documentElement.scrollWidth,items:Array.from(document.querySelectorAll('body *')).filter(e=>e.getBoundingClientRect().right>391).slice(0,15).map(e=>[e.tagName,e.className,e.getBoundingClientRect().right])}));
  document.body.dataset.testResult='pass';
  if(location.search.includes('bottom'))window.scrollTo(0,document.body.scrollHeight);
 }catch(error){document.body.dataset.testResult='fail';const pre=document.createElement('pre');pre.id='test-error';pre.textContent=error.stack;document.body.prepend(pre)}
})();
`;
const server=createServer(async(req,res)=>{
 if(req.url.startsWith('/_test.js')){res.writeHead(200,{'content-type':'text/javascript;charset=utf-8'});res.end(harness);return}
 if(req.url==='/'||req.url.startsWith('/?')){let html=await readFile('office/public/index.html','utf8');res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html.replace('</body>','<script src="/_test.js" defer></script></body>'));return}
 office.server.emit('request',req,res);
});
await new Promise(resolve=>server.listen(43189,'127.0.0.1',resolve));
const browser=[process.env.FRONTSMITH_TEST_BROWSER,...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean).flatMap(base=>[path.join(base,'Microsoft','Edge','Application','msedge.exe'),path.join(base,'Google','Chrome','Application','chrome.exe')])].find(p=>p&&existsSync(p));
if(!browser)throw new Error('Установленный Edge/Chrome не найден');
const common=['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--virtual-time-budget=15000'];
async function run(label,size,screenshot=false,bottom=false){
 const args=[...common,'--user-data-dir='+path.join(temp,'browser-'+label),'--window-size='+size,...(screenshot?['--screenshot='+path.join(temp,label+'.png')]:['--dump-dom']),'http://127.0.0.1:43189/'+(label.startsWith('mobile')?'?mobile=1'+(bottom?'&bottom=1':''):'')+'#/dispatcher'];
 const {stdout}=await promisify(execFile)(browser,args,{windowsHide:true,timeout:45000,maxBuffer:2*1024*1024});
 if(!screenshot){await writeFile(path.join(temp,label+'.html'),stdout);assert.match(stdout,/data-test-result="pass"/,stdout.slice(-7000))}
}
try {
 await run('desktop-dom','1440,1000');await run('desktop','1440,1000',true);
 await run('mobile-dom','390,844');await run('mobile','390,844',true);await run('mobile-bottom','390,844',true,true);
 await office.close();office=createOfficeServer(options);
 await run('restart-dom','1440,1000');
 console.log('Dispatcher browser PASS: desktop/mobile real screens, dirty draft, save, approval/error and server restart. Evidence: '+temp);
}finally{await new Promise(resolve=>server.close(resolve));await office.close()}
