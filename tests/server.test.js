import test from "node:test";import assert from "node:assert/strict";import{WebSocket}from"ws";import{createSignalingServer}from"../server/signaling.js";
const wait=(ws,p=()=>true,t=3000)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off("message",on);reject(new Error("signaling timeout"));},t);function on(d){try{const m=JSON.parse(d.toString());if(p(m)){clearTimeout(timer);ws.off("message",on);resolve(m);}}catch{}}ws.on("message",on);});
const join=(code,role,id)=>JSON.stringify({roomId:code,role,from:id,announce:true,sentAt:Date.now()});
test("routes controller and rejects a third peer",async()=>{const s=createSignalingServer({port:0});await new Promise(r=>s.httpServer.listen(0,r));const port=s.httpServer.address().port;const h=new WebSocket("ws://127.0.0.1:"+port),c=new WebSocket("ws://127.0.0.1:"+port),t=new WebSocket("ws://127.0.0.1:"+port);await Promise.all([new Promise(r=>h.once("open",r)),new Promise(r=>c.once("open",r)),new Promise(r=>t.once("open",r))]);h.send(join("123456","host","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));await new Promise(r=>setTimeout(r,20));c.send(join("123456","controller","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));assert.equal((await wait(h,m=>m.announce===true)).role,"controller");t.send(join("123456","controller","cccccccc-cccc-4ccc-8ccc-cccccccccccc"));assert.equal((await wait(t,m=>m.kind==="error")).codeName,"SESSION_BUSY");h.close();c.close();t.close();await new Promise(r=>s.httpServer.close(r));});

test("explicit leave is relayed to the remaining peer",async()=>{
  const s=createSignalingServer({port:0});
  await new Promise(r=>s.httpServer.listen(0,r));
  const port=s.httpServer.address().port;
  const h=new WebSocket("ws://127.0.0.1:"+port);
  const c=new WebSocket("ws://127.0.0.1:"+port);
  await Promise.all([new Promise(r=>h.once("open",r)),new Promise(r=>c.once("open",r))]);
  h.send(join("654321","host","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
  c.send(join("654321","controller","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  await wait(h,m=>m.announce===true);
  h.send(JSON.stringify({roomId:"654321",from:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",to:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",kind:"leave",sentAt:Date.now()}));
  assert.equal((await wait(c,m=>m.kind==="leave")).from,"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  h.close();c.close();
  await new Promise(r=>s.httpServer.close(r));
});
