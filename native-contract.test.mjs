import { test, expect } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeModels } from './catalog.mjs';
import { nativeCatalog } from './native-byok.mjs';

const archive = '/Applications/Kimi.app/Contents/Resources/app.asar';

function installedContract() {
  const bytes = fs.readFileSync(archive);
  const tree = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString());
  let entry = tree;
  for (const part of 'out/main/index.js'.split('/')) entry = entry.files[part];
  const base = 8 + bytes.readUInt32LE(4);
  const text = bytes.subarray(base + Number(entry.offset), base + Number(entry.offset) + entry.size).toString();
  const table = text.match(/function _0x9700\(\) \{[\s\S]*?\n\}/)?.[0];
  const decoder = text.match(/function _0x5c0f\([^\n]*\) \{[\s\S]*?\n\}/)?.[0];
  const marker = '})(_0x9700, 467652)';
  if (!table || !decoder || !text.includes(marker)) throw Error('installed Kimi contract changed; review before using native mode');
  const strings = vm.createContext({});
  vm.runInContext(table+'\n'+decoder+'\n'+text.slice(text.indexOf('(function('),text.indexOf(marker)+marker.length)+';',strings,{timeout:2000});
  const aliases = new Set(['_0x5c0f','_0x3180cc']);
  for (let i=0;i<4;i++) for (const match of text.matchAll(/\b(_0x[a-f0-9]+)\s*=\s*(_0x[a-f0-9]+)\s*[,;]/g)) {
    if (aliases.has(match[2])) aliases.add(match[1]);
  }
  const decode = value => value.replace(/\b(_0x[a-f0-9]+)\((\d+)\)/g,(all,name,index)=>
    aliases.has(name)?JSON.stringify(strings._0x5c0f(Number(index))):all);
  const source = name => {
    const match = text.match(new RegExp('(?:async\\s+)?function '+name+'\\('));
    if (!match) throw Error('native contract function missing: '+name);
    return decode(text.slice(match.index,text.indexOf('\n}',match.index)+2));
  };
  const functions = ['_0x3d394c','_0x5e5623','_0x167d08','_0x344e46','_0x235e21','_0x1f87b3','_0x588f2a',
    '_0x52469d','_0x321891','_0x4f10ee','_0x58ac37','_0xcdb585','_0x215cc2','_0x3a6e0d'];
  const constants = decode(text.slice(text.indexOf('const _0x76d39 ='),text.indexOf('function _0x4c1da4')));
  const rank = decode(text.match(/_0x26a83e\s*=\s*(\{[^}]*\})/)[1]);
  const context = vm.createContext({_0x3180cc:()=>{throw Error('unexpected native string lookup');},
    _0x20c936:{warn:()=>{}},_0x1ab58c:'isolated-contract',_0x216f22:131072});
  vm.runInContext(constants+'\nconst _0x26a83e = '+rank+';\n'+functions.map(source).join('\n'),context,{timeout:2000});
  return context;
}

test.skipIf(process.platform!=='darwin' || !fs.existsSync(archive))('installed Kimi native parser accepts every generated model, including generic families', () => {
  const ids = ['group/kimi-k3.1-rpro','group/gpt-6-1-sol','group/glm-5-3-flash','group/deepseek-v4-1-flash',
    'group/glm-5-3','group/opus-5-5','group/step-5'];
  const data = ids.map(id=>({id,display_name:id,context_window:131072,max_output_tokens:32768,reasoning:true,
    supported_reasoning_levels:[{effort:'low'},{effort:'high'}],modalities:{input:['text','image']}}));
  const models = normalizeModels({data});
  const context = installedContract();
  context.fixture = nativeCatalog(models);
  const parsed = vm.runInContext('_0xcdb585(fixture)',context,{timeout:2000});
  expect(parsed.skippedModels).toHaveLength(0);
  expect(parsed.models.map(row=>row.model).sort()).toEqual([...ids].sort());
  expect(parsed.models.find(row=>row.model==='group/kimi-k3.1-rpro')).toMatchObject({family:'kimi',
    alias:'byok-kth-kimi/group/kimi-k3.1-rpro',maxContextSize:131072,maxOutputSize:32768,supportEfforts:['low','high']});
  expect(parsed.models.find(row=>row.model==='group/glm-5-3-flash')).toMatchObject({family:'generic'});
  context.plain = {data};
  const fallback = vm.runInContext('_0x3a6e0d(plain)',context,{timeout:2000});
  expect(fallback.models).toHaveLength(2);
  expect(fallback.skippedModels).toContain('group/glm-5-3-flash');
  expect(fallback.skippedModels).toContain('group/deepseek-v4-1-flash');
});

test('the plugin splits protocols with the same naming rule Kimi itself applies', () => {
  const models = normalizeModels({data: [
    {id:'group/kimi-k3.1-rpro',display_name:'Kimi K3.1 Pro',context_window:131072},
    {id:'group/glm-5-3-flash',display_name:'GLM 5.3 Flash',context_window:131072},
    {id:'vendor/plain-id',display_name:'Plain',context_window:8192},
  ]});
  const groups = nativeCatalog(models);
  expect(Object.keys(groups.kimi.models)).toEqual(['group/kimi-k3.1-rpro']);
  expect(Object.keys(groups.responses.models)).toEqual(['group/glm-5-3-flash','vendor/plain-id']);
  expect(groups.responses.models['vendor/plain-id']).toMatchObject({
    name:'Plain · Magpie', limit:{context:8192}, tool_call:true, reasoning:false,
  });
});
