'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionMonitor, toDisplayEvent, sessionDirs } = require('../src/main/codex-session-monitor');

test('journal mapping is metadata-only; ignores prompts, output and reasoning', () => {
  const id = 'thread-123';
  const started = toDisplayEvent({type:'event_msg',payload:{type:'task_started',turn_id:'turn1',message:'secret'}},id);
  assert.equal(started.hook_event_name,'UserPromptSubmit');
  assert.equal(JSON.stringify(started).includes('secret'),false);
  assert.equal(toDisplayEvent({type:'event_msg',payload:{type:'user_message',message:'secret'}},id),null);
  const call=toDisplayEvent({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'{"cmd":"my-password"}'}},id);
  assert.equal(call.tool_name,'exec_command');
  assert.equal(JSON.stringify(call).includes('my-password'),false);
  assert.equal(toDisplayEvent({type:'response_item',payload:{type:'reasoning',content:'secret'}},id),null);
  const stop=toDisplayEvent({type:'event_msg',payload:{type:'task_complete',turn_id:'turn1',last_agent_message:'secret'}},id);
  assert.equal(stop.hook_event_name,'Stop');
  assert.equal(JSON.stringify(stop).includes('secret'),false);
  assert.equal(toDisplayEvent({type:'event_msg',payload:{type:'turn_aborted',turn_id:'turn1'}},id).hook_event_name,'Interrupt');
});

test('reads only new Codex Desktop journal lines and does not replay startup history', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'capri-codex-'));
  const date=new Date();
  const folder=sessionDirs(tmp,date.getTime())[0];
  fs.mkdirSync(folder,{recursive:true});
  const a=path.join(folder,'rollout-2026-10-26T10-00-00-11111111-1111-1111-1111-111111111111.jsonl');
  const meta={type:'session_meta',payload:{id:'11111111-1111-1111-1111-111111111111',originator:'Codex Desktop',cwd:'C:\\test'}};
  const line=x=>JSON.stringify(x)+'\n';
  fs.writeFileSync(a,line(meta)+line({type:'event_msg',payload:{type:'task_started',turn_id:'old'}}));
  const seen=[];
  const monitor=createSessionMonitor({root:tmp,now:()=>date.getTime(),onEvent:e=>seen.push(e)});
  try {
    await monitor.start();
    assert.equal(seen.length,0);
    fs.appendFileSync(a,line({type:'event_msg',payload:{type:'task_started',turn_id:'new'}}));
    fs.appendFileSync(a,line({type:'response_item',payload:{type:'function_call',name:'exec_command',arguments:'{"cmd":"secret"}'}}));
    fs.appendFileSync(a,line({type:'event_msg',payload:{type:'task_complete',turn_id:'new',last_agent_message:'private'}}));
    await monitor.poll();
    assert.deepEqual(seen.map(e=>e.hook_event_name),['UserPromptSubmit','PreToolUse','Stop']);
    assert.ok(seen.every(e=>e.provider==='codex'));
    assert.ok(!JSON.stringify(seen).includes('secret'));
    await monitor.poll();
    assert.equal(seen.length,3);
  } finally { monitor.stop(); fs.rmSync(tmp,{recursive:true,force:true}); }
});

test('never consumes non-Desktop session journals', async () => {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'capri-cli-'));
  const date=new Date();
  const folder=sessionDirs(tmp,date.getTime())[0];
  fs.mkdirSync(folder,{recursive:true});
  const f=path.join(folder,'rollout-cli.jsonl');
  fs.writeFileSync(f,JSON.stringify({type:'session_meta',payload:{originator:'codex-tui',cwd:'C:\\test'}})+'\n');
  const seen=[];
  const monitor=createSessionMonitor({root:tmp,now:()=>date.getTime(),onEvent:e=>seen.push(e)});
  try {
    await monitor.start();
    fs.appendFileSync(f,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'X'}})+'\n');
    await monitor.poll();
    assert.equal(seen.length,0);
  } finally { monitor.stop(); fs.rmSync(tmp,{recursive:true,force:true}); }
});
