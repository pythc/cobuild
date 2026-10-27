import {randomUUID} from 'node:crypto';

// Additive outbox; old application releases can still read/write project rows.
export function projectKnowledgeStore(db,{now=Date.now}={}) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_knowledge_space(
    project_id TEXT PRIMARY KEY REFERENCES projects(id), name TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    space_id TEXT, url TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ) STRICT;`);
  const getRow=id=>db.prepare('SELECT * FROM project_knowledge_space WHERE project_id=?').get(id);
  return {
    request(id,name){db.prepare(`INSERT INTO project_knowledge_space(project_id,name,state,created_at,updated_at)
      VALUES(?,?,'awaiting_approval',?,?) ON CONFLICT(project_id) DO NOTHING`).run(id,name,now(),now());},
    approve(id,name){db.prepare(`UPDATE project_knowledge_space SET state='queued',name=?,updated_at=?
      WHERE project_id=? AND state='awaiting_approval'`).run(name,now(),id);},
    get(id){const r=getRow(id);return r?{requested:true,state:r.state,spaceId:r.space_id,url:r.url,errorCode:r.error_code}:null;},
    claim(){
      db.exec('SAVEPOINT knowledge_claim');
      try{
        const time=now();
        const row=db.prepare(`SELECT k.* FROM project_knowledge_space k JOIN projects p ON p.id=k.project_id
          WHERE p.phase='active' AND p.archived=0 AND
          ((k.state IN ('queued','retrying') AND k.next_attempt<=?) OR (k.state='working' AND k.lease_until<=?))
          ORDER BY k.created_at,k.project_id LIMIT 1`).get(time,time);
        if(!row){db.exec('RELEASE knowledge_claim');return null;}
        const lease=randomUUID();
        db.prepare("UPDATE project_knowledge_space SET state='working',lease=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE project_id=?")
          .run(lease,time+120000,time,row.project_id);
        db.exec('RELEASE knowledge_claim');return {id:row.project_id,name:row.name,lease,attempts:row.attempts+1};
      }catch(e){db.exec('ROLLBACK TO knowledge_claim; RELEASE knowledge_claim');throw e;}
    },
    finish(job,{spaceId,url}){
      db.exec('SAVEPOINT knowledge_finish');
      try{
        const r=db.prepare(`UPDATE project_knowledge_space SET state='ready',space_id=?,url=?,error_code=NULL,
          lease=NULL,lease_until=0,updated_at=? WHERE project_id=? AND state='working' AND lease=? AND lease_until>?`)
          .run(spaceId,url,now(),job.id,job.lease,now());
        if(r.changes)db.prepare(`UPDATE projects SET links_json=json_set(links_json,'$.knowledgeSpace',?),revision=revision+1,updated_at=?
          WHERE id=? AND coalesce(json_extract(links_json,'$.knowledgeSpace'),'')=''`)
          .run(url,new Date(now()).toISOString(),job.id);
        db.exec('RELEASE knowledge_finish');return !!r.changes;
      }catch(e){db.exec('ROLLBACK TO knowledge_finish; RELEASE knowledge_finish');throw e;}
    },
    fail(job,error){db.prepare(`UPDATE project_knowledge_space SET state=?,error_code=?,next_attempt=?,lease=NULL,lease_until=0,updated_at=?
      WHERE project_id=? AND state='working' AND lease=? AND lease_until>?`).run(error.permanent?'blocked':'retrying',
      error.code||'KNOWLEDGE_UNCONFIRMED',now()+Math.min(300000,10000*2**Math.min(job.attempts-1,5)),now(),job.id,job.lease,now());},
    retry(id){return db.prepare("UPDATE project_knowledge_space SET state='queued',next_attempt=0,error_code=NULL WHERE project_id=? AND state IN ('blocked','retrying')").run(id).changes>0;},
  };
}
