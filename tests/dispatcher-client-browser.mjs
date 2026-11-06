// Real widget/channel/booking/provider, scripted model double; no live AI or customer data.
import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {createServer} from 'node:http';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomUUID} from 'node:crypto';
const temp=await mkdtemp(path.join(os.tmpdir(),'frontsmith-dispatcher-client-'));
process.env.FRONTSMITH_BUSINESS_ROOT=path.join(temp,'business');await mkdir(process.env.FRONTSMITH_BUSINESS_ROOT);
const {useFakeCrm}=await import('../services/crm/testing/fake-crmkit.mjs');const crm=await useFakeCrm(path.join(temp,'data'));
const {openOfficeDb,migrate}=await import('../office/lib/db.mjs');const {syncBusinessProjection,importCatalog}=await import('../office/lib/import.mjs');
const {registerFunctions}=await import('../office/lib/repositories.mjs');const {connectCustomers}=await import('../office/customers/index.mjs');
const {ConversationStore}=await import('../services/conversation/store.mjs');const {ConversationCore,HANDOFF_TOOL}=await import('../services/conversation/core.mjs');
const {BookingDesk,BOOKING_TOOLS}=await import('../services/conversation/booking.mjs');const {createWebChannel}=await import('../services/conversation/web-channel.mjs');
const {loadPublicBusinessContext}=await import('../services/conversation/business-context.mjs');
const profile={businessName:'Синтетическая парикмахерская',blueprint:'generic-service',timeZone:'Europe/Moscow',currency:'RUB',contact:{},hours:{days:[1,2,3,4,5,6,7],start:'10:00',end:'20:00'},services:[{id:'cut',name:'Стрижка',priceFrom:null,durationMinutes:45,description:'Стоимость после консультации'}]};
await writeFile(path.join(process.env.FRONTSMITH_BUSINESS_ROOT,'business.json'),JSON.stringify(profile));
const db=registerFunctions(openOfficeDb());migrate(db);syncBusinessProjection(db,profile);importCatalog(db,profile);
const customers=await connectCustomers({db});const store=new ConversationStore({file:path.join(temp,'conversations.sqlite')});
const desk=new BookingDesk({db,provider:customers.provider,store,profile:()=>profile,now:()=>new Date('2026-11-09T06:00:00Z')});
const threads=new Map();let aiAvailable=true;const calls=[];
const host={
 async openConversation({context}){const id=randomUUID();threads.set(id,context);return {conversationId:id,threadId:id,privacySessionId:'synthetic-'+id}},
 async resumeConversation({threadId,context}){threads.set(threadId,context);return {conversationId:threadId,threadId}},
 async send(id,text){const conversation=store.byThread(id);let result;
  if(text.includes('после 15')){const slots=await desk.find_booking_slots({service:'cut',timeFrom:'15:00',timeTo:'18:00'},conversation);const start=slots.match(/- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/)[1];await desk.offer_booking({service:'cut',start},conversation);calls.push('slots','offer');result='Предлагаю время '+start+'. Проверьте форму: запись ещё не создана'}
  else if(text.includes('Форма записи'))result=await desk.get_booking_status({},conversation);
  else if(text.includes('цена'))result='Стоимость стрижки — индивидуальная оценка после консультации, точной суммы нет';
  else result='Не знаю: в проверенных сведениях нет ответа. Можно передать вопрос сотруднику, без обещания времени ответа';
  return {text:result,toolCalls:[]};
 }
};
const core=new ConversationCore({store,host:()=>aiAvailable?host:null,context:loadPublicBusinessContext,tools:[...BOOKING_TOOLS,HANDOFF_TOOL]});
const chat=createWebChannel({core,booking:desk,allowedHosts:new Set(['127.0.0.1:43191'])});
const harness=`
(async()=>{
 const sleep=()=>new Promise(r=>setTimeout(r,50));const wait=async(fn)=>{for(let i=0;i<160;i++){if(fn())return;await sleep()}throw new Error('Widget timeout')};
 try{
  await wait(()=>window.ChatCops);ChatCops.open();const shadow=document.getElementById('chatcops-root').shadowRoot;
  const send=async(text,expected)=>{const input=shadow.querySelector('textarea');input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));shadow.querySelector('.cc-send-btn').click();await wait(()=>shadow.textContent.includes(expected))};
  if(location.search.includes('offline')){await send('Неизвестный вопрос','сейчас недоступен');shadow.querySelector('.fs-handoff-button').click();await wait(()=>shadow.textContent.includes('не означает'));}
  else {
   await send('Неизвестный вопрос','Не знаю');await send('Какая цена стрижки?','индивидуальная оценка');await send('Запись после 15','Проверьте форму');
   await wait(()=>document.querySelector('.fs-booking input[name=start]:checked'));
   const offered=shadow.textContent.match(/Предлагаю время (\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2})/)[1];if(document.querySelector('.fs-booking input[name=start]:checked').value!==offered)throw new Error('Afternoon choice changed');
   if(location.search.includes('form')){document.body.dataset.testResult='pass';return;}
   document.querySelector('.fs-booking button[type=submit]').click();await wait(()=>document.querySelector('.fs-error').textContent.includes('Укажите имя'));
   document.querySelector('.fs-booking input[name=name]').value='Синтетический посетитель';document.querySelector('.fs-booking input[name=phone]').value='+79990000123';document.querySelector('.fs-booking input[name=consent]').checked=true;
   document.querySelector('.fs-booking button[type=submit]').click();await wait(()=>document.querySelector('.fs-booking').textContent.includes('Запрос на запись отправлен'));
   if(document.querySelector('.fs-booking').textContent.includes('Вы записаны'))throw new Error('False confirmation');
   document.querySelector('.fs-booking .fs-secondary').click();await wait(()=>shadow.textContent.includes('requested:'));
   shadow.querySelector('.fs-handoff-button').click();await wait(()=>shadow.textContent.includes('не означает'));
  }
  document.body.dataset.testResult='pass';
 }catch(error){document.body.dataset.testResult='fail';document.body.appendChild(Object.assign(document.createElement('pre'),{textContent:error.stack}))}
})();
`;
const server=createServer(async(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(await chat.handle(req,res,pathname))return;
 const files={'/vendor.js':'vendor/chatcops-widget/chatcops.min.js','/widget.js':'website/chat-widget.js'};
 if(files[pathname]){res.writeHead(200,{'content-type':'text/javascript;charset=utf-8'});res.end(await readFile(files[pathname]));return}
 if(pathname==='/test.js'){res.writeHead(200,{'content-type':'text/javascript;charset=utf-8'});res.end(harness);return}
 aiAvailable=!req.url.includes('offline');res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta property="og:site_name" content="Синтетическая компания"><title>Синтетический клиентский сценарий</title><h1>Синтетическая компания</h1><p>Проверка виджета, модель — сценарный двойник</p><script src="/vendor.js"></script><script src="/widget.js"></script><script src="/test.js"></script>');
});
await new Promise(resolve=>server.listen(43191,'127.0.0.1',resolve));
const browser=[process.env.FRONTSMITH_TEST_BROWSER,...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean).flatMap(base=>[path.join(base,'Microsoft','Edge','Application','msedge.exe'),path.join(base,'Google','Chrome','Application','chrome.exe')])].find(p=>p&&existsSync(p));
try {
 for(const label of ['desktop','mobile','offline']){
  const args=['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--disable-component-update','--virtual-time-budget=20000','--window-size='+(label==='mobile'?'390,844':'1440,1000'),'--user-data-dir='+path.join(temp,label),'--dump-dom','http://127.0.0.1:43191/'+(label==='offline'?'?offline=1':'')];
  const {stdout}=await promisify(execFile)(browser,args,{windowsHide:true,timeout:45000,maxBuffer:2*1024*1024});await writeFile(path.join(temp,label+'.html'),stdout);assert.match(stdout,/data-test-result="pass"/,stdout.slice(-5000));
 }
 for(const [label,size,query] of [['booking-desktop','1440,1000','form=1'],['booking-narrow','500,900','form=1'],['unavailable','1440,1000','offline=1']]){
  await promisify(execFile)(browser,['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--disable-component-update','--virtual-time-budget=20000','--window-size='+size,'--user-data-dir='+path.join(temp,label),'--screenshot='+path.join(temp,label+'.png'),'http://127.0.0.1:43191/?'+query],{windowsHide:true,timeout:45000,maxBuffer:1024*1024});
 }
 assert.ok(calls.includes('offer'));assert.equal(db.prepare('SELECT count(*) AS n FROM appointments').get().n,2);
 assert.ok(db.prepare('SELECT status FROM appointments').all().every(r=>r.status==='tentative'));
 console.log('Client browser PASS: unknown/individual price/afternoon preserved/form error/real booking via fake CRM/handoff/offline; SCRIPTED MODEL DOUBLE. Evidence: '+temp);
} finally {await new Promise(resolve=>server.close(resolve));await customers.stop();store.close();db.close();await crm.close?.()}
