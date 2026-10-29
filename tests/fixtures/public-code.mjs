export const HEAD='a'.repeat(40), NEXT_HEAD='b'.repeat(40);
export const REPO='https://github.com/example/project';
export const repository={id:123,private:false,visibility:'public',full_name:'example/project'};
export const pr={id:456,number:7,title:'Improve project flow',state:'open',draft:false,merged_at:null,base:{repo:repository},head:{sha:HEAD}};
export function payload(path){
  if(path==='/repos/example/project')return repository;
  if(path.startsWith('/repos/example/project/pulls?'))return [pr];
  if(path==='/repos/example/project/pulls/7')return pr;
  if(path.includes('/check-runs?'))return {total_count:1,check_runs:[{id:701,name:'Unit tests',head_sha:HEAD,status:'completed',conclusion:'success'}]};
  if(path.includes('/status?'))return {sha:HEAD,total_count:1,statuses:[{id:702,context:'lint',state:'success'}]};
  throw Error('Unexpected fixture path: '+path);
}
export function response(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});}
export const fixtureFetch=async(url)=>response(payload(new URL(url).pathname+new URL(url).search));
