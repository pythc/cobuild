import {createIdentityRegistry,readIdentityApplications} from '../server/identity-applications.mjs';
try{
 const filename=process.argv[2]||process.env.PORTAL_IDENTITY_APPLICATIONS_CONFIG;
 if(!filename)throw new Error('Provide the controlled application configuration file');
 const applications=readIdentityApplications(filename);
 const registry=createIdentityRegistry({applications,knowledgeCallback:process.env.PORTAL_KNOWLEDGE_SSO_CALLBACK});
 console.log(JSON.stringify({valid:true,applications:applications.map(app=>({id:app.id,name:registry.get(app.id).name,scopes:registry.get(app.id).scopes}))}));
}catch(error){console.error('Identity application preflight failed: '+error.message);process.exitCode=1;}
