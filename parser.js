/* RutaPack 3.0 — extracción conservadora de la sección destinatario. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.RutaPackParser=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const norm = value => String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
  const START = /^(?:DESTINATARIO\b|DESTINATARI[0O]\b|RECEPTOR\b|RECIPIENT\b|SHIP\s*TO\b|ENTREGAR\s+A\b|ENVIAR\s+A\b|DELIVER\s+TO\b|DIRECCI[OÓ]N\s+DE\s+ENTREGA\b)/;
  const STOP = /^(?:REMITENTE\b|CANT\b|CANTIDAD\b|DESCRIP\b|DESCRIPCION\b|DESCRIPTION\b|CONTENTS?\b|ITEMS?\b|PRODUCTO\b|CONTENIDO\b|PESO\b|CONCEPTO\b|TOTAL\b|REFERENCIA\b|OBSERVACIONES\b|VALOR DECLARADO\b|FECHA ESTIMADA\b|DOCUMENTADOR\b|FLETE\b|SERVICIOS\b|SEGURO\b|SUBTOTAL\b|IVA\b|REIMPRESION\b|PAGO\b)/;
  const STREET = /(?:\b(?:CALLE|C\.|AV\.?|AVENIDA|BLVD|BOULEVARD|PRIVADA|PRIV\.?|ANDADOR|CARRETERA|CAMINO|CERRADA|PASEO|PROLONGACION|PROL\.?|CDA\.?|RETORNO|RIO|PROFR\.?|EJE|CIRCUITO|DIAGONAL)\b|^\d{1,3}\s+(?:DE\s+)?(?:MAYO|FEBRERO|MARZO|ABRIL|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE|ENERO)\b|\b(?:MZ\.?\s*\d+|MANZANA\s*\d+|LT\.?\s*\d+|LOTE\s*\d+|NO\.?\s*\d+|NUM\.?\s*\d+|#\s*\d+)\b)/i;
  const EXCLUDE = /^(?:CEL\b|TEL\b|TELEFONO\b|PHONE\b|CP\s*[:=]?\s*$|CODIGO\s+POSTAL\b|RASTREO\b|RUTA\b)/;
  const zipPattern=/\b\d{5}\b/;
  const mexicoCity=/\b(?:IZTAPALAPA|COYOACAN|TLAHUAC|XOCHIMILCO|TLALPAN|AZCAPOTZALCO|IZTACALCO|MIGUEL HIDALGO|BENITO JUAREZ|CUAUHTEMOC|VENUSTIANO CARRANZA|ALVARO OBREGON|MAGDALENA CONTRERAS|CUAJIMALPA|GUSTAVO A\.? MADERO|MILPA ALTA|CDMX|CIUDAD DE MEXICO)\b/;
  function extractRecipient(text){
    const lines=String(text||'').split(/\r?\n/).map(l=>l.replace(/[\t|]+/g,' ').trim()).filter(Boolean);
    const start=lines.findIndex(l=>START.test(norm(l)));
    if(start<0)return {found:false,name:'',address:'',postal:'',section:[],warning:'No se identificó el encabezado DESTINATARIO. Introduce el domicilio manualmente o repite la fotografía.'};
    let section=[];
    for(let i=start+1;i<lines.length&&section.length<15;i++){
      if(STOP.test(norm(lines[i])))break;
      if(START.test(norm(lines[i])))break;
      section.push(lines[i]);
    }
    // Descarta celulares, teléfonos y etiquetas internas sin dirección.
    section=section.map(l=>l.replace(/\b(?:CEL|TEL|TELEFONO|PHONE)\s*[:.]?\s*\d[\d\s()-]{5,}/ig,'').trim()).filter(Boolean);
    const candidates=section.filter(l=>!EXCLUDE.test(norm(l)));
    let streetAt=candidates.findIndex(l=>STREET.test(norm(l))&&!/^(?:\d{7,}|(?:[A-Z]{2,}\d{2,}))$/.test(norm(l)));
    if(streetAt<0){streetAt=candidates.findIndex((l,i)=>i>0&&/\d/.test(l)&&/[A-Za-zÁÉÍÓÚÑ]/.test(l)&&!/^(?:\d[\d\s-]{6,})$/.test(l));}
    const rawBefore=streetAt<0?candidates:candidates.slice(0,streetAt);
    const possibleName=rawBefore.map(l=>l.replace(/^\d{6,}\s*[-–]?\s*/,'').trim()).filter(l=>/[A-Za-zÁÉÍÓÚÑ]{2}/.test(l)&&!/^\w{1,5}\d{2,}$/.test(l));
    const name=possibleName.length?possibleName[possibleName.length-1].slice(0,120):'';
    if(streetAt<0)return {found:true,name,address:'',postal:'',section,warning:'Encontré DESTINATARIO, pero no pude identificar una calle con seguridad. Corrige el domicilio antes de guardar.'};
    const selected=candidates.slice(streetAt,Math.min(streetAt+4,candidates.length)).filter(l=>!EXCLUDE.test(norm(l))&&!/^\d[\d\s()-]{6,}$/.test(l));
    let cleaned=selected.map(l=>l.replace(/\b(?:TEL|CEL|TELEFONO|PHONE)\s*[:.]?\s*\d[\d\s()-]{5,}/ig,'').replace(/\s+/g,' ').trim()).filter(l=>l&&!/^(?:CX\.?MX|CD\.?MX|MX|TELEFONO|TEL)\.?$/i.test(l));
    const postal=(cleaned.join(' ').match(zipPattern)||[])[0]||'';
    const combined=norm(section.join(' '));
    let address=cleaned.join(', ');
    if(mexicoCity.test(combined)&&!/(?:CDMX|CIUDAD DE MEXICO)/.test(norm(address)))address+=', Ciudad de México';
    return {found:true,name,address:address.slice(0,600),postal,section,warning:postal?'Confirma que la calle, colonia, número y código postal sean correctos.':'Revisa el domicilio: no se detectó un código postal de 5 dígitos.'};
  }
  return {extractRecipient};
});
