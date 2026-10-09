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
let state=load();
function load(){try{const x=JSON.parse(localStorage.getItem(KEY));return x?{...structuredClone(defaults),...x}:structuredClone(defaults)}catch{return structuredClone(defaults)}}
function save(){localStorage.setItem(KEY,JSON.stringify(state));renderAll()}
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const uid=p=>p+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);
const today=()=>new Date().toISOString().slice(0,10);
$('usageDate').value=today(); $('workDate').value=today();

document.querySelectorAll('.tabs button').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.tabs button').forEach(b=>b.classList.toggle('active',b===btn));
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  $('view-'+btn.dataset.view).classList.remove('hidden');
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
  $('recordAsset').innerHTML='<option value="">All assets</option>'+state.assets.map(a=>'<option value="'+esc(a.id)+'">'+esc(assetLabel(a))+'</option>').join('');
  $('usageItem').innerHTML=optionList(state.items,'Select item');
  $('usageUnit').innerHTML=optionList(state.units,'Select unit');
  $('workMeasure').innerHTML=optionList(state.measures,'Select measure');
  $('assetTypeSelect').innerHTML=optionList(state.assetTypes,'Select asset type',t=>({value:t.id,label:t.name}));
}
function renderDefinitions(){
  $('assetTypeList').innerHTML=state.assetTypes.length?state.assetTypes.map(t=>'<div class="stack-row"><b>'+esc(t.name)+'</b><small>'+esc(t.fields.join(' · ')||'No metadata fields')+'</small></div>').join(''):'<div class="empty">No asset types yet.</div>';
  renderChips('itemList',state.items,'items');
  renderChips('unitList',state.units,'units');
  renderChips('measureList',state.measures,'measures');
}
function renderChips(id,arr,key){
  $(id).innerHTML=arr.map((v,i)=>'<span class="chip">'+esc(v)+'<button type="button" aria-label="Remove" data-remove="'+key+'" data-index="'+i+'">×</button></span>').join('');
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
function renderDashboard(){
  const usage=state.records.filter(r=>r.kind==='usage'), work=state.records.filter(r=>r.kind==='work');
  const fuel=usage.filter(r=>r.item==='Fuel').reduce((s,r)=>s+Number(r.qty||0),0);
  $('summaryCards').innerHTML=[
    ['Registered Assets',state.assets.length],
    ['Usage Records',usage.length],
    ['Work Records',work.length],
    ['Fuel Quantity',fuel.toLocaleString()]
  ].map(([k,v])=>'<div class="summary-card"><span>'+esc(k)+'</span><b>'+esc(v)+'</b></div>').join('');
  $('recentRecords').innerHTML=recordsTable(state.records.slice().sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,8));
}
function recordsTable(records){
  if(!records.length)return '<div class="empty">No records yet.</div>';
  return '<table><thead><tr><th>Date</th><th>Asset</th><th>Type</th><th>Detail</th><th>Reference / Sign</th></tr></thead><tbody>'+records.map(r=>{
    const a=state.assets.find(x=>x.id===r.assetId);
    const detail=r.kind==='usage'?r.item+' · '+r.qty+' '+r.unit:r.measure+' · '+r.qty;
    const ref=r.kind==='usage'?[r.mechanic&&'Mechanic: '+r.mechanic,r.supervisor&&'Supervisor: '+r.supervisor].filter(Boolean).join(' · '):(r.job||r.remarks||'');
    return '<tr><td>'+esc(r.date)+'</td><td>'+esc(a?a.name:'Removed asset')+'</td><td><span class="record-kind '+r.kind+'">'+esc(r.kind==='usage'?'Usage':'Work')+'</span></td><td>'+esc(detail)+'</td><td>'+esc(ref||'—')+'</td></tr>';
  }).join('')+'</tbody></table>';
}
function renderRecords(){
  const aid=$('recordAsset').value, kind=$('recordKind').value;
  const rows=state.records.filter(r=>(!aid||r.assetId===aid)&&(!kind||r.kind===kind)).sort((a,b)=>b.date.localeCompare(a.date));
  $('recordsTable').innerHTML=recordsTable(rows);
}
function renderAll(){renderSelectors();renderDefinitions();renderAssets();renderMetaFields();renderDashboard();renderRecords()}

$('assetTypeSelect').addEventListener('change',renderMetaFields);
$('recordAsset').addEventListener('change',renderRecords);
$('recordKind').addEventListener('change',renderRecords);

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
  const b=e.target.closest('[data-remove]');
  if(b){state[b.dataset.remove].splice(Number(b.dataset.index),1);save()}
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
  state.records.push({id:uid('rec'),kind:'usage',date:$('usageDate').value,assetId:$('usageAsset').value,item:$('usageItem').value,qty:Number($('usageQty').value),unit:$('usageUnit').value,mechanic:$('usageMechanic').value.trim(),supervisor:$('usageSupervisor').value.trim(),remarks:$('usageRemarks').value.trim(),createdAt:new Date().toISOString()});
  e.target.reset(); $('usageDate').value=today(); save(); alert('Usage record saved.');
});
$('workForm').addEventListener('submit',e=>{
  e.preventDefault();
  state.records.push({id:uid('rec'),kind:'work',date:$('workDate').value,assetId:$('workAsset').value,measure:$('workMeasure').value,qty:Number($('workQty').value),job:$('workJob').value.trim(),remarks:$('workRemarks').value.trim(),createdAt:new Date().toISOString()});
  e.target.reset(); $('workDate').value=today(); save(); alert('Work record saved.');
});

renderAll();