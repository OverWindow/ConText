import type {DB} from './database.ts';
import {assert} from './errors.ts';

export interface SearchHit {id:string;kind:'document';document_id:string;version_id:string;version_number:number;is_current:boolean;document_title:string;text:string;locations:never[];score:number;}
export async function searchEvidence(db:DB,workspaceId:string,question:string,requestedScope='auto',asOf?:string|null,limit=20,{fallback=false}={}) {
  assert(['auto','current','history','as_of'].includes(requestedScope),'INVALID_SCOPE','Unsupported evidence scope');
  const scope=requestedScope==='auto'?/과거|이전|지난|작년|변경\s*전|\d{4}[-년./]/.test(question)?'history':'current':requestedScope;
  const needle=question.trim().toLocaleLowerCase();assert(needle.length>0&&needle.length<=4000,'INVALID_QUERY','Search query must contain 1–4000 characters');
  let cutoff:string|null=null;
  if(scope==='as_of'){
    assert(typeof asOf==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(asOf),'INVALID_DATE','Historical search requires YYYY-MM-DD');
    const stamp=new Date(`${asOf}T23:59:59.999+09:00`);assert(Number.isFinite(stamp.getTime())&&asOf<=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul'}).format(new Date()),'INVALID_DATE','Historical search date is invalid');cutoff=stamp.toISOString();
  }
  const base=`FROM unified.document_texts t
    JOIN unified.entities d ON d.workspace_id=t.workspace_id AND d.collection='documents' AND d.id=t.document_id
    JOIN unified.entities v ON v.workspace_id=t.workspace_id AND v.collection='versions' AND v.id=t.version_id
    JOIN unified.entities e ON e.workspace_id=t.workspace_id AND e.collection='entries' AND e.payload->>'document_id'=t.document_id::text
    WHERE t.workspace_id=$1 AND NOT d.deleted AND NOT e.deleted
    ${scope==='current'?"AND d.payload->>'reference_head_id'=t.version_id::text":''}
    ${scope==='as_of'?`AND (v.payload->>'created_at')::timestamptz<=$4::timestamptz
      AND NOT EXISTS(SELECT 1 FROM unified.entities newer WHERE newer.workspace_id=t.workspace_id AND newer.collection='versions'
        AND newer.payload->>'document_id'=t.document_id::text AND (newer.payload->>'created_at')::timestamptz<=$4::timestamptz
        AND ((newer.payload->>'created_at')::timestamptz,newer.id)>((v.payload->>'created_at')::timestamptz,v.id))`:''}`;
  const select=`SELECT t.artifact_id,t.document_id,t.version_id,t.body,e.payload->>'name' AS title,
    (d.payload->>'reference_head_id'=v.id::text) AS is_current,
    COALESCE((v.payload->>'display_number')::int,(SELECT count(*)::int FROM unified.entities numbered WHERE numbered.workspace_id=v.workspace_id AND numbered.collection='versions' AND numbered.payload->>'document_id'=t.document_id::text AND ((numbered.payload->>'created_at')::timestamptz,numbered.id)<=((v.payload->>'created_at')::timestamptz,v.id))) AS version_number`;
  const values=scope==='as_of'?[workspaceId,needle,limit,cutoff]:[workspaceId,needle,limit];
  let rows=(await db.query(`${select},ts_rank_cd(t.search_vector,plainto_tsquery('simple',$2)) AS score ${base}
    AND (t.search_vector @@ plainto_tsquery('simple',$2) OR position($2 IN lower(t.body))>0) ORDER BY score DESC,(v.payload->>'created_at')::timestamptz DESC,t.version_id LIMIT $3`,values)).rows;
  if(!rows.length&&fallback){
    // A natural-language instruction may contain no exact document terms. Use bounded
    // current reference-head excerpts rather than treating an empty search as no context.
    const fallbackValues=scope==='as_of'?values:[workspaceId,needle,limit];
    rows=(await db.query(`${select},0::real AS score ${base} AND length(t.body)>0 AND $2::text IS NOT NULL ORDER BY (v.payload->>'created_at')::timestamptz DESC,t.version_id LIMIT $3`,fallbackValues)).rows;
  }
  const results:SearchHit[]=rows.map(row=>{const at=Math.max(0,String(row.body).toLocaleLowerCase().indexOf(needle));return {id:row.artifact_id,kind:'document',document_id:row.document_id,version_id:row.version_id,version_number:Number(row.version_number)||1,is_current:!!row.is_current,document_title:row.title||'Document',text:String(row.body).slice(Math.max(0,at-200),at+1600),locations:[],score:Number(row.score)||1};});
  return {results,scope,as_of:scope==='as_of'?asOf||null:null,warnings:[] as string[]};
}
