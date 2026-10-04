import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReply,visibleReply,localCommand} from '../src/meaning.js';
test('valid generated navigation is bounded data with an optional proposal',()=>{
  const r=parseReply('What would starting look like? <navigation>{"region":"maker","focus":"One small action","memory":{"kind":"goal","text":"Finish my book"},"url":"https://evil.test"}</navigation>');
  assert.equal(r.text,'What would starting look like?'); assert.equal(r.intent.region,'maker');
  assert.deepEqual(r.intent.memory,{kind:'goal',text:'Finish my book',region:'maker'}); assert.equal(r.intent.url,undefined);
});
test('invalid output never creates destinations or storage instructions',()=>{
  for(const payload of ['null','[]','{"region":"constructor"}','{"region":"__proto__"}','{"region":"earth"}','oops'])
    assert.equal(parseReply(`Hello <navigation>${payload}</navigation>`).intent,null);
  assert.equal(parseReply('Hello <navigation>{"region":"world","memory":{"kind":"diagnosis","text":"x"}}</navigation>').intent.memory,null);
});
test('streamed control markup is never shown even before its closing tag',()=>{
  for(let n=1;n<12;n++) assert.equal(visibleReply('Hello '+ '<navigation>'.slice(0,n)).trim(),'Hello');
  assert.equal(visibleReply('Hello <navigation>{"region":').trim(),'Hello');
});
test('ordinary statements are not silently treated as navigation commands',()=>{
  assert.equal(localCommand('I know what I want but I cannot act'),null);
  assert.deepEqual(localCommand('Take me to Dream Maker.'),{type:'region',region:'maker'});
  assert.deepEqual(localCommand('Show my constellation'),{type:'constellation'});
});
