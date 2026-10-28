import copy
import hashlib
import unittest
import migration_policy as p

def plan():
    return {'format':1,'steps':[{'file':'0091_probe.sql','changes':[
        {'kind':'create_table','table':'cobuild_probe','columns':[{'name':'id','type':'text','primary':True},{'name':'note','type':'text'}]},
        {'kind':'add_nullable_column','table':'portal_project','column':'note_v2','type':'text'},
        {'kind':'create_index','name':'cobuild_probe_note','table':'cobuild_probe','columns':['note']},
    ]}]}

def fixture():
    old={'contract':{'format':1,'schema':'a'*64,'runtime':'core-single-writer-v1','postgresMajor':17},'images':{'core':{'id':'sha256:'+'1'*64}}}
    new=copy.deepcopy(old);new['contract']['schema']='b'*64;new['images']['core']['id']='sha256:'+'2'*64
    migration={'format':1,'kind':'makit-additive-v1','fromImage':old['images']['core']['id'],'fromContract':old['contract'],'plan':plan()}
    migration['planDigest']=p.digest({'fromImage':migration['fromImage'],'fromContract':old['contract'],'toContract':new['contract'],'plan':migration['plan']})
    new['migration']=migration
    base={'files':{'apps/platform/server/a-store.mjs':'c'*64,'apps/makit/migrations/selfhost/0090_base.sql':'d'*64},'makitLedger':{'0090_base.sql':'d'*64}}
    target=copy.deepcopy(base);target.update({'migrationRunner':True,'runnerDigest':'f'*64})
    sql=p.generated_files(plan())['0091_probe.sql']
    target['files']['apps/makit/migrations/selfhost/0091_probe.sql']=hashlib.sha256(sql.encode()).hexdigest()
    return old,new,base,target

class MigrationPolicyTests(unittest.TestCase):
    def test_generated_sql_is_additive_and_transaction_bounded(self):
        sql=p.generated_files(plan())['0091_probe.sql']
        self.assertTrue(sql.startswith(p.PREFIX));self.assertIn('ADD COLUMN "note_v2" text;',sql)
        self.assertNotIn('DEFAULT',sql);self.assertNotIn('NOT NULL',sql);self.assertNotIn('UNIQUE',sql)
    def test_destructive_or_unrestricted_sql_is_rejected(self):
        for change in [{'kind':'drop_table','table':'portal_project'},{'kind':'sql','sql':'DELETE FROM portal_project'},
                       {'kind':'add_nullable_column','table':'portal_project','column':'x','type':'text','default':'secret'},
                       {'kind':'create_index','name':'cobuild_idx','table':'portal_project','columns':['id'],'unique':True}]:
            value=plan();value['steps'][0]['changes']=[change]
            with self.assertRaises(p.PolicyError):p.generated_files(value)
    def test_identifiers_types_paths_and_duplicate_steps_are_rejected(self):
        for name in ['../0091_x.sql','0090.sql','0091_x.sql/',';DROP.sql']:
            value=plan();value['steps'][0]['file']=name
            with self.assertRaises(p.PolicyError):p.generated_files(value)
        for value in ['x; DROP TABLE portal_project','Public.x',{},None]:
            with self.assertRaises(p.PolicyError):p.ident(value)
        for value in ['text; DELETE',{},None,True]:
            with self.assertRaises(p.PolicyError):p.datatype(value)
        value=plan();value['steps'].append(copy.deepcopy(value['steps'][0]))
        with self.assertRaises(p.PolicyError):p.generated_files(value)
    def test_exact_new_files_and_unchanged_old_schema_are_required(self):
        old,new,base,target=fixture();evidence=p.authorize_transition(old,new,base,target)
        self.assertEqual(evidence['baseLedger'],base['makitLedger'])
        for path in ['apps/platform/server/a-store.mjs','apps/makit/migrations/selfhost/0090_base.sql']:
            bad=copy.deepcopy(target);bad['files'][path]='e'*64
            with self.assertRaises(p.PolicyError):p.authorize_transition(old,new,base,bad)
        bad=copy.deepcopy(target);bad['files']['integrations/weknow/source/apps/server/dist/database/migrations/new.js']='e'*64
        with self.assertRaises(p.PolicyError):p.authorize_transition(old,new,base,bad)
    def test_changed_sql_and_runner_are_rejected(self):
        old,new,base,target=fixture();bad=copy.deepcopy(target)
        bad['files']['apps/makit/migrations/selfhost/0091_probe.sql']='e'*64
        with self.assertRaises(p.PolicyError):p.validate_candidate(new['migration'],new['contract'],bad)
        with self.assertRaises(p.PolicyError):p.validate_candidate(new['migration'],new['contract'],target,'0'*64)
    def test_transition_cannot_be_reused_for_another_source_image_or_plan(self):
        old,new,base,target=fixture();wrong=copy.deepcopy(old);wrong['images']['core']['id']='sha256:'+'3'*64
        with self.assertRaises(p.PolicyError):p.authorize_transition(wrong,new,base,target)
        new['migration']['plan']['steps'][0]['file']='0092_other.sql'
        with self.assertRaises(p.PolicyError):p.validate_candidate(new['migration'],new['contract'],target)
    def test_only_an_exact_committed_prefix_is_recoverable(self):
        base={'old':'a'*64};new={'0091.sql':'b'*64,'0092.sql':'c'*64}
        self.assertEqual(p.reconcile_history(base,new,{**base,'0091.sql':'b'*64}),{'applied':['0091.sql'],'complete':False})
        self.assertTrue(p.reconcile_history(base,new,{**base,**new})['complete'])
        for current in [{'old':'x'},base|{'0092.sql':'c'*64},base|{'extra':'b'*64},base|{'0091.sql':'0'*64}]:
            with self.assertRaises(p.PolicyError):p.reconcile_history(base,new,current)
    def test_forward_repair_keeps_committed_prefix_but_can_replace_unapplied_suffix(self):
        state={'baseLedger':{'old':'a'},'newLedger':{'0091.sql':'b','0092.sql':'c'},'applied':['0091.sql']}
        evidence={'baseLedger':{'old':'a'},'newLedger':{'0091.sql':'b','0092.sql':'changed','0093.sql':'new'}}
        self.assertIs(p.validate_repair(state,evidence),evidence)
        for rows in [{'0091.sql':'changed','0092.sql':'c'},{'0092.sql':'c'}]:
            with self.assertRaises(p.PolicyError):p.validate_repair(state,{'baseLedger':{'old':'a'},'newLedger':rows})

    def test_stored_state_derives_compatibility_from_committed_progress(self):
        old,new,base,target=fixture();evidence=p.authorize_transition(old,new,base,target)
        state={'format':1,'status':'complete','baseContract':old['contract'],'targetContract':new['contract'],
            'targetImage':new['images']['core']['id'],'transition':new['migration'],**evidence,
            'applied':sorted(evidence['newLedger']),'complete':True,'actualSchema':new['contract']['schema'],
            'compatibleSchemas':[old['contract']['schema'],new['contract']['schema']]}
        self.assertIs(p.validate_state(state),state)
        for key,value in [('compatibleSchemas',['unrelated']),('actualSchema',old['contract']['schema']),('status','partial'),('complete',1),('targetImage','mutable:latest')]:
            bad=copy.deepcopy(state);bad[key]=value
            with self.assertRaises(p.PolicyError):p.validate_state(bad)
        for status in ['migrating','not_applied']:
            pending=copy.deepcopy(state);pending.update(status=status,applied=[],complete=False,
                actualSchema=None if status=='migrating' else old['contract']['schema'],
                compatibleSchemas=[] if status=='migrating' else [old['contract']['schema']])
            self.assertIs(p.validate_state(pending),pending)

    def test_runtime_contract_and_transition_format_are_strict(self):
        old,new,base,target=fixture()
        for key,value in [('format',True),('runtime','unknown-v2'),('postgresMajor',18),('schema','mutable')]:
            bad=copy.deepcopy(new['contract']);bad[key]=value
            with self.assertRaises(p.PolicyError):p.validate_contract(bad)
        for key,value in [('format',True),('kind','raw-sql'),('fromImage',None)]:
            bad=copy.deepcopy(new['migration']);bad[key]=value
            with self.assertRaises(p.PolicyError):p.validate_transition(bad)

    def test_partial_schema_never_grants_the_target_application(self):
        old,new,base,target=fixture()
        second={'file':'0092_probe.sql','changes':[{'kind':'create_table','table':'cobuild_second','columns':[{'name':'id','type':'text'}]}]}
        new['migration']['plan']['steps'].append(second)
        new['migration']['planDigest']=p.digest({'fromImage':new['migration']['fromImage'],'fromContract':old['contract'],'toContract':new['contract'],'plan':new['migration']['plan']})
        generated=p.generated_files(new['migration']['plan'])
        state={'format':1,'status':'partial','baseContract':old['contract'],'targetContract':new['contract'],
            'targetImage':new['images']['core']['id'],'transition':new['migration'],'baseLedger':base['makitLedger'],
            'newLedger':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in generated.items()},'applied':['0091_probe.sql'],
            'complete':False,'actualSchema':None,'compatibleSchemas':[old['contract']['schema']]}
        self.assertIs(p.validate_state(state),state)
        bad=copy.deepcopy(state);bad['compatibleSchemas'].append(new['contract']['schema'])
        with self.assertRaises(p.PolicyError):p.validate_state(bad)

if __name__=='__main__':unittest.main()
