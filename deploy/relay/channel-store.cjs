'use strict';
// Independent ingress credentials, kept apart from the relay connection key.
// Mutations are written atomically before the live in-memory list changes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hex = /^[a-f0-9]{64}$/;
const maxChannels = 32;
function validName(name) {
  return typeof name === 'string' && name.trim() === name && name.length > 0 &&
    Array.from(name).length <= 40 && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name);
}
function validId(id) { return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id); }
function validate(records, defaultToken) {
  if (!Array.isArray(records) || records.length > maxChannels) throw new Error('invalid channel store');
  const ids = new Set(), tokens = new Set([defaultToken]);
  return records.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        Object.keys(record).sort().join(',') !== 'enabled,id,name,token' ||
        !validId(record.id) || !hex.test(record.token || '') ||
        !validName(record.name) || typeof record.enabled !== 'boolean' ||
        ids.has(record.id) || tokens.has(record.token)) throw new Error('invalid channel store');
    ids.add(record.id);tokens.add(record.token);
    return {id:record.id,name:record.name,token:record.token,enabled:record.enabled};
  });
}
function createChannelStore({ file, defaultToken }) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/i.test(defaultToken || '')) throw new Error('invalid channel configuration');
  let records;
  try { records = validate(JSON.parse(fs.readFileSync(file, 'utf8')), defaultToken); }
  catch (error) { if (error.code === 'ENOENT') records = []; else throw new Error('invalid channel store'); }
  const save = next => {
    const checked = validate(next,defaultToken);
    const temporary = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary,JSON.stringify(checked),{flag:'wx',mode:0o600});
      fs.renameSync(temporary,file);
      records = checked;
    } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw new Error('channel storage failed'); }
  };
  const find = id => records.find(record => record.id === id);
  return {
    list: () => records.map(record => ({...record})),
    resolve(token) {
      if (typeof token !== 'string' || !hex.test(token)) return null;
      for (const record of records) {
        if (crypto.timingSafeEqual(Buffer.from(record.token),Buffer.from(token))) return {...record};
      }
      return null;
    },
    create(name) {
      if (!validName(name) || records.length >= maxChannels) throw new Error('invalid channel');
      let id,token;
      do { id=crypto.randomBytes(16).toString('hex'); } while (find(id));
      do { token=crypto.randomBytes(32).toString('hex'); } while (token===defaultToken || records.some(record=>record.token===token));
      const channel={id,name,token,enabled:true};save([...records,channel]);return {...channel};
    },
    update(id, changes) {
      const existing=find(id);
      if (!existing || !changes || typeof changes !== 'object' || Array.isArray(changes) ||
          Object.keys(changes).some(key=>!['name','enabled'].includes(key)) ||
          (Object.hasOwn(changes,'name') && !validName(changes.name)) ||
          (Object.hasOwn(changes,'enabled') && typeof changes.enabled !== 'boolean')) throw new Error('invalid channel');
      const updated={...existing,...changes};
      save(records.map(record=>record.id===id?updated:record));return {...updated};
    },
    remove(id) {
      if (!find(id)) throw new Error('invalid channel');
      save(records.filter(record=>record.id!==id));
    }
  };
}
module.exports={createChannelStore,validName};
