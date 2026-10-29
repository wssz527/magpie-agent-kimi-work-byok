import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import { NativeByokGateway } from './native-byok.mjs';
import { LocalKimiAdapter } from './native-controller.mjs';
import { NativeSetupProbe } from './native-status.mjs';
import { NativeByokDNS, BYOK_ADDRESS, BYOK_DOMAIN, dnsReply, nativePrivateAddress, resolverConfiguration } from './native-dns.mjs';
import { applyResponsesInstructions } from './library.mjs';

const key = 'synthetic-magpie-key';
const official = 'https://agent-gw.kimi.com/coding/v1';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, JSON.stringify(value)); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const close = server => { server.closeAllConnections?.(); return new Promise(resolve => server.close(resolve)); };
const ids = ['group/glm-5-3-flash', 'group/deepseek-v4-1-flash', 'group/gpt-6-1-sol', 'group/kimi-k3.1-rpro',
  'group/glm-5-3', 'group/opus-5-5', 'group/step-5'];

async function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-byok-'));
  const requests = [], catalogRequests = [];
  const data = ids.map(id => ({id, display_name:id, context_window:131072, max_output_tokens:32768,
    reasoning:true, supported_reasoning_levels:[{effort:'low'},{effort:'high'}], modalities:{input:['text','image']}}));
  const control = {status:200, catalogStatus:200, catalogBody:null, stream:false, cancelled:0};
  const upstream = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      catalogRequests.push(req.headers);
      res.writeHead(control.catalogStatus, {'Content-Type':'application/json'});
      res.end(control.catalogBody ?? JSON.stringify({data})); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({path:req.url, headers:req.headers, body:JSON.parse(body)});
    if (control.stream) {
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      res.on('close', () => control.cancelled++);
      return;
    }
    res.writeHead(control.status, {'Content-Type':control.status===200?'text/event-stream':'application/json',
      'Retry-After':'17','X-Request-ID':'synthetic-request'});
    res.end(control.status===200 ? 'event: response.completed\ndata: {"type":"response.completed","output":[{"type":"function_call","call_id":"read-1","name":"Read","arguments":"{}"}]}\n\ndata: [DONE]\n\n'
      : '{"error":{"message":"synthetic upstream rejection"}}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + upstream.address().port + '/v1';
  const instructionsFile = path.join(directory, 'AGENTS.md');
  const adapter = new NativeByokGateway({instructionsFile, ...options});
  await adapter.configure({url,key,port:0});
  return {directory, upstream, adapter, data, requests, catalogRequests, control, url, instructionsFile,
    async cleanup() { await adapter.stop(); await close(upstream); fs.rmSync(directory,{recursive:true,force:true}); }};
}

function request(f, endpoint, payload, extra = {}) {
  return fetch(f.adapter.url + endpoint, {method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',...extra},
    body:JSON.stringify(payload)});
}

test('native metadata retains all seven IDs, limits and reasoning options without renaming generic models', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.adapter.url+'/models/api.json',{headers:{Authorization:'Bearer '+key}});
    expect(response.status).toBe(200);
    const groups = await response.json();
    expect(groups.kimi.type).toBe('kimi');
    expect(groups.responses.type).toBe('openai_responses');
    expect(Object.keys(groups.kimi.models)).toEqual(['group/kimi-k3.1-rpro']);
    expect(Object.keys(groups.responses.models)).toHaveLength(6);
    expect(groups.responses.models['group/glm-5-3-flash']).toMatchObject({limit:{context:131072,output:32768},
      reasoning:true,tool_call:true,support_efforts:['low','high'],default_effort:'high'});
    expect(f.catalogRequests[0].authorization).toBe('Bearer '+key);
    expect(f.catalogRequests[0]['user-agent']).toBe('Desktop Kimi Work');
  } finally { await f.cleanup(); }
});

test('native menu selections control the upstream model in both protocols and preserve complete histories', async () => {
  const f = await fixture();
  try {
    const input = [
      {role:'system',content:'native system prompt'},
      {role:'developer',content:'native developer prompt'},
      {role:'user',content:[{type:'input_text',text:'synthetic 中文'},{type:'input_image',image_url:'data:image/png;base64,AAAA'}]},
      {type:'reasoning',id:'reason-1',summary:[{type:'summary_text',text:'synthetic reasoning'}]},
      {type:'function_call',call_id:'read-1',name:'Read',arguments:'{}'},
      {type:'function_call_output',call_id:'read-1',output:'synthetic result'},
    ];
    for (const [endpoint, model] of [['/responses',ids[0]],['/responses','byok-kth-resp/'+ids[1]],['/chat/completions','byok-kth-kimi/'+ids[3]]]) {
      const messages = [{role:'system',content:'native'},{role:'assistant',reasoning_content:'keep',tool_calls:[{id:'read-1',type:'function',function:{name:'Read',arguments:'{}'}}]},
        {role:'tool',tool_call_id:'read-1',content:'synthetic result'}];
      const payload = {model,stream:true,reasoning:{effort:'high',summary:'auto'},thinking:{type:'enabled',effort:'high'},
        ...(endpoint==='/responses'?{input,instructions:'native instructions',tools:[{type:'function',name:'Read',parameters:{type:'object'}}]}:{messages})};
      const response = await request(f,endpoint,payload);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('"call_id":"read-1"');
      expect(body).toEndWith('data: [DONE]\n\n');
      const expectedModel = model.replace(/^byok-kth-(?:resp|kimi)\//,'');
      expect(f.requests.at(-1).body).toEqual({...payload,model:expectedModel});
      expect(f.requests.at(-1).path).toBe('/v1'+endpoint);
      expect(f.requests.at(-1).headers.authorization).toBe('Bearer '+key);
    }
  } finally { await f.cleanup(); }
});

test('Responses shared instructions update independently while native messages, reasoning and tool items stay unchanged', async () => {
  const f = await fixture();
  try {
    const payload = {model:ids[0],input:[{role:'system',content:'native'},{role:'developer',content:'native developer'},
      {type:'reasoning',id:'reason-1',encrypted_content:'synthetic'},
      {type:'function_call',call_id:'read-1',name:'Read',arguments:'{}'},
      {type:'function_call_output',call_id:'read-1',output:'synthetic'}],instructions:'keep instructions',previous_response_id:'synthetic-response'};
    for (const rule of ['rule one','rule two','']) {
      fs.writeFileSync(f.instructionsFile,rule);
      const response = await request(f,'/responses',payload); expect(response.status).toBe(200); await response.text();
      const sent = f.requests.at(-1).body;
      expect(sent.instructions).toBe(payload.instructions);
      expect(sent.input.slice(rule?3:2)).toEqual(payload.input.slice(2));
      expect(sent.input.slice(0,2)).toEqual(payload.input.slice(0,2));
      if (rule) expect(sent.input[2].content[0].text).toContain(rule);
    }
    fs.writeFileSync(f.instructionsFile,'new rule');
    const once = applyResponsesInstructions(payload,f.instructionsFile);
    expect(applyResponsesInstructions(once,f.instructionsFile)).toEqual(once);
    fs.writeFileSync(f.instructionsFile,'');
    expect(applyResponsesInstructions(once,f.instructionsFile)).toEqual(payload);
    fs.writeFileSync(f.instructionsFile,Buffer.from([0xff]));
    const failed = await request(f,'/responses',payload);
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.code).toBe('instructions_unavailable');
    expect(f.requests).toHaveLength(3);
  } finally { await f.cleanup(); }
});

test('removed selections and unavailable catalogs never fall back to the selected default or another supplier', async () => {
  const f = await fixture();
  try {
    f.data.splice(0,1);
    const denied = await request(f,'/responses',{model:ids[0],input:[]});
    expect(denied.status).toBe(409); await denied.text();
    expect(f.requests).toHaveLength(0);
    f.control.catalogStatus = 503;
    const unavailable = await request(f,'/responses',{model:ids[1],input:[]});
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe('catalog_unavailable');
    f.control.catalogStatus = 200; f.control.catalogBody = 'not JSON';
    const invalid = await request(f,'/responses',{model:ids[1],input:[]});
    expect(invalid.status).toBe(503); await invalid.text();
    expect(f.requests).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test('auth, browser and path restrictions apply before model discovery or inference', async () => {
  const f = await fixture();
  try {
    for (const [method,endpoint,headers,status] of [
      ['GET','/models/api.json',{},401],
      ['POST','/responses',{Authorization:'Bearer other'},401],
      ['GET','/models',{Authorization:'Bearer '+key,Origin:'https://example.invalid'},403],
      ['POST','/responses',{Authorization:'Bearer '+key,'Sec-Fetch-Site':'cross-site'},403],
      ['POST','/search',{Authorization:'Bearer '+key},404],
    ]) {
      const response = await fetch(f.adapter.url+endpoint,{method,headers,...(method==='POST'?{body:'{}'}:{})});
      expect(response.status).toBe(status); await response.text();
    }
    expect(f.catalogRequests).toHaveLength(0); expect(f.requests).toHaveLength(0);
  } finally { await f.cleanup(); }
});

test('Electron native fetch metadata permits authenticated discovery and inference without allowing webpage origins', async () => {
  const f = await fixture();
  try {
    const headers = { Authorization: 'Bearer ' + key, 'Sec-Fetch-Site': 'none' };
    const catalog = await fetch(f.adapter.url + '/models/api.json', { headers });
    expect(catalog.status).toBe(200); await catalog.json();
    const inference = await request(f, '/responses', { model: ids[0], input: 'synthetic' }, { 'Sec-Fetch-Site': 'none' });
    expect(inference.status).toBe(200); await inference.text();
    const webpage = await fetch(f.adapter.url + '/models', { headers: { ...headers, Origin: 'null' } });
    expect(webpage.status).toBe(403); await webpage.text();
    expect(f.requests).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('upstream rate limits and authentication failures preserve status, body and retry headers without retries', async () => {
  const f = await fixture();
  try {
    for (const status of [429,401,502]) {
      f.control.status = status;
      const response = await request(f,'/responses',{model:ids[0],input:'synthetic'});
      expect(response.status).toBe(status);
      expect(response.headers.get('retry-after')).toBe('17');
      expect(response.headers.get('x-request-id')).toBe('synthetic-request');
      expect(await response.text()).toBe('{"error":{"message":"synthetic upstream rejection"}}');
    }
    expect(f.requests).toHaveLength(3);
  } finally { await f.cleanup(); }
});

test('connection changes wait for an in-flight catalog and never repoint its inference', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const catalogStarted = new Promise(resolve => { started = resolve; });
  let hold = true;
  const f = await fixture({ fetchImpl: async (url, options) => {
    if (hold && url.endsWith('/models')) { started(); await gate; }
    return fetch(url, options);
  } });
  try {
    const pending = request(f, '/responses', { model: ids[0], input: 'synthetic' });
    await catalogStarted;
    await expect(f.adapter.configure({ url: 'http://127.0.0.1:31002/v1', key: 'synthetic-new-key', port: 0 }))
      .rejects.toThrow('waiting_kimi_idle');
    expect(f.adapter.backend.connection).toEqual({ target: f.url, key });
    expect(f.adapter.connection.key).toBe(key);
    hold = false; release();
    const response = await pending;
    expect(response.status).toBe(200); await response.text();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].headers.authorization).toBe('Bearer ' + key);
    await f.adapter.configure({ url: 'http://127.0.0.1:31002/v1', key: 'synthetic-new-key', port: 0 });
    expect(f.adapter.backend.connection.target).toBe('http://127.0.0.1:31002/v1');
  } finally { release(); await f.cleanup(); }
});

test('invalid local connection settings leave the upstream connection unchanged', async () => {
  const f = await fixture();
  try {
    await expect(f.adapter.configure({ url: 'http://127.0.0.1:31002/v1', key: '', port: 0 }))
      .rejects.toThrow('invalid_connection');
    expect(f.adapter.backend.connection).toEqual({ target: f.url, key });
    expect(f.adapter.connection.key).toBe(key);
  } finally { await f.cleanup(); }
});

test('identical connection settings reuse the live listener without disconnecting the upstream', async () => {
  const f = await fixture();
  let configureCalls = 0;
  let disconnectCalls = 0;
  f.adapter.gateway.configure = async () => { configureCalls += 1; throw Error('must_not_reconfigure'); };
  const disconnect = f.adapter.backend.disconnect.bind(f.adapter.backend);
  f.adapter.backend.disconnect = () => { disconnectCalls += 1; disconnect(); };
  try {
    expect(await f.adapter.configure({ url: f.url, key, port: 0 })).toBe(f.adapter.url);
    const response = await request(f, '/responses', { model: ids[0], input: 'synthetic unchanged configuration' });
    expect(response.status).toBe(200); await response.text();
    expect(configureCalls).toBe(0);
    expect(disconnectCalls).toBe(0);
    expect(f.adapter.backend.connection).toEqual({ target: f.url, key });
  } finally { await f.cleanup(); }
});

test('failed listener replacement restores the old ephemeral port, credentials and upstream', async () => {
  const f = await fixture();
  const blocker = http.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const oldURL = f.adapter.url;
  const oldPort = f.adapter.port;
  try {
    await expect(f.adapter.configure({ url: f.url, key: 'synthetic-new-key', port: blocker.address().port }))
      .rejects.toThrow('native_byok_port_unavailable');
    expect(f.adapter.url).toBe(oldURL);
    expect(f.adapter.port).toBe(oldPort);
    expect(f.adapter.connection.key).toBe(key);
    expect(f.adapter.backend.connection).toEqual({ target: f.url, key });
    const response = await request(f, '/responses', { model: ids[0], input: 'synthetic after rollback' });
    expect(response.status).toBe(200); await response.text();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].headers.authorization).toBe('Bearer ' + key);
  } finally { await close(blocker); await f.cleanup(); }
});

test('connection changes are serialized while a new listener is being configured', async () => {
  const f = await fixture();
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const firstStarted = new Promise(resolve => { started = resolve; });
  const configure = f.adapter.gateway.configure.bind(f.adapter.gateway);
  const calls = [];
  f.adapter.gateway.configure = async options => {
    calls.push(options.key);
    if (options.key === 'synthetic-first-key') { started(); await gate; }
    return configure(options);
  };
  try {
    const first = f.adapter.configure({ url: 'http://127.0.0.1:31002/v1', key: 'synthetic-first-key', port: 0 });
    await firstStarted;
    const second = f.adapter.configure({ url: 'http://127.0.0.1:31003/v1', key: 'synthetic-second-key', port: 0 });
    await Bun.sleep(20);
    expect(calls).toEqual(['synthetic-first-key']);
    expect(f.adapter.backend.connection).toBeNull();
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(['synthetic-first-key', 'synthetic-second-key']);
    expect(f.adapter.backend.connection).toEqual({ target: 'http://127.0.0.1:31003/v1', key: 'synthetic-second-key' });
    expect(f.adapter.connection.key).toBe('synthetic-second-key');
  } finally { release(); await f.cleanup(); }
});

test('cancelling a native streamed turn cancels the upstream connection', async () => {
  const f = await fixture();
  try {
    f.control.stream = true;
    await new Promise((resolve,reject)=>{
      const client = http.request(f.adapter.url+'/responses',{method:'POST',headers:{Authorization:'Bearer '+key}},response=>{
        response.once('data',()=>{client.destroy();response.destroy();resolve();});
        response.on('error',()=>{});
      });
      client.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});
      client.end(JSON.stringify({model:ids[0],input:'synthetic',stream:true}));
    });
    const deadline = Date.now()+1500;
    while (!f.control.cancelled && Date.now()<deadline) await Bun.sleep(5);
    expect({cancelled:f.control.cancelled,active:[...f.adapter.inflight].map(item=>item.signal.aborted)})
      .toEqual({cancelled:1,active:[]});
    expect(f.requests).toHaveLength(1);
  } finally { await f.cleanup(); }
});

function query(domain,type=1) {
  const header = Buffer.alloc(12); header.writeUInt16BE(317,0);header.writeUInt16BE(0x0100,2);header.writeUInt16BE(1,4);
  const labels = domain.split('.').flatMap(label=>[Buffer.from([label.length]),Buffer.from(label)]);
  const tail = Buffer.alloc(5);tail.writeUInt16BE(type,1);tail.writeUInt16BE(1,3);
  return Buffer.concat([header,...labels,tail]);
}

test('plugin DNS answers only the BYOK name and never becomes a general resolver', async () => {
  const server = new NativeByokDNS(); await server.start(0);
  const client = dgram.createSocket('udp4');
  try {
    const response = await new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>reject(Error('local DNS timeout')),1000);
      client.once('message',packet=>{clearTimeout(timer);resolve(packet);});
      client.send(query(BYOK_DOMAIN),server.address.port,'127.0.0.1');
    });
    expect([...response.subarray(-4)].join('.')).toBe(BYOK_ADDRESS);
    expect(response.readUInt16BE(6)).toBe(1);
    const other = dnsReply(query('www.kimi.com'));
    expect(other.readUInt16BE(2)&15).toBe(5);
    expect(other.readUInt16BE(6)).toBe(0);
    expect(dnsReply(query(BYOK_DOMAIN,28)).readUInt16BE(6)).toBe(0);
    expect(dnsReply(Buffer.from([1,2,3]))).toBeNull();
    expect(nativePrivateAddress('198.18.0.189')).toBe(false);
    expect(nativePrivateAddress(BYOK_ADDRESS)).toBe(true);
    expect(nativePrivateAddress('fc00::1')).toBe(true);
    expect(nativePrivateAddress('127.0.0.1')).toBe(false);
    expect(resolverConfiguration().path).toBe('/etc/resolver/'+BYOK_DOMAIN);
    expect(resolverConfiguration().content).not.toContain('nameserver 10.');
  } finally { client.close(); await server.stop(); }
});

test('native diagnostics do not confuse a revealed setting or running DNS listener with actual intranet availability', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'byok-probe-'));
  try {
    const flagFile = path.join(directory,'flag.json'); write(flagFile,{revealed:true});
    let calls = 0;
    const probe = new NativeSetupProbe({flagFile,lookupFn:async()=>{calls++;return {address:'198.18.0.189'};}});
    const [one,two] = await Promise.all([probe.check(),probe.check()]);
    expect(one.revealed).toBe(true);expect(one.intranet.passed).toBe(false);expect(two.intranet.passed).toBe(false);expect(calls).toBe(1);
    const timeout = new NativeSetupProbe({flagFile,timeoutMs:10,lookupFn:()=>new Promise(()=>{})});
    expect((await timeout.check()).intranet).toEqual({passed:false,error:'dns_unavailable'});
  } finally { fs.rmSync(directory,{recursive:true,force:true}); }
});

test('native mode serves the gateway while reporting unmet setup separately and leaves Kimi config untouched', async () => {
  const f = await fixture();
  const kimiDir = path.join(f.directory,'kimi/daimon-share/daimon');
  const stateDir = path.join(f.directory,'state'),flagFile=path.join(f.directory,'flag.json');
  const calls=[];
  const adapter = new LocalKimiAdapter({kimiDir,stateDir,flagFile,stabilityMs:0,
    lookupFn:async()=>({address:'198.18.0.189'}),rpcCall:async(...args)=>{calls.push(args);return {};}});
  const config = {credentials:{kimiCode:{apiKey:'synthetic-kimi-secret'}},
    model:{current:'k3-agent',models:{'k3-agent':{model:'k3-agent',provider:'daimon-kimi-code'}},providers:{'daimon-kimi-code':{type:'kimi',baseUrl:official}}},keep:{value:1}};
  write(adapter.configFile,config);write(adapter.runnerFile,{lifecycleStatus:'running'});write(flagFile,{revealed:true});
  adapter.bootstrap();
  const desired={enabled:true,mode:'native-byok',gateway:{url:f.url,key},nativeByok:{port:0}};
  write(adapter.connectionFile,desired);
  const before=fs.readFileSync(adapter.configFile);
  try {
    await adapter.tick();
    expect(adapter.status.code).toBe('native_byok_waiting_intranet');
    expect(adapter.status.gatewayReady).toBe(true);expect(adapter.status.models).toBe(7);
    expect(adapter.nativeDNS.socket).toBeUndefined();
    expect(fs.readFileSync(adapter.configFile).equals(before)).toBe(true);expect(calls).toHaveLength(0);
    const response=await fetch(adapter.nativeGateway.url+'/models/api.json',{headers:{Authorization:'Bearer '+key}});
    expect(response.status).toBe(200);await response.text();
    expect(JSON.stringify(read(adapter.statusFile))).not.toContain(key);
    expect(JSON.stringify(read(adapter.statusFile))).not.toContain('synthetic-kimi-secret');
    write(adapter.connectionFile,{...desired,enabled:false});await adapter.tick();
    expect(adapter.status.code).toBe('disconnected');expect(adapter.nativeGateway.server).toBeNull();
    expect(fs.readFileSync(adapter.configFile).equals(before)).toBe(true);
  } finally {await adapter.stop();await f.cleanup();}
});

async function controllerFixture() {
  const f = await fixture();
  const kimiDir=path.join(f.directory,'kimi/daimon-share/daimon'),stateDir=path.join(f.directory,'state');
  const flagFile=path.join(f.directory,'flag.json'),calls=[];
  const adapter=new LocalKimiAdapter({kimiDir,stateDir,flagFile,stabilityMs:0,lookupFn:async()=>({address:'10.0.0.2'}),
    rpcCall:async(_runner,method,params)=>{calls.push({method,params});
      return method==='conversations.getKimiModelList'?{models:[{model:'k3-agent'}]}:{current:'k3-agent'};}});
  const doc={credentials:{kimiCode:{apiKey:'synthetic-kimi-key',refreshToken:'synthetic-refresh'}},
    model:{current:'k3-agent',models:{'k3-agent':{model:'k3-agent',provider:'daimon-kimi-code'}},
      providers:{'daimon-kimi-code':{type:'kimi',baseUrl:official}}},unrelated:{keep:1}};
  write(adapter.configFile,doc);write(flagFile,{revealed:true});
  write(adapter.runnerFile,{lifecycleStatus:'running',daemonGeneration:'synthetic',activeKernelTurns:0});
  adapter.bootstrap();
  const desired={enabled:true,mode:'native-byok',model:ids[0],gateway:{url:f.url,key},nativeByok:{port:0}};
  write(adapter.connectionFile,desired);
  return {...f,adapter,desired,calls,doc,async cleanup(){await adapter.stop();await f.cleanup();}};
}

test('switching from legacy bridge waits for idle and restores its owned address before native mode', async()=>{
  const f=await controllerFixture();
  try {
    write(f.adapter.connectionFile,{...f.desired,mode:'bridge'});await f.adapter.tick();
    expect(f.adapter.status.code).toBe('connected');
    const bridge=read(f.adapter.configFile).model.providers['daimon-kimi-code'].baseUrl;
    expect(bridge).not.toBe(official);
    const doc=read(f.adapter.configFile);doc.credentials.kimiCode.refreshToken='synthetic-refreshed';write(f.adapter.configFile,doc);
    write(f.adapter.runnerFile,{...read(f.adapter.runnerFile),activeKernelTurns:1});
    write(f.adapter.connectionFile,f.desired);await f.adapter.tick();
    expect(f.adapter.status.code).toBe('waiting_kimi_idle');
    expect(read(f.adapter.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(bridge);
    write(f.adapter.runnerFile,{...read(f.adapter.runnerFile),activeKernelTurns:0});await f.adapter.tick();
    expect(f.adapter.status.code).toBe('native_byok_waiting_import');
    expect(read(f.adapter.configFile).model.providers['daimon-kimi-code'].baseUrl).toBe(official);
    expect(read(f.adapter.configFile).credentials.kimiCode.refreshToken).toBe('synthetic-refreshed');
    expect(f.adapter.server).toBeNull();
    expect(f.adapter.nativeGateway.server).toBeTruthy();
  } finally {await f.cleanup();}
});

test('native configured readiness requires import and a running Work runtime, not just an available HTTP endpoint',async()=>{
  const f=await controllerFixture();
  try {
    await f.adapter.tick();expect(f.adapter.status.code).toBe('native_byok_waiting_import');
    const doc=read(f.adapter.configFile);
    doc.model.providers['byok-kth-resp']={type:'openai_responses',baseUrl:f.adapter.nativeGateway.url};
    write(f.adapter.configFile,doc);await f.adapter.tick();expect(f.adapter.status.code).toBe('native_byok_waiting_import');
    expect(f.adapter.status.setup.missingProviders).toEqual(['byok-kth-kimi']);
    doc.model.providers['byok-kth-kimi']={type:'kimi',baseUrl:f.url};
    write(f.adapter.configFile,doc);
    const wrongImport=fs.readFileSync(f.adapter.configFile);
    await f.adapter.tick();expect(f.adapter.status.code).toBe('native_byok_waiting_import');
    expect(f.adapter.status.setup.missingProviders).toEqual(['byok-kth-kimi']);
    expect(fs.readFileSync(f.adapter.configFile).equals(wrongImport)).toBe(true);
    doc.model.providers['byok-kth-kimi'].baseUrl=f.adapter.nativeGateway.url;
    write(f.adapter.configFile,doc);await f.adapter.tick();expect(f.adapter.status.code).toBe('native_byok_ready');
    expect(f.adapter.status.setup.missingProviders).toEqual([]);
    delete doc.model.providers['byok-kth-kimi'];
    f.data.splice(f.data.findIndex(row=>row.id===ids[3]),1);f.adapter.nativeCatalogAfter=0;
    write(f.adapter.configFile,doc);await f.adapter.tick();expect(f.adapter.status.code).toBe('native_byok_ready');
    write(f.adapter.runnerFile,{lifecycleStatus:'stopped'});await f.adapter.tick();expect(f.adapter.status.code).toBe('waiting_kimi');
    expect(f.requests).toHaveLength(0);
  } finally {await f.cleanup();}
});

test('invalid native gateway changes stop the old native listener without editing Kimi or using fallback inference',async()=>{
  const f=await controllerFixture();
  try {
    await f.adapter.tick();const before=fs.readFileSync(f.adapter.configFile);
    write(f.adapter.connectionFile,{...f.desired,gateway:{url:'https://example.invalid/v1',key}});await f.adapter.tick();
    expect(f.adapter.status.code).toBe('invalid_gateway');
    expect(f.adapter.status.gatewayReady).toBe(false);expect(f.adapter.nativeGateway.server).toBeNull();
    expect(fs.readFileSync(f.adapter.configFile).equals(before)).toBe(true);expect(f.requests).toHaveLength(0);
  } finally {await f.cleanup();}
});

test('pending preparation keeps discovery available and serializes fresh option requests', async () => {
  const f = await controllerFixture();
  const calls = []; let complete;
  f.adapter.nativeSetup = { result: { state: 'running' }, run: request => {
    calls.push(request.id); return new Promise(resolve => { complete = resolve; });
  } };
  try {
    f.adapter.options.setupRequest = { id: 'prepare-first-request' };
    await f.adapter.tick();
    expect(f.adapter.status.preparation.state).toBe('running');
    const catalog = await fetch(f.adapter.nativeGateway.url + '/models/api.json', { headers: { Authorization: 'Bearer ' + key } });
    expect(catalog.status).toBe(200); await catalog.json();
    f.adapter.options.setupRequest = { id: 'prepare-second-request' };
    await f.adapter.tick(); expect(calls).toEqual(['prepare-first-request']);
    complete(); await f.adapter.preparationTask;
    await f.adapter.tick(); expect(calls).toEqual(['prepare-first-request', 'prepare-second-request']);
    complete(); await f.adapter.preparationTask;
    await f.adapter.tick(); expect(calls).toHaveLength(2);
  } finally { complete?.(); await f.cleanup(); }
});

test('compatibility checks active models and invalidates cached results after catalog or archive changes', async () => {
  const f = await controllerFixture();
  const calls = [];
  let fingerprint = 'archive-v1';
  f.adapter.options.contractFingerprint = () => fingerprint;
  f.adapter.options.inspectKimiContract = ({ models }) => {
    calls.push(structuredClone(models));
    return { state: 'verified', version: 'fixture', accepted: models.map(row => row.id), skipped: [] };
  };
  try {
    await f.adapter.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].map(row => row.id)).toEqual(ids);
    expect(calls[0][0]).toMatchObject({ contextWindow: 131072, maxOutputTokens: 32768, reasoning: true, tools: true });
    expect(f.adapter.status.compat).toMatchObject({ state: 'verified', scope: 'active-models', modelCount: 7, accepted: 7 });
    await f.adapter.tick(); expect(calls).toHaveLength(1);
    f.data.pop(); f.adapter.nativeCatalogAfter = 0;
    await f.adapter.tick();
    expect(calls).toHaveLength(2);
    expect(f.adapter.status.compat.modelCount).toBe(6);
    fingerprint = 'archive-v2';
    await f.adapter.tick(); expect(calls).toHaveLength(3);
    fingerprint = 'archive-v3';
    f.adapter.options.inspectKimiContract = () => { throw Error('probe failure'); };
    await f.adapter.tick();
    expect(f.adapter.status.compat.state).toBe('unverified');
    expect(f.adapter.status.gatewayReady).toBe(true);
  } finally { await f.cleanup(); }
});

test('the plugin guards inference while a native subagent policy is still being applied', async () => {
  const f = await controllerFixture();
  try {
    const home = path.join(f.adapter.kimiDir, 'runtime/kimi-code/home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'),
      'default_model = "byok-kth-resp/' + ids[0] + '"\n'
      + [ids[0], ids[1]].map(id => '[models."byok-kth-resp/' + id + '"]\nprovider = "synthetic"\nmodel = "' + id + '"\n').join(''));
    await f.adapter.tick();
    f.adapter.options.workModels = { subagents: { mode: 'pool', transport: 'native-config', model: ids[0],
      models: [{ id: ids[0], description: 'Default' }, { id: ids[1], description: 'Review' }] } };

    // A newly saved native target must not forward inference before the first
    // tick applies it: the gateway would otherwise send the old tool schema.
    f.adapter.nativeSubagentInitializing = true;
    expect(f.adapter.nativeGateway.gateway.beforeRequest('responses', { model: ids[0], input: [] }))
      .toEqual({ status: 503, code: 'subagent_policy_initializing' });
    await f.adapter.tick();
    expect(f.adapter.nativeSubagentInitializing).toBe(false);
    expect(f.adapter.nativeGateway.gateway.beforeRequest('responses', { model: ids[0], input: [] })).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('native requests with a mismatched model protocol never reach Magpie', async () => {
  const f = await fixture();
  try {
    const response = await request(f, '/responses', { model: ids[3], input: 'hello' });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('model_protocol_mismatch');
    expect(f.requests).toHaveLength(0);
  } finally { await f.cleanup(); }
});
