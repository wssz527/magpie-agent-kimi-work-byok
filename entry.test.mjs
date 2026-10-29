import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const entry = new URL('./index.mjs', import.meta.url).href;

test('the shipped plugin entry connects, forwards both protocols, refreshes models and disconnects in an isolated host', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-entry-'));
  try {
    const child = spawnSync(process.execPath, ['--eval', `
      import fs from 'node:fs';
      import path from 'node:path';
      import http from 'node:http';
      const home = process.env.MAGPIE_KIMI_DATA_HOME;
      const stateDir = path.join(home, '.config', 'magpie-kimi');
      const { defaultKimiDirectory } = await import(${JSON.stringify(new URL('./adapter.mjs', import.meta.url).href)});
      const kimiDir = defaultKimiDirectory(home);
      const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value)); };
      const check = (condition, message) => { if (!condition) throw Error(message); };
      const key = 'isolated-entry-key';
      const data = [{id:'group/kimi-entry-chat',context_window:8192},{id:'group/entry-responses',context_window:16384}];
      let forwarded = 0;
      const upstream = http.createServer(async (req,res) => {
        if (req.url === '/v1/models') { res.end(JSON.stringify({data})); return; }
        let body=''; for await (const chunk of req) body += chunk;
        forwarded++;
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({path:req.url,model:JSON.parse(body).model}));
      });
      await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
      const desired = {enabled:false,mode:'native-byok',gateway:{url:'http://127.0.0.1:'+upstream.address().port+'/v1',key},nativeByok:{port:0}};
      const connection = path.join(stateDir,'connection.json');
      const configFile = path.join(kimiDir,'config.json');
      write(connection,desired); write(configFile,{model:{providers:{}},retained:'fixture'});
      write(path.join(kimiDir,'agents','main','runner.state.json'),{lifecycleStatus:'running'});
      write(path.join(path.dirname(path.dirname(kimiDir)),'kimi-agent','byok-availability.json'),{revealed:true});
      const plugin = (await import(${JSON.stringify(entry)})).default;
      let adapter;
      try {
        await plugin({});
        adapter=globalThis[Symbol.for('magpie.kimi-desktop.adapter.v1')];
        clearInterval(adapter.timer);
        adapter.nativeProbe.lookupFn=async()=>({address:'10.0.0.2'});
        const {connect,agent}=await import(${JSON.stringify(new URL('./kimi-desktop.agent.js', import.meta.url).href)});
        const changes=connect({gateway:{v1:desired.gateway.url,key},model:{id:data[0].id}});
        for (const [key,value] of Object.entries(changes)) {
          if (key==='nativeByok.dns.enabled') continue;
          const keys=key.split('.'); let target=desired;
          for (const part of keys.slice(0,-1)) target=target[part]??={};
          target[keys.at(-1)]=value;
        }
        check(agent.model==='subagents.model','selector metadata mismatch');
        desired.subagents.model=data[0].id;
        write(connection,desired);
        await adapter.tick();
        const policyFile=path.join(stateDir,'subagent-policy.json');
        check(readPolicy().modelAlias==='byok-kth-kimi/'+data[0].id,'selected child policy mismatch');
        check(['not-prepared','unsupported'].includes(adapter.status.subagents.runtime.state),'unloaded runtime reported active');
        function readPolicy(){return JSON.parse(fs.readFileSync(policyFile,'utf8'));}
        const url=adapter.nativeGateway.url;
        const headers={Authorization:'Bearer '+key};
        const catalog=await (await fetch(url+'/models/api.json',{headers})).json();
        check(catalog.kimi.models['group/kimi-entry-chat'] && catalog.responses.models['group/entry-responses'],'catalog mismatch');
        const list=await (await fetch(url+'/models',{headers})).json();
        check(list.data.length===2,'OpenAI catalog mismatch');
        for (const [endpoint,model] of [['/chat/completions','group/kimi-entry-chat'],['/responses','group/entry-responses']]) {
          const response=await fetch(url+endpoint,{method:'POST',headers,body:JSON.stringify({model,messages:[],input:'hello'})});
          const result=await response.json();
          check(response.status===200 && result.path==='/v1'+endpoint && result.model===model,'inference mismatch');
        }
        const denied=await fetch(url+'/responses',{method:'POST',headers,body:JSON.stringify({model:'group/kimi-entry-chat',input:'hello'})});
        check(denied.status===409 && forwarded===2,'protocol mismatch reached upstream'); await denied.text();
        write(configFile,{model:{providers:{'byok-kth-resp':{baseUrl:url}}},retained:'fixture'});
        await adapter.tick(); check(adapter.status.code==='native_byok_waiting_import','partial import reported ready');
        write(configFile,{model:{providers:{'byok-kth-resp':{baseUrl:url},'byok-kth-kimi':{baseUrl:url}}},retained:'fixture'});
        await adapter.tick(); check(adapter.status.code==='native_byok_ready','import readiness mismatch');
        data.shift(); adapter.nativeCatalogAfter=0; await adapter.tick();
        check(adapter.status.compat.scope==='active-models' && adapter.status.compat.modelCount===1,'compat catalog stale');
        check(adapter.status.gatewayReady && adapter.status.subagents.policy.mode==='blocked','child revocation disabled main gateway');
        check(readPolicy().mode==='blocked','revoked child was retained');
        desired.enabled=false; write(connection,desired); await adapter.tick();
        check(adapter.status.code==='disconnected' && !adapter.nativeGateway.server,'disconnect failed');
        check(readPolicy().mode==='inherit','disconnect retained child override');
        check(JSON.parse(fs.readFileSync(configFile)).retained==='fixture','Kimi data changed');
        console.log('entry flow verified');
      } finally {
        if (adapter) await adapter.stop();
        upstream.closeAllConnections?.(); await new Promise(resolve=>upstream.close(resolve));
      }
    `], { env: { ...process.env, MAGPIE_KIMI_DATA_HOME: home, APPDATA: path.join(home, 'AppData', 'Roaming') },
      encoding: 'utf8', timeout: 20000 });
    expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 0, stderr: '' });
    expect(child.stdout).toContain('entry flow verified');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}, 30000);
