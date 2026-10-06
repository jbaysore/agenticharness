import { createServer } from 'node:http';
import { readFile,mkdir,writeFile,stat } from 'node:fs/promises';
import { resolve,join,basename,dirname } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { randomBytes,randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { Store } from './core/store.mjs';
import { Controller } from './core/controller.mjs';
import { Authentication,safeOrigin,readJson } from './security/http.mjs';
import { projectPath,repositoryState,repositoryDiff,readRepositoryFile } from './core/repository.mjs';
import { historyCall } from './core/history.mjs';
import { cursorAuth } from './providers/cursor.mjs';
import { Terminals } from './core/terminals.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function createHarness({dataDir=process.env.HARNESS_DATA_DIR??join(process.env.LOCALAPPDATA??homedir(),'AgenticHarness'),port=Number(process.env.HARNESS_PORT??47831),publicOrigin=process.env.HARNESS_PUBLIC_ORIGIN??null,startProviders=true,seedProject=process.env.HARNESS_INITIAL_PROJECT}={}) {
  if(publicOrigin){const url=new URL(publicOrigin);if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash)throw new Error('Remote origin must be an HTTPS origin without a path');publicOrigin=url.origin;}
  await mkdir(dataDir,{recursive:true});await mkdir(join(dataDir,'connection-probe'),{recursive:true});
  const store=new Store(join(dataDir,'workspace.sqlite'));
  if(seedProject)store.addProject(basename(seedProject),await projectPath(seedProject));
  const auth=new Authentication(store),instanceId=randomUUID(),controlToken=randomBytes(32).toString('base64url');
  let localOrigin,controller;
  const clients=new Set();
  const terminals=new Terminals((type,data)=>controller?.event(null,null,type,data));
  const json=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
  const projectRoot=(projectId,index)=>{
    const project=store.project(projectId);if(!project)throw new Error('Project not found');
    if(index===null||index===undefined||index===''||index==='primary')return project.path;
    const ref=project.repositories[Number(index)];if(!ref)throw new Error('Repository not found');return ref.path;
  };
  const server=createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
    try {
      if(!safeOrigin(req,localOrigin,publicOrigin))return json(res,403,{error:'Unrecognized host or cross-site request'});
      const url=new URL(req.url,localOrigin),path=url.pathname,method=req.method;
      if(path==='/health'&&method==='GET')return json(res,200,{app:'Agentic Harness',version:'0.1.0',instanceId});
      if(path==='/internal/launch'&&method==='POST') {
        if(req.headers.authorization!=='Bearer '+controlToken)return json(res,401,{error:'Invalid local launch capability'});
        return json(res,200,{url:localOrigin+'/#pair='+auth.pairing()});
      }
      if(path==='/internal/history'&&method==='POST') {
        const token=req.headers.authorization?.replace(/^Bearer /,''),chatId=controller.bridgeTokens.get(token);
        if(!chatId)return json(res,401,{error:'History capability expired'});
        const body=await readJson(req);return json(res,200,historyCall(store,chatId,body.name,body.arguments??{}));
      }
      if(path.startsWith('/api/')) {
        if(!['GET','HEAD'].includes(method)&&req.headers['x-harness-client']!=='1')return json(res,403,{error:'Missing same-origin client header'});
        if(path==='/api/pair'&&method==='POST') {
          const body=await readJson(req),token=auth.pair(body.code,req.socket.remoteAddress);
          const secure=req.headers.host===new URL(publicOrigin??localOrigin).host&&!!publicOrigin;
          return json(res,200,{ok:true},{'Set-Cookie':`harness_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure?'; Secure':''}`});
        }
        if(!auth.authenticated(req))return json(res,401,{error:'Pair this browser with the Windows host'});
        if(path==='/api/logout'&&method==='POST'){auth.logout(req);return json(res,200,{ok:true},{'Set-Cookie':'harness_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
        if(path==='/api/pairing-code'&&method==='POST')return json(res,200,{code:auth.pairing(),expiresInMinutes:10,remoteOrigin:publicOrigin});
        if(path==='/api/state'&&method==='GET')return json(res,200,{...store.snapshot(),providers:controller.providers,terminals:terminals.list(),remoteOrigin:publicOrigin,version:'0.1.0'});
        if(path==='/api/providers/refresh'&&method==='POST')return json(res,200,{providers:await controller.refreshProviders()});
        if(path==='/api/providers/cursor/confirm'&&method==='POST') {
          const body=await readJson(req);if(body.disabled!==true)throw new Error('Confirm on-demand usage is disabled in the Cursor account settings');
          const current=await cursorAuth();if(!current.connected)throw new Error('Sign in to Cursor first');
          store.setting('cursor-billing',{fingerprint:current.fingerprint,disabled:true,verifiedAt:Date.now(),source:'user-confirmed provider dashboard'});
          return json(res,200,{providers:await controller.refreshProviders()});
        }
        if(path==='/api/events'&&method==='GET') {
          res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});
          const after=Number(req.headers['last-event-id']??url.searchParams.get('after')??0);
          if(!Number.isSafeInteger(after)||after<0){res.end();return;}
          const replay=store.events(after,2001);
          if(replay.length>2000)res.write(`event: resync\ndata: ${JSON.stringify({lastEventId:store.latestEventId()})}\n\n`);
          else for(const event of replay)res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          clients.add(res);const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),20000);
          req.on('close',()=>{clients.delete(res);clearInterval(heartbeat);});return;
        }
        if(path==='/api/projects'&&method==='POST') {
          const body=await readJson(req),path=await projectPath(body.path),project=store.addProject(String(body.name??basename(path)).slice(0,100),path);
          controller.event(null,null,'projects',{});return json(res,201,project);
        }
        let match;
        if((match=path.match(/^\/api\/projects\/([^/]+)\/references$/))&&method==='POST') {
          const body=await readJson(req),path=await projectPath(body.path);return json(res,200,store.addReference(match[1],{name:String(body.name??basename(path)).slice(0,100),path,reason:String(body.reason??'Upstream reference').slice(0,1000)}));
        }
        if(path==='/api/chats'&&method==='POST') {
          const body=await readJson(req);if(!store.project(body.projectId))throw new Error('Choose a project first');
          const chat=store.createConversation({projectId:body.projectId,provider:body.provider??'codex',model:body.model??'',effort:body.effort??null});
          controller.event(chat.id,null,'chat',chat);return json(res,201,chat);
        }
        if((match=path.match(/^\/api\/chats\/([^/]+)$/))) {
          const id=match[1];if(!store.conversation(id))return json(res,404,{error:'Conversation not found'});
          if(method==='GET')return json(res,200,store.conversationSnapshot(id));
          if(method==='PATCH') {
            const body=await readJson(req),fields={};
            if(body.title!==undefined)fields.title=String(body.title).slice(0,120);
            if(body.scope!==undefined){if(!['none','project','all'].includes(body.scope))throw new Error('Invalid history scope');if(controller.active.has(id))throw new Error('Stop the turn before changing history scope');fields.scope=body.scope;fields.sessions={};}
            return json(res,200,store.updateConversation(id,fields));
          }
        }
        if((match=path.match(/^\/api\/chats\/([^/]+)\/messages$/))&&method==='POST')return json(res,202,controller.send(match[1],await readJson(req)));
        if((match=path.match(/^\/api\/chats\/([^/]+)\/cancel$/))&&method==='POST')return json(res,200,controller.cancel(match[1]));
        if((match=path.match(/^\/api\/approvals\/([^/]+)$/))&&method==='POST')return json(res,200,controller.answer(match[1],await readJson(req)));
        if(path==='/api/search'&&method==='GET')return json(res,200,store.search(url.searchParams.get('q')??'',{projectId:url.searchParams.get('projectId')??undefined}));
        if(path==='/api/repository'&&method==='GET')return json(res,200,await repositoryState(projectRoot(url.searchParams.get('projectId'),url.searchParams.get('repo'))));
        if(path==='/api/diff'&&method==='GET')return json(res,200,await repositoryDiff(projectRoot(url.searchParams.get('projectId'),url.searchParams.get('repo')),url.searchParams.get('file')));
        if(path==='/api/file'&&method==='GET')return json(res,200,await readRepositoryFile(projectRoot(url.searchParams.get('projectId'),url.searchParams.get('repo')),url.searchParams.get('file')));
        if(path==='/api/comments'&&method==='POST') {
          const body=await readJson(req),chat=store.conversation(body.conversationId);if(!chat)throw new Error('Conversation not found');
          const root=projectRoot(chat.project_id,body.repo),diff=await repositoryDiff(root,body.file);
          if(diff.revision!==body.revision)return json(res,409,{error:'The diff changed. Refresh it before attaching this comment.'});
          if(!Number.isInteger(body.line)||body.line<1||typeof body.body!=='string'||!body.body.trim()||body.body.length>20000)throw new Error('Provide a line number and review comment');
          const id=store.addComment({...body,repository:root});return json(res,201,{id});
        }
        if(path==='/api/artifacts'&&method==='POST') {
          const body=await readJson(req),chat=store.conversation(body.conversationId);if(!chat)throw new Error('Choose a conversation first');
          const root=projectRoot(chat.project_id,body.repo);await readRepositoryFile(root,body.file);
          const id=randomUUID();store.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?)').run(id,chat.id,chat.project_id,root,body.file,String(body.title??basename(body.file)).slice(0,120),store.now());
          return json(res,201,{id});
        }
        if(path==='/api/notes'&&method==='GET')return json(res,200,store.notes(url.searchParams.get('projectId')));
        if(path==='/api/notes'&&method==='POST') {
          const body=await readJson(req);if(!store.project(body.projectId)||!body.content?.trim()||!Array.isArray(body.evidence)||!body.evidence.length)throw new Error('A project note needs content and source evidence');
          return json(res,201,{id:store.addNote(body)});
        }
        if((match=path.match(/^\/api\/notes\/([^/]+)\/stale$/))&&method==='POST') {store.db.prepare('UPDATE notes SET stale=1 WHERE id=?').run(match[1]);return json(res,200,{ok:true});}
        if(path==='/api/terminals'&&method==='GET')return json(res,200,terminals.list());
        if(path==='/api/terminals'&&method==='POST'){const body=await readJson(req),project=store.project(body.projectId);if(!project)throw new Error('Project not found');return json(res,201,terminals.create(project));}
        if((match=path.match(/^\/api\/terminals\/([^/]+)\/(input|resize|close)$/))&&method==='POST') {
          const body=await readJson(req);if(match[2]==='input')terminals.write(match[1],body.data);if(match[2]==='resize')terminals.resize(match[1],body.cols,body.rows);if(match[2]==='close')terminals.close(match[1]);return json(res,200,{ok:true});
        }
        if(path==='/api/activity'&&method==='GET')return json(res,200,store.db.prepare('SELECT * FROM events WHERE conversation_id=? AND type IN (\'work\',\'handoff\',\'run\') ORDER BY id DESC LIMIT 150').all(url.searchParams.get('chatId')).map(e=>({...e,payload:JSON.parse(e.payload)})));
        if(path==='/api/export'&&method==='GET') {
          const data={version:1,exportedAt:new Date().toISOString(),projects:store.projects(),conversations:store.conversations().map(c=>({...c,messages:store.messages(c.id),comments:store.comments(c.id)})),notes:store.projects().flatMap(p=>store.notes(p.id))};
          return json(res,200,data,{'Content-Disposition':'attachment; filename="harness-history.json"'});
        }
        return json(res,404,{error:'Endpoint not found'});
      }
      if(method!=='GET'&&method!=='HEAD')return json(res,405,{error:'Method not allowed'});
      const assets={'/':'index.html','/app.js':'app.js','/app.css':'app.css'};
      const asset=assets[path];if(!asset)return json(res,404,{error:'Not found'});
      const content=await readFile(join(root,'dist',asset));res.setHeader('Cache-Control','no-cache');res.setHeader('Content-Type',asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html');res.end(content);
    }catch(error){if(!res.headersSent)json(res,400,{error:error.message});else res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const actualPort=server.address().port;localOrigin=`http://127.0.0.1:${actualPort}`;
  controller=new Controller(store,{probePath:join(dataDir,'connection-probe'),bridgeUrl:localOrigin});
  controller.on('event',event=>{const data=`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;for(const client of clients){if(client.writableLength>2*1024*1024){client.end();clients.delete(client);}else client.write(data);}});
  const runtime={pid:process.pid,port:actualPort,origin:localOrigin,instanceId,controlToken};
  await writeFile(join(dataDir,'runtime.json'),JSON.stringify(runtime),{mode:0o600});
  if(startProviders)controller.refreshProviders().catch(()=>{});
  return {server,store,controller,auth,terminals,runtime,dataDir,async close(){await controller.close();terminals.closeAll();for(const client of clients)client.end();server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));store.close();}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const app=await createHarness();console.log(`Agentic Harness is running at ${app.runtime.origin}`);
  let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
  process.on('SIGINT',close);process.on('SIGTERM',close);
}
