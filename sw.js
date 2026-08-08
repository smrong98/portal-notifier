self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("push",e=>{
  if(!e.data)return;
  let d={};
  try{d=e.data.json()}catch{d={title:"Portal Notifier",body:e.data.text()}}
  e.waitUntil(self.registration.showNotification(d.title||"Portal Notifier",{
    body:d.body||"",tag:d.tag,data:d.data||{}
  }));
});
self.addEventListener("notificationclick",e=>{
  e.notification.close();
  const target=e.notification.data?.url||"./";
  e.waitUntil(self.clients.matchAll({type:"window",includeUncontrolled:true}).then(cs=>{
    for(const c of cs){if("focus"in c){c.navigate(target);return c.focus()}}
    return self.clients.openWindow(target);
  }));
});
