import { createInterface } from 'node:readline';
import { historyTools } from './core/history.mjs';
const reply=message=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',async line=>{
  let m;try{m=JSON.parse(line);}catch{return;}
  if(m.id===undefined)return;
  try {
    if(m.method==='initialize')reply({id:m.id,result:{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'harness-history',version:'0.1.0'}}});
    else if(m.method==='ping')reply({id:m.id,result:{}});
    else if(m.method==='tools/list')reply({id:m.id,result:{tools:historyTools}});
    else if(m.method==='tools/call') {
      const response=await fetch(process.env.HARNESS_BRIDGE_URL+'/internal/history',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.HARNESS_BRIDGE_TOKEN},body:JSON.stringify(m.params),signal:AbortSignal.timeout(15000)});
      const value=await response.json();reply({id:m.id,result:{isError:!response.ok,content:[{type:'text',text:JSON.stringify(value)}]}});
    }else reply({id:m.id,error:{code:-32601,message:'Method not supported'}});
  }catch(error){reply({id:m.id,error:{code:-32603,message:error.message}});}
});
