import {readdir,readFile} from 'node:fs/promises';
const repo=process.env.GITHUB_REPOSITORY;
if(repo!=='dream-unity/start-fresh')throw new Error('Evidence publishing is restricted to start-fresh.');
const kind=process.env.EVIDENCE_KIND;
if(!['browser','inference'].includes(kind))throw new Error('Unknown evidence kind.');
const ref='verification-evidence';
const headers={Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
async function api(path,method='GET',body) {
  const response=await fetch(`https://api.github.com/repos/${repo}/${path}`,{method,headers,body:body?JSON.stringify(body):undefined});
  if(response.status===404&&method==='GET')return null;
  if(!response.ok)throw new Error(`Evidence API ${method} ${path}: ${response.status}`);
  return response.json();
}
async function files(dir) {
  let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return [];}
  const result=[];
  for(const entry of entries) {
    const path=`${dir}/${entry.name}`;
    if(entry.isDirectory())result.push(...await files(path));
    else if(/\.(png|json|txt|md)$/.test(entry.name))result.push(path);
  }
  return result;
}
const paths=await files('output');
if(!paths.length){console.log('No evidence files were produced.');process.exit(0);}
const entries=[];
for(const path of paths) {
  const data=await readFile(path);if(data.length>8_000_000)continue;
  const blob=await api('git/blobs','POST',{encoding:'base64',content:data.toString('base64')});
  entries.push({path:`${process.env.GITHUB_SHA}/${kind}/${path.slice(7)}`,mode:'100644',type:'blob',sha:blob.sha});
}
// Both independent jobs may finish together. Retry a non-fast-forward update
// against the latest evidence tree; never force or touch the source branch.
for(let attempt=0;attempt<4;attempt++) {
  const head=await api(`git/ref/heads/${ref}`);
  const base=head?await api(`git/commits/${head.object.sha}`):null;
  const tree=await api('git/trees','POST',{base_tree:base?.tree.sha,tree:entries});
  const commit=await api('git/commits','POST',{message:`${kind} evidence for ${process.env.GITHUB_SHA}`,tree:tree.sha,parents:head?[head.object.sha]:[process.env.GITHUB_SHA]});
  try {
    if(head)await api(`git/refs/heads/${ref}`,'PATCH',{sha:commit.sha,force:false});
    else await api('git/refs','POST',{ref:`refs/heads/${ref}`,sha:commit.sha});
    console.log(`Published ${entries.length} evidence files for ${process.env.GITHUB_SHA}.`);break;
  } catch(error) {if(attempt===3)throw error;}
}
