// Serialize supported configuration changes and final booking commits across local processes.
import { mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { businessPath } from '../../scripts/lib/paths.mjs';
export async function withDispatcherLock(action) {
  const dir=businessPath('dispatcher');mkdirSync(dir,{recursive:true});
  const lock=businessPath('dispatcher','action.lock');
  const deadline=Date.now()+5000;let handle;
  while(handle===undefined) {
    try { handle=openSync(lock,'wx'); }
    catch(error) { if(error.code!=='EEXIST')throw error;if(Date.now()>deadline)throw Object.assign(new Error('Настройки заняты другой операцией. Повторите позже; после аварийной остановки проверьте dispatcher/action.lock'),{status:409});await new Promise(resolve=>setTimeout(resolve,25)); }
  }
  try { return await action(); } finally { closeSync(handle);unlinkSync(lock); }
}
