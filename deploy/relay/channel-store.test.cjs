'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createChannelStore}=require('./channel-store.cjs');
test('channel credentials persist and remain independent',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'focus-channels-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'channels.json'),defaultToken='a'.repeat(64);
  let store=createChannelStore({file,defaultToken});
  const a=store.create('构建通知'),b=store.create('服务器告警');
  assert.notEqual(a.token,b.token);assert.notEqual(a.token,defaultToken);
  store.update(a.id,{enabled:false});assert.equal(store.resolve(a.token).enabled,false);assert.equal(store.resolve(b.token).enabled,true);
  store=createChannelStore({file,defaultToken});
  assert.equal(store.list().length,2);assert.equal(store.resolve(a.token).name,'构建通知');
  store.remove(a.id);assert.equal(store.resolve(a.token),null);assert.equal(store.resolve(b.token).enabled,true);
});
test('malformed storage or mutation is rejected without replacing valid state',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'focus-channels-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'channels.json'),defaultToken='a'.repeat(64),store=createChannelStore({file,defaultToken});
  const channel=store.create('消息');assert.throws(()=>store.update(channel.id,{enabled:'yes'}));assert.throws(()=>store.create('bad\nname'));
  assert.equal(store.list().length,1);fs.writeFileSync(file,'not json');assert.throws(()=>createChannelStore({file,defaultToken}));
});
