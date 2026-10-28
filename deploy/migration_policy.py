"""Constrained, additive Makit migrations. No arbitrary SQL or down migrations."""
import hashlib
import json
import re

class PolicyError(ValueError): pass
IDENTIFIER = re.compile(r'^[a-z][a-z0-9_]{0,62}$')
FILENAME = re.compile(r'^[0-9]{4,6}_[a-z0-9_]+\.sql$')
TYPES = {'text','integer','bigint','boolean','timestamptz','uuid','jsonb'}
PREFIX = 'SET LOCAL lock_timeout = \'5s\';\nSET LOCAL statement_timeout = \'60s\';\n'

def canonical(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)

def digest(value): return hashlib.sha256(canonical(value).encode()).hexdigest()

def same_schema(a,b):
    return bool(a.get('schema')) and all(a.get(k)==b.get(k) for k in ['format','schema','runtime','postgresMajor'])

def validate_contract(value):
    fields(value,['format','schema','runtime','postgresMajor'])
    if type(value['format']) is not int or value['format']!=1 or value['runtime']!='core-single-writer-v1' or type(value['postgresMajor']) is not int or value['postgresMajor']!=17 or not isinstance(value['schema'],str) or not re.fullmatch(r'[a-f0-9]{64}',value['schema']):
        raise PolicyError('Unsupported schema contract')

def validate_transition(value):
    fields(value,['format','kind','fromImage','fromContract','plan','planDigest'])
    if type(value['format']) is not int or value['format']!=1 or value['kind']!='makit-additive-v1' or not isinstance(value['fromImage'],str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',value['fromImage']):
        raise PolicyError('Unsupported migration transition')
    validate_contract(value['fromContract'])

def fields(value,required,optional=()):
    if not isinstance(value,dict) or not set(required)<=value.keys() or set(value)-set(required)-set(optional):
        raise PolicyError('Unsupported or missing migration plan field')

def ident(value):
    if not isinstance(value,str) or not IDENTIFIER.fullmatch(value):raise PolicyError('Invalid SQL identifier')
    return '"'+value+'"'

def table(value): return '"public".'+ident(value)

def owned_name(value):
    ident(value)
    if not value.startswith(('cobuild_','makit_')):raise PolicyError('New objects require a cobuild_ or makit_ prefix')
    return value

def datatype(value):
    if not isinstance(value,str) or value not in TYPES:raise PolicyError('Unsupported migration column type')
    return value

def operation(change):
    kind=change.get('kind') if isinstance(change,dict) else None
    if kind=='create_table':
        fields(change,['kind','table','columns'])
        name=owned_name(change['table']);columns=change['columns']
        if not isinstance(columns,list) or not 1<=len(columns)<=64:raise PolicyError('Invalid new table columns')
        definitions=[];names=set();primary=0
        for column in columns:
            fields(column,['name','type'],['primary'])
            ident(column['name'])
            if column['name'] in names:raise PolicyError('Duplicate column')
            names.add(column['name']);text=ident(column['name'])+' '+datatype(column['type'])
            if 'primary' in column and type(column['primary']) is not bool:raise PolicyError('primary must be boolean')
            if column.get('primary'):primary+=1;text+=' PRIMARY KEY'
            definitions.append(text)
        if primary>1:raise PolicyError('Only one primary key column is supported')
        return 'CREATE TABLE '+table(name)+' (\n  '+',\n  '.join(definitions)+'\n);\nGRANT SELECT, INSERT, UPDATE, DELETE ON '+table(name)+' TO makit_application;\n'
    if kind=='add_nullable_column':
        fields(change,['kind','table','column','type'])
        return 'ALTER TABLE '+table(change['table'])+' ADD COLUMN '+ident(change['column'])+' '+datatype(change['type'])+';\n'
    if kind=='create_index':
        fields(change,['kind','name','table','columns'])
        owned_name(change['name']);columns=change['columns']
        if not isinstance(columns,list) or not 1<=len(columns)<=16:raise PolicyError('Invalid index columns')
        for c in columns:ident(c)
        if len(set(columns))!=len(columns):raise PolicyError('Duplicate index column')
        return 'CREATE INDEX '+ident(change['name'])+' ON '+table(change['table'])+' ('+', '.join(ident(c) for c in columns)+');\n'
    raise PolicyError('Only new tables, nullable columns and ordinary indexes are supported')

def generated_files(plan):
    fields(plan,['format','steps'])
    if type(plan['format']) is not int or plan['format']!=1 or not isinstance(plan['steps'],list) or not 1<=len(plan['steps'])<=32:raise PolicyError('Invalid migration plan')
    result={}
    for step in plan['steps']:
        fields(step,['file','changes'])
        name=step['file']
        if not isinstance(name,str) or not FILENAME.fullmatch(name) or name in result:raise PolicyError('Invalid or duplicate migration filename')
        changes=step['changes']
        if not isinstance(changes,list) or not 1<=len(changes)<=64:raise PolicyError('Invalid migration changes')
        result[name]=PREFIX+''.join(operation(c) for c in changes)
    if list(result)!=sorted(result):raise PolicyError('Migration filenames must be ordered')
    return result

def validate_candidate(migration,contract,manifest,approved_runner=None):
    validate_transition(migration)
    validate_contract(contract)
    if migration['planDigest']!=digest({'fromImage':migration['fromImage'],'fromContract':migration['fromContract'],'toContract':contract,'plan':migration['plan']}):raise PolicyError('Migration plan digest differs')
    expected=generated_files(migration['plan'])
    for name,sql in expected.items():
        path='apps/makit/migrations/selfhost/'+name
        if manifest['files'].get(path)!=hashlib.sha256(sql.encode()).hexdigest():raise PolicyError('Candidate SQL differs from generated migration plan')
    if not manifest.get('migrationRunner'):raise PolicyError('Candidate does not contain the controlled migration runner')
    if approved_runner is not None and manifest.get('runnerDigest')!=approved_runner:raise PolicyError('Candidate migration runner differs from the reviewed lifecycle runner')
    return expected

def authorize_transition(old,new,old_manifest,new_manifest):
    migration=new.get('migration')
    if not migration:raise PolicyError('Schema change requires an explicit additive migration plan')
    expected=validate_candidate(migration,new['contract'],new_manifest)
    if old['images']['core']['id']!=migration['fromImage'] or not same_schema(old['contract'],migration['fromContract']):raise PolicyError('Migration plan is for a different source release')
    old_files=old_manifest['files'];new_files=new_manifest['files']
    if any(new_files.get(path)!=sha for path,sha in old_files.items()):raise PolicyError('Existing schema files or migration drivers changed')
    added=set(new_files)-set(old_files)
    declared={'apps/makit/migrations/selfhost/'+name for name in expected}
    if added!=declared:raise PolicyError('Unplanned schema changes are not supported')
    previous=[path.rsplit('/',1)[1] for path in old_files if path.startswith('apps/makit/migrations/selfhost/')]
    if previous and min(expected)<=max(previous):raise PolicyError('Migrations must append after the existing history')
    if same_schema(old['contract'],new['contract']):raise PolicyError('Migration transition must change the schema contract')
    return {'baseLedger':old_manifest['makitLedger'],'newLedger':{name:hashlib.sha256(sql.encode()).hexdigest() for name,sql in expected.items()}}

def reconcile_history(base,new,current):
    if not isinstance(current,dict) or any(current.get(k)!=v for k,v in base.items()):raise PolicyError('Baseline migration history changed')
    extra=set(current)-set(base)
    if not extra<=set(new) or any(current[k]!=new[k] for k in extra):raise PolicyError('Unexpected migration history or checksum')
    ordered=sorted(new)
    applied=[name for name in ordered if name in extra]
    if applied!=ordered[:len(applied)]:raise PolicyError('Migration history is not an applied prefix')
    return {'applied':applied,'complete':len(applied)==len(ordered)}

def validate_repair(state,evidence):
    if evidence['baseLedger']!=state['baseLedger']:raise PolicyError('Repair changes the baseline migration history')
    applied=state['applied'];names=sorted(evidence['newLedger'])
    if names[:len(applied)]!=applied or any(evidence['newLedger'].get(k)!=state['newLedger'][k] for k in applied):
        raise PolicyError('Repair must retain every already-committed migration unchanged')
    return evidence

def validate_state(value):
    fields(value,['format','status','baseContract','targetContract','targetImage','transition','baseLedger','newLedger','applied','complete','actualSchema','compatibleSchemas'])
    if type(value['format']) is not int or value['format']!=1 or value['status'] not in ['migrating','partial','complete','not_applied']:raise PolicyError('Invalid schema state')
    for contract in [value['baseContract'],value['targetContract']]:
        validate_contract(contract)
    if not isinstance(value['targetImage'],str) or not re.fullmatch(r'sha256:[a-f0-9]{64}',value['targetImage']):raise PolicyError('Invalid target image')
    transition=value['transition'];validate_transition(transition);plan=transition['plan']
    files=generated_files(plan)
    expected={name:hashlib.sha256(sql.encode()).hexdigest() for name,sql in files.items()}
    if value['newLedger']!=expected or not same_schema(transition.get('fromContract',{}),value['baseContract']):raise PolicyError('Stored migration evidence differs')
    digest_value=digest({'fromImage':transition.get('fromImage'),'fromContract':transition.get('fromContract'),'toContract':value['targetContract'],'plan':plan})
    if transition.get('planDigest')!=digest_value:raise PolicyError('Stored plan digest differs')
    if not isinstance(value['baseLedger'],dict) or any(not isinstance(k,str) or not re.fullmatch(r'[a-f0-9]{64}',str(v)) for k,v in value['baseLedger'].items()):raise PolicyError('Invalid baseline history')
    applied=value['applied']
    if not isinstance(applied,list) or applied!=sorted(expected)[:len(applied)]:raise PolicyError('Invalid applied migration prefix')
    status=value['status'];base=value['baseContract']['schema'];target=value['targetContract']['schema']
    if status=='migrating':compatible=[];actual=None;complete=False
    else:
        complete=len(applied)==len(expected)
        derived='complete' if complete else 'partial' if applied else 'not_applied'
        if status!=derived:raise PolicyError('Stored schema status disagrees with applied history')
        compatible=[base]+([target] if complete else [])
        actual=target if complete else None if applied else base
    if value['complete'] is not complete or value['compatibleSchemas']!=compatible or value['actualSchema']!=actual:raise PolicyError('Invalid compatibility grant')
    return value
