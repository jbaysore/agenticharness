import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHarness} from '../src/server.mjs';

test('real local HTTP server requires pairing, enforces same-origin writes, and keeps stored history',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'harness-http-')),app=await createHarness({dataDir:dir,port:0,startProviders:false});const url=app.runtime.origin;
  try {
    assert.equal((await fetch(url+'/api/state')).status,401);
    const code=app.auth.pairing(),headers={'Content-Type':'application/json','X-Harness-Client':'1'};
    const paired=await fetch(url+'/api/pair',{method:'POST',headers,body:JSON.stringify({code})});assert.equal(paired.status,200);const cookie=paired.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(url+'/api/state',{headers:{cookie}})).status,200);
    assert.equal((await fetch(url+'/api/projects',{method:'POST',headers:{cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
    assert.equal((await fetch(url+'/api/state',{headers:{cookie,Origin:'https://evil.example'}})).status,403);
    const project=await fetch(url+'/api/projects',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({path:dir,name:'Test project'})}).then(r=>r.json());
    const chat=await fetch(url+'/api/chats',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({projectId:project.id})}).then(r=>r.json());assert.ok(chat.id);
    const state=await fetch(url+'/api/state',{headers:{cookie}}).then(r=>r.json());assert.equal(state.conversations.length,1);
    assert.equal((await fetch(url+'/internal/history',{method:'POST',headers,body:'{}'})).status,401);
    const response=await fetch(url+'/api/chats/'+chat.id+'/messages',{method:'POST',headers:{...headers,cookie},body:JSON.stringify({actionId:'submit-once-12345',text:'hello',provider:'codex',model:'unverified'})});assert.equal(response.status,400);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
