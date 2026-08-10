const $=s=>document.querySelector(s);
const $$=s=>document.querySelectorAll(s);
const worker=(window.PORTAL_NOTIFIER_CONFIG?.WORKER_URL||"").replace(/\/$/,"");
const key=()=>localStorage.getItem("portalNotifierClientKey")||"";

async function api(path,opt={}) {
  const h=new Headers(opt.headers||{});
  h.set("X-Client-Key",key());
  if(opt.body&&!h.has("Content-Type"))h.set("Content-Type","application/json");
  const r=await fetch(worker+path,{...opt,headers:h});
  let b={}; try{b=await r.json()}catch{}
  if(!r.ok)throw new Error(b.error||`HTTP ${r.status}`);
  return b;
}
function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;")}
function b64(v){const p="=".repeat((4-v.length%4)%4),s=(v+p).replace(/-/g,"+").replace(/_/g,"/");return Uint8Array.from([...atob(s)].map(c=>c.charCodeAt(0)))}

let config=null,status=null,activeTab="all";
const LATEST_POST_LIMIT=10;
const MEALS={breakfast:"조식",lunch:"중식",dinner:"석식"};

function todayInSeoul(){
  return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
}
function renderMeal(meal){
  const date=todayInSeoul();
  $("#mealDate").textContent=new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",dateStyle:"full"}).format(new Date());
  const restaurants=(meal?.restaurants||[]).map(r=>({name:r.restaurant,day:r.days?.[date]})).filter(r=>r.day&&Object.keys(r.day).length);
  if(!restaurants.length){$("#meal").innerHTML='<div class="empty">오늘 등록된 식단이 없습니다.</div>';return}
  $("#meal").innerHTML=restaurants.map(r=>`<div class="restaurant"><strong>${esc(r.name)}</strong>${Object.entries(MEALS).map(([key,label])=>{
    const corners=r.day[key]; if(!corners)return "";
    const menu=Object.entries(corners).map(([corner,items])=>`${corner==="menu"?"":`<b>${esc(corner)}</b> `}${items.map(esc).join(", ")}`).join(" · ");
    return `<div class="meal-row"><span class="meal-label">${label}</span><span>${menu}</span></div>`;
  }).join("")}</div>`).join("");
}
async function loadMeal(){
  try{renderMeal(await api("/api/meal"))}catch(e){$("#mealDate").textContent="";$("#meal").innerHTML=`<div class="empty">${esc(e.message)}</div>`}
}
function renderMealSettings(settings){
  $("#mealSettings").innerHTML=Object.entries(MEALS).map(([key,label])=>{
    const value=settings?.[key]||{enabled:true,time:"12:00"};
    return `<div class="meal-setting"><label class="check"><input data-meal="${key}" type="checkbox" ${value.enabled?"checked":""}><span>${label} 알림</span></label><label class="field"><input data-meal-time="${key}" type="time" value="${esc(value.time)}" aria-label="${label} 알림 시간"></label></div>`;
  }).join("");
}

function allLatest(){
  const enabledBoards=new Set(config?.settings?.enabledBoards||[]);
  const x=Object.values(status?.latestByBoard||{}).flat();
  return x
    .filter(p=>enabledBoards.has(p.boardKey))
    .sort((a,b)=>new Date(b.regDt||0)-new Date(a.regDt||0));
}
function tabPosts(){
  const posts=activeTab==="all"
    ? allLatest()
    : status?.latestByBoard?.[activeTab]||[];
  return posts.slice(0,LATEST_POST_LIMIT);
}
function renderTabs(){
  const wrap=$("#tabs"); wrap.innerHTML="";
  const tabs=[{key:"all",name:"전체"},...(config?.boards||[])];
  for(const t of tabs){
    const b=document.createElement("button");
    b.className="tab"+(activeTab===t.key?" active":"");
    b.textContent=t.name;
    b.onclick=()=>{activeTab=t.key;renderTabs();renderLatest()};
    wrap.appendChild(b);
  }
}
function renderLatest(){
  const wrap=$("#latest"); wrap.innerHTML="";
  const posts=tabPosts();
  if(!posts.length){wrap.innerHTML='<div class="empty">표시할 최신 게시물이 없습니다.</div>';return}
  for(const p of posts){
    const d=document.createElement(p.url ? "a" : "div");
    d.className="post";
    if(p.url){
      d.href=p.url;
      d.target="_blank";
      d.rel="noopener noreferrer";
    }
    d.innerHTML=`<div class="board">${esc(p.boardName)}</div><div class="title">${esc(p.title)}</div><div class="date">${esc(p.regDt||"")}</div>`;
    wrap.appendChild(d);
  }
}
function renderStatus(){
  $("#statusText").textContent=status?.ok?"정상":"오류";
  $("#dot").className="dot "+(status?.ok?"ok":"bad");
  $("#lastCheck").textContent=status?.lastSuccessAt?new Date(status.lastSuccessAt).toLocaleString():"아직 없음";
  $("#lastError").textContent=status?.lastError||"";
  $("#lastError").style.display=status?.lastError?"block":"none";
}
async function load(){
  if(!key()){ $("#statusText").textContent="앱 키를 입력하세요"; return; }
  [config,status]=await Promise.all([api("/api/config"),api("/api/status")]);
  const s=config.settings;
  $("#interval").value=s.intervalMinutes;
  $("#quietEnabled").checked=s.quietEnabled;
  $("#quietStart").value=s.quietStart;
  $("#quietEnd").value=s.quietEnd;
  renderMealSettings(s.mealNotifications);
  $("#boards").innerHTML="";
  for(const b of config.boards){
    const l=document.createElement("label"); l.className="check";
    l.innerHTML=`<input type="checkbox" value="${esc(b.key)}" ${s.enabledBoards.includes(b.key)?"checked":""}><span>${esc(b.name)}</span>`;
    $("#boards").appendChild(l);
  }
  renderStatus();renderTabs();renderLatest();await loadMeal();
}
async function pushSetup(){
  const perm=await Notification.requestPermission();
  if(perm!=="granted")throw new Error("알림 권한이 허용되지 않았습니다.");
  const reg=await navigator.serviceWorker.register("./sw.js");
  await navigator.serviceWorker.ready;
  const {publicKey}=await api("/api/vapid-public-key");
  let sub=await reg.pushManager.getSubscription();
  if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(publicKey)});
  await api("/api/push/subscribe",{method:"POST",body:JSON.stringify(sub.toJSON())});
  alert("알림 연결 완료");
}
async function saveSettings(){
  await api("/api/settings",{method:"PUT",body:JSON.stringify({
    intervalMinutes:Number($("#interval").value),
    quietEnabled:$("#quietEnabled").checked,
    quietStart:$("#quietStart").value,
    quietEnd:$("#quietEnd").value,
    timezone:"Asia/Seoul",
    mealNotifications:Object.fromEntries(Object.keys(MEALS).map(meal=>[meal,{
      enabled:Boolean($(`[data-meal="${meal}"]`)?.checked),
      time:$(`[data-meal-time="${meal}"]`)?.value
    }])),
    // `$` returns only one element. Always collect the checkbox NodeList before
    // converting it to an array; spreading a single input caused Safari's
    // "not iterable" error when settings were saved.
    enabledBoards:Array.from($$("#boards input:checked"),x=>x.value)
  })});
  await load();
}
$("#clientKey").value=key();
$("#saveKey").onclick=()=>{localStorage.setItem("portalNotifierClientKey",$("#clientKey").value.trim());load().catch(e=>alert(e.message))};
$("#check").onclick=async()=>{try{await api("/api/check",{method:"POST"});await load()}catch(e){alert(e.message)}};
$("#push").onclick=()=>pushSetup().catch(e=>alert(e.message));
$("#test").onclick=()=>api("/api/push/test",{method:"POST"}).catch(e=>alert(e.message));
$("#mealTest").onclick=()=>api("/api/push/meal-test",{method:"POST",body:JSON.stringify({meal:$("#testMeal").value})}).then(()=>alert("식단 테스트 알림을 보냈습니다.")).catch(e=>alert(e.message));
$("#refreshMeal").onclick=()=>api("/api/meal/refresh",{method:"POST",body:JSON.stringify({force:true})}).then(loadMeal).catch(e=>alert(e.message));
$("#saveSettings").onclick=()=>saveSettings().catch(e=>alert(e.message));
load().catch(e=>{console.error(e);$("#statusText").textContent=e.message});
