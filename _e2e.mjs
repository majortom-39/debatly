import WebSocket from "ws";
import fs from "node:fs";

// Parse a slice of the scenario WAV → 16k mono PCM (reuse the smoke logic inline)
function parseWav(p){const b=fs.readFileSync(p);let o=12,fmt=null,dO=0,dS=0;while(o+8<=b.length){const id=b.toString("ascii",o,o+4),sz=b.readUInt32LE(o+4),body=o+8;if(id==="fmt ")fmt={ch:b.readUInt16LE(body+2),sr:b.readUInt32LE(body+4),ba:b.readUInt16LE(body+12),bps:b.readUInt16LE(body+14)};else if(id==="data"){dO=body;dS=sz;break;}o+=8+sz+(sz%2);}return{b,fmt,dO,dS};}
function to16kMono(w,sec){const{b,fmt,dO,dS}=w;const frames=Math.min(Math.floor(sec*fmt.sr),Math.floor(dS/fmt.ba));const ratio=fmt.sr/16000;const out=Buffer.alloc(Math.floor(frames/ratio)*2);for(let i=0;i<out.length/2;i++){const s=Math.floor(i*ratio)*fmt.ba+dO;const v=b.readInt16LE(s)/32768;out.writeInt16LE(Math.max(-32768,Math.min(32767,Math.round(v*32767))),i*2);}return out;}

const wav=parseWav("Samples/TEST 3/Scenario 1 audio.wav");
const pcm=to16kMono(wav, 150); // 150s slice = enough to open the gate + produce points
const ws=new WebSocket("ws://127.0.0.1:8787/live");
const got={transcript:0, debate_state:0, lastAnalysis:null, errors:[]};
ws.on("message",(d)=>{let m;try{m=JSON.parse(d.toString());}catch{return;}
  if(m.type==="transcript"&&m.turn?.isFinal)got.transcript++;
  if(m.type==="debate_state"){got.debate_state++;got.lastAnalysis=m.analysis;}
  if(m.type==="error")got.errors.push(m.message);});
await new Promise((r,j)=>{ws.once("open",r);ws.once("error",j);});
// wait for ready
await new Promise(r=>setTimeout(r,1500));
const chunk=3200;for(let o=0;o<pcm.length;o+=chunk){if(ws.readyState!==1)break;ws.send(pcm.subarray(o,o+chunk));await new Promise(r=>setTimeout(r,100*0.4));}
ws.send(JSON.stringify({type:"stop"}));
await new Promise(r=>setTimeout(r,8000));
const a=got.lastAnalysis;
fs.writeFileSync(".cache/e2e-out.json",JSON.stringify({
  transcripts:got.transcript, debateStateMsgs:got.debate_state, errors:got.errors,
  topic:a?.topic, gateOpen:a?.gateOpen,
  blueScore:a?.sides?.blue?.score, redScore:a?.sides?.red?.score,
  counts:a?.counts
},null,2));
console.log("done");
ws.close();
