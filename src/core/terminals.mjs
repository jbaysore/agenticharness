import * as pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { subscriptionEnvironment } from '../security/environment.mjs';
export class Terminals {
  sessions=new Map();
  constructor(onEvent){this.onEvent=onEvent;}
  list(){return [...this.sessions.values()].map(({process,...session})=>session);}
  create(project){
    if(this.sessions.size>=8)throw new Error('Close a terminal before opening another (maximum eight).');
    const id=randomUUID(),shell=process.platform==='win32'?'powershell.exe':process.env.SHELL??'/bin/sh';
    const child=pty.spawn(shell,process.platform==='win32'?['-NoLogo','-NoProfile']:[],{cwd:project.path,env:subscriptionEnvironment(),cols:100,rows:24,name:'xterm-256color',useConpty:true});
    const session={id,projectId:project.id,title:'Terminal',output:'',status:'running',process:child};this.sessions.set(id,session);
    child.onData(data=>{session.output=(session.output+data).slice(-200000);this.onEvent('terminal-output',{id,data});});
    child.onExit(({exitCode})=>{session.status='exited';this.onEvent('terminal-exit',{id,exitCode});});
    return {id,projectId:project.id,title:session.title,status:'running',output:''};
  }
  write(id,data){const s=this.sessions.get(id);if(!s||s.status!=='running')throw new Error('Terminal has ended');if(typeof data!=='string'||data.length>10000)throw new Error('Invalid terminal input');s.process.write(data);}
  resize(id,cols,rows){if(Number.isInteger(cols)&&Number.isInteger(rows)&&cols>=10&&cols<=500&&rows>=2&&rows<=200)this.sessions.get(id)?.process.resize(cols,rows);}
  close(id){const s=this.sessions.get(id);if(s){s.process.kill();this.sessions.delete(id);}}
  closeAll(){for(const id of this.sessions.keys())this.close(id);}
}
