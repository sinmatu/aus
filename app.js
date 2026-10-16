import { firebaseConfig } from "./firebase-config.js";

const fb={};
let currentUser=null;
let currentRole="";

const defaults={
  assetTypes:[
    {id:'type-lorry',name:'Lorry',fields:['Plate Number','Make / Model']},
    {id:'type-machine',name:'Machine',fields:['Machine ID','Make / Model']}
  ],
  items:[{name:'Diesel',unit:'litre',recoverable:false},{name:'Battery',unit:'pc',recoverable:true},{name:'Battery Liquid',unit:'litre',recoverable:false},{name:'Rimula',unit:'litre',recoverable:false},{name:'Hydraulic Oil',unit:'litre',recoverable:false}],
  units:['drum','litre','pc'],
  measures:['hour','trip','km','load','tonne'],
  assets:[],
  records:[],
  movements:[],
  balances:[]
};
let state=structuredClone(defaults);
const PAGE_SIZE=25;
let recordsPage=0;
const monthSubscriptions=new Map();
const monthDatasets=new Map();
let stockSubscriptions=[];
let refreshToken=0;
function selectedMonths(){
 return [...new Set(['record','report'].map(prefix=>periodKey(prefix)).filter(Boolean))];
}
function periodKey(prefix){
 const year=$(prefix+'Year')?.value||String(new Date().getFullYear());
 return $(prefix+'Period')?.value==='month'?($(prefix+'Month')?.value||year+'-01'):year;
}
function matchesPeriod(date,key){return !key||String(date||'').startsWith(key)}
function showPeriodFields(prefix){
 $(prefix+'Month').classList.toggle('hidden',$(prefix+'Period').value!=='month');
}
function periodLabel(prefix){const key=periodKey(prefix);return key.length===7?'Month: '+key:'Year: '+key}
function stopDataSync(){
  refreshToken++;
  for(const stop of monthSubscriptions.values())stop();
  monthSubscriptions.clear();monthDatasets.clear();
  stockSubscriptions.forEach(stop=>stop());stockSubscriptions=[];
}
function applyMonthlyRecords(){
  const active=new Map();
  for(const [month,rows] of monthDatasets)active.set(month,rows);
  // The authoritative stock history is kept separately, so month-scoped Records
  // and Reports never change stock opening balances or stock availability.
  state.records=[...active.values()].flat();
}
function watchMonth(month){
  if(!month||!fb.db||monthSubscriptions.has(month))return;
  const key=month,token=refreshToken;
  const begin=month.length===4?month+'-01-01':month+'-01',endMonth=month.length===4?new Date(Number(month)+1,0,1):new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),1);
  const finish=endMonth.getFullYear()+'-'+String(endMonth.getMonth()+1).padStart(2,'0')+'-01';
  const snapshots={usage:null,work:null};
  const update=()=>{
    if(token!==refreshToken||!snapshots.usage||!snapshots.work)return;
    monthDatasets.set(key,[...snapshots.usage,...snapshots.work]);
    applyMonthlyRecords();
    renderRecords();renderReports();
  };
  const stops=['usage','work'].map(kind=>{
    const collection=kind==='usage'?'usageRecords':'workRecords';
    return fb.onSnapshot(fb.query(fb.collection(fb.db,collection),fb.where('date','>=',begin),fb.where('date','<',finish)),snap=>{
      snapshots[kind]=snap.docs.map(d=>({id:d.id,kind,...d.data()}));update();
    },error=>notify('Monthly '+kind+' sync failed: '+error.message));
  });
  monthSubscriptions.set(key,()=>stops.forEach(stop=>stop()));
}
function syncSelectedMonths(){
  const selected=selectedMonths();
  for(const [month,stop] of monthSubscriptions)if(!selected.includes(month)){stop();monthSubscriptions.delete(month);monthDatasets.delete(month)}
  for(const month of selected)watchMonth(month);
  applyMonthlyRecords();renderRecords();renderReports();
}
function beginDataSync(){
  stopDataSync();
  const token=refreshToken;
  const snapStock={usage:null,movements:null};
  const updateStock=()=>{
    if(token!==refreshToken||!snapStock.usage||!snapStock.movements)return;
    stockHistoryRecords=snapStock.usage;
    state.movements=snapStock.movements;
    renderStockReports();renderMovementHistory();
  };
  stockSubscriptions=[
    fb.onSnapshot(fb.collection(fb.db,'usageRecords'),snap=>{
      snapStock.usage=snap.docs.map(d=>({id:d.id,kind:'usage',...d.data()}));updateStock();
    },err=>notify('Stock usage sync failed: '+err.message)),
    fb.onSnapshot(fb.collection(fb.db,'stockMovements'),snap=>{
      snapStock.movements=snap.docs.map(d=>({id:d.id,...d.data()}));updateStock();
    },err=>notify('Stock movement sync failed: '+err.message))
  ];
  syncSelectedMonths();
}
let stockHistoryRecords=[];
function save(){
  renderAll();
}
const itemName=i=>typeof i==='string'?i:i.name;
const itemConfig=name=>state.items.find(i=>itemName(i)===name);
const itemUnit=name=>itemConfig(name)?.unit||'';
const itemMeasured=name=>itemConfig(name)?.trackQuantity!==false;
const itemRecoverable=name=>itemMeasured(name)&&!!itemConfig(name)?.recoverable;
function recordCollection(r){return r.kind==='usage'?'usageRecords':'workRecords'}
async function persistSettings(){
 await fb.setDoc(fb.doc(fb.db,'settings','global'),{items:state.items,units:state.units,measures:state.measures,updatedBy:currentUser.uid,updatedAt:new Date().toISOString()},{merge:true});
}
async function persistAssetType(t){await fb.setDoc(fb.doc(fb.db,'assetTypes',t.id),{name:t.name,fields:t.fields})}
async function persistAsset(a){await fb.setDoc(fb.doc(fb.db,'assets',a.id),{name:a.name,typeId:a.typeId,meta:a.meta||{}})}
async function persistRecord(r){const data={...r};delete data.id;delete data.kind;await fb.setDoc(fb.doc(fb.db,recordCollection(r),r.id),data)}
async function persistMovement(m){const data={...m};delete data.id;await fb.setDoc(fb.doc(fb.db,'stockMovements',m.id),data)}
async function refreshServerState(){
 await loadFirebaseState();
 stockHistoryRecords=state.records.filter(r=>r.kind==='usage');
 if(monthSubscriptions.size){syncSelectedMonths()}else save();
}
async function loadFirebaseState(){
  const [typeSnap,assetSnap,usageSnap,workSnap,settingsSnap,movementSnap]=await Promise.all([
    fb.getDocsFromServer(fb.collection(fb.db,'assetTypes')),
    fb.getDocsFromServer(fb.collection(fb.db,'assets')),
    fb.getDocsFromServer(fb.collection(fb.db,'usageRecords')),
    fb.getDocsFromServer(fb.collection(fb.db,'workRecords')),
    fb.getDocFromServer(fb.doc(fb.db,'settings','global')),
    fb.getDocsFromServer(fb.collection(fb.db,'stockMovements'))
  ]);
  state={
    assetTypes:typeSnap.docs.map(d=>({id:d.id,...d.data()})),
    items:settingsSnap.exists()&&Array.isArray(settingsSnap.data().items)?settingsSnap.data().items.map(i=>typeof i==='string'?{name:i,unit:'',recoverable:false}:i):[],
    units:settingsSnap.exists()&&Array.isArray(settingsSnap.data().units)?settingsSnap.data().units:[],
    measures:settingsSnap.exists()&&Array.isArray(settingsSnap.data().measures)?settingsSnap.data().measures:[],
    assets:assetSnap.docs.map(d=>({id:d.id,...d.data()})),
    movements:movementSnap.docs.map(d=>({id:d.id,...d.data()})),
    records:[
      ...usageSnap.docs.map(d=>({id:d.id,kind:'usage',...d.data()})),
      ...workSnap.docs.map(d=>({id:d.id,kind:'work',...d.data()}))
    ]
  };
}
async function seedFirebaseDefaults(){
 if(currentRole!=='manager')return;
 const settingsRef=fb.doc(fb.db,'settings','global');
 const snap=await fb.getDocFromServer(settingsRef);
 if(!snap.exists())await fb.setDoc(settingsRef,{items:structuredClone(defaults.items),units:[...defaults.units],measures:[...defaults.measures],updatedBy:currentUser.uid,updatedAt:new Date().toISOString()});
 for(const t of defaults.assetTypes){const ref=fb.doc(fb.db,'assetTypes',t.id);if(!(await fb.getDocFromServer(ref)).exists())await persistAssetType(t)}
}

const $=id=>document.getElementById(id);

function notify(message){
 const el=$('ausNotice');el.textContent=String(message);el.classList.remove('hidden');
 clearTimeout(notify.timer);notify.timer=setTimeout(()=>el.classList.add('hidden'),5500);
}
function uiDialog(title,value='',confirmOnly=false){
 return new Promise(resolve=>{
  const overlay=$('ausModal'),form=$('ausModalForm'),field=$('ausModalInput');
  $('ausModalTitle').textContent=title;
  field.value=String(value);field.classList.toggle('hidden',confirmOnly);
  overlay.classList.remove('hidden');
  const finish=result=>{overlay.classList.add('hidden');form.onsubmit=null;$('ausModalCancel').onclick=null;resolve(result)};
  form.onsubmit=e=>{e.preventDefault();finish(confirmOnly?true:field.value)};
  $('ausModalCancel').onclick=()=>finish(confirmOnly?false:null);
  if(!confirmOnly)field.focus();
 });
}
const uiPrompt=(title,value)=>uiDialog(title,value,false);
const uiConfirm=title=>uiDialog(title,'',true);
function editUsageItem(item,hasHistory){
 return new Promise(resolve=>{
  const modal=$('usageItemModal'),form=$('usageItemEditForm');
  const name=$('usageItemEditName'),unit=$('usageItemEditUnit'),recovery=$('usageItemEditRecoverable');
  name.value=itemName(item);name.readOnly=hasHistory;
  unit.innerHTML=state.units.map(u=>'<option value="'+esc(u)+'">'+esc(u)+'</option>').join('');
  unit.value=item.unit||'';unit.disabled=hasHistory;
  const tracking=$('usageItemEditTracking');tracking.checked=item.trackQuantity!==false;
  recovery.checked=!!item.recoverable;
  const syncTracking=()=>{unit.disabled=hasHistory||!tracking.checked;recovery.disabled=!tracking.checked;if(!tracking.checked)recovery.checked=false};tracking.onchange=syncTracking;syncTracking();
  $('usageItemHistoryNote').classList.toggle('hidden',!hasHistory);
  modal.classList.remove('hidden');
  const finish=value=>{modal.classList.add('hidden');form.onsubmit=null;$('usageItemEditCancel').onclick=null;tracking.onchange=null;resolve(value)};
  form.onsubmit=e=>{
   e.preventDefault();
   const n=name.value.trim(),u=unit.value;
   if(!n||(tracking.checked&&!state.units.includes(u))){notify('Enter an item name and choose a configured unit.');return}
   finish({name:n,unit:tracking.checked?u:'',recoverable:tracking.checked&&recovery.checked,trackQuantity:tracking.checked});
  };
  $('usageItemEditCancel').onclick=()=>finish(null);
  name.focus();
 });
}


const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const uid=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
const today=()=>new Date().toISOString().slice(0,10);
$('usageDate').value=today(); $('workDate').value=today();$('stockDate').value=today();$('recoveryDate').value=today();
const currentMonth=today().slice(0,7);
$('recordMonth').value=currentMonth;$('recordYear').value=currentMonth.slice(0,4);
$('reportMonth').value=currentMonth;$('reportYear').value=currentMonth.slice(0,4);

function applyRoleUI(){
  document.querySelectorAll('[data-role]').forEach(el=>{
    const allowed=el.dataset.role.split(',').includes(currentRole);
    el.classList.toggle('hidden',!allowed);
  });
}
function showLogin(){
  $('loginView').classList.remove('hidden');
  $('shell').classList.add('hidden');
  $('userArea').innerHTML='<span class="system-mark">AUS</span>';
}
function showShell(){
  $('loginView').classList.add('hidden');
  $('shell').classList.remove('hidden');
  $('signedInName').textContent=currentUser?.displayName||currentUser?.email||'User';
  $('roleBadge').textContent=currentRole?currentRole.charAt(0).toUpperCase()+currentRole.slice(1):'';
  $('userArea').innerHTML='<strong>'+esc(currentUser?.displayName||currentUser?.email||'User')+'</strong>';
  applyRoleUI();
}
async function initFirebase(){
  const [A,U,F]=await Promise.all([
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js'),
    import('https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js')
  ]);
  const app=A.initializeApp(firebaseConfig);
  fb.auth=U.getAuth(app); fb.db=F.getFirestore(app);
  await U.setPersistence(fb.auth,U.inMemoryPersistence);
  Object.assign(fb,U,F);
  U.onAuthStateChanged(fb.auth,async user=>{
    if(!user){stopDataSync();currentUser=null;currentRole='';showLogin();return}
    try{
      const snap=await F.getDocFromServer(F.doc(fb.db,'users',user.uid));
      if(!snap.exists())throw Error('Account is not authorised for this system.');
      const profile=snap.data();
      const role=profile.role||'';
      const status=profile.status||'';
      if(profile.uid && profile.uid!==user.uid)throw Error('Account profile does not match this signed-in user.');
      if(!['manager','staff'].includes(role))throw Error('Account role is missing or not authorised.');
      if(status!=='active')throw Error('Account is not active.');
      currentUser=user; currentRole=role;
      showShell();
      try {
        await loadFirebaseState();
        stockHistoryRecords=state.records.filter(r=>r.kind==='usage');
        save();
        beginDataSync();
        $('setupBanner').classList.add('hidden');
      } catch (loadErr) {
        $('setupBanner').textContent='Signed in, but Firestore could not load: '+(loadErr.message||loadErr)+'. Check Firestore Rules and connection.';
        $('setupBanner').classList.remove('hidden');
        console.error('AUS data loading failed',loadErr);
      }
    }catch(err){
      $('loginError').textContent=err.message||'Account is not authorised.';
      $('loginError').classList.remove('hidden');
      await U.signOut(fb.auth);
    }
  });
}
$('loginForm').addEventListener('submit',async e=>{
  e.preventDefault(); $('loginError').classList.add('hidden');
  try{await fb.signInWithEmailAndPassword(fb.auth,$('loginEmail').value.trim(),$('loginPassword').value)}
  catch(err){$('loginError').textContent='Sign in failed. Check your email and password.';$('loginError').classList.remove('hidden')}
});
$('googleLoginBtn').addEventListener('click',async()=>{
  $('loginError').classList.add('hidden');
  try{await fb.signInWithPopup(fb.auth,new fb.GoogleAuthProvider())}
  catch(err){$('loginError').textContent='Google sign in failed.';$('loginError').classList.remove('hidden')}
});
$('signOutBtn').addEventListener('click',()=>fb.signOut(fb.auth));

document.querySelectorAll('.tabs button').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b===btn));
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  $('view-'+btn.dataset.view).classList.remove('hidden');
  if(btn.dataset.view==='assets')renderAssetProfiles();
  if(btn.dataset.view==='records')renderRecords();
  if(btn.dataset.view==='reports')renderReports();
}));

function optionList(arr,placeholder,mapper=x=>({value:x,label:x})){
  return '<option value="">'+esc(placeholder)+'</option>'+arr.map(x=>{const o=mapper(x);return '<option value="'+esc(o.value)+'">'+esc(o.label)+'</option>'}).join('');
}
function assetLabel(a){
  const t=state.assetTypes.find(x=>x.id===a.typeId);
  return a.name+(t?' · '+t.name:'');
}
function renderSelectors(){
  const assetOpts=optionList(state.assets,'Select asset',a=>({value:a.id,label:assetLabel(a)}));
  $('usageAsset').innerHTML=assetOpts; $('workAsset').innerHTML=assetOpts;
  const allAssets='<option value="">All Assets</option>'+state.assets.map(a=>'<option value="'+esc(a.id)+'">'+esc(assetLabel(a))+'</option>').join('');
  const oldRecordAsset=$('recordAsset').value,oldReportAsset=$('reportAsset').value;
  $('recordAsset').innerHTML=allAssets;
  $('reportAsset').innerHTML=allAssets;
  $('recordAsset').value=oldRecordAsset; $('reportAsset').value=oldReportAsset;
  const oldReportItem=$('reportItem').value;
  $('reportItem').innerHTML='<option value="">All Items</option>'+state.items.map(i=>'<option value="'+esc(itemName(i))+'">'+esc(itemName(i))+'</option>').join('');
  $('reportItem').value=oldReportItem;
  $('usageItem').innerHTML=optionList(state.items,'Select item',i=>({value:itemName(i),label:itemName(i)}));
  syncUsageItem();
  $('stockItem').innerHTML=optionList(state.items,'Select item',i=>({value:itemName(i),label:itemName(i)}));
  $('recoveryItem').innerHTML=optionList(state.items.filter(i=>i.recoverable),'Select recovered item',i=>({value:itemName(i),label:itemName(i)}));
  $('usageUnit').value=itemUnit($('usageItem').value);
  $('workMeasure').innerHTML=optionList(state.measures,'Select measure');
  $('assetTypeSelect').innerHTML=optionList(state.assetTypes,'Select asset type',t=>({value:t.id,label:t.name}));
}
function renderDefinitions(){
  $('assetTypeList').innerHTML=state.assetTypes.length?state.assetTypes.map(t=>
    '<div class="stack-row editable-row"><div><b>'+esc(t.name)+'</b><small>'+esc(t.fields.join(' · ')||'No metadata fields')+'</small></div>'+
    '<div class="definition-actions"><button type="button" class="edit-link" data-edit-type-name="'+esc(t.id)+'">Edit Name</button>'+
    '<button type="button" class="edit-link" data-edit-type-meta="'+esc(t.id)+'">Edit Metadata</button></div></div>'
  ).join(''):'<div class="empty">No asset types yet.</div>';
  $('itemList').innerHTML=state.items.map((i,index)=>'<div class="stack-row editable-row"><div><b>'+esc(itemName(i))+'</b><small>'+(i.trackQuantity===false?'No quantity / unit':esc(i.unit||'Unit not set'))+(i.recoverable&&i.trackQuantity!==false?' · Recovery enabled':'')+'</small></div><button type="button" class="edit-link" data-edit-item="'+index+'">Edit</button></div>').join('');
  renderChips('unitList',state.units,'units');
  renderChips('measureList',state.measures,'measures');
}
function renderChips(id,arr,key){
  $(id).innerHTML=arr.map((v,i)=>
    '<span class="chip editable-chip"><span>'+esc(v)+'</span><button type="button" class="edit-link" data-edit-simple="'+key+'" data-index="'+i+'">Edit</button></span>'
  ).join('');
}
function renderAssets(){
  $('assetList').innerHTML=state.assets.length?state.assets.map(a=>{
    const t=state.assetTypes.find(x=>x.id===a.typeId);
    const meta=Object.entries(a.meta||{}).filter(([,v])=>v).map(([k,v])=>k+': '+v).join(' · ');
    return '<div class="asset-row"><div><b>'+esc(a.name)+'</b><small>'+esc((t?t.name:'Unknown type')+(meta?' · '+meta:''))+'</small></div><button class="row-delete" data-delete-asset="'+esc(a.id)+'">Remove</button></div>';
  }).join(''):'<div class="empty">No assets registered yet.</div>';
}
function renderMetaFields(){
  const t=state.assetTypes.find(x=>x.id===$('assetTypeSelect').value);
  $('assetMetaFields').innerHTML=t?t.fields.map((f,i)=>'<label>'+esc(f)+'<input data-meta-index="'+i+'" placeholder="'+esc(f)+'"></label>').join(''):'';
}
function renderAssetProfiles(){
  $('assetProfileCount').textContent=state.assets.length+" registered asset"+(state.assets.length===1?"":"s");
  if(!state.assets.length){
    $('assetProfiles').innerHTML='<div class="panel empty">No assets registered yet. A manager can add assets in Settings.</div>';
    return;
  }
  $('assetProfiles').innerHTML=state.assets.map(a=>{
    const t=state.assetTypes.find(x=>x.id===a.typeId);
    const meta=Object.entries(a.meta||{}).filter(([,v])=>v);
    return '<article class="asset-profile-card"><div class="asset-profile-head"><div><span class="asset-type">'+esc(t?.name||"Asset")+'</span><h3>'+esc(a.name)+'</h3></div></div>'+
      '<div class="asset-meta">'+(meta.length?meta.map(([k,v])=>'<div><span>'+esc(k)+'</span><b>'+esc(v)+'</b></div>').join(''):'<span class="muted">No additional profile information.</span>')+'</div></article>';
  }).join('');
}
const money=v=>v==null||!Number.isFinite(Number(v))?'—':'RM '+Number(v).toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2});
const entryAmount=r=>r.kind!=='usage'?'—':money(r.amount);
function cost(price,qty){
 if(price===''||price==null)return {unitPrice:null,amount:null};
 const unitPrice=Number(price);
 if(!Number.isFinite(unitPrice)||unitPrice<0)return null;
 return {unitPrice,amount:qty==null?null:Math.round(unitPrice*qty*100)/100};
}
function recordDetail(r){
  if(r.status==='pending_details')return r.kind==='usage'?r.item+' · Quantity pending':'Work quantity pending';
  return r.kind==='usage'?(r.trackQuantity===false?r.item:r.item+' · '+r.qty+' '+r.unit):r.qty+' '+r.measure;
}
function recordReference(r){
  return [(r.operator||r.performedBy)&&'Operator: '+(r.operator||r.performedBy),r.mechanic&&'Mechanic: '+r.mechanic,r.supervisor&&'Supervisor: '+r.supervisor].filter(Boolean).join(' · ');
}
function recordRemarks(r){return [r.remarks,r.kind==='work'&&r.job?'Job / Ref: '+r.job:''].filter(Boolean).join(' · ');}
function recordsTable(records){
  if(!records.length)return '<div class="empty">No matching records.</div>';
  const manager=currentRole==='manager';
  const usageView=$('recordKind').value==='usage';
  const selectHead=manager?'<th class="select-col"><input id="selectVisibleRecords" type="checkbox" aria-label="Select reviewable records"></th>':'';
  const reviewHead=manager?'<th>Review</th>':'<th>Actions</th>';
  return '<table><thead><tr>'+selectHead+'<th>Date</th><th>Asset</th><th>Type</th><th>Activity / Quantity</th>'+(usageView?'<th>Amount</th>':'')+'<th>Status</th><th>Description</th><th>Personnel</th>'+reviewHead+'</tr></thead><tbody>'+records.map(r=>{
    const a=state.assets.find(x=>x.id===r.assetId);
    const status=r.status||'pending';
    const reviewable=status!=='checked'&&status!=='void'&&status!=='pending_details';
    const selectCell=manager?'<td class="select-col">'+(reviewable?'<input class="record-select" type="checkbox" value="'+esc(r.id)+'">':'')+'</td>':'';
    const canComplete=status==='pending_details'&&(currentRole==='manager'||r.createdBy===currentUser?.uid);
    const completion=canComplete?'<button type="button" class="record-action" data-complete="1">Complete Entry</button>':'';
    let reviewCell='';
    if(manager){
      const checkedDisabled=status==='checked'||status==='pending_details'||status==='void';
      const checked='<button type="button" class="record-action" data-status="checked" '+(checkedDisabled?'disabled title="'+(status==='pending_details'?'Complete the missing quantity before checking.':'Already checked or voided.')+'"':'')+'>Mark Checked</button>';
      const correct='<button type="button" class="record-action" data-correct="1">Correct Entry</button>';
      const correctionDisabled=status==='correction'||status==='pending_details'||status==='void';
      const correction='<button type="button" class="record-action" data-status="correction" '+(correctionDisabled?'disabled title="'+(status==='pending_details'?'Complete missing details or use Correct Entry.':'Correction already required or record voided.')+'"':'')+'>Correction Required</button>';
      const voidBtn='<button type="button" class="record-action danger-link" data-status="void" '+(status==='void'?'disabled':'')+'>Void Entry</button>';
      reviewCell='<td><div class="record-actions">'+completion+checked+correct+correction+voidBtn+'</div></td>';
    }
    return '<tr data-record-id="'+esc(r.id)+'">'+selectCell+'<td>'+esc(r.date)+'</td><td>'+esc(a?a.name:'Removed asset')+'</td><td><span class="record-kind '+r.kind+'">'+esc(r.kind==='usage'?'Usage':'Work')+'</span></td><td>'+esc(recordDetail(r))+'</td>'+(usageView?'<td>'+esc(entryAmount(r))+'</td>':'')+'<td>'+esc(status==='pending_details'?'Pending Details':status==='pending'?'Pending Review':status)+'</td><td class="remarks-cell">'+esc(recordRemarks(r)||'—')+'</td><td class="sign-cell">'+esc(recordReference(r)||'—')+'</td>'+(manager?reviewCell:completion?'<td><div class="record-actions">'+completion+'</div></td>':'<td></td>')+'</tr>';
  }).join('')+'</tbody></table>';
}
function filteredRecords(month,assetId,kind){
  const dir=$('recordSort')?.value==='asc'?1:-1;
  return state.records.filter(r=>matchesPeriod(r.date,month)&&(!assetId||r.assetId===assetId)&&(!kind||r.kind===kind)).sort((a,b)=>dir*a.date.localeCompare(b.date));
}
function renderRecords(){
  const rows=filteredRecords(periodKey('record'),$('recordAsset').value,$('recordKind').value);
  const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));
  recordsPage=Math.min(recordsPage,pages-1);
  $('recordCount').textContent=rows.length+' records';
  $('recordsTable').innerHTML=recordsTable(rows.slice(recordsPage*PAGE_SIZE,(recordsPage+1)*PAGE_SIZE));
  $('recordsPaging').innerHTML=rows.length?'<span>Page '+(recordsPage+1)+' of '+pages+'</span> <button type="button" class="secondary" data-page="prev" '+(recordsPage===0?'disabled':'')+'>Previous</button> <button type="button" class="secondary" data-page="next" '+(recordsPage===pages-1?'disabled':'')+'>Next</button>':'';
  updateBulkReview();
}
function updateBulkReview(){
  if(currentRole!=='manager')return;
  const boxes=[...document.querySelectorAll('#recordsTable .record-select')];
  const checked=boxes.filter(x=>x.checked);
  $('recordSelectedCount').textContent=checked.length+' selected';
  $('markSelectedChecked').disabled=checked.length===0;
  const master=$('selectVisibleRecords');
  if(master){
    master.checked=boxes.length>0&&checked.length===boxes.length;
    master.indeterminate=checked.length>0&&checked.length<boxes.length;
  }
}
async function setRecordStatus(id,status){
 if(currentRole!=='manager')return;
 const r=state.records.find(x=>x.id===id);if(!r||r.status==='pending_details'&&status==='checked')return;
 const next={...r,status,reviewedBy:currentUser.uid,reviewedAt:new Date().toISOString()};
 await persistRecord(next);await refreshServerState();
}
async function markSelectedChecked(){
 if(currentRole!=='manager')return;
 const selected=[...document.querySelectorAll('#recordsTable .record-select:checked')];
 for(const x of selected)await setRecordStatus(x.value,'checked');
}
function renderUsageCorrectionFields(r){
 const selected=$('correctItem').value;
 const measured=itemMeasured(selected);
 const qtyWrap=$('correctQtyWrap'),unitWrap=$('correctUnitWrap'),priceWrap=$('correctPriceWrap');
 qtyWrap.classList.toggle('hidden',!measured);
 unitWrap.classList.toggle('hidden',!measured);
 priceWrap.classList.toggle('hidden',!measured);
 $('correctQty').required=measured;
 $('correctUnit').value=measured?itemUnit(selected):'';
 const recoveryWrap=$('correctRecoveryWrap');
 recoveryWrap.classList.toggle('hidden',!measured||!itemRecoverable(selected));
 $('correctRemarks').required=!measured;
}
function openCorrection(id){
 const r=state.records.find(x=>x.id===id);if(!r)return;
 $('correctionRecordId').value=id;
 $('correctionOriginal').textContent=(r.kind==='usage'?'Usage':'Work')+' · '+r.date+' · '+recordDetail(r);
 $('correctionNote').value=r.correctionNote||'';
 if(r.kind==='usage'){
   $('correctionFields').innerHTML=
     '<div class="grid two"><label>Date<input id="correctDate" type="date" value="'+esc(r.date)+'" required></label>'+
     '<label>Asset<select id="correctAsset">'+state.assets.map(a=>'<option value="'+esc(a.id)+'" '+(a.id===r.assetId?'selected':'')+'>'+esc(assetLabel(a))+'</option>').join('')+'</select></label></div>'+
     '<label>Item<select id="correctItem">'+state.items.map(i=>'<option value="'+esc(itemName(i))+'" '+(itemName(i)===r.item?'selected':'')+'>'+esc(itemName(i))+'</option>').join('')+'</select></label>'+
     '<div class="grid three">'+
     '<label id="correctQtyWrap">Quantity<input id="correctQty" type="number" min="0.01" step="0.01" value="'+esc(r.qty??'')+'"></label>'+
     '<label id="correctUnitWrap">Unit<input id="correctUnit" type="text" readonly value="'+esc(r.unit||'')+'"></label>'+
     '<label id="correctPriceWrap">Unit price (RM)<input id="correctUnitPrice" type="number" min="0" step="0.0001" value="'+esc(r.unitPrice??'')+'"></label></div>'+
     '<label id="correctRecoveryWrap">Old items recovered<input id="correctRecovered" type="number" min="0" step="1" value="'+esc(r.recoveredQty??0)+'"></label>'+
     '<div class="grid three"><label>Operator<input id="correctOperator" maxlength="100" value="'+esc(r.operator||r.performedBy||'')+'"></label><label>Mechanic<input id="correctMechanic" maxlength="80" value="'+esc(r.mechanic||'')+'"></label>'+
     '<label>Supervisor<input id="correctSupervisor" maxlength="80" value="'+esc(r.supervisor||'')+'"></label></div>'+
     '<label>Description<input id="correctRemarks" maxlength="400" value="'+esc(r.remarks||'')+'"></label>';
   $('correctItem').addEventListener('change',()=>renderUsageCorrectionFields(r));
   renderUsageCorrectionFields(r);
 }else{
   $('correctionFields').innerHTML='<div class="grid two"><label>Date<input id="correctDate" type="date" value="'+esc(r.date)+'" required></label><label>Asset<select id="correctAsset">'+state.assets.map(a=>'<option value="'+esc(a.id)+'" '+(a.id===r.assetId?'selected':'')+'>'+esc(assetLabel(a))+'</option>').join('')+'</select></label></div>'+ '<div class="grid three"><label>Work measure<select id="correctMeasure">'+state.measures.map(m=>'<option '+(m===r.measure?'selected':'')+'>'+esc(m)+'</option>').join('')+'</select></label><label>Quantity (optional)<input id="correctQty" type="number" min="0.01" step="0.01" value="'+esc(r.qty??'')+'"></label><label>Job / reference<input id="correctJob" maxlength="100" value="'+esc(r.job||'')+'"></label></div>'+ '<div class="grid three"><label>Operator<input id="correctOperator" maxlength="100" value="'+esc(r.operator||r.performedBy||'')+'"></label><label>Mechanic<input id="correctMechanic" maxlength="80" value="'+esc(r.mechanic||'')+'"></label><label>Supervisor<input id="correctSupervisor" maxlength="100" value="'+esc(r.supervisor||'')+'"></label></div>'+ '<label>Description<textarea id="correctRemarks" rows="3" maxlength="400">'+esc(r.remarks||'')+'</textarea></label>';
 }
 $('correctionDialog').showModal();
}
async function saveCorrection(e){
 e.preventDefault();if(currentRole!=='manager')return;
 const r=state.records.find(x=>x.id===$('correctionRecordId').value);if(!r)return;
 const next={...r,original:r.original||structuredClone(r),correctionNote:$('correctionNote').value.trim(),correctedBy:currentUser.uid,correctedAt:new Date().toISOString(),status:'checked'};
 if(r.kind==='usage'){
   const item=$('correctItem').value,measured=itemMeasured(item);
   next.date=$('correctDate').value;
   next.assetId=$('correctAsset').value;
   next.item=item;
   next.trackQuantity=measured;
   next.operator=$('correctOperator').value.trim();
   next.mechanic=$('correctMechanic').value.trim();
   next.supervisor=$('correctSupervisor').value.trim();
   next.remarks=$('correctRemarks').value.trim();
   if(!next.date||!next.assetId)return notify('Date and asset are required.');
   if(!measured&&!next.remarks)return notify('Description is required for non-quantity items.');
   if(measured){
     const qtyText=$('correctQty').value.trim();
     next.qty=qtyText===''?null:Number(qtyText);
     if(next.qty!==null&&(!Number.isFinite(next.qty)||next.qty<=0))return notify('Quantity must be positive or blank.');
     next.unit=itemUnit(item);
     if(!next.unit)return notify('Selected item has no configured unit.');
     const price=cost($('correctUnitPrice').value.trim(),next.qty);
     if(price===null)return notify('Invalid unit price.');
     next.unitPrice=price.unitPrice;next.amount=price.amount;
     next.recoveredQty=next.qty!==null&&itemRecoverable(item)?Number($('correctRecovered').value||0):0;
     if(!Number.isInteger(next.recoveredQty)||next.recoveredQty<0||(next.qty!==null&&next.recoveredQty>next.qty))return notify('Invalid recovered quantity.');
     next.receivedQty=next.qty!==null&&next.stockSource==='immediate'?next.qty:0;
     next.status=next.qty===null?'pending_details':'checked';
   }else{
     next.qty=null;next.unit='';next.unitPrice=null;next.amount=null;
     next.recoveredQty=0;next.receivedQty=0;next.stockSource='none';
   }
 }else{
   const qtyText=$('correctQty').value.trim();
   next.qty=qtyText===''?null:Number(qtyText);
   if(next.qty!==null&&(!Number.isFinite(next.qty)||next.qty<=0))return notify('Quantity must be positive or blank.');
   next.date=$('correctDate').value;next.assetId=$('correctAsset').value;
   if(!next.date||!next.assetId)return notify('Date and asset are required.');
   next.measure=$('correctMeasure').value;
   next.job=$('correctJob').value.trim();next.operator=$('correctOperator').value.trim();
   next.mechanic=$('correctMechanic').value.trim();
   next.supervisor=$('correctSupervisor').value.trim();next.remarks=$('correctRemarks').value.trim();
   next.status=next.qty===null?'pending_details':'checked';
 }
 await persistRecord(next);$('correctionDialog').close();await refreshServerState();
}
function reportRows(){
 const item=$('reportItem').value,kind=$('reportKind').value;
 return state.records.filter(r=>matchesPeriod(r.date,periodKey('report')))
   .filter(r=>!$('reportAsset').value||r.assetId===$('reportAsset').value)
   .filter(r=>r.kind===kind&&r.status!=='void'&&r.status!=='pending_details')
   .filter(r=>kind!=='usage'||!item||r.item===item);
}
function reportAssetGroups(records){
  const selected=$('reportAsset').value;
  const ids=[];
  if(selected){
    ids.push(selected);
  }else{
    state.assets.forEach(a=>{
      if(records.some(r=>r.assetId===a.id))ids.push(a.id);
    });
    records.forEach(r=>{
      if(!ids.includes(r.assetId))ids.push(r.assetId);
    });
  }
  return ids.map(assetId=>{
    const asset=state.assets.find(a=>a.id===assetId);
    const rows=records.filter(r=>r.assetId===assetId);
    const usage=rows.filter(r=>r.kind==='usage').sort((a,b)=>b.date.localeCompare(a.date));
    const work=rows.filter(r=>r.kind==='work').sort((a,b)=>b.date.localeCompare(a.date));
    return {assetId,name:asset?.name||'Removed asset',usage,work};
  }).filter(g=>g.usage.length||g.work.length);
}
function reportRowsTable(records,kind){
 if(!records.length)return '';
 const usage=kind==='usage',label=usage?'Usage':'Work';
 return '<div class="report-kind-section"><h4>'+label+'</h4><table><thead><tr><th>Date</th><th>Type</th><th>Activity / Quantity</th>'+(usage?'<th>Amount</th>':'')+'<th>Description</th><th>Personnel</th></tr></thead><tbody>'+records.map(r=>
  '<tr><td>'+esc(r.date)+'</td><td><span class="record-kind '+r.kind+'">'+esc(label)+'</span></td><td>'+esc(recordDetail(r))+'</td>'+(usage?'<td>'+esc(entryAmount(r))+'</td>':'')+'<td class="remarks-cell">'+esc(recordRemarks(r)||'—')+'</td><td class="sign-cell">'+esc(recordReference(r)||'—')+'</td></tr>'
 ).join('')+'</tbody></table></div>';
}
function amountTotals(records){
 const priced=records.filter(r=>r.kind==='usage'&&r.amount!=null&&r.amount!==''&&Number.isFinite(Number(r.amount)));
 return {cents:priced.reduce((n,r)=>n+Math.round(Number(r.amount)*100),0),unpriced:records.filter(r=>r.kind==='usage').length-priced.length};
}
function usageItemGroups(records){
 const groups=new Map();
 for(const r of records){
  const item=r.item||'Unspecified',unit=r.trackQuantity===false?'':(r.unit||'');
  const key=JSON.stringify([item,unit]);
  if(!groups.has(key))groups.set(key,{item,unit,qty:0,hasQty:false,amountCents:0,unpriced:0});
  const g=groups.get(key);
  if(r.qty!=null&&Number.isFinite(Number(r.qty))&&r.trackQuantity!==false){g.qty+=Number(r.qty);g.hasQty=true}
  if(r.amount!=null&&r.amount!==''&&Number.isFinite(Number(r.amount)))g.amountCents+=Math.round(Number(r.amount)*100);
  else g.unpriced++;
 }
 return [...groups.values()].sort((a,b)=>a.item.localeCompare(b.item));
}
function usageSummaryTable(records){
 if(!records.length)return '';
 const groups=usageItemGroups(records),totals=amountTotals(records);
 return '<div class="report-kind-section"><h4>Usage Summary by Item</h4><table><thead><tr><th>Item</th><th>Total Quantity</th><th>Amount (RM)</th></tr></thead><tbody>'+
 groups.map(g=>'<tr><td>'+esc(g.item)+'</td><td>'+esc(g.hasQty?Number(g.qty.toFixed(4))+' '+g.unit:'—')+'</td><td>'+esc(money(g.amountCents/100))+(g.unpriced?' <small class="muted">('+g.unpriced+' unpriced)</small>':'')+'</td></tr>').join('')+
 '<tr><th>Asset Usage Total</th><th>—</th><th>'+esc(money(totals.cents/100))+'</th></tr></tbody></table></div>';
}
function reportTable(records){
 if(!records.length)return '<div class="empty">No matching report records.</div>';
 return reportAssetGroups(records).map(g=>
  '<section class="report-asset-group"><h3>'+esc(g.name)+'</h3>'+
  reportRowsTable(g.usage,'usage')+
  usageSummaryTable(g.usage)+
  reportRowsTable(g.work,'work')+
  '</section>'
 ).join('');
}
function workMeasureGroups(records){
 const groups=new Map();
 records.forEach(r=>{
  const key=r.measure||'Unspecified';
  if(!groups.has(key))groups.set(key,{measure:key,qty:0,count:0});
  const g=groups.get(key);g.count++;if(Number.isFinite(Number(r.qty)))g.qty+=Number(r.qty);
 });
 return [...groups.values()];
}
function workSummaryTable(records){
 if(!records.length)return '';
 return '<div class="report-kind-section"><h4>Work Summary by Measure</h4><table><thead><tr><th>Measure</th><th>Total Quantity</th><th>Entries</th></tr></thead><tbody>'+
 workMeasureGroups(records).map(g=>'<tr><td>'+esc(g.measure)+'</td><td>'+esc(Number(g.qty.toFixed(4)))+'</td><td>'+g.count+'</td></tr>').join('')+'</tbody></table></div>';
}
function renderReports(){
 if(!$('reportTable'))return;
 const kind=$('reportKind').value,rows=reportRows(),groups=reportAssetGroups(rows);
 $('reportItem').classList.toggle('hidden',kind!=='usage');
 $('reportSummary').innerHTML='';
 $('reportTable').innerHTML=rows.length?groups.map(g=>{
  const records=kind==='usage'?g.usage:g.work;
  return '<section class="report-asset-group"><h3>'+esc(g.name)+'</h3>'+
   reportRowsTable(records,kind)+(kind==='usage'?usageSummaryTable(records):workSummaryTable(records))+'</section>';
 }).join(''):'<div class="empty">No matching '+kind+' records.</div>';
 const totals=$('reportTotals');
 if(totals){
  if(kind==='usage'){const amount=amountTotals(rows);totals.innerHTML='<strong>Usage Total: '+esc(money(amount.cents/100))+'</strong>'+(amount.unpriced?' · '+amount.unpriced+' unpriced entries':'');}
  else totals.innerHTML='<strong>Work Totals:</strong> '+(workMeasureGroups(rows).map(g=>esc(Number(g.qty.toFixed(4))+' '+g.measure)).join(' · ')||'No recorded work');
 }
}
function reportMatrix(){
 const kind=$('reportKind').value,rows=reportRows(),groups=reportAssetGroups(rows);
 const aoa=[['Asset Usage System - '+(kind==='usage'?'Usage':'Work')+' Report'],['Period',periodKey('report')],['Asset',$('reportAsset').value?(state.assets.find(a=>a.id===$('reportAsset').value)?.name||'Selected'):'All Assets']];
 if(kind==='usage')aoa.push(['Item',$('reportItem').value||'All Items']);
 aoa.push([]);
 for(const g of groups){
  const records=kind==='usage'?g.usage:g.work;
  aoa.push([g.name]);
  aoa.push(kind==='usage'?['Date','Type','Activity / Quantity','Amount','Description','Personnel']:['Date','Type','Activity / Quantity','Description','Personnel']);
  records.forEach(r=>aoa.push(kind==='usage'?[r.date,'Usage',recordDetail(r),entryAmount(r),recordRemarks(r),recordReference(r)||'']:[r.date,'Work',recordDetail(r),recordRemarks(r),recordReference(r)||'']));
  if(kind==='usage'){
   aoa.push(['Usage Summary by Item'],['Item','Quantity','Unit','Amount (RM)','Unpriced']);
   usageItemGroups(records).forEach(t=>aoa.push([t.item,t.hasQty?Number(t.qty.toFixed(4)):null,t.unit,t.amountCents/100,t.unpriced]));
   const total=amountTotals(records);aoa.push(['Asset Usage Total',null,null,total.cents/100,total.unpriced]);
  }else{
   aoa.push(['Work Summary by Measure'],['Measure','Total Quantity','Entries']);
   workMeasureGroups(records).forEach(t=>aoa.push([t.measure,Number(t.qty.toFixed(4)),t.count]));
  }
  aoa.push([]);
 }
 if(kind==='usage'){const total=amountTotals(rows);aoa.push(['Grand total',null,null,total.cents/100,total.unpriced])}
 else{aoa.push(['All Assets - Work Totals'],['Measure','Total Quantity','Entries']);workMeasureGroups(rows).forEach(t=>aoa.push([t.measure,Number(t.qty.toFixed(4)),t.count]))}
 return aoa;
}
async function exportExcel(){
  const XLSX=await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  const ws=XLSX.utils.aoa_to_sheet(reportMatrix());
  ws['!cols']=[{wch:22},{wch:16},{wch:30},{wch:18},{wch:65},{wch:30}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Report');
  XLSX.writeFile(wb,'aus-report-'+(periodKey('report')+'-'+$('reportKind').value)+'.xlsx');
}
async function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s)})}
async function exportPdf(){
  await loadScript('https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js');
  const {jsPDF}=window.jspdf,doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'}),rows=reportMatrix();
  const navy=[35,56,91],pale=[230,238,248],stripe=[246,249,253],ink=[35,48,67];
  const xs=[14,48,78,119,151,240],widths=[32,27,38,29,85,35];
  const sectionTitles=['Usage Summary by Item','Work Summary by Measure'];
  const headerFirst=['Item','Asset','Date'];
  let y=30,rowNo=0;
  function page(){
    doc.setFillColor(...navy);doc.rect(0,0,297,22,'F');
    doc.setFont('helvetica','bold');doc.setFontSize(15);doc.setTextColor(255,255,255);
    doc.text('Asset Usage System Report',14,11);
    doc.setFont('helvetica','normal');doc.setFontSize(9);
    doc.text(periodLabel('report')+' · '+$('reportKind').value,282,11,{align:'right'});
    doc.setTextColor(...ink);y=30;
  }
  function ensure(height){if(y+height>190){doc.addPage();page()}}
  page();
  for(const row of rows.slice(1)){
    if(row.length===0){y+=3;continue}
    const first=String(row[0]??'');
    const section=row.length===1&&first!=='';
    const header=headerFirst.includes(first)&&row.length>1;
    const total=/^(grand total|asset usage total)$/i.test(first);
    if(section){
      ensure(13);doc.setFillColor(...pale);doc.rect(12,y-4,272,9,'F');
      doc.setFont('helvetica','bold');doc.setFontSize(10);doc.setTextColor(...navy);
      doc.text(first.slice(0,120),15,y+1);doc.setTextColor(...ink);y+=13;rowNo=0;continue;
    }
    const cells=row.slice(0,6).map((v,i)=>doc.splitTextToSize(v==null?'':String(v),widths[i]-2));
    const height=Math.max(7,...cells.map(lines=>Math.max(1,lines.length)*3.4+3));
    ensure(height+1);
    if(header||total){doc.setFillColor(...(header?navy:pale));doc.rect(12,y-4,272,height,'F')}
    else if(rowNo++%2===0){doc.setFillColor(...stripe);doc.rect(12,y-4,272,height,'F')}
    doc.setFont('helvetica',header||total?'bold':'normal');doc.setFontSize(header?8:7.5);
    doc.setTextColor(...(header?[255,255,255]:ink));
    cells.forEach((lines,i)=>{if(lines.length)doc.text(lines,xs[i],y)});
    doc.setTextColor(...ink);y+=height;
  }
  const pages=doc.internal.getNumberOfPages();
  for(let p=1;p<=pages;p++){doc.setPage(p);doc.setFont('helvetica','normal');doc.setFontSize(8);doc.setTextColor(100,110,125);doc.line(12,198,284,198);doc.text('Page '+p+' / '+pages,283,203,{align:'right'})}
  doc.save('aus-report-'+($('reportMonth').value||'all')+'.pdf');
}
$('exportExcel').addEventListener('click',exportExcel);
$('exportPdf').addEventListener('click',exportPdf);


function syncUsageTotal(){const q=$('usageQty').value.trim()===''?null:Number($('usageQty').value);const p=cost($('usageUnitPrice').value.trim(),q);$('usageTotalAmount').value=p?.amount==null?'':money(p.amount)}
$('usageUnitPrice').addEventListener('input',syncUsageTotal);
$('usageQty').addEventListener('input',syncUsageTotal);
function syncUsageItem(){
 const name=$('usageItem').value,measured=itemMeasured(name);$('usageUnit').value=measured?itemUnit(name):'';
 $('usageQty').closest('label').classList.toggle('hidden',!measured);
 $('usageUnit').closest('label').classList.toggle('hidden',!measured);
 $('usageQty').required=measured;
 $('usageSource').closest('.usage-source-panel').classList.toggle('hidden',!measured);
 $('usageRemarks').required=!measured;
 const active=itemRecoverable(name);$('usageRecovery').classList.toggle('hidden',!active);
 $('usageRecoveredQty').value=active?String(Number($('usageQty').value)||0):'0';syncUsageSource();
}
$('usageItem').addEventListener('change',syncUsageItem);
$('usageQty').addEventListener('input',()=>{if(itemRecoverable($('usageItem').value))$('usageRecoveredQty').value=String(Number($('usageQty').value)||0)});
function syncUsageSource(){
 $('usageImmediateFields').classList.toggle('hidden',!itemMeasured($('usageItem').value)||$('usageSource').value!=='immediate');
}
$('usageSource').addEventListener('change',syncUsageSource);
$('stockItem').addEventListener('change',()=>{$('stockUnit').value=itemUnit($('stockItem').value)});
async function createMovement(entry){const m={id:uid('mov'),...entry,createdAt:new Date().toISOString(),createdBy:currentUser?.uid||''};await persistMovement(m);await refreshServerState()}
$('stockForm').addEventListener('submit',async e=>{
 e.preventDefault();const item=$('stockItem').value,qty=Number($('stockQty').value),unit=itemUnit(item);
 if(!unit||!Number.isFinite(qty)||qty<=0)return notify('Item and positive quantity required.');
 await createMovement({type:'in',item,unit,qty,date:$('stockDate').value,remarks:$('stockRemarks').value.trim()});e.target.reset();$('stockDate').value=today();notify('Stock received.');
});
$('recoveryForm').addEventListener('submit',async e=>{
 e.preventDefault();const item=$('recoveryItem').value,qty=Number($('recoveryQty').value);
 if(!itemRecoverable(item)||!Number.isInteger(qty)||qty<=0)return notify('Choose a recoverable item and whole quantity.');
 const balance=stockSummaryData().find(x=>x.item===item)?.recoveredBalance||0;
 if(qty>balance)return notify('Insufficient recovered stock ('+balance+' available).');
 await createMovement({type:'recovered-out',item,unit:itemUnit(item),qty,date:$('recoveryDate').value,reason:$('recoveryReason').value,remarks:$('recoveryRemarks').value.trim()});e.target.reset();$('recoveryDate').value=today();notify('Recovered stock out saved.');
});
function stockSummaryData(){
 const stockRecords=stockHistoryRecords;
 return state.items.filter(i=>i.trackQuantity!==false).map(i=>{
  const item=itemName(i),unit=i.unit;
  const ins=state.movements.filter(m=>m.type==='in'&&m.item===item).reduce((n,m)=>n+Number(m.qty||0),0);
  const directIns=stockRecords.filter(r=>r.kind==='usage'&&r.item===item&&r.status!=='void'&&r.status!=='pending_details').reduce((n,r)=>n+Number(r.receivedQty||0),0);
  const outs=stockRecords.filter(r=>r.kind==='usage'&&r.item===item&&r.status!=='void'&&r.status!=='pending_details').reduce((n,r)=>n+Number(r.qty||0),0);
  const recoveredIn=stockRecords.filter(r=>r.kind==='usage'&&r.item===item&&r.status!=='void'&&r.status!=='pending_details').reduce((n,r)=>n+Number(r.recoveredQty||0),0);
  const recoveredOut=state.movements.filter(m=>m.type==='recovered-out'&&m.item===item).reduce((n,m)=>n+Number(m.qty||0),0);
  return {item,unit,ins:ins+directIns,outs,balance:ins+directIns-outs,recoveredIn,recoveredOut,recoveredBalance:recoveredIn-recoveredOut,recoverable:!!i.recoverable};
 });
}
function renderStockReports(){
 const data=stockSummaryData(),month=$('reportMonth').value,chosen=$('reportItem').value;
 const filtered=data.filter(x=>!chosen||x.item===chosen);
 // Balances are all-time; movement quantities respect the selected month.
 const tbody=filtered.map(x=>{
 const movementIns=state.movements.filter(m=>m.type==='in'&&m.item===x.item&&(!month||m.date.startsWith(month))).reduce((n,m)=>n+Number(m.qty),0);
 const ins=movementIns+stockHistoryRecords.filter(r=>r.kind==='usage'&&r.item===x.item&&r.status!=='void'&&r.status!=='pending_details'&&(!month||r.date.startsWith(month))).reduce((n,r)=>n+Number(r.receivedQty||0),0);
 const outs=stockHistoryRecords.filter(r=>r.kind==='usage'&&r.item===x.item&&r.status!=='void'&&r.status!=='pending_details'&&(!month||r.date.startsWith(month))&&(!$('reportAsset').value||r.assetId===$('reportAsset').value)).reduce((n,r)=>n+Number(r.qty),0);
 const periodStart=month?month+'-01':'';
 const opening=periodStart?(state.movements.filter(m=>m.type==='in'&&m.item===x.item&&m.date<periodStart).reduce((n,m)=>n+Number(m.qty),0)+stockHistoryRecords.filter(r=>r.kind==='usage'&&r.item===x.item&&r.status!=='void'&&r.status!=='pending_details'&&r.date<periodStart).reduce((n,r)=>n+Number(r.receivedQty||0),0))-stockHistoryRecords.filter(r=>r.kind==='usage'&&r.item===x.item&&r.status!=='void'&&r.status!=='pending_details'&&r.date<periodStart).reduce((n,r)=>n+Number(r.qty),0):0;
 // With an asset filter, show quantities for that asset, but don't label the warehouse balance as an asset balance.
 const stockBalance=$('reportAsset').value?'—':opening+ins-stockHistoryRecords.filter(r=>r.kind==='usage'&&r.item===x.item&&r.status!=='void'&&r.status!=='pending_details'&&(!month||r.date.startsWith(month))).reduce((n,r)=>n+Number(r.qty),0);
 return '<tr><td>'+esc(x.item)+'</td><td>'+esc(x.unit)+'</td><td>'+($('reportAsset').value?'—':opening)+'</td><td>'+ins+'</td><td>'+outs+'</td><td>'+stockBalance+'</td></tr>';
 }).join('');
 $('stockSummary').innerHTML='<table><thead><tr><th>Item</th><th>Unit</th><th>Opening</th><th>In</th><th>Usage Out</th><th>Closing</th></tr></thead><tbody>'+tbody+'</tbody></table>';
 $('recoverySummary').innerHTML='<table><thead><tr><th>Recovered Item</th><th>Unit</th><th>Total In</th><th>Total Out</th><th>Balance</th></tr></thead><tbody>'+filtered.filter(x=>x.recoverable).map(x=>'<tr><td>'+esc(x.item)+'</td><td>'+esc(x.unit)+'</td><td>'+x.recoveredIn+'</td><td>'+x.recoveredOut+'</td><td>'+x.recoveredBalance+'</td></tr>').join('')+'</tbody></table><p class="muted">Recovered totals are all-time warehouse balances.</p>';
}
function renderMovementHistory(){
 $('movementTable').innerHTML='<table><thead><tr><th>Date</th><th>Movement</th><th>Item</th><th>Quantity</th><th>Remarks</th></tr></thead><tbody>'+state.movements.slice().sort((a,b)=>b.date.localeCompare(a.date)).map(m=>'<tr><td>'+esc(m.date)+'</td><td>'+esc(m.type==='in'?'Stock In':'Recovered Out · '+(m.reason||''))+'</td><td>'+esc(m.item)+'</td><td>'+esc(m.qty+' '+m.unit)+'</td><td class="remarks-cell">'+esc(m.remarks||'—')+'</td></tr>').join('')+'</tbody></table>';
}

function renderAll(){renderSelectors();renderDefinitions();renderAssets();renderMetaFields();renderAssetProfiles();renderRecords();renderReports();renderMovementHistory();$('itemUnit').innerHTML=optionList(state.units,'Select unit')}

$('assetTypeSelect').addEventListener('change',renderMetaFields);
$('recordApply').addEventListener('click',()=>{recordsPage=0;renderRecords()});
$('recordMonth').addEventListener('change',()=>{recordsPage=0;syncSelectedMonths()});
$('recordYear').addEventListener('change',()=>{if($('recordPeriod').value==='month')$('recordMonth').value=$('recordYear').value+'-'+$('recordMonth').value.slice(5);recordsPage=0;syncSelectedMonths()});
$('recordPeriod').addEventListener('change',()=>{showPeriodFields('record');recordsPage=0;syncSelectedMonths()});
$('recordAsset').addEventListener('change',()=>{recordsPage=0;renderRecords()});
$('recordKind').addEventListener('change',()=>{recordsPage=0;renderRecords()});
$('recordsPaging').addEventListener('click',e=>{
 const direction=e.target.closest('[data-page]')?.dataset.page;
 if(direction==='prev'&&recordsPage>0){recordsPage--;renderRecords()}
 if(direction==='next'){recordsPage++;renderRecords()}
});
$('recordSort').addEventListener('change',()=>{recordsPage=0;renderRecords()});
$('reportMonth').addEventListener('change',syncSelectedMonths);
$('reportYear').addEventListener('change',()=>{if($('reportPeriod').value==='month')$('reportMonth').value=$('reportYear').value+'-'+$('reportMonth').value.slice(5);syncSelectedMonths()});
$('reportPeriod').addEventListener('change',()=>{showPeriodFields('report');syncSelectedMonths()});
$('reportKind').addEventListener('change',renderReports);
$('reportAsset').addEventListener('change',renderReports);
$('reportItem').addEventListener('change',renderReports);

$('recordsTable').addEventListener('click',e=>{
  if(e.target.id==='selectVisibleRecords'){document.querySelectorAll('#recordsTable .record-select').forEach(x=>x.checked=e.target.checked);updateBulkReview();return}
  if(e.target.classList.contains('record-select')){updateBulkReview();return}
  const row=e.target.closest('tr[data-record-id]');if(!row)return;
  if(e.target.closest('[data-complete]')){openCompletion(row.dataset.recordId);return}
  if(e.target.closest('[data-correct]')){openCorrection(row.dataset.recordId);return}
  const statusBtn=e.target.closest('[data-status]');if(statusBtn)setRecordStatus(row.dataset.recordId,statusBtn.dataset.status);
});
$('markSelectedChecked').addEventListener('click',markSelectedChecked);

let completingId='';
function openCompletion(id){
 const r=state.records.find(x=>x.id===id);
 if(!r||r.status!=='pending_details'||!(currentRole==='manager'||r.createdBy===currentUser?.uid))return;
 completingId=id;
 $('completeUnitPriceWrap').classList.toggle('hidden',r.kind!=='usage');
 $('completeUnitPrice').value=r.unitPrice??'';
 $('completeDescription').textContent=(r.kind==='usage'?r.item:'Work')+' · '+r.date;
 $('completeUnitLabel').textContent=r.kind==='usage'?'Unit: '+r.unit:'Measure: '+r.measure;
 $('completeRecoveredWrap').classList.toggle('hidden',r.kind!=='usage'||!itemRecoverable(r.item));
 $('completeRecovered').value='0';
 $('completeQty').value='';
 $('completeDialog').showModal();
}
$('completeCancel').addEventListener('click',()=>$('completeDialog').close());
$('completeForm').addEventListener('submit',async e=>{
 e.preventDefault();
 const r=state.records.find(x=>x.id===completingId),qty=Number($('completeQty').value);
 if(!r||r.status!=='pending_details'||!(currentRole==='manager'||r.createdBy===currentUser?.uid))return;
 if(!Number.isFinite(qty)||qty<=0)return notify('Enter a positive quantity.');
 const next={...r,qty,status:'pending',completedBy:currentUser.uid,completedAt:new Date().toISOString()};
 if(r.kind==='usage'){
  const price=cost($('completeUnitPrice').value.trim(),qty);
  if(price===null)return notify('Invalid unit price.');
  next.unitPrice=price.unitPrice;next.amount=price.amount;
  next.receivedQty=r.stockSource==='immediate'?qty:0;
  next.recoveredQty=itemRecoverable(r.item)?Number($('completeRecovered').value||0):0;
  if(!Number.isInteger(next.recoveredQty)||next.recoveredQty<0||next.recoveredQty>qty)return notify('Recovered quantity must be a whole number from 0 to usage quantity.');
  if(r.stockSource==='warehouse'){
   const available=stockSummaryData().find(x=>x.item===r.item)?.balance||0;
   if(qty>available&&!await uiConfirm('Usage exceeds recorded stock ('+available+' '+r.unit+'). Continue?'))return;
  }
 }
 await persistRecord(next);
 $('completeDialog').close();await refreshServerState();notify('Entry completed and awaiting Manager review.');
});

$('correctionForm').addEventListener('submit',saveCorrection);
$('correctionClose').addEventListener('click',()=>$('correctionDialog').close());
$('correctionCancel').addEventListener('click',()=>$('correctionDialog').close());

$('assetTypeForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const name=$('assetTypeName').value.trim();
  const fields=$('assetTypeFields').value.split(',').map(x=>x.trim()).filter(Boolean);
  const t={id:uid('type'),name,fields};
  state.assetTypes.push(t);
  await persistAssetType(t);
  e.target.reset();
  save();
});
$('itemForm').addEventListener('submit',async e=>{
  e.preventDefault();const name=$('itemName').value.trim(),unit=$('itemUnit').value;
  const trackQuantity=$('itemTrackQuantity').checked;
  if(!name||(trackQuantity&&!unit))return notify('Name and unit are required for tracked items.');
  if(state.items.some(i=>itemName(i).toLowerCase()===name.toLowerCase()))return notify('Item already exists.');
  state.items.push({name,unit:trackQuantity?unit:'',trackQuantity,recoverable:trackQuantity&&$('itemRecoverable').checked});await persistSettings();e.target.reset();save();
});
$('unitForm').addEventListener('submit',e=>addSimple(e,'unitName','units'));
$('measureForm').addEventListener('submit',e=>addSimple(e,'measureName','measures'));
async function addSimple(e,input,key){
  e.preventDefault();
  const v=$(input).value.trim();
  if(v&&!state[key].includes(v)){
    state[key].push(v);
    await persistSettings();
  }
  e.target.reset();
  save();
}

document.addEventListener('click',async e=>{
  const nameBtn=e.target.closest('[data-edit-type-name]');
  if(nameBtn){
    const t=state.assetTypes.find(x=>x.id===nameBtn.dataset.editTypeName);if(!t)return;
    const name=await uiPrompt('Asset Type name',t.name);
    if(name===null)return;
    const cleanName=name.trim();
    if(!cleanName)return notify('Asset Type name cannot be empty.');
    t.name=cleanName;
    await persistAssetType(t);
    save();
    return;
  }

  const metaBtn=e.target.closest('[data-edit-type-meta]');
  if(metaBtn){
    const t=state.assetTypes.find(x=>x.id===metaBtn.dataset.editTypeMeta);if(!t)return;
    const fieldsText=await uiPrompt('Metadata fields for '+t.name+' (comma separated)',t.fields.join(', '));
    if(fieldsText===null)return;
    const newFields=fieldsText.split(',').map(x=>x.trim()).filter(Boolean);
    if(!newFields.length)return notify('Add at least one metadata field.');
    const oldFields=[...t.fields];
    state.assets.filter(a=>a.typeId===t.id).forEach(a=>{
      const oldMeta=a.meta||{},next={};
      newFields.forEach((field,i)=>{
        const sameNameValue=oldMeta[field];
        const oldField=oldFields[i];
        next[field]=sameNameValue!==undefined?sameNameValue:(oldField!==undefined?(oldMeta[oldField]??''):'');
      });
      a.meta=next;
    });
    t.fields=newFields;
    await persistAssetType(t);
    for(const a of state.assets.filter(a=>a.typeId===t.id))await persistAsset(a);
    save();
    return;
  }

  const itemBtn=e.target.closest('[data-edit-item]');
  if(itemBtn){
    const i=state.items[Number(itemBtn.dataset.editItem)];if(!i)return;
    const hasHistory=state.records.some(r=>r.item===itemName(i))||state.movements.some(m=>m.item===itemName(i));
    const result=await editUsageItem(i,hasHistory);
    if(!result)return;
    if(state.items.some(j=>j!==i&&itemName(j).toLowerCase()===result.name.toLowerCase()))return notify('Item already exists.');
    i.name=result.name;i.unit=result.unit;i.recoverable=result.recoverable;i.trackQuantity=result.trackQuantity;
    try{await persistSettings();save();notify('Usage Item updated.')}catch(err){await refreshServerState();notify('Save failed: '+(err.message||err))}
    return;
  }
  const simpleBtn=e.target.closest('[data-edit-simple]');
  if(simpleBtn){
    const key=simpleBtn.dataset.editSimple,index=Number(simpleBtn.dataset.index);
    const current=state[key]?.[index];
    if(current===undefined)return;
    const value=await uiPrompt('Edit '+(key==='items'?'Usage Item':key==='units'?'Unit':'Work Measure'),current);
    if(value===null)return;
    const clean=value.trim();
    if(!clean)return notify('Value cannot be empty.');
    if(state[key].some((v,i)=>i!==index&&v.toLowerCase()===clean.toLowerCase()))return notify('That value already exists.');
    if(key==='units'&&state.items.some(i=>i.unit===current))return notify('Unit is assigned to an item. Edit items first.');
    state[key][index]=clean;
    await persistSettings();
    save();
    return;
  }

  const a=e.target.closest('[data-delete-asset]');
  if(a){
    const id=a.dataset.deleteAsset;
    if(state.records.some(r=>r.assetId===id)){notify('This asset already has records and cannot be removed.');return}
    await fb.deleteDoc(fb.doc(fb.db,'assets',id));
    state.assets=state.assets.filter(x=>x.id!==id);
    save();
  }
});

$('assetForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const type=state.assetTypes.find(x=>x.id===$('assetTypeSelect').value); if(!type)return;
  const meta={}; document.querySelectorAll('#assetMetaFields [data-meta-index]').forEach(inp=>meta[type.fields[Number(inp.dataset.metaIndex)]]=inp.value.trim());
  const a={id:uid('asset'),typeId:type.id,name:$('assetName').value.trim(),meta};
  state.assets.push(a);
  await persistAsset(a);
  e.target.reset();
  save();
});
$('usageForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const item=$('usageItem').value,qtyText=$('usageQty').value,qty=qtyText===''?null:Number(qtyText),unit=itemUnit(item);
  const measured=itemMeasured(item);
  if(measured&&(!unit||(qty!==null&&(!Number.isFinite(qty)||qty<=0))))return notify('Select a configured item and positive quantity.');
  if(!measured&&!$('usageRemarks').value.trim())return notify('Purpose / Remarks is required for non-quantity items.');
  const incomplete=measured&&qty===null;
  const returned=!incomplete&&itemRecoverable(item)?Number($('usageRecoveredQty').value||0):0;
  if(!Number.isFinite(returned)||!Number.isInteger(returned)||returned<0||(!incomplete&&returned>qty))return notify('Recovered quantity must be between zero and usage quantity.');
  // Inform users when no sufficient stock has been entered.
  const price=cost($('usageUnitPrice').value.trim(),qty);
  if(price===null)return notify('Invalid unit price.');
  const immediate=measured&&$('usageSource').value==='immediate';
  const receivedQty=immediate&&!incomplete?qty:0;
  const available=(stockSummaryData().find(x=>x.item===item)?.balance||0)+receivedQty;
  if(measured&&!incomplete&&qty>available&&!await uiConfirm('Usage exceeds recorded stock ('+available+' '+unit+'). Save anyway?'))return;
  const r={id:uid('rec'),kind:'usage',date:$('usageDate').value,assetId:$('usageAsset').value,item,qty:measured?qty:null,unit:measured?unit:'',trackQuantity:measured,receivedQty,unitPrice:price.unitPrice,amount:price.amount,stockSource:measured?(immediate?'immediate':'warehouse'):'none',recoveredQty:returned,operator:$('usageOperator').value.trim(),mechanic:$('usageMechanic').value.trim(),supervisor:$('usageSupervisor').value.trim(),remarks:$('usageRemarks').value.trim(),status:incomplete?'pending_details':'pending',createdBy:currentUser?.uid||'',createdAt:new Date().toISOString()};
  await persistRecord(r);
  await refreshServerState();
  e.target.reset(); $('usageDate').value=today();syncUsageItem();syncUsageSource();save(); notify(immediate?'Immediate stock receipt and usage saved.':'Usage record saved.');
});
$('workForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const workQty=$('workQty').value===''?null:Number($('workQty').value);
  if(workQty!==null&&(!Number.isFinite(workQty)||workQty<=0))return notify('Enter a positive quantity or leave it blank.');
  const r={id:uid('rec'),kind:'work',date:$('workDate').value,assetId:$('workAsset').value,measure:$('workMeasure').value,qty:workQty,job:$('workJob').value.trim(),operator:$('workPerformedBy').value.trim(),mechanic:$('workMechanic').value.trim(),supervisor:$('workSupervisor').value.trim(),remarks:$('workRemarks').value.trim(),status:workQty===null?'pending_details':'pending',createdBy:currentUser?.uid||'',createdAt:new Date().toISOString()};
  await persistRecord(r);
  await refreshServerState();
  e.target.reset(); $('workDate').value=today(); save(); notify('Work record saved.');
});

showPeriodFields('record');showPeriodFields('report');
renderAll();
showLogin();
initFirebase().catch(err=>{
  $('setupBanner').classList.remove('hidden');
  $('setupBanner').textContent='Firebase startup error: '+(err.message||err);
  showLogin();
});
window.addEventListener('offline',()=>{$('setupBanner').textContent='AUS requires an internet connection. Entries are disabled offline.';$('setupBanner').classList.remove('hidden');document.querySelectorAll('#shell form button[type="submit"]').forEach(b=>b.disabled=true)});
window.addEventListener('online',()=>{document.querySelectorAll('#shell form button[type="submit"]').forEach(b=>b.disabled=false);$('setupBanner').classList.add('hidden');if(currentUser)refreshServerState().catch(err=>{$('setupBanner').textContent='Firestore refresh failed: '+(err.message||err);$('setupBanner').classList.remove('hidden');console.error(err)})});
window.addEventListener('unhandledrejection',e=>{if(e.reason?.message){$('setupBanner').textContent='Server operation failed: '+e.reason.message;$('setupBanner').classList.remove('hidden')}});
