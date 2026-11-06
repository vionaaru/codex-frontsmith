import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
const root=await mkdtemp(path.join(os.tmpdir(),'frontsmith-dispatcher-safety-'));
process.env.FRONTSMITH_BUSINESS_ROOT=path.join(root,'business');await mkdir(process.env.FRONTSMITH_BUSINESS_ROOT);
const {useFakeCrm}=await import('../services/crm/testing/fake-crmkit.mjs');const crm=await useFakeCrm(path.join(root,'data'));
const {openOfficeDb,migrate}=await import('../office/lib/db.mjs');const {syncBusinessProjection}=await import('../office/lib/import.mjs');const {registerFunctions}=await import('../office/lib/repositories.mjs');
const {connectCustomers}=await import('../office/customers/index.mjs');const {ConversationStore}=await import('../services/conversation/store.mjs');const {BookingDesk}=await import('../services/conversation/booking.mjs');
const {emptyKnowledge,dispatcherStatus,changeDispatcher}=await import('../services/conversation/dispatcher-settings.mjs');const {loadPublicBusinessContext}=await import('../services/conversation/business-context.mjs');
const profile={businessName:'Synthetic safety',timeZone:'Europe/Moscow',currency:'RUB',contact:{},hours:{days:[1,2,3,4,5,6,7],start:'10:00',end:'20:00'},services:[{id:'legacy',name:'Original consultation',priceFrom:1500,durationMinutes:60,description:'Original description'}]};
const profileFile=path.join(process.env.FRONTSMITH_BUSINESS_ROOT,'business.json');await writeFile(profileFile,JSON.stringify(profile));const originalFile=await readFile(profileFile,'utf8');
const db=registerFunctions(openOfficeDb());migrate(db);syncBusinessProjection(db,profile);const customers=await connectCustomers({db});const store=new ConversationStore({file:path.join(root,'conversations.sqlite')});
let state=await dispatcherStatus(profile);
const change=async(action,extra={})=>{state=await changeDispatcher({revision:state.revision,action,...extra},profile);return state};
const schedule={timeZone:'Europe/Moscow',days:[1,2,3,4,5,6,7],start:'10:00',end:'20:00',slotStepMinutes:30,autoConfirm:false};
const activate=async(value)=>{await change('save',{draft:{...emptyKnowledge(),schedule:value}});return change('publish',{reviewed:true})};
const now=()=>new Date('2026-11-09T06:00:00Z');const desk=new BookingDesk({db,provider:customers.provider,store,profile:()=>profile,now});
const visitor=()=>store.create({channel:'web',tenantId:'synthetic'});
const input=offer=>({offerId:offer.id,start:offer.start,name:'Synthetic visitor',phone:'+79990000123',consent:true});
try {
 await change('save',{draft:{...emptyKnowledge(),services:[{code:'new',name:'New synthetic',kind:'from',min:100,max:null,conditions:'Explicitly public description',durationMinutes:60}]}});
 await assert.rejects(change('catalog',{reviewed:true}),{status:400});
 await change('catalog',{reviewed:true,publicCatalog:true});
 assert.deepEqual(state.catalog.map(s=>s.code).sort(),['legacy','new']);
 assert.match(await loadPublicBusinessContext(),/Original consultation/);assert.match(await loadPublicBusinessContext(),/New synthetic/);
 assert.equal(await readFile(profileFile,'utf8'),originalFile);assert.equal(db.prepare('SELECT base_price_kopecks FROM services WHERE code=?').get('legacy').base_price_kopecks,150000);
 await change('catalog',{reviewed:true,publicCatalog:true});assert.equal(db.prepare('SELECT count(*) AS n FROM services').get().n,2);
 for(const kind of ['range','fixed']){
  await change('save',{draft:{...emptyKnowledge(),services:[{code:'unsafe-price',name:'Unsafe price',kind,min:100,max:200,conditions:'Do not publish range as from'}]}});
  await assert.rejects(change('catalog',{reviewed:true,publicCatalog:true}),{status:409});assert.equal(db.prepare('SELECT count(*) AS n FROM services').get().n,2);
  assert.ok(!(await loadPublicBusinessContext()).includes('Do not publish range'));
 }
 await change('save',{draft:{...emptyKnowledge(),services:[{code:'another',name:'Another',kind:'estimate',min:null,max:null,conditions:''}]}});
 db.prepare('UPDATE services SET is_active=0').run();state=await dispatcherStatus(profile);
 await assert.rejects(change('catalog',{reviewed:true,publicCatalog:true}),/SQL-запись/);assert.equal(db.prepare('SELECT count(*) AS n FROM services').get().n,2);assert.ok(db.prepare('SELECT is_active FROM services').all().every(row=>row.is_active===0));db.prepare('UPDATE services SET is_active=1').run();
 await activate(schedule);assert.equal(state.previous,null);const firstVersion=state.active.version;
 await change('deactivate');assert.equal(state.active,null);assert.ok(state.previous);
 await change('rollback');assert.ok(state.active.version>firstVersion);
 const person=visitor();await desk.offer_booking({service:'legacy',start:'2026-11-09T15:00'},person);let old=await desk.pending(person.id);
 assert.equal(old.mode,'request');assert.equal(store.latestOffer(person.id).starts_at,'2026-11-09T12:00:00.000Z');
 await change('deactivate');await change('rollback');await assert.rejects(desk.confirm(person.id,input(old)),{code:'offer_changed'});
 await desk.offer_booking({service:'legacy',start:'2026-11-09T15:00'},person);old=await desk.pending(person.id);
 await activate({...schedule,timeZone:'Asia/Yekaterinburg',autoConfirm:true});
 await assert.rejects(desk.confirm(person.id,input(old)),{code:'offer_changed'});
 assert.equal(db.prepare('SELECT count(*) AS n FROM appointments').get().n,0);
 assert.equal((await desk.pending(person.id)).status,'stale');assert.match(await desk.get_booking_status({},person),/offer_changed/);assert.equal((await desk.pending(person.id)).timeZone,'Europe/Moscow');assert.equal((await desk.pending(person.id)).mode,'request');
 await desk.offer_booking({service:'legacy',start:'2026-11-09T15:00'},person);const fresh=await desk.pending(person.id);assert.equal(fresh.timeZone,'Asia/Yekaterinburg');
 const confirmed=await desk.confirm(person.id,input(fresh));assert.equal(confirmed.status,'confirmed');assert.equal(db.prepare('SELECT starts_at FROM appointments').get().starts_at,'2026-11-09T10:00:00.000Z');
 await activate(schedule);assert.equal((await desk.confirm(person.id,input(fresh))).status,'confirmed','Completed form remains idempotent');
 let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
 const waitingProvider=new Proxy(customers.provider,{get(target,key){if(key==='createCustomer')return async(...args)=>{enter();await gate;return target.createCustomer(...args)};return Reflect.get(target,key)}});
 const racingDesk=new BookingDesk({db,provider:waitingProvider,store,profile:()=>profile,now});const racing=visitor();await racingDesk.offer_booking({service:'legacy',start:'2026-11-09T17:00'},racing);const racingOffer=await racingDesk.pending(racing.id);
 const pending=racingDesk.confirm(racing.id,input(racingOffer));const rejection=assert.rejects(pending,{code:'offer_changed'});
 await entered;await activate({...schedule,autoConfirm:true});release();await rejection;
 assert.equal(db.prepare('SELECT count(*) AS n FROM appointments').get().n,1,'Policy race must not create a booking');
 const concurrent=visitor();await desk.offer_booking({service:'legacy',start:'2026-11-09T18:00'},concurrent);const concurrentOffer=await desk.pending(concurrent.id);
 const secondDesk=new BookingDesk({db,provider:customers.provider,store,profile:()=>profile,now});
 const outcomes=await Promise.allSettled([desk.confirm(concurrent.id,input(concurrentOffer)),secondDesk.confirm(concurrent.id,input(concurrentOffer))]);assert.ok(outcomes.some(result=>result.status==='fulfilled'));await secondDesk.confirm(concurrent.id,input(concurrentOffer));
 assert.equal(db.prepare('SELECT count(*) AS n FROM appointments').get().n,2,'Two desk instances create one booking for the same offer');
 // A completed receipt must never be replaced by a newer offer B.
 await activate(schedule);
 const repeat=visitor();await desk.offer_booking({service:'legacy',start:'2026-11-10T10:00'},repeat);const a=await desk.pending(repeat.id);const acceptedA=await desk.confirm(repeat.id,input(a));
 await desk.offer_booking({service:'legacy',start:'2026-11-10T11:00'},repeat);const b=await desk.pending(repeat.id);assert.notEqual(a.id,b.id);
 await activate({...schedule,timeZone:'Asia/Yekaterinburg',autoConfirm:true});
 const repeated=await desk.confirm(repeat.id,input(a));assert.equal(repeated.id,a.id);assert.equal(repeated.reference,acceptedA.reference);assert.equal(repeated.status,'requested');assert.equal(repeated.timeZone,'Europe/Moscow');
 assert.equal((await desk.pending(repeat.id,b.id)).status,'stale');assert.equal(await desk.pending(visitor().id,a.id),null);
 assert.match(await desk.get_booking_status({offerId:a.id},repeat),/requested:/);
 // Fail after office COMMIT, before linking the receipt in the conversation DB.
 await activate(schedule);const split=visitor();await desk.offer_booking({service:'legacy',start:'2026-11-10T12:00'},split);const splitOffer=await desk.pending(split.id);
 let receiptReadsFail=false;
 const brokenStore=new Proxy(store,{get(target,key){if(key==='completeOffer')return ()=>{receiptReadsFail=true;throw new Error('Injected failure after office commit')};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
 const brokenDb=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{if(receiptReadsFail&&sql.includes("WHERE source='website' AND external_id=?"))throw new Error('Injected receipt read failure');return target.prepare(sql)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
 const brokenDesk=new BookingDesk({db:brokenDb,provider:customers.provider,store:brokenStore,profile:()=>profile,now});
 await assert.rejects(brokenDesk.confirm(split.id,input(splitOffer)),{code:'booking_status_unknown'});
 const committed=db.prepare("SELECT * FROM appointments WHERE external_id=?").get('chat:'+splitOffer.id);assert.ok(committed);assert.equal(store.getOffer(splitOffer.id).status,'offered');const countBeforeRecovery=db.prepare('SELECT count(*) AS n FROM appointments').get().n;
 await activate({...schedule,timeZone:'Asia/Yekaterinburg',autoConfirm:true});receiptReadsFail=false;
 const recovered=await desk.confirm(split.id,input(splitOffer));assert.equal(recovered.id,splitOffer.id);assert.equal(recovered.reference,committed.id.slice(0,8));assert.equal(recovered.start,'2026-11-10T12:00');assert.equal(recovered.timeZone,'Europe/Moscow');assert.equal(recovered.status,'requested');
 assert.equal(store.getOffer(splitOffer.id).appointment_id,committed.id);assert.equal(db.prepare('SELECT count(*) AS n FROM appointments').get().n,countBeforeRecovery);
 // A persistent metadata-write failure can still return a verified office receipt.
 await activate(schedule);const persistent=visitor();await desk.offer_booking({service:'legacy',start:'2026-11-10T14:00'},persistent);const persistentOffer=await desk.pending(persistent.id);
 const metadataOnly=new Proxy(store,{get(target,key){if(key==='completeOffer')return ()=>{throw new Error('Injected persistent metadata failure')};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}});
 const metadataDesk=new BookingDesk({db,provider:customers.provider,store:metadataOnly,profile:()=>profile,now});
 const known=await metadataDesk.confirm(persistent.id,input(persistentOffer));assert.equal(known.id,persistentOffer.id);assert.equal(known.status,'requested');assert.ok(known.reference);
 assert.equal(store.getOffer(persistentOffer.id).status,'offered');assert.equal((await desk.pending(persistent.id,persistentOffer.id)).status,'requested');
 const superseded=visitor();await desk.offer_booking({service:'legacy',start:'2026-11-11T10:00'},superseded);const replaced=await desk.pending(superseded.id);await desk.offer_booking({service:'legacy',start:'2026-11-11T11:00'},superseded);
 assert.match(await desk.get_booking_status({offerId:replaced.id},superseded),/^offer_closed:/);assert.equal((await desk.pending(superseded.id,replaced.id)).status,'withdrawn');
 const {createServer}=await import('node:http');const {createWebChannel}=await import('../services/conversation/web-channel.mjs');
 const allowedHosts=new Set();let activeDesk=desk;
 const channel=createWebChannel({core:{authorize:(...args)=>store.authorize(...args)},booking:{confirm:(...args)=>activeDesk.confirm(...args),pending:(...args)=>activeDesk.pending(...args)},allowedHosts});
 const server=createServer((req,res)=>channel.handle(req,res,new URL(req.url,'http://localhost').pathname));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;allowedHosts.add('127.0.0.1:'+port);
 const post=async(endpoint,person,body)=>{const response=await fetch('http://127.0.0.1:'+port+endpoint,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+person.token},body:JSON.stringify({conversationId:person.id,...body})});return {status:response.status,body:await response.json()}};
 try {
  const httpA=await post('/api/chat/booking/confirm',repeat,input(a));assert.equal(httpA.status,200);assert.equal(httpA.body.offer.id,a.id);assert.equal(httpA.body.offer.status,'requested');
  const httpB=await post('/api/chat/booking',repeat,{offerId:b.id});assert.equal(httpB.body.offer.id,b.id);assert.notEqual(httpB.body.offer.id,a.id);
  const foreign=await post('/api/chat/booking',persistent,{offerId:a.id});assert.equal(foreign.body.offer,null);
  activeDesk=brokenDesk;receiptReadsFail=true;const unknown=await post('/api/chat/booking',split,{offerId:splitOffer.id});assert.equal(unknown.status,503);assert.equal(unknown.body.error.code,'booking_status_unknown');
  receiptReadsFail=false;activeDesk=desk;const httpRecovered=await post('/api/chat/booking',split,{offerId:splitOffer.id});assert.equal(httpRecovered.status,200);assert.equal(httpRecovered.body.offer.reference,committed.id.slice(0,8));
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 console.log('Dispatcher safety PASS: stale timezone/mode, exact instant, policy race across CRM await, duplicate confirm, full fallback transition, public-price refusal, first activation deactivation/restore/exact receipt A vs B/split-store recovery/uncertain reads');
}finally{await customers.stop();await crm.close();store.close();db.close();if(path.dirname(root)!==path.resolve(os.tmpdir()))throw new Error('Unsafe cleanup');await rm(root,{recursive:true,force:true});}
