/** Pure attendance rules and calendar calculations. The database is authoritative. */
export const TIMEZONE = 'Europe/Athens';
export const ACTIONS = Object.freeze(['clock_in', 'break_start', 'break_end', 'clock_out']);
export const ACTION_LABELS = Object.freeze({clock_in:'Είσοδος',break_start:'Έναρξη διαλείμματος',break_end:'Επιστροφή',clock_out:'Έξοδος'});

const NEXT = Object.freeze({OUT:{clock_in:'IN'},IN:{break_start:'ON_BREAK',clock_out:'OUT'},ON_BREAK:{break_end:'IN'}});
const REQUIRED = Object.freeze({
  OUT:{break_start:['clock_in'],break_end:['clock_in','break_start'],clock_out:['clock_in']},
  IN:{clock_in:['clock_out'],break_end:['break_start']},
  ON_BREAK:{clock_in:['break_end','clock_out'],break_start:['break_end'],clock_out:['break_end']}
});
const formatters = new Map();
function partsFormatter(timeZone) {
  if (!formatters.has(timeZone)) formatters.set(timeZone,new Intl.DateTimeFormat('en-GB',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}));
  return formatters.get(timeZone);
}
function instant(value) { if(value===null||value===undefined||value==='')return null;const n = value instanceof Date ? value.getTime() : new Date(value).getTime(); return Number.isFinite(n) ? n : null; }
// PostgreSQL timestamps retain microseconds. Date alone would collapse distinct
// instants inside one millisecond and incorrectly fall back to tie_order or UUID.
function instantNanos(value) {
  const ms=instant(value);if(ms===null)return null;
  const fraction=typeof value==='string'?value.match(/[Tt ]\d{2}:\d{2}:\d{2}\.(\d+)(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/)?.[1]||'':'';
  return BigInt(ms)*1000000n+BigInt(fraction.slice(3,9).padEnd(6,'0'));
}
function calendarParts(value,timeZone=TIMEZONE) {
  const ms=instant(value); if(ms===null) throw new RangeError('Μη έγκυρη ημερομηνία και ώρα.');
  return Object.fromEntries(partsFormatter(timeZone).formatToParts(new Date(ms)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
const pad=n=>String(n).padStart(2,'0');
export function dateKey(value,timeZone=TIMEZONE) { const p=calendarParts(value,timeZone);return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
export function formatTime(value,options={}) {
  if(value===null||value===undefined||value==='')return '—';
  const p=calendarParts(value,typeof options==='string'?options:options.timeZone||TIMEZONE);
  return `${pad(p.hour)}:${pad(p.minute)}${options.seconds?`:${pad(p.second)}`:''}`;
}
export function formatDate(value,timeZone=TIMEZONE) {
  if(value===null||value===undefined||value==='')return '—';
  const p=calendarParts(value,timeZone);return `${pad(p.day)}/${pad(p.month)}/${p.year}`;
}
export function formatMinutes(value) {
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';
  const n=Math.round(Number(value)),sign=n<0?'−':'';return `${sign}${Math.floor(Math.abs(n)/60)}ω ${pad(Math.abs(n)%60)}λ`;
}
export function addDateDays(key,days) {
  const [y,m,d]=String(key).split('-').map(Number);const date=new Date(Date.UTC(y,m-1,d+days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth()+1)}-${pad(date.getUTCDate())}`;
}

/** All matching instants, explicitly accounting for the Athens DST gap and fold. */
export function possibleInstants(date,time,timeZone=TIMEZONE) {
  const dm=String(date||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const tm=String(time||'').match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if(!dm||!tm)throw new RangeError('Συμπλήρωσε έγκυρη ημερομηνία και ώρα.');
  const target={year:+dm[1],month:+dm[2],day:+dm[3],hour:+tm[1],minute:+tm[2],second:+(tm[3]||0)};
  const millisecond=+(tm[4]||'0').padEnd(3,'0');
  const naive=Date.UTC(target.year,target.month-1,target.day,target.hour,target.minute,target.second,millisecond);
  const check=new Date(naive);
  if(target.year<1900||target.year>9999||target.month<1||target.month>12||target.day<1||target.hour>23||target.minute>59||target.second>59||check.getUTCFullYear()!==target.year||check.getUTCMonth()+1!==target.month||check.getUTCDate()!==target.day)throw new RangeError('Μη έγκυρη ημερομηνία και ώρα.');
  const offsets=new Set();
  for(const hours of [-48,-24,-12,0,12,24,48]){
    const sample=naive+hours*3600000,p=calendarParts(sample,timeZone);
    offsets.add(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(sample/1000)*1000);
  }
  const matches=[];
  for(const offset of offsets){
    const candidate=naive-offset,p=calendarParts(candidate,timeZone);
    if(Object.keys(target).every(k=>p[k]===target[k]))matches.push(candidate);
  }
  return [...new Set(matches)].sort((a,b)=>a-b).map(ms=>new Date(ms).toISOString());
}
export function localToIso(date,time,{timeZone=TIMEZONE,disambiguation='reject'}={}) {
  const candidates=possibleInstants(date,time,timeZone);
  if(!candidates.length)throw new RangeError('Αυτή η ώρα δεν υπάρχει λόγω της αλλαγής σε θερινή ώρα.');
  if(candidates.length>1&&disambiguation!=='earlier'&&disambiguation!=='later')throw new RangeError('Αυτή η ώρα εμφανίζεται δύο φορές λόγω αλλαγής ώρας. Επίλεξε την πρώτη ή τη δεύτερη εμφάνιση.');
  return disambiguation==='later'?candidates.at(-1):candidates[0];
}
export const getAthensDateKey=value=>dateKey(value,TIMEZONE);
export const combineDateAndTimeToIso=(date,time,options={})=>localToIso(date,time,options);
function dayBounds(key,timeZone) {return [instant(localToIso(key,'00:00',{timeZone})),instant(localToIso(addDateDays(key,1),'00:00',{timeZone}))];}
function monthDays(month) {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month)))throw new RangeError('Μη έγκυρος μήνας.');
  const [year,mon]=month.split('-').map(Number),count=new Date(Date.UTC(year,mon,0)).getUTCDate();
  return Array.from({length:count},(_,i)=>`${month}-${pad(i+1)}`);
}

function exactDecimal(value) {
  const match=String(value??0).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if(!match)return {coefficient:0n,scale:0};
  const exponent=Number(match[4]||0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1000)return {coefficient:0n,scale:0};
  let coefficient=BigInt((match[1]==='-'?'-':'')+match[2]+(match[3]||'')),scale=(match[3]||'').length-exponent;
  if(scale<0){coefficient*=10n**BigInt(-scale);scale=0;}
  return {coefficient,scale};
}
function compareOrder(a,b) {
  const x=exactDecimal(a),y=exactDecimal(b),scale=Math.max(x.scale,y.scale);
  const left=x.coefficient*10n**BigInt(scale-x.scale),right=y.coefficient*10n**BigInt(scale-y.scale);
  return left<right?-1:left>right?1:0;
}
export function effectiveEvents(events,{includePending=true}={}) {
  return (Array.isArray(events)?events:[]).filter(event=>{
    const status=event.status||'approved';return status==='approved'||(includePending&&status==='pending');
  }).map(event=>({...event,type:event.type||event.event_type,status:event.status||'approved'})).sort((a,b)=>{
    const at=instantNanos(a.event_at),bt=instantNanos(b.event_at);
    if(at!==null&&bt!==null&&at!==bt)return at<bt?-1:1;
    if(at!==null&&bt===null)return -1;if(at===null&&bt!==null)return 1;
    const order=compareOrder(a.tie_order,b.tie_order);if(order!==0)return order;
    return String(a.id??a.type).localeCompare(String(b.id??b.type),'en');
  });
}
function actionMessage(state,expected) {
  const labels=expected.map(type=>ACTION_LABELS[type]).join(' και μετά ');
  return expected.length?`Χρειάζεται πρώτα ${labels}.`:`Η ενέργεια δεν επιτρέπεται στην κατάσταση ${state}.`;
}

/** Replay the full effective history; invalid transitions never silently change state. */
export function replay(events,{now=new Date(),timeZone=TIMEZONE,timezone,includePending=true,includeScheduled=false,validateFuture=true}={}) {
  timeZone=timezone||timeZone;
  const timeline=effectiveEvents(events,{includePending}),issues=[],accepted=[],counts={},scheduled=[];
  let state='OUT',openShift=null,openBreak=null,lastEvent=null;
  const current=instant(now),currentPrecise=instantNanos(now);
  const issue=(event,expected_actions,message,code='invalid_transition')=>issues.push({code,event_id:event.id??null,type:event.type,event_at:event.event_at,state_before:state,expected_actions:[...expected_actions],repair_after_at:lastEvent?.event_at??null,repair_before_at:event.event_at??null,open_shift_at:openShift?.event_at??null,open_break_at:openBreak?.event_at??null,suggested_date:openBreak?dateKey(openBreak.event_at,timeZone):openShift?dateKey(openShift.event_at,timeZone):(instant(event.event_at)!==null?dateKey(event.event_at,timeZone):null),message});
  for(const event of timeline){
    const ms=instant(event.event_at);
    if(ms===null){issue(event,[],'Η εγγραφή έχει μη έγκυρη ημερομηνία.','invalid_timestamp');continue;}
    if(!ACTIONS.includes(event.type)){issue(event,[],'Άγνωστος τύπος ενέργειας.','unknown_action');continue;}
    const administrative=event.source==='admin'&&event.status==='approved';
    const future=currentPrecise!==null&&instantNanos(event.event_at)>currentPrecise;
    if(future&&administrative){scheduled.push(event);if(!includeScheduled)continue;}
    if(validateFuture&&future&&!(administrative&&includeScheduled)){issue(event,[],'Μια μελλοντική διόρθωση δεν μπορεί να καλύψει σημερινή ενέργεια.','future_event');continue;}
    if(administrative&&event.type!=='clock_in'&&event.shift_ref&&openShift&&String(event.shift_ref)!==String(openShift.id)){
      issue(event,[],'Η διοικητική ώρα ανήκει σε διαφορετική βάρδια.','wrong_shift_reference');continue;
    }
    if(administrative&&event.type==='break_end'&&event.break_ref&&openBreak&&String(event.break_ref)!==String(openBreak.id)){
      issue(event,[],'Η διοικητική επιστροφή ανήκει σε διαφορετικό διάλειμμα.','wrong_break_reference');continue;
    }
    const next=NEXT[state]?.[event.type]||(administrative&&event.closes_open_break===true&&state==='ON_BREAK'&&event.type==='clock_out'?'OUT':null);
    if(!next){const required=REQUIRED[state]?.[event.type]||[];issue(event,required,actionMessage(state,required));continue;}
    const key=dateKey(event.event_at,timeZone);
    if(event.type==='clock_in'){openShift=event;counts[key]=(counts[key]||0)+1;}
    if(event.type==='break_start')openBreak=event;
    if(event.type==='break_end')openBreak=null;
    if(event.type==='clock_out'){openShift=null;openBreak=null;}
    state=next;lastEvent=event;accepted.push(event);
  }
  const today=current===null?null:dateKey(current,timeZone);
  return {state,issues,open_shift_at:openShift?.event_at??null,open_break_at:openBreak?.event_at??null,open_shift_id:openShift?.id??null,open_break_id:openBreak?.id??null,pending_count:timeline.filter(e=>e.status==='pending').length,valid:issues.length===0,
    last_event_at:lastEvent?.event_at??null,last_event_id:lastEvent?.id??null,shift_counts:counts,today,today_shift_count:counts[today]||0,max_daily_shifts:null,timeZone,timeline,accepted_events:accepted,scheduled_events:scheduled,scheduled_count:scheduled.length,draft_count:(Array.isArray(events)?events:[]).filter(e=>e.status==='draft').length};
}

/** Describe missing prerequisites, never unlock an action merely because a request exists. */
export function planNext(status,type,{now=new Date(),timeZone=TIMEZONE}={}) {
  const state=status?.state||'OUT';
  if(!ACTIONS.includes(type))return {allowed:false,expected_actions:[],issues:[],message:'Άγνωστη ενέργεια.',suggested_date:null};
  if(status?.valid===false||status?.issues?.length){
    const first=status.issues[0];return {allowed:false,expected_actions:[...(first.expected_actions||[])],issues:status.issues,message:first.message||'Χρειάζεται ολοκλήρωση των διορθώσεων.',suggested_date:first.suggested_date||(first.event_at?dateKey(first.event_at,timeZone):null)};
  }
  const required=REQUIRED[state]?.[type]||[],next=NEXT[state]?.[type];
  const suggested_date=status?.open_break_at?dateKey(status.open_break_at,timeZone):status?.open_shift_at?dateKey(status.open_shift_at,timeZone):dateKey(now,timeZone);
  return {allowed:Boolean(next),expected_actions:[...required],issues:[],message:next?'':actionMessage(state,required),suggested_date};
}

function buildIntervals(accepted) {
  const shifts=[];let shift=null,activeBreak=null;
  for(const event of accepted){
    if(event.type==='clock_in'){shift={id:event.id??null,start_at:event.event_at,end_at:null,start_event:event,end_event:null,breaks:[],pending:event.status==='pending'};shifts.push(shift);}
    else if(event.type==='break_start'&&shift){activeBreak={id:event.id??null,start_at:event.event_at,end_at:null,start_event:event,end_event:null,pending:event.status==='pending'};shift.breaks.push(activeBreak);shift.pending ||= event.status==='pending';}
    else if(event.type==='break_end'&&activeBreak){activeBreak.end_at=event.event_at;activeBreak.end_event=event;activeBreak.pending ||= event.status==='pending';if(shift)shift.pending ||= event.status==='pending';activeBreak=null;}
    else if(event.type==='clock_out'&&shift){
      if(activeBreak&&event.source==='admin'&&event.status==='approved'&&event.closes_open_break===true){
        activeBreak.end_at=event.event_at;activeBreak.generated_end=true;activeBreak.admin_exit_id=event.id;
      }
      shift.end_at=event.event_at;shift.end_event=event;shift.pending ||= event.status==='pending';shift=null;activeBreak=null;
    }
  }
  return shifts;
}
function overlap(start,end,low,high) {return Math.max(0,Math.min(end,high)-Math.max(start,low));}
function scheduleMinutes(value) {const m=String(value||'').match(/^(\d{2}):(\d{2})(?::\d{2})?$/);return m&&+m[1]<24&&+m[2]<60?+m[1]*60+ +m[2]:null;}
function lateness(shift,employee,timeZone,index) {
  const p=calendarParts(shift.start_at,timeZone),actual=p.hour*60+p.minute+p.second/60;
  const schedules=[scheduleMinutes(employee?.shift1_start),scheduleMinutes(employee?.shift2_start)].filter(n=>n!==null);
  if(index>=schedules.length)return {late_minutes:0,scheduled_start:null};
  const preferred=index===1&&schedules.length>1?schedules[1]:[...schedules].sort((a,b)=>Math.abs(a-actual)-Math.abs(b-actual))[0];
  const tolerance=Math.max(0,Number(employee?.lateness_tolerance_minutes)||0);
  return {late_minutes:Math.max(0,actual-preferred-tolerance),scheduled_start:`${pad(Math.floor(preferred/60))}:${pad(preferred%60)}`};
}

/** Calendar-day report. Gross presence includes breaks; open intervals are estimated separately. */
export function monthlyStats(events,{month,employee={},notes=[],settings={},now=new Date(),includePending=true,includeScheduled=false,timeZone=TIMEZONE}={}) {
  timeZone=settings.timezone||timeZone;
  const keys=monthDays(month),keySet=new Set(keys),current=instant(now);
  // The server supplies the full timeline, so shifts crossing month boundaries remain pairable.
  const result=replay(events,{now,timeZone,includePending,includeScheduled,validateFuture:true});
  const shifts=buildIntervals(result.accepted_events);
  const noteMap=new Map((Array.isArray(notes)?notes:[]).filter(n=>!employee.id||!n.employee_id||String(n.employee_id)===String(employee.id)).map(n=>[n.date||n.note_date,n]));
  const target=Math.max(0,Number(settings.shift_target_minutes??480)||0),breakLimit=Math.max(0,Number(settings.break_limit_minutes??30)||0);
  const pendingByDay={};
  for(const event of result.timeline)if(event.status==='pending'&&instant(event.event_at)!==null){const key=dateKey(event.event_at,timeZone);pendingByDay[key]=(pendingByDay[key]||0)+1;}
  const startsByDay={};
  for(const shift of shifts){const key=dateKey(shift.start_at,timeZone);(startsByDay[key]??=[]).push(shift);}
  const days=keys.map(key=>{
    const [low,high]=dayBounds(key,timeZone),dayShifts=[];let gross=0,breakMinutes=0,breakCount=0,estimatedOpen=0,estimatedBreak=0,late=0;
    for(const shift of shifts){
      const start=instant(shift.start_at),end=shift.end_at?instant(shift.end_at):null;
      const closed=end!==null;
      const visibleEnd=closed?end:Math.max(start,current??start);
      if(start>=high||visibleEnd<low||(visibleEnd===low&&start!==low))continue;
      const duration=closed?overlap(start,end,low,high)/60000:0;
      if(!closed)estimatedOpen+=overlap(start,visibleEnd,low,high)/60000;
      gross+=duration;
      const dayBreaks=[];
      for(const br of shift.breaks){
        const bs=instant(br.start_at),be=br.end_at?instant(br.end_at):null,bend=be??Math.max(bs,current??bs);
        if(bs>=high||bend<low||(bend===low&&bs!==low))continue;
        const minutes=be===null?0:overlap(bs,be,low,high)/60000;
        breakMinutes+=minutes;
        if(be===null)estimatedBreak+=overlap(bs,bend,low,high)/60000;
        if(dateKey(br.start_at,timeZone)===key)breakCount++;
        dayBreaks.push({id:br.id,start_at:br.start_at,end_at:br.end_at,start_id:br.start_event?.id??null,end_id:br.end_event?.id??null,start_text:formatTime(br.start_at,{timeZone}),end_text:formatTime(br.end_at,{timeZone}),minutes,pending:br.pending,closed:be!==null,carried_in:bs<low,carried_out:bend>high,generated_end:br.generated_end===true,admin_exit_id:br.admin_exit_id??null});
      }
      const startsToday=dateKey(shift.start_at,timeZone)===key;
      const timing=startsToday?lateness(shift,employee,timeZone,startsByDay[key].indexOf(shift)):{late_minutes:0,scheduled_start:null};
      late+=timing.late_minutes;
      dayShifts.push({id:shift.id,start_at:shift.start_at,end_at:shift.end_at,start_id:shift.start_event?.id??null,end_id:shift.end_event?.id??null,start_text:formatTime(shift.start_at,{timeZone}),end_text:formatTime(shift.end_at,{timeZone}),gross_minutes:duration,breaks:dayBreaks,pending:shift.pending,closed,carried_in:start<low,carried_out:visibleEnd>high,...timing});
    }
    const targetMinutes=(startsByDay[key]?.length||0)>0?target:0;
    return {date:key,weekday:new Date(`${key}T12:00:00Z`).getUTCDay(),shifts:dayShifts,gross_minutes:gross,break_minutes:breakMinutes,break_count:breakCount,break_excess_minutes:Math.max(0,breakMinutes-breakLimit),late_minutes:late,target_minutes:targetMinutes,variance_minutes:gross-targetMinutes,pending_count:pendingByDay[key]||0,note:noteMap.get(key)||null,has_open_shift:dayShifts.some(s=>!s.closed),has_open_break:dayShifts.some(s=>s.breaks.some(b=>!b.closed)),estimated_open_minutes:estimatedOpen,estimated_open_break_minutes:estimatedBreak,issues:result.issues.filter(i=>instant(i.event_at)!==null&&dateKey(i.event_at,timeZone)===key)};
  });
  const totals={gross_minutes:0,break_minutes:0,break_count:0,break_excess_minutes:0,late_minutes:0,target_minutes:0,variance_minutes:0,worked_days:0,pending_count:0,estimated_open_minutes:0};
  for(const day of days){for(const key of ['gross_minutes','break_minutes','break_count','break_excess_minutes','late_minutes','target_minutes','variance_minutes','pending_count','estimated_open_minutes'])totals[key]+=day[key];if(day.gross_minutes>0)totals.worked_days++;}
  return {month,timeZone,employee_id:employee.id??null,includePending,includeScheduled,days,totals,issues:result.issues,state:result,has_scheduled:result.scheduled_events.some(e=>keySet.has(dateKey(e.event_at,timeZone))),has_pending:result.timeline.some(e=>e.status==='pending'&&instant(e.event_at)!==null&&keySet.has(dateKey(e.event_at,timeZone)))};
}
