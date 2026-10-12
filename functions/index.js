"use strict";
const {onCall,HttpsError}=require("firebase-functions/v2/https");
const admin=require("firebase-admin");
admin.initializeApp();
const db=admin.firestore();
const err=(code,message)=>{throw new HttpsError(code,message)};
const str=(v,max=400)=>typeof v==="string"&&v.length<=max;
const positive=v=>typeof v==="number"&&Number.isFinite(v)&&v>0&&v<=1000000000;
const date=v=>str(v,10)&&/^\d{4}-\d{2}-\d{2}$/.test(v);
const cap=(v,max=400)=>str(v,max)?v:"";
const stockRef=item=>db.doc("stockBalances/"+encodeURIComponent(item));
async function userRole(uid){
 const snap=await db.doc("users/"+uid).get();
 if(!snap.exists||snap.get("status")!=="active"||!["staff","manager"].includes(snap.get("role")))err("permission-denied","Active AUS account required");
 return snap.get("role");
}
async function itemConfig(t,item){
 const snap=await t.get(db.doc("settings/global"));
 const config=(snap.data()?.items||[]).find(i=>i&&i.name===item);
 if(!config||!str(config.unit,30)||!config.unit)err("failed-precondition","Item must have an assigned unit");
 return config;
}
async function updateBalance(t,item,normalDelta,recoveredDelta){
 const ref=stockRef(item),snap=await t.get(ref),prev=snap.exists?snap.data():{available:0,recovered:0};
 const available=Number(prev.available||0)+normalDelta,recovered=Number(prev.recovered||0)+recoveredDelta;
 if(!Number.isFinite(available)||!Number.isFinite(recovered)||available<0||recovered<0)err("failed-precondition","Insufficient stock or recovered items for "+item);
 t.set(ref,{item,available,recovered,updatedAt:admin.firestore.FieldValue.serverTimestamp()});
}
function requireFields(obj,fields){if(!obj||typeof obj!=="object"||!fields.every(k=>Object.hasOwn(obj,k)))err("invalid-argument","Required fields missing")}
function validRemarks(data){if(!str(data.remarks||"",400))err("invalid-argument","Remarks too long")}
exports.ausWrite=onCall({region:"asia-southeast1",maxInstances:10,cors:["https://sinmatu.github.io"]},async request=>{
 if(!request.auth)err("unauthenticated","Sign in required");
 const uid=request.auth.uid,role=await userRole(uid),manager=role==="manager";
 const {action,payload={}}=request.data||{};
 if(!str(action,40)||!payload||typeof payload!=="object")err("invalid-argument","Invalid request");
 if(["settings","assetType","asset","removeAsset","seed"].includes(action)&&!manager)err("permission-denied","Manager required");
 if(action==="seed"){
  const settings=db.doc("settings/global"),types=db.collection("assetTypes");
  await db.runTransaction(async t=>{
   const definitions=[["type-lorry","Lorry",["Plate Number","Make / Model"]],["type-machine","Machine",["Machine ID","Make / Model"]]];
   const snapshots=await Promise.all([t.get(settings),...definitions.map(([id])=>t.get(types.doc(id)))]);
   if(!snapshots[0].exists)t.set(settings,{units:["drum","litre","pc"],measures:["hour","trip","km","load","tonne"],items:[{name:"Diesel",unit:"litre",recoverable:false},{name:"Battery",unit:"pc",recoverable:true},{name:"Battery Liquid",unit:"litre",recoverable:false},{name:"Rimula",unit:"litre",recoverable:false},{name:"Hydraulic Oil",unit:"litre",recoverable:false}]});
   definitions.forEach(([id,name,fields],i)=>{if(!snapshots[i+1].exists)t.set(types.doc(id),{name,fields})});
  });return {ok:true};
 }
 if(action==="settings"){
  const {items,units,measures}=payload;
  if(!Array.isArray(items)||!Array.isArray(units)||!Array.isArray(measures)||items.length>250||units.length>100||measures.length>100)err("invalid-argument","Invalid settings");
  if(!units.every(u=>str(u,30)&&u)||!measures.every(m=>str(m,30)&&m)||!items.every(i=>i&&str(i.name,60)&&i.name&&units.includes(i.unit)&&typeof i.recoverable==="boolean"))err("invalid-argument","Every item requires a valid unit and recovery setting");
  if(new Set(items.map(i=>i.name.toLowerCase())).size!==items.length)err("invalid-argument","Duplicate items");
  const existing=await db.doc("settings/global").get();
  const old=existing.data()?.items||[];
  for(const i of old){
   const next=items.find(n=>n.name===i.name);
   if(next&&next.unit!==i.unit){
    const snap=await db.collection("stockBalances").doc(encodeURIComponent(i.name)).get();
    if(snap.exists)err("failed-precondition","Item unit is locked once stock exists");
   }
  }
  await db.doc("settings/global").set({items,units,measures,updatedBy:uid,updatedAt:admin.firestore.FieldValue.serverTimestamp()},{merge:true});return {ok:true};
 }
 if(action==="assetType"){
  const {id,name,fields}=payload;
  if(!str(id,100)||!id||!str(name,60)||!name||!Array.isArray(fields)||fields.length>30||!fields.every(f=>str(f,80)))err("invalid-argument","Invalid asset type");
  await db.doc("assetTypes/"+id).set({name,fields});return {ok:true};
 }
 if(action==="asset"){
  const {id,name,typeId,meta={}}=payload;
  if(!str(id,100)||!id||!str(name,80)||!name||!str(typeId,100)||!typeId||!meta||typeof meta!=="object")err("invalid-argument","Invalid asset");
  await db.doc("assets/"+id).set({name,typeId,meta});return {ok:true};
 }
 if(action==="removeAsset"){
  if(!str(payload.id,100)||!payload.id)err("invalid-argument","Invalid asset");
  const [u,w]=await Promise.all(["usageRecords","workRecords"].map(c=>db.collection(c).where("assetId","==",payload.id).limit(1).get()));
  if(!u.empty||!w.empty)err("failed-precondition","Asset has records");
  await db.doc("assets/"+payload.id).delete();return {ok:true};
 }
 if(action==="movement"){
  const {id,type,item,qty,reason,date:when,remarks=""}=payload;
  if(!str(id,100)||!id||!["in","recovered-out"].includes(type)||!str(item,60)||!positive(qty)||!date(when))err("invalid-argument","Invalid movement");
  validRemarks({remarks});
  if(type==="recovered-out"&&(!Number.isInteger(qty)||!["sold","disposed","other"].includes(reason)))err("invalid-argument","Invalid recovered stock out");
  await db.runTransaction(async t=>{
   const target=db.doc("stockMovements/"+id);
   if((await t.get(target)).exists)err("already-exists","Movement already recorded");
   const config=await itemConfig(t,item);
   if(type==="recovered-out"&&!config.recoverable)err("failed-precondition","Item is not recoverable");
   await updateBalance(t,item,type==="in"?qty:0,type==="recovered-out"?-qty:0);
   t.create(target,{type,item,unit:config.unit,qty,reason:type==="recovered-out"?reason:null,date:when,remarks,createdBy:uid,createdAt:admin.firestore.FieldValue.serverTimestamp()});
  });return {ok:true};
 }
 if(action==="record"){
  const {id,kind,date:when,assetId,qty,status="pending"}=payload;
  if(!str(id,100)||!id||!["usage","work"].includes(kind)||!date(when)||!str(assetId,100)||!assetId||!positive(qty))err("invalid-argument","Invalid record");
  validRemarks(payload);
  const collection=kind==="usage"?"usageRecords":"workRecords";
  await db.runTransaction(async t=>{
   const target=db.doc(collection+"/"+id),old=await t.get(target);
   if(old.exists)err("already-exists","Record already exists");
   if(!(await t.get(db.doc("assets/"+assetId))).exists)err("failed-precondition","Asset does not exist");
   const base={date:when,assetId,qty,status:"pending",remarks:cap(payload.remarks),createdBy:uid,createdAt:admin.firestore.FieldValue.serverTimestamp()};
   if(kind==="usage"){
    const item=payload.item,recoveredQty=Number(payload.recoveredQty||0);
    if(!str(item,60)||!item)err("invalid-argument","Item required");
    const config=await itemConfig(t,item);
    if(!Number.isInteger(recoveredQty)||recoveredQty<0||recoveredQty>qty||(!config.recoverable&&recoveredQty!==0))err("invalid-argument","Invalid recovery quantity");
    await updateBalance(t,item,-qty,recoveredQty);
    t.create(target,{...base,item,unit:config.unit,recoveredQty,mechanic:cap(payload.mechanic,80),supervisor:cap(payload.supervisor,80)});
   }else{
    if(!str(payload.measure,30)||!payload.measure)err("invalid-argument","Work measure required");
    t.create(target,{...base,measure:payload.measure,job:cap(payload.job,100)});
   }
  });return {ok:true};
 }
 if(action==="review"){
  if(!manager)err("permission-denied","Manager only");
  const {id,kind,status}=payload;
  if(!["usage","work"].includes(kind)||!["checked","correction","void"].includes(status)||!str(id,100))err("invalid-argument","Invalid review");
  await db.runTransaction(async t=>{
   const ref=db.doc((kind==="usage"?"usageRecords":"workRecords")+"/"+id),old=await t.get(ref);
   if(!old.exists)err("not-found","Record not found");
   const data=old.data();if(data.status==="void"&&status!=="void")err("failed-precondition","Voided record cannot be restored here");
   if(kind==="usage"&&data.status!=="void"&&status==="void")await updateBalance(t,data.item,Number(data.qty),-Number(data.recoveredQty||0));
   t.update(ref,{status,reviewedBy:uid,reviewedAt:admin.firestore.FieldValue.serverTimestamp()});
  });return {ok:true};
 }
 if(action==="correct"){
  if(!manager)err("permission-denied","Manager only");
  const {id,kind,qty,item,measure,recoveredQty=0,note}=payload;
  if(!["usage","work"].includes(kind)||!str(id,100)||!positive(qty)||!str(note,300)||!note)err("invalid-argument","Invalid correction");
  await db.runTransaction(async t=>{
   const ref=db.doc((kind==="usage"?"usageRecords":"workRecords")+"/"+id),snap=await t.get(ref);
   if(!snap.exists||snap.get("status")==="void")err("failed-precondition","Record missing or void");
   const old=snap.data();let fields={qty,status:"checked",correctionNote:note,correctedBy:uid,correctedAt:admin.firestore.FieldValue.serverTimestamp()};
   if(kind==="usage"){
    const config=await itemConfig(t,item);
    if(!Number.isInteger(recoveredQty)||recoveredQty<0||recoveredQty>qty||(!config.recoverable&&recoveredQty))err("invalid-argument","Invalid recovery quantity");
    if(old.item===item){await updateBalance(t,item,Number(old.qty)-qty,recoveredQty-Number(old.recoveredQty||0));}
    else{
     const oldRef=stockRef(old.item),newRef=stockRef(item);
     const [oldSnap,newSnap]=await Promise.all([t.get(oldRef),t.get(newRef)]);
     const oldAvail=Number(oldSnap.data()?.available||0)+Number(old.qty);
     const oldRecovered=Number(oldSnap.data()?.recovered||0)-Number(old.recoveredQty||0);
     const newAvail=Number(newSnap.data()?.available||0)-qty;
     const newRecovered=Number(newSnap.data()?.recovered||0)+recoveredQty;
     if(oldRecovered<0||newAvail<0||newRecovered<0)err("failed-precondition","Correction would create negative stock");
     const stamp=admin.firestore.FieldValue.serverTimestamp();
     t.set(oldRef,{item:old.item,available:oldAvail,recovered:oldRecovered,updatedAt:stamp});
     t.set(newRef,{item,available:newAvail,recovered:newRecovered,updatedAt:stamp});
    }
    fields={...fields,item,unit:config.unit,recoveredQty};
   }else{
    if(!str(measure,30)||!measure)err("invalid-argument","Invalid work measure");fields.measure=measure;
   }
   t.update(ref,fields);
  });return {ok:true};
 }
 err("invalid-argument","Unknown action");
});
