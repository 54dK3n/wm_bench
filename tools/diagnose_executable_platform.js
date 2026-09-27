#!/usr/bin/env node
'use strict';
// Isolated native platform diagnostic; no model, truth capture, map coordinates,
// object IDs, evaluator export, simulator teleport or task-answer script.
const fs=require('node:fs'), path=require('node:path'), os=require('node:os');
const crypto=require('node:crypto'), assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class Cdp {
  constructor(){this.id=0;this.pending=new Map();}
  async connect(url){this.socket=new WebSocket(url);await new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',()=>reject(new Error('Local browser failed')),{once:true});});this.socket.addEventListener('message',e=>{const m=JSON.parse(String(e.data)),p=this.pending.get(m.id);if(!p)return;this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);});}
  send(method,params={},sessionId){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Local diagnostic page timeout'));},90000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('closed'));}this.pending.clear();this.socket?.close();}
}
async function wait(check){for(let i=0;i<1200;i++){const result=await check();if(result)return result;await sleep(100);}throw new Error('Local diagnostic bootstrap timeout');}
async function main(){
  assert.equal(process.argv[2],'--out');const out=path.resolve(process.argv[3]);assert.ok(!fs.existsSync(out),'create-only output');fs.mkdirSync(out,{recursive:true});
  const platform=path.join(ROOT,'workspaces/guangyang-platform/projects/car-python');
  const frozen=JSON.parse(fs.readFileSync(path.join(ROOT,'artifacts/autonomous-brain/active-confirmation-20260926/FROZEN_INPUTS.json'))).source_manifest;
  for(const [name,hash] of Object.entries(frozen.platform))assert.equal(sha(fs.readFileSync(path.join(platform,name))),hash,'Frozen platform changed: '+name);
  const sources={};for(const folder of ['autonomous_brain'])for(const name of fs.readdirSync(path.join(ROOT,folder)).filter(n=>n.endsWith('.py')))sources[folder+'/'+name]=sha(fs.readFileSync(path.join(ROOT,folder,name)));
  for(const name of ['tools/diagnose_executable_platform.js','tools/diagnose_executable_platform.py'])sources[name]=sha(fs.readFileSync(path.join(ROOT,name)));
  const contract=require(path.join(platform,'robot-bridge-contract.js'));
  const {createServer}=require(path.join(platform,'server.js'));
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wm-local-executable-'));
  const server=createServer({dataDir:path.join(temp,'data'),robotBridgeEnabled:true,robotBridge:{pollTimeoutMs:1000}});
  let browser,cdp,evaluate,child,started=false,childCode=null;
  try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const origin='http://127.0.0.1:'+server.address().port,profile=path.join(temp,'browser');fs.mkdirSync(profile);
    browser=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1280,900','--force-device-scale-factor=1','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-sync','--no-proxy-server','--disable-features=MediaRouter','--enable-unsafe-swiftshader','--use-angle=swiftshader','about:blank'],{stdio:'ignore'});
    const endpoint=await wait(()=>{assert.equal(browser.exitCode,null);const file=path.join(profile,'DevToolsActivePort');if(!fs.existsSync(file))return null;const [port,suffix]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/);return 'ws://127.0.0.1:'+port+suffix;});
    cdp=new Cdp();await cdp.connect(endpoint);const target=await cdp.send('Target.createTarget',{url:'about:blank'});const session=(await cdp.send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    await cdp.send('Runtime.enable',{},session);await cdp.send('Page.enable',{},session);
    evaluate=async expression=>{const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw new Error('Local platform expression failed: '+r.exceptionDetails.text);return r.result.value;};
    async function navigate(url){await cdp.send('Page.navigate',{url},session);await wait(()=>evaluate(`location.href===${JSON.stringify(url)}&&document.readyState==='complete'`));}
    await navigate(origin+'/login.html');
    const registration={username:'local-'+crypto.randomBytes(8).toString('hex'),password:'Local-'+crypto.randomBytes(20).toString('hex'),teamName:'bounded local diagnostic',group:'primary'};
    const registered=await evaluate(`(async()=>{const r=await fetch('/api/v1/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(registration)})});return r.status})()`);assert.equal(registered,201);
    // Select a native pool entry without inspecting layout/objects/coordinates.
    const pool=server.mapConfigPools.get('R2-GYI-MVP-02'),store=pool.get('map-05');assert.ok(store);for(const key of pool.keys())pool.set(key,store);
    await navigate(origin+'/');await wait(()=>evaluate(`typeof RobotBackend==='object'&&typeof activeMission==='object'&&document.querySelector('#runButton')?.disabled===false&&(!document.querySelector('#loadingOverlay')||document.querySelector('#loadingOverlay').classList.contains('is-hidden'))`));
    await evaluate(`(async()=>{await refreshPublishedGuangyangMap({config:guangyangConfigForTaskId('R2-GYI-MVP-02'),apply:false});loadMission('guangyang2');return true})()`);
    const capability=await evaluate(`RobotBackend.start({provenance:{purpose:'bounded-local-motion-diagnostic'},limits:{timeLimitSeconds:120,visionEvidenceLimitBytes:null,visionEvidenceFrameLimit:null}})`);started=true;
    const config={origin,bridge_id:capability.bridgeId,client_token:capability.clientToken,task:'把两个红球送到绿色存放区',simulation_step_ms:20,max_rounds:20,max_simulation_seconds:120};
    const stdout=fs.createWriteStream(path.join(out,'child.stdout.txt')),stderr=fs.createWriteStream(path.join(out,'child.stderr.txt'));
    const flushed=Promise.all([new Promise(r=>stdout.on('finish',r)),new Promise(r=>stderr.on('finish',r))]);
    child=spawn('python3',['tools/diagnose_executable_platform.py','--out',out],{cwd:ROOT,env:{PATH:process.env.PATH,HOME:process.env.HOME,PYTHONDONTWRITEBYTECODE:'1',PYTHONUNBUFFERED:'1'},stdio:['pipe','pipe','pipe']});child.stdout.pipe(stdout);child.stderr.pipe(stderr);child.stdin.end(JSON.stringify(config)+'\n');
    const timer=setTimeout(()=>child.kill('SIGTERM'),240000);childCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
    await flushed;
    const calls=fs.readFileSync(path.join(out,'bridge-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const bad=calls.filter(r=>!contract.METHODS.includes(r.request.method));assert.equal(bad.length,0);
    const normalized=calls.map(row=>contract.normalizeCommand(row.request));
    const unchanged=Object.entries(sources).every(([n,h])=>sha(fs.readFileSync(path.join(ROOT,n)))===h);
    fs.writeFileSync(path.join(out,'platform-diagnostic.json'),JSON.stringify({schema:'native-local-executable-diagnostic/v1',formal_run:false,model_calls:0,task_script:false,truth_read:false,scene_pose_set:false,platform_matches_previous_frozen_manifest:true,source_sha256:sources,sources_unchanged:unchanged,child_exit_code:childCode,whitelist_violations:bad.length,bridge_calls:calls.length,normalized_commands:normalized},null,2)+'\n');
    assert.ok(unchanged);assert.equal(childCode,0);
  }finally{
    if(child&&child.exitCode===null)child.kill('SIGTERM');
    if(started&&evaluate)try{await evaluate('(async()=>{await RobotBackend.stop();return true})()');}catch{}
    cdp?.close();if(browser&&browser.exitCode===null){browser.kill('SIGTERM');await Promise.race([new Promise(r=>browser.once('exit',r)),sleep(3000)]);if(browser.exitCode===null)browser.kill('SIGKILL');}
    server.closeAllConnections?.();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});
  }
  console.log(JSON.stringify({out:path.relative(ROOT,out),formal_run:false,child_exit_code:childCode,passed:childCode===0}));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
