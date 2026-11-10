/* RutaPack 3.0 — PWA de prueba sin servidor. Solo usa datos que el usuario capture. */
(()=>{
  'use strict';
  const $=id=>document.getElementById(id);
  const KEY='rutapack-v3-jornadas';
  const LIMIT=80;
  const makeId=()=>crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const today=()=>new Date().toLocaleDateString('en-CA');
  const html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const emptyState=()=>({version:3,date:today(),deliveries:[],history:[],start:null,finishMode:'return'});
  let state=emptyState(), currentFile=null, currentImageURL=null, stream=null, worker=null, ocrBusy=false, ocrPromise=null;
  function safeRead(){
    try{
      const existing=localStorage.getItem(KEY);
      if(existing){const value=JSON.parse(existing);if(value&&Array.isArray(value.deliveries)&&Array.isArray(value.history)){
        state={...emptyState(),...value};
        state.deliveries=state.deliveries.slice(0,LIMIT);
        state.history=state.history.slice(0,45);
        return;
      }}
      // Migración de RutaPack 1.0/2.1: conserva intactos los datos previos.
      const legacy=JSON.parse(localStorage.getItem('rutapack-deliveries-v1')||'[]');
      if(Array.isArray(legacy)&&legacy.length){
        state.deliveries=legacy.slice(0,LIMIT).filter(x=>x&&typeof x.address==='string').map((x,i)=>({
          id:makeId(),tracking:String(x.tracking||'').slice(0,100),recipient:'',address:x.address.slice(0,600),status:x.done?'done':'pending',order:i+1,createdAt:new Date().toISOString()
        }));
        persist();
      }
    }catch(e){console.warn('No se pudo recuperar el almacenamiento',e)}
  }
  function persist(){
    try{localStorage.setItem(KEY,JSON.stringify(state));return true}
    catch(e){alert('No fue posible guardar los datos en este navegador. Exporta un respaldo y revisa el espacio de almacenamiento.');console.error(e);return false}
  }
  function toast(msg,type='good'){
    $('ocrProgress').textContent=msg;
    $('ocrProgress').className='status '+(type==='bad'?'alert':type==='good'?'good':'hint');
  }
  function getAddress(){return $('address').value.trim().replace(/\s+/g,' ').slice(0,600)}
  function deliveryQuery(d){return d.address}
  function mapSearchUrl(address){return 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(address)}
  function mapDirUrl(destination,origin){
    let url='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(destination)+'&travelmode=driving&dir_action=navigate';
    if(origin)url+='&origin='+encodeURIComponent(origin);
    return url;
  }
  function maps(destination,origin=null,search=false){
    if(!destination){alert('Primero confirma el domicilio de entrega.');return}
    const url=search?mapSearchUrl(destination):mapDirUrl(destination,origin);
    // Se invoca desde un toque del usuario; el enlace evita falsos bloqueos al usar noopener.
    const link=document.createElement('a');
    link.href=url;link.target='_blank';link.rel='noopener noreferrer';
    document.body.appendChild(link);link.click();link.remove();
  }
  function ensureReadyToScan(){
    if(state.deliveries.length>=LIMIT){alert('La jornada ya tiene 80 paquetes. Termina o exporta la jornada antes de registrar más.');return false}
    return true;
  }
  function setPhoto(file){
    if(!file)return;
    if(!ensureReadyToScan())return;
    currentFile=file;
    if(currentImageURL)URL.revokeObjectURL(currentImageURL);
    currentImageURL=URL.createObjectURL(file);
    $('photoPreview').src=currentImageURL;
    $('photoPreview').style.display='block';
    $('recipient').value=''; $('tracking').value=''; $('address').value=''; $('rawText').value='';
    $('parseWarning').textContent='Buscando la sección DESTINATARIO…';
    void readPhoto();
  }
  async function getOCRWorker(){
    if(worker)return worker;
    if(ocrPromise)return ocrPromise;
    ocrPromise=(async()=>{
      if(!window.Tesseract){
        await new Promise((resolve,reject)=>{
          const tag=document.createElement('script');tag.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
          tag.onload=resolve;tag.onerror=()=>reject(new Error('No se pudo descargar el OCR. Comprueba tu conexión.'));
          document.head.appendChild(tag);
        });
      }
      // Reutilizar un único worker hace mucho más ágil el escaneo consecutivo.
      const w=await Tesseract.createWorker(['spa','eng'],1,{logger:m=>{
        if(ocrBusy&&m.progress!=null)toast('Leyendo texto: '+Math.round(m.progress*100)+'%','hint');
      }});
      worker=w;
      return w;
    })();
    try{return await ocrPromise}finally{ocrPromise=null}
  }
  async function resizeFile(file){
    // Reducir fotos enormes para ahorrar RAM en Android sin enviar imágenes a servicios externos.
    let bitmap;
    try{
      bitmap=await createImageBitmap(file);
      const max=1900,scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
      const width=Math.max(1,Math.round(bitmap.width*scale)),height=Math.max(1,Math.round(bitmap.height*scale));
      const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      canvas.getContext('2d',{willReadFrequently:true}).drawImage(bitmap,0,0,width,height);
      return canvas;
    }catch{return file}
    finally{bitmap?.close?.()}
  }
  let zxingPromise=null;
  async function tryDetectBarcode(image){
    // Primero el lector nativo. Usar solo formatos soportados evita errores en Android.
    if('BarcodeDetector' in window){
      try{
        const desired=['code_128','code_39','ean_13','ean_8','qr_code','itf','codabar','pdf417'];
        const supported=typeof BarcodeDetector.getSupportedFormats==='function'
          ?await BarcodeDetector.getSupportedFormats():desired;
        const formats=desired.filter(f=>supported.includes(f));
        if(formats.length){
          const found=await new BarcodeDetector({formats}).detect(image);
          if(found.length){
            // En guías hay distintos códigos: preferir uno de rastreo de longitud normal.
            const values=found.map(x=>String(x.rawValue||'').trim()).filter(Boolean);
            const chosen=values.find(x=>/^[A-Z0-9-]{10,30}$/i.test(x))||values[0];
            if(chosen)return chosen.slice(0,100);
          }
        }
      }catch(e){console.warn('Lector nativo no disponible:',e)}
    }
    // Respaldo para navegadores que no ofrecen BarcodeDetector, sin subir la foto.
    try{
      if(!window.ZXingBrowser){
        if(!zxingPromise){
          zxingPromise=new Promise((resolve,reject)=>{
            const tag=document.createElement('script');
            tag.src='https://cdn.jsdelivr.net/npm/@zxing/browser@0.2.1/umd/zxing-browser.min.js';
            tag.onload=resolve;
            tag.onerror=()=>reject(new Error('No se pudo descargar el lector alternativo'));
            document.head.appendChild(tag);
          });
        }
        try{await zxingPromise}catch(e){zxingPromise=null;throw e}
      }
      const canvas=image instanceof HTMLCanvasElement ? image : await resizeFile(currentFile);
      if(!(canvas instanceof HTMLCanvasElement))return '';
      const reader=new ZXingBrowser.BrowserMultiFormatReader();
      const result=await reader.decodeFromCanvas(canvas);
      return (result?.getText?.()||result?.text||'').trim().slice(0,100);
    }catch(e){
      // No hallar código es normal: la extracción de domicilio continúa con OCR.
      console.debug('No se leyó código de barras:',e?.message||e);
      return '';
    }
  }
  async function readPhoto(){
    if(!currentFile||ocrBusy)return;
    ocrBusy=true; $('repeatOCR').disabled=true; $('saveDelivery').disabled=true;
    toast('Analizando código y dirección. La primera vez puede requerir Internet…','hint');
    try{
      const image=await resizeFile(currentFile);
      const readBarcode=await tryDetectBarcode(image);
      if(readBarcode)$('tracking').value=readBarcode;
      const w=await getOCRWorker();
      const result=await w.recognize(image);
      $('rawText').value=result?.data?.text||'';
      applyParser();
      const confidence=Number(result?.data?.confidence||0);
      if(!getAddress())toast('Lectura terminada. No se pudo identificar una dirección: revisa el texto o escribe el domicilio.','bad');
      else toast('Dirección sugerida de DESTINATARIO'+(readBarcode?' · código detectado':'')+'. Revísala antes de guardar.'+(confidence<45?' La foto puede estar poco clara.':''),'good');
    }catch(e){console.error(e);toast('No fue posible leer la fotografía. Revisa Internet o ingresa la dirección manualmente.','bad')}
    finally{ocrBusy=false;$('repeatOCR').disabled=false;$('saveDelivery').disabled=false}
  }
  function applyParser(){
    const text=$('rawText').value;
    const result=window.RutaPackParser.extractRecipient(text);
    if(result.name)$('recipient').value=result.name;
    if(result.address)$('address').value=result.address;
    $('parseWarning').textContent=result.warning;
  }
  async function startCamera(){
    if(!ensureReadyToScan())return;
    if(stream)return;
    if(!navigator.mediaDevices?.getUserMedia){toast('Esta versión de Chrome no permite video directo. Usa Fotografiar etiqueta.','bad');return}
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});
      const video=$('liveCamera');video.srcObject=stream;video.style.display='block';
      await video.play();
      $('startCamera').disabled=true;$('snapCamera').disabled=false;$('stopCamera').disabled=false;
      $('cameraTip').style.display='block';
      toast('Cámara activa. Centra una etiqueta, luego pulsa Capturar etiqueta.','good');
    }catch(e){console.error(e);toast('No se pudo activar la cámara. Permite acceso a la cámara en Chrome o usa Fotografiar etiqueta.','bad')}
  }
  function stopCamera(){
    if(stream){for(const track of stream.getTracks())track.stop();stream=null}
    const video=$('liveCamera');video.pause();video.srcObject=null;video.style.display='none';
    $('startCamera').disabled=false;$('snapCamera').disabled=true;$('stopCamera').disabled=true;
    $('cameraTip').style.display='none';
  }
  function snapCamera(){
    if(!stream||ocrBusy||!ensureReadyToScan())return;
    const video=$('liveCamera');
    if(!video.videoWidth){toast('La cámara aún no está lista. Vuelve a intentarlo.','bad');return}
    $('snapCamera').disabled=true;
    const canvas=document.createElement('canvas');
    const scale=Math.min(1,1900/Math.max(video.videoWidth,video.videoHeight));
    canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
    canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    canvas.toBlob(blob=>{
      $('snapCamera').disabled=false;
      if(!blob){toast('No se pudo capturar la fotografía.','bad');return}
      setPhoto(new File([blob],'etiqueta.jpg',{type:'image/jpeg'}));
    },'image/jpeg',.92);
  }
  function saveDelivery(){
    if(ocrBusy){alert('Termina primero el reconocimiento de la etiqueta.');return}
    if(!ensureReadyToScan())return;
    const address=getAddress();
    if(address.length<12){alert('Revisa y escribe el domicilio completo del destinatario antes de guardar.');$('address').focus();return}
    const tracking=$('tracking').value.trim().slice(0,100);
    if(tracking&&state.deliveries.some(d=>d.tracking?.toUpperCase()===tracking.toUpperCase())){
      if(!confirm('Ya hay una entrega con este número de guía. ¿Guardar otra de todos modos?'))return;
    }
    const delivery={id:makeId(),recipient:$('recipient').value.trim().slice(0,120),tracking,address,status:'pending',order:state.deliveries.length+1,createdAt:new Date().toISOString()};
    state.deliveries.push(delivery);
    if(!persist()){state.deliveries.pop();return}
    render();
    $('recipient').value='';$('tracking').value='';$('address').value='';$('rawText').value='';$('photo').value='';
    if(currentImageURL){URL.revokeObjectURL(currentImageURL);currentImageURL=null}
    $('photoPreview').removeAttribute('src');$('photoPreview').style.display='none';currentFile=null;
    $('parseWarning').textContent='En cada fotografía confirma que la dirección corresponde al destinatario.';
    $('scanner').scrollIntoView({behavior:'smooth',block:'start'});
    toast(`📦 Paquete ${state.deliveries.length} de ${LIMIT} guardado. ${stream&&$('continuous').checked?'La cámara sigue activa: apunta a la siguiente etiqueta y pulsa Capturar.':'Pulsa Abrir cámara o Fotografiar etiqueta para continuar.'}`);
    if(stream&&!$('continuous').checked)stopCamera();
  }
  function countStatus(status){return state.deliveries.filter(d=>d.status===status).length}
  function statusLabel(status){return status==='done'?'✅ Entregado':status==='issue'?'⚠️ Incidencia':'📦 Pendiente'}
  function ordered(){return [...state.deliveries].sort((a,b)=>a.order-b.order)}
  function render(){
    $('journeyDate').textContent=state.date;
    $('total').textContent=String(state.deliveries.length);
    $('completed').textContent=String(countStatus('done'));
    $('issues').textContent=String(countStatus('issue'));
    $('deliveryCount').textContent=String(state.deliveries.length);
    $('finishMode').value=state.finishMode;
    $('gpsStatus').textContent=state.start?`Inicio guardado: ${state.start.lat.toFixed(5)}, ${state.start.lng.toFixed(5)}. Puedes cambiarlo con el botón de GPS.`:'Sin ubicación inicial guardada.';
    const filter=$('filter').value;
    const selected=ordered().filter(d=>filter==='all'||d.status===filter);
    $('deliveries').innerHTML=selected.length?selected.map(d=>`
      <article class="delivery" data-id="${html(d.id)}">
        <div class="section-heading"><strong>#${d.order} · ${statusLabel(d.status)}</strong><span class="small">${html(d.tracking||'Sin guía')}</span></div>
        ${d.recipient?`<div class="small">👤 ${html(d.recipient)}</div>`:''}
        <div class="address">📍 ${html(d.address)}</div>
        <div class="actions">
          <button data-action="navigate">🚗 Navegar</button>
          <button class="ghost" data-action="map">📍 Ver punto</button>
          <button class="ghost" data-action="edit">✏️ Corregir</button>
          <button class="ghost" data-action="up" aria-label="Subir entrega">↑</button>
          <button class="ghost" data-action="down" aria-label="Bajar entrega">↓</button>
          <button class="secondary" data-action="done">✅ Entregada</button>
          <button class="secondary" data-action="issue">⚠️ Incidencia</button>
          <button class="danger" data-action="delete">✕</button>
        </div>
      </article>`).join(''):'<p class="hint">No hay entregas en esta vista. Puedes escanear la primera etiqueta arriba.</p>';
    $('history').innerHTML=state.history.length?state.history.map((h,i)=>`<div class="delivery"><b>${html(h.date||'Jornada anterior')}</b> · ${(h.deliveries||[]).length} entregas <button class="ghost" data-history="${i}" data-action="exportHistory">⬇️ Respaldar jornada</button></div>`).join(''):'<p class="hint">Aún no hay jornadas archivadas.</p>';
  }
  function moveDelivery(id,offset){
    const list=ordered(),at=list.findIndex(x=>x.id===id),next=at+offset;
    if(at<0||next<0||next>=list.length)return;
    [list[at],list[next]]=[list[next],list[at]];
    list.forEach((x,i)=>x.order=i+1);persist();render();
  }
  function editDelivery(d){
    const recipient=prompt('Nombre del destinatario (opcional):',d.recipient||'');if(recipient===null)return;
    const address=prompt('Corrige el domicilio del destinatario:',d.address);if(address===null)return;
    if(address.trim().length<12){alert('La dirección debe ser más completa.');return}
    const tracking=prompt('Número de guía (opcional):',d.tracking||'');if(tracking===null)return;
    d.recipient=recipient.trim().slice(0,120);d.address=address.trim().slice(0,600);d.tracking=tracking.trim().slice(0,100);
    persist();render();
  }
  function fromGps(){
    if(!navigator.geolocation){alert('Tu navegador no permite GPS.');return}
    $('useGps').disabled=true;$('gpsStatus').textContent='Solicitando permiso GPS…';
    navigator.geolocation.getCurrentPosition(pos=>{
      state.start={lat:pos.coords.latitude,lng:pos.coords.longitude,at:new Date().toISOString()};
      persist();render();$('useGps').disabled=false;
    },err=>{console.error(err);$('gpsStatus').textContent='No se obtuvo tu GPS. Revisa los permisos de ubicación de Chrome.';$('useGps').disabled=false},
    {enableHighAccuracy:true,timeout:15000,maximumAge:30000});
  }
  function nextStop(){
    const d=ordered().find(x=>x.status==='pending');
    if(!d){alert('No hay entregas pendientes. Revisa incidencias y la opción de regresar al inicio.');return}
    maps(deliveryQuery(d));
  }
  function backToStart(){
    if(state.finishMode!=='return'){if(!confirm('Elegiste terminar en la última entrega. ¿Quieres navegar al inicio igualmente?'))return}
    if(!state.start){alert('Primero guarda tu ubicación de partida usando el GPS.');return}
    maps(`${state.start.lat},${state.start.lng}`);
  }
  function getPostal(s){return (String(s).match(/\b\d{5}\b/)||[])[0]||'ZZZZZ'}
  function groupByPostal(){
    if(state.deliveries.length<2)return;
    if(!confirm('Esta organización SOLO agrupa por código postal. No calcula tiempos, calles ni tráfico; puede empeorar la ruta. ¿Continuar?'))return;
    const sorted=ordered().sort((a,b)=>getPostal(a.address).localeCompare(getPostal(b.address),'es'));
    sorted.forEach((d,i)=>d.order=i+1);persist();render();
  }
  function newJourney(){
    if(!confirm('¿Archivar la jornada actual e iniciar una nueva? Sus entregas seguirán en Historial.'))return;
    if(state.deliveries.length){state.history.unshift({date:state.date,deliveries:state.deliveries,start:state.start,finishMode:state.finishMode});state.history=state.history.slice(0,45)}
    state.date=today();state.deliveries=[];state.start=null;
    persist();render();toast('Jornada nueva creada. Puedes comenzar a escanear.');
  }
  function exportBlob(data,name){
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
  }
  function exportBackup(){exportBlob(state,'rutapack-respaldo-'+today()+'.json')}
  function isValidDelivery(d){return d&&typeof d.address==='string'&&d.address.length<=600&&['pending','done','issue'].includes(d.status)}
  async function importBackup(file){
    if(!file)return;
    try{
      if(file.size>3_000_000)throw new Error('Archivo demasiado grande');
      const data=JSON.parse(await file.text());
      if(!data||!Array.isArray(data.deliveries)||!Array.isArray(data.history)||data.deliveries.length>LIMIT||data.history.length>45||!data.deliveries.every(isValidDelivery)||!data.history.every(h=>Array.isArray(h.deliveries)&&h.deliveries.length<=LIMIT&&h.deliveries.every(isValidDelivery)))throw new Error('Formato no reconocido');
      if(!confirm('¿Restaurar este respaldo y REEMPLAZAR las jornadas actuales?'))return;
      state={...emptyState(),...data,version:3};
      state.deliveries=state.deliveries.map((d,i)=>({...d,id:makeId(),order:i+1}));
      state.history=state.history.map(h=>({...h,deliveries:h.deliveries.map(d=>({...d,id:makeId()}))}));
      if(state.start&&(!Number.isFinite(state.start.lat)||!Number.isFinite(state.start.lng)))state.start=null;
      persist();render();toast('Respaldo restaurado.','good');
    }catch(e){alert('El archivo no es un respaldo válido de RutaPack 3.0.');console.error(e)}
    finally{$('backupFile').value=''}
  }
  // Conectar controles
  $('photo').addEventListener('change',e=>setPhoto(e.target.files?.[0]));
  $('startCamera').addEventListener('click',startCamera);
  $('stopCamera').addEventListener('click',stopCamera);
  $('snapCamera').addEventListener('click',snapCamera);
  $('openNext').addEventListener('click',()=>{if(stream)toast('La cámara continua ya está activa. Pulsa Capturar etiqueta.');else $('photo').click()});
  $('repeatOCR').addEventListener('click',readPhoto);
  $('parseText').addEventListener('click',applyParser);
  $('saveDelivery').addEventListener('click',saveDelivery);
  $('previewMap').addEventListener('click',()=>maps(getAddress(),null,true));
  $('useGps').addEventListener('click',fromGps);
  $('finishMode').addEventListener('change',e=>{state.finishMode=e.target.value;persist();render()});
  $('openNextStop').addEventListener('click',nextStop);
  $('returnStart').addEventListener('click',backToStart);
  $('groupByPostal').addEventListener('click',groupByPostal);
  $('newJourney').addEventListener('click',newJourney);
  $('backup').addEventListener('click',exportBackup);
  $('restore').addEventListener('click',()=>$('backupFile').click());
  $('backupFile').addEventListener('change',e=>importBackup(e.target.files?.[0]));
  $('clearHistory').addEventListener('click',()=>{
    if(!state.history.length){alert('No hay historial para borrar.');return}
    if(confirm('¿Borrar definitivamente el historial de jornadas anteriores? Primero exporta tu respaldo si deseas conservarlo.')){state.history=[];persist();render()}
  });
  $('filter').addEventListener('change',render);
  $('history').addEventListener('click',e=>{
    const button=e.target.closest('[data-history]');if(!button)return;
    const archive=state.history[Number(button.dataset.history)];if(archive)exportBlob(archive,'rutapack-jornada-'+(archive.date||'archivo')+'.json');
  });
  $('deliveries').addEventListener('click',e=>{
    const b=e.target.closest('button[data-action]');if(!b)return;
    const d=state.deliveries.find(x=>x.id===b.closest('[data-id]')?.dataset.id);if(!d)return;
    const action=b.dataset.action;
    if(action==='navigate')maps(deliveryQuery(d));
    else if(action==='map')maps(deliveryQuery(d),null,true);
    else if(action==='edit')editDelivery(d);
    else if(action==='up')moveDelivery(d.id,-1);
    else if(action==='down')moveDelivery(d.id,1);
    else if(action==='done'||action==='issue'){d.status=action==='done'?(d.status==='done'?'pending':'done'):(d.status==='issue'?'pending':'issue');persist();render()}
    else if(action==='delete'&&confirm('¿Eliminar este paquete de la jornada?')){
      state.deliveries=state.deliveries.filter(x=>x.id!==d.id);ordered().forEach((v,i)=>v.order=i+1);persist();render();
    }
  });
  window.addEventListener('pagehide',()=>stopCamera());
  if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(console.warn));
  safeRead();render();
})();
