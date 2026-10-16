import {runWorkerSimulation} from './simulation.mjs';
self.onmessage=async()=>{try{self.postMessage({ok:true,value:await runWorkerSimulation()});}catch(error){self.postMessage({ok:false,error:{message:error.message,code:error.code,hint:error.hint,detail:error.detail}});}};
