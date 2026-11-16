const open = (): Promise<IDBDatabase> => new Promise((resolve,reject)=>{
  const request=indexedDB.open('forgeax-water-r7',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('publication');
  request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
});
export async function loadBakeSnapshot():Promise<unknown>{
  const db=await open();
  try{const saved=await new Promise<Blob|undefined>((resolve,reject)=>{const tx=db.transaction('publication','readonly'),request=tx.objectStore('publication').get('river');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});return saved===undefined?undefined:JSON.parse(await saved.text());}
  finally{db.close();}
}
export async function saveBakeSnapshot(snapshot:unknown):Promise<void>{
  const bytes=new Blob([JSON.stringify(snapshot)],{type:'application/json'});
  const db=await open();
  try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('publication','readwrite');tx.objectStore('publication').put(bytes,'river');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}
  finally{db.close();}
}
