export const REGIONS = Object.freeze({
  unity: {title:'Unity', subtitle:'Where possibility becomes a life', color:'#c2deff'},
  machine: {title:'Dream Machine', subtitle:'Possibility · imagination · perspective', color:'#8dcfff'},
  maker: {title:'Dream Maker', subtitle:'Intention · choice · action', color:'#91e6be'},
  world: {title:'Dream World', subtitle:'Experience · consequence · revision', color:'#ceadff'},
});
const kinds = new Set(['goal','insight','tension','project','action']);
const clean = (v,n) => typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g,' ').trim().slice(0,n) : '';

// The model may propose data; it never supplies code, URLs, HTML or storage commands.
export function parseReply(raw) {
  const source = String(raw ?? '').slice(0,18000);
  const match = source.match(/<navigation>\s*([\s\S]*?)\s*<\/navigation>/i);
  const text = visibleReply(source).trim();
  let intent = null;
  if (match) {
    try {
      const data = JSON.parse(match[1]);
      if (data && !Array.isArray(data) && Object.hasOwn(REGIONS,data.region)) {
        const focus = clean(data.focus,90);
        let memory = null;
        if (data.memory && kinds.has(data.memory.kind) && clean(data.memory.text,600)) {
          memory = {kind:data.memory.kind,text:clean(data.memory.text,600),region:data.region};
        }
        intent = {region:data.region,focus,memory};
      }
    } catch { /* Malformed navigation leaves the current scene unchanged. */ }
  }
  return {text, intent};
}

// Hide the control channel, including a marker arriving across streaming chunks.
export function visibleReply(raw) {
  let text = String(raw ?? '');
  const marker = text.toLowerCase().indexOf('<navigation');
  if (marker >= 0) text = text.slice(0,marker);
  else {
    for (let n = 1; n < '<navigation'.length; n++) {
      if (text.toLowerCase().endsWith('<navigation'.slice(0,n))) { text=text.slice(0,-n); break; }
    }
  }
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/gi,'').trimStart();
}

// Explicit commands are user actions, never a substitute for generated conversation.
export function localCommand(text) {
  const s = text.trim().toLowerCase().replace(/[.!?]+$/,'');
  if (/^(pause|stop listening|stop speaking|stop)$/.test(s)) return {type:'pause'};
  if (/^(show|open)( me)? (my |the )?constellation$/.test(s)) return {type:'constellation'};
  if (/^(return|go back|take me back)( to)? (unity|the nexus|the centre|the center)$/.test(s)) return {type:'region',region:'unity'};
  const region=s.match(/^(?:go|take me|bring me|move)(?: to)? (?:the )?(?:dream )?(machine|maker|world)$/);
  if (region) return {type:'region',region:region[1]};
  return null;
}

export function conversationContext(history,nodes) {
  const recent=history.slice(-18).map(({role,content})=>({role,content:content.slice(0,5000)}));
  const memory=nodes.slice(-24).map(({kind,text,region})=>({kind,text,region}));
  return {recent,memory};
}
