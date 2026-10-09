import { firebaseConfig } from "./firebase-config.js";

const fb={};
let currentUser=null;
let currentRole="";

const KEY='sinmatu-aus-v1';
const defaults={
  assetTypes:[
    {id:'type-lorry',name:'Lorry',fields:['Plate Number','Make / Model']},
    {id:'type-machine',name:'Machine',fields:['Machine ID','Make / Model']}
  ],
  items:['Fuel','Battery','Hydraulic','Rimula'],
  units:['drum','litre','pc'],
  measures:['hour','trip','km','load','tonne'],
  assets:[],
  records:[]
};
let state=structuredClone(defaults);
function save(){
  localStorage.setItem(KEY,JSON.stringify(state));
  renderAll();
}
function recordCollection(r){return r.kind==='usage'?'usageRecords':'workRecords'}
async function persistSettings(){
  await fb.setDoc(fb.doc(fb.db,'settings','global'),{
    items:state.items,
    units:state.units,
    measures:state.measures,
    updatedAt:new Date().toISOString(),
    updatedBy:currentUser?.uid||''
  },{merge:true});
}
async function persistAssetType(t){
  await fb.setDoc(fb.doc(fb.db,'assetTypes',t.id),{name:t.name,fields:t.fields},{merge:true});
}
async function persistAsset(a){
  await fb.setDoc(fb.doc(fb.db,'assets',a.id),{
    typeId:a.typeId,
    name:a.name,
    meta:a.meta||{}
  },{merge:true});
}
async function persistRecord(r){
  const data={...r};delete data.id;delete data.kind;
  await fb.setDoc(fb.doc(fb.db,recordCollection(r),r.id),data,{merge:true});
}
async function loadFirebaseState(){
  const [typeSnap,assetSnap,usageSnap,workSnap,settingsSnap]=await Promise.all([
    fb.getDocs(fb.collection(fb.db,'assetTypes')),
    fb.getDocs(fb.collection(fb.db,'assets')),
    fb.getDocs(fb.collection(fb.db,'usageRecords')),
    fb.getDocs(fb.collection(fb.db,'workRecords')),
    fb.getDoc(fb.doc(fb.db,'settings','global'))
  ]);
  state={
    assetTypes:typeSnap.docs.map(d=>({id:d.id,...d.data()})),
    items:settingsSnap.exists()&&Array.isArray(settingsSnap.data().items)?settingsSnap.data().items:[],
    units:settingsSnap.exists()&&Array.isArray(settingsSnap.data().units)?settingsSnap.data().units:[],
    measures:settingsSnap.exists()&&Array.isArray(settingsSnap.data().measures)?settingsSnap.data().measures:[],
    assets:assetSnap.docs.map(d=>({id:d.id,...d.data()})),
    records:[
      ...usageSnap.docs.map(d=>({id:d.id,kind:'usage',...d.data()})),
      ...workSnap.docs.map(d=>({id:d.id,kind:'work',...d.data()}))
    ]
  };
}
async function seedFirebaseDefaults(){
  if(currentRole!=='manager')return;
  const typeSnap=await fb.getDocs(fb.collection(fb.db,'assetTypes'));
  if(typeSnap.empty){
    for(const t of defaults.assetTypes)await persistAssetType(t);
  }
  const settingsRef=fb.doc(fb.db,'settings','global');
  const settingsSnap=await fb.getDoc(settingsRef);
  if(!settingsSnap.exists()){
    state.items=[...defaults.items];state.units=[...defaults.units];state.measures=[...defaults.measures];
    await persistSettings();
  }
}
async function migrateLocalDataOnce(){
  const marker=KEY+'-firebase-migrated';
  if(localStorage.getItem(marker)==='1')return;
  let local=null;
  try{local=JSON.parse(localStorage.getItem(KEY)||'null')}catch{}
  if(!local){localStorage.setItem(marker,'1');return}
  if(currentRole==='manager'){
    if(Array.isArray(local.assetTypes))for(const t of local.assetTypes)await persistAssetType(t);
    if(Array.isArray(local.items))state.items=[...local.items];
    if(Array.isArray(local.units))state.units=[...local.units];
    if(Array.isArray(local.measures))state.measures=[...local.measures];
    if(Array.isArray(local.items)||Array.isArray(local.units)||Array.isArray(local.measures))await persistSettings();
    if(Array.isArray(local.assets))for(const a of local.assets)await persistAsset(a);
  }
  if(Array.isArray(local.records)){
    for(const r of local.records){
      if(currentRole==='manager'||(r.createdBy===currentUser?.uid&&(r.status||'pending')==='pending')){
        await persistRecord(r);
      }
    }
  }
  localStorage.setItem(marker,'1');
}
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const uid=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
const today=()=>new Date().toISOString().slice(0,10);
$('usageDate').value=today(); $('workDate').value=today();
const currentMonth=today().slice(0,7);
$('recordMonth').value=currentMonth;
$('reportMonth').value=currentMonth;

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
  Object.assign(fb,U,F);
  U.onAuthStateChanged(fb.auth,async user=>{
    if(!user){currentUser=null;currentRole='';showLogin();return}
    try{
      const snap=await F.getDoc(F.doc(fb.db,'users',user.uid));
      if(!snap.exists())throw Error('Account is not authorised for this system.');
      const profile=snap.data();
      const role=profile.role||'';
      const status=profile.status||'';
      if(profile.uid && profile.uid!==user.uid)throw Error('Account profile does not match this signed-in user.');
      if(!['manager','staff'].includes(role))throw Error('Account role is missing or not authorised.');
      if(status!=='active')throw Error('Account is not active.');
      currentUser=user; currentRole=role;
      await migrateLocalDataOnce();
      await seedFirebaseDefaults();
      await loadFirebaseState();
      save();
      showShell();
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
  $('recordAsset').innerHTML=allAssets;
  $('reportAsset').innerHTML=allAssets;
  $('reportItem').innerHTML='<option value="">All Items</option>'+state.items.map(i=>'<option value="'+esc(i)+'">'+esc(i)+'</option>').join('');
  $('usageItem').innerHTML=optionList(state.items,'Select item');
  $('usageUnit').innerHTML=optionList(state.units,'Select unit');
  $('workMeasure').innerHTML=optionList(state.measures,'Select measure');
  $('assetTypeSelect').innerHTML=optionList(state.assetTypes,'Select asset type',t=>({value:t.id,label:t.name}));
}
function renderDefinitions(){
  $('assetTypeList').innerHTML=state.assetTypes.length?state.assetTypes.map(t=>
    '<div class="stack-row editable-row"><div><b>'+esc(t.name)+'</b><small>'+esc(t.fields.join(' · ')||'No metadata fields')+'</small></div>'+
    '<div class="definition-actions"><button type="button" class="edit-link" data-edit-type-name="'+esc(t.id)+'">Edit Name</button>'+
    '<button type="button" class="edit-link" data-edit-type-meta="'+esc(t.id)+'">Edit Metadata</button></div></div>'
  ).join(''):'<div class="empty">No asset types yet.</div>';
  renderChips('itemList',state.items,'items');
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
function recordDetail(r){
  return r.kind==='usage'?r.item+' · '+r.qty+' '+r.unit:r.measure+' · '+r.qty;
}
function recordReference(r){
  return r.kind==='usage'?[r.mechanic&&'Mechanic: '+r.mechanic,r.supervisor&&'Supervisor: '+r.supervisor].filter(Boolean).join(' · '):(r.job||r.remarks||'');
}
function recordsTable(records){
  if(!records.length)return '<div class="empty">No matching records.</div>';
  const manager=currentRole==='manager';
  const selectHead=manager?'<th class="select-col"><input id="selectVisibleRecords" type="checkbox" aria-label="Select reviewable records"></th>':'';
  const reviewHead=manager?'<th>Review</th>':'';
  return '<table><thead><tr>'+selectHead+'<th>Date</th><th>Asset</th><th>Type</th><th>Detail</th><th>Status</th><th>Reference / Sign</th>'+reviewHead+'</tr></thead><tbody>'+records.map(r=>{
    const a=state.assets.find(x=>x.id===r.assetId);
    const status=r.status||'pending';
    const reviewable=status!=='checked'&&status!=='void';
    const selectCell=manager?'<td class="select-col">'+(reviewable?'<input class="record-select" type="checkbox" value="'+esc(r.id)+'">':'')+'</td>':'';
    let reviewCell='';
    if(manager){
      const checked=status==='checked'?'':'<button class="record-action" data-status="checked">Mark Checked</button>';
      const correct='<button class="record-action" data-correct="1">Correct Entry</button>';
      const correction=status==='correction'?'':'<button class="record-action" data-status="correction">Correction Required</button>';
      const voidBtn='<button class="record-action danger-link" data-status="void">Void Entry</button>';
      reviewCell='<td><div class="record-actions">'+checked+correct+correction+voidBtn+'</div></td>';
    }
    return '<tr data-record-id="'+esc(r.id)+'">'+selectCell+'<td>'+esc(r.date)+'</td><td>'+esc(a?a.name:'Removed asset')+'</td><td><span class="record-kind '+r.kind+'">'+esc(r.kind==='usage'?'Usage':'Work')+'</span></td><td>'+esc(recordDetail(r))+'</td><td>'+esc(status)+'</td><td>'+esc(recordReference(r)||'—')+'</td>'+reviewCell+'</tr>';
  }).join('')+'</tbody></table>';
}
function filteredRecords(month,assetId,kind){
  const dir=$('recordSort')?.value==='asc'?1:-1;
  return state.records.filter(r=>(!month||r.date.startsWith(month))&&(!assetId||r.assetId===assetId)&&(!kind||r.kind===kind)).sort((a,b)=>dir*a.date.localeCompare(b.date));
}
function renderRecords(){
  const rows=filteredRecords($('recordMonth').value,$('recordAsset').value,$('recordKind').value);
  $('recordCount').textContent=rows.length+' shown';
  $('recordsTable').innerHTML=recordsTable(rows);
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
function setRecordStatus(id,status){
  const r=state.records.find(x=>x.id===id); if(!r)return;
  r.status=status;
  r.reviewedBy=currentUser?.uid||'';
  r.reviewedAt=new Date().toISOString();
  save();
}
function markSelectedChecked(){
  [...document.querySelectorAll('#recordsTable .record-select:checked')].forEach(x=>{
    const r=state.records.find(v=>v.id===x.value);
    if(r){r.status='checked';r.reviewedBy=currentUser?.uid||'';r.reviewedAt=new Date().toISOString()}
  });
  save();
}
function openCorrection(id){
  const r=state.records.find(x=>x.id===id);if(!r)return;
  $('correctionRecordId').value=id;
  $('correctionOriginal').textContent=(r.kind==='usage'?'Usage':'Work')+' · '+r.date+' · '+recordDetail(r);
  $('correctionNote').value=r.correctionNote||'';
  if(r.kind==='usage'){
    $('correctionFields').innerHTML='<div class="grid three"><label>Quantity<input id="correctQty" type="number" min="0" step="0.01" value="'+esc(r.qty)+'" required></label><label>Unit<select id="correctUnit">'+state.units.map(u=>'<option '+(u===r.unit?'selected':'')+'>'+esc(u)+'</option>').join('')+'</select></label><label>Item<select id="correctItem">'+state.items.map(i=>'<option '+(i===r.item?'selected':'')+'>'+esc(i)+'</option>').join('')+'</select></label></div>';
  }else{
    $('correctionFields').innerHTML='<div class="grid two"><label>Quantity<input id="correctQty" type="number" min="0" step="0.01" value="'+esc(r.qty)+'" required></label><label>Work measure<select id="correctMeasure">'+state.measures.map(m=>'<option '+(m===r.measure?'selected':'')+'>'+esc(m)+'</option>').join('')+'</select></label></div>';
  }
  $('correctionDialog').showModal();
}
function saveCorrection(e){
  e.preventDefault();
  const r=state.records.find(x=>x.id===$('correctionRecordId').value);if(!r)return;
  r.original=r.original||structuredClone(r);
  r.qty=Number($('correctQty').value);
  if(r.kind==='usage'){r.unit=$('correctUnit').value;r.item=$('correctItem').value}else r.measure=$('correctMeasure').value;
  r.correctionNote=$('correctionNote').value.trim();
  r.correctedBy=currentUser?.uid||'';
  r.correctedAt=new Date().toISOString();
  r.status='checked';
  $('correctionDialog').close();
  save();
}
function reportRows(){
  const item=$('reportItem').value;
  return state.records
    .filter(r=>(!$('reportMonth').value||r.date.startsWith($('reportMonth').value)))
    .filter(r=>(!$('reportAsset').value||r.assetId===$('reportAsset').value))
    .filter(r=>r.status!=='void')
    .filter(r=>!item||(r.kind==='usage'&&r.item===item));
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
  const label=kind==='usage'?'Usage':'Work';
  return '<div class="report-kind-section"><h4>'+label+'</h4><table><thead><tr><th>Date</th><th>Type</th><th>Detail</th><th>Reference / Sign</th></tr></thead><tbody>'+records.map(r=>
    '<tr><td>'+esc(r.date)+'</td><td><span class="record-kind '+r.kind+'">'+esc(label)+'</span></td><td>'+esc(recordDetail(r))+'</td><td>'+esc(recordReference(r)||'—')+'</td></tr>'
  ).join('')+'</tbody></table></div>';
}
function reportTable(records){
  if(!records.length)return '<div class="empty">No matching report records.</div>';
  const groups=reportAssetGroups(records);
  return groups.map(g=>
    '<section class="report-asset-group"><h3>'+esc(g.name)+'</h3>'+
    reportRowsTable(g.usage,'usage')+
    reportRowsTable(g.work,'work')+
    '</section>'
  ).join('');
}
function renderReports(){
  if(!$('reportTable'))return;
  const rows=reportRows();
  const usage=rows.filter(r=>r.kind==='usage');
  const work=rows.filter(r=>r.kind==='work');
  const assetCount=new Set(rows.map(r=>r.assetId)).size;
  $('reportSummary').innerHTML='<div class="summary-grid"><div class="summary-card"><span class="muted">Usage records</span><b>'+usage.length+'</b></div><div class="summary-card"><span class="muted">Work records</span><b>'+work.length+'</b></div><div class="summary-card"><span class="muted">Assets involved</span><b>'+assetCount+'</b></div><div class="summary-card"><span class="muted">Total records</span><b>'+rows.length+'</b></div></div>';
  $('reportTable').innerHTML=reportTable(rows);
}
function reportMatrix(){
  const rows=reportRows();
  const aoa=[['Asset Usage System Report'],['Month',$('reportMonth').value||'All'],['Asset',$('reportAsset').value?(state.assets.find(a=>a.id===$('reportAsset').value)?.name||'Selected'):'All Assets'],['Item',$('reportItem').value||'All Items'],[]];
  const groups=reportAssetGroups(rows);
  groups.forEach((g,gi)=>{
    aoa.push([g.name]);
    if(g.usage.length){
      aoa.push(['Usage']);
      aoa.push(['Date','Type','Detail','Reference / Sign']);
      g.usage.forEach(r=>aoa.push([r.date,'Usage',recordDetail(r),recordReference(r)||'']));
    }
    if(g.work.length){
      aoa.push(['Work']);
      aoa.push(['Date','Type','Detail','Reference / Sign']);
      g.work.forEach(r=>aoa.push([r.date,'Work',recordDetail(r),recordReference(r)||'']));
    }
    if(gi<groups.length-1)aoa.push([]);
  });
  return aoa;
}
async function exportExcel(){
  const XLSX=await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs');
  const ws=XLSX.utils.aoa_to_sheet(reportMatrix());
  ws['!cols']=[{wch:22},{wch:16},{wch:30},{wch:42}];
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'Report');
  XLSX.writeFile(wb,'aus-report-'+($('reportMonth').value||'all')+'.xlsx');
}
async function loadScript(src){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=reject;document.head.appendChild(s)})}
async function exportPdf(){
  await loadScript('https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js');
  const {jsPDF}=window.jspdf,doc=new jsPDF({orientation:'landscape',unit:'mm',format:'a4'}),rows=reportMatrix();
  let y=14;doc.setFontSize(14);doc.text('Asset Usage System Report',14,y);y+=8;doc.setFontSize(8);
  const xs=[14,52,90,155];
  rows.slice(1).forEach(row=>{if(y>190){doc.addPage();y=14}row.forEach((v,i)=>{if(v!==undefined&&v!==null&&v!=='')doc.text(String(v).slice(0,42),xs[i]||14,y)});y+=6});
  doc.save('aus-report-'+($('reportMonth').value||'all')+'.pdf');
}
$('exportExcel').addEventListener('click',exportExcel);
$('exportPdf').addEventListener('click',exportPdf);

function renderAll(){renderSelectors();renderDefinitions();renderAssets();renderMetaFields();renderAssetProfiles();renderRecords();renderReports()}

$('assetTypeSelect').addEventListener('change',renderMetaFields);
$('recordApply').addEventListener('click',renderRecords);
$('recordSort').addEventListener('change',renderRecords);
$('reportMonth').addEventListener('change',renderReports);
$('reportAsset').addEventListener('change',renderReports);
$('reportItem').addEventListener('change',renderReports);

$('recordsTable').addEventListener('click',e=>{
  if(e.target.id==='selectVisibleRecords'){document.querySelectorAll('#recordsTable .record-select').forEach(x=>x.checked=e.target.checked);updateBulkReview();return}
  if(e.target.classList.contains('record-select')){updateBulkReview();return}
  const row=e.target.closest('tr[data-record-id]');if(!row)return;
  if(e.target.closest('[data-correct]')){openCorrection(row.dataset.recordId);return}
  const statusBtn=e.target.closest('[data-status]');if(statusBtn)setRecordStatus(row.dataset.recordId,statusBtn.dataset.status);
});
$('markSelectedChecked').addEventListener('click',markSelectedChecked);
$('correctionForm').addEventListener('submit',saveCorrection);
$('correctionClose').addEventListener('click',()=>$('correctionDialog').close());
$('correctionCancel').addEventListener('click',()=>$('correctionDialog').close());

$('assetTypeForm').addEventListener('submit',e=>{
  e.preventDefault();
  const name=$('assetTypeName').value.trim();
  const fields=$('assetTypeFields').value.split(',').map(x=>x.trim()).filter(Boolean);
  state.assetTypes.push({id:uid('type'),name,fields}); e.target.reset(); save();
});
$('itemForm').addEventListener('submit',e=>addSimple(e,'itemName','items'));
$('unitForm').addEventListener('submit',e=>addSimple(e,'unitName','units'));
$('measureForm').addEventListener('submit',e=>addSimple(e,'measureName','measures'));
function addSimple(e,input,key){e.preventDefault();const v=$(input).value.trim();if(v&&!state[key].includes(v))state[key].push(v);e.target.reset();save()}

document.addEventListener('click',e=>{
  const nameBtn=e.target.closest('[data-edit-type-name]');
  if(nameBtn){
    const t=state.assetTypes.find(x=>x.id===nameBtn.dataset.editTypeName);if(!t)return;
    const name=prompt('Asset Type name',t.name);
    if(name===null)return;
    const cleanName=name.trim();
    if(!cleanName)return alert('Asset Type name cannot be empty.');
    t.name=cleanName;
    save();
    return;
  }

  const metaBtn=e.target.closest('[data-edit-type-meta]');
  if(metaBtn){
    const t=state.assetTypes.find(x=>x.id===metaBtn.dataset.editTypeMeta);if(!t)return;
    const fieldsText=prompt('Metadata fields for '+t.name+' (comma separated)',t.fields.join(', '));
    if(fieldsText===null)return;
    const newFields=fieldsText.split(',').map(x=>x.trim()).filter(Boolean);
    if(!newFields.length)return alert('Add at least one metadata field.');
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
    save();
    return;
  }

  const simpleBtn=e.target.closest('[data-edit-simple]');
  if(simpleBtn){
    const key=simpleBtn.dataset.editSimple,index=Number(simpleBtn.dataset.index);
    const current=state[key]?.[index];
    if(current===undefined)return;
    const value=prompt('Edit '+(key==='items'?'Usage Item':key==='units'?'Unit':'Work Measure'),current);
    if(value===null)return;
    const clean=value.trim();
    if(!clean)return alert('Value cannot be empty.');
    if(state[key].some((v,i)=>i!==index&&v.toLowerCase()===clean.toLowerCase()))return alert('That value already exists.');
    state[key][index]=clean;
    save();
    return;
  }

  const a=e.target.closest('[data-delete-asset]');
  if(a){const id=a.dataset.deleteAsset;if(state.records.some(r=>r.assetId===id)){alert('This asset already has records and cannot be removed.');return}state.assets=state.assets.filter(x=>x.id!==id);save()}
});

$('assetForm').addEventListener('submit',e=>{
  e.preventDefault();
  const type=state.assetTypes.find(x=>x.id===$('assetTypeSelect').value); if(!type)return;
  const meta={}; document.querySelectorAll('#assetMetaFields [data-meta-index]').forEach(inp=>meta[type.fields[Number(inp.dataset.metaIndex)]]=inp.value.trim());
  state.assets.push({id:uid('asset'),typeId:type.id,name:$('assetName').value.trim(),meta});
  e.target.reset(); save();
});
$('usageForm').addEventListener('submit',e=>{
  e.preventDefault();
  state.records.push({id:uid('rec'),kind:'usage',date:$('usageDate').value,assetId:$('usageAsset').value,item:$('usageItem').value,qty:Number($('usageQty').value),unit:$('usageUnit').value,mechanic:$('usageMechanic').value.trim(),supervisor:$('usageSupervisor').value.trim(),remarks:$('usageRemarks').value.trim(),status:'pending',createdBy:currentUser?.uid||'',createdAt:new Date().toISOString()});
  e.target.reset(); $('usageDate').value=today(); save(); alert('Usage record saved.');
});
$('workForm').addEventListener('submit',e=>{
  e.preventDefault();
  state.records.push({id:uid('rec'),kind:'work',date:$('workDate').value,assetId:$('workAsset').value,measure:$('workMeasure').value,qty:Number($('workQty').value),job:$('workJob').value.trim(),remarks:$('workRemarks').value.trim(),status:'pending',createdBy:currentUser?.uid||'',createdAt:new Date().toISOString()});
  e.target.reset(); $('workDate').value=today(); save(); alert('Work record saved.');
});

renderAll();
showLogin();
initFirebase().catch(err=>{
  $('setupBanner').classList.remove('hidden');
  $('setupBanner').textContent='Firebase startup error: '+(err.message||err);
  showLogin();
});